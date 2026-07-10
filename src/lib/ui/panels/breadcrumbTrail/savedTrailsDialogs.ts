// Name/update dialogs for saving, renaming, and replacing saved trail paths.

import {
  SAVED_TRAIL_NAME_MAX_LENGTH,
  slicePathToIndex,
  suggestSavedTrailName,
  savedTrailEndpoint,
  savedTrailEntriesEqual,
} from "../../../core/trail/trailCore";
import {
  closeOverlaySurface,
  pushOverlaySurface,
} from "./overlaySurfaces";
import { entryTitle, pagesLabel } from "./trailPresentation";
import {
  UNDO_DURATION_MS,
  acceptAuthoritativeTrails,
  activeShadowElement,
  currentCapturedPath,
  host,
  librarySession,
  pendingTrailIds,
  renderLibrary,
  restoreLibraryFocus,
  restoreSurfaceFocus,
  syncLiveInteraction,
  allocateDialogId,
  type LibrarySession,
  type SavedTrailsHost,
} from "./savedTrailsSession";

interface NameDialogOptions {
  title: string;
  summary: string;
  initialName: string;
  submitLabel: string;
  pendingLabel: string;
  opener: HTMLElement | null;
  closeLibrary: boolean;
  trailId?: string;
  submit: (name: string) => Promise<
    | { ok: true; trail: SavedTrail; trails: SavedTrail[] }
    | { ok: false; reason: string }
  >;
  successMessage: (trail: SavedTrail) => string;
}

interface ManagedDialogShellOptions {
  idPrefix: string;
  title: string;
  summary: string;
  submitLabel: string;
  pendingLabel: string;
  input?: {
    initialValue: string;
    ariaLabel: string;
    maxLength: number;
  };
}

interface ManagedDialogShell {
  dialog: HTMLDivElement;
  input: HTMLInputElement | null;
  cancel: HTMLButtonElement;
  submit: HTMLButtonElement;
  setPending: (pending: boolean) => void;
  showError: (message: string) => void;
}

type ManagedDialogResult =
  | {
      ok: true;
      trail: SavedTrail;
      trails: SavedTrail[];
      previousTrail?: SavedTrail;
    }
  | { ok: false; reason: string };

interface MutationDialogOptions {
  shell: ManagedDialogShellOptions;
  opener: HTMLElement | null;
  trailId?: string;
  closeLibrary?: boolean;
  closeLiveSurfaces?: boolean;
  failureMessage: string;
  submit: (inputValue: string | undefined) => Promise<ManagedDialogResult>;
  onSuccess: (
    result: Extract<ManagedDialogResult, { ok: true }>,
    boundHost: SavedTrailsHost,
    originSession: LibrarySession | null,
  ) => void;
}

export function createManagedDialogShell(options: ManagedDialogShellOptions): ManagedDialogShell {
  const dialogId = `${options.idPrefix}-${allocateDialogId()}`;
  const titleId = `${dialogId}-title`;
  const summaryId = `${dialogId}-summary`;
  const dialog = document.createElement("div");
  dialog.id = dialogId;
  dialog.className = "wf-dialog";
  dialog.dataset.tabtrailHitSurface = "";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "false");
  dialog.setAttribute("aria-labelledby", titleId);
  dialog.setAttribute("aria-describedby", summaryId);

  const heading = document.createElement("div");
  heading.id = titleId;
  heading.className = "wf-dialog-title";
  heading.textContent = options.title;
  dialog.appendChild(heading);

  const summary = document.createElement("div");
  summary.id = summaryId;
  summary.className = "wf-dialog-summary";
  summary.textContent = options.summary;
  dialog.appendChild(summary);

  const input = options.input ? document.createElement("input") : null;
  if (input && options.input) {
    input.className = "wf-dialog-input";
    input.type = "text";
    input.maxLength = options.input.maxLength;
    input.value = options.input.initialValue;
    input.setAttribute("aria-label", options.input.ariaLabel);
    dialog.appendChild(input);
  }

  const error = document.createElement("div");
  error.className = "wf-dialog-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  dialog.appendChild(error);

  const actions = document.createElement("div");
  actions.className = "wf-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "wf-dialog-btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => closeOverlaySurface("nameDialog"));
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "wf-dialog-btn wf-dialog-btn-primary";
  submit.textContent = options.submitLabel;
  actions.appendChild(cancel);
  actions.appendChild(submit);
  dialog.appendChild(actions);

  const setPending = (pending: boolean): void => {
    dialog.toggleAttribute("aria-busy", pending);
    if (pending) error.hidden = true;
    if (input) input.disabled = pending;
    cancel.disabled = pending;
    submit.disabled = pending;
    submit.textContent = pending ? options.pendingLabel : options.submitLabel;
  };
  const showError = (message: string): void => {
    error.textContent = message;
    error.hidden = false;
    setPending(false);
    input?.focus();
  };

  return { dialog, input, cancel, submit, setPending, showError };
}

export function openMutationDialog(options: MutationDialogOptions): void {
  if (!host) return;
  const dialogHost = host;
  const dialogSession = librarySession;
  if (options.closeLiveSurfaces) dialogHost.closeLiveSurfaces();
  if (options.closeLibrary) {
    if (librarySession) librarySession.restoreFocusOnClose = false;
    closeOverlaySurface("library");
  }
  closeOverlaySurface("treePreview");
  closeOverlaySurface("menu");
  closeOverlaySurface("nameDialog");

  const shell = createManagedDialogShell(options.shell);
  const { dialog, input, submit: submitButton } = shell;
  let submitting = false;

  const submit = (): void => {
    if (submitting) return;
    submitting = true;
    shell.setPending(true);
    const mutationGeneration = dialogSession?.loadRequest;
    if (options.trailId) {
      pendingTrailIds.add(options.trailId);
      if (librarySession) renderLibrary(librarySession);
    }
    void options.submit(input?.value).then((result) => {
      if (host !== dialogHost) return;
      if (!result.ok) {
        if (dialog.isConnected) {
          shell.showError(result.reason);
          submitting = false;
        } else {
          dialogHost.showNotice(result.reason, { tone: "error", durationMs: 5000 });
        }
        return;
      }
      acceptAuthoritativeTrails(result.trails, dialogSession, mutationGeneration);
      if (dialog.isConnected) closeOverlaySurface("nameDialog");
      options.onSuccess(result, dialogHost, dialogSession);
    }).catch(() => {
      if (host !== dialogHost) return;
      if (!dialog.isConnected) {
        dialogHost.showNotice(options.failureMessage, { tone: "error", durationMs: 5000 });
        return;
      }
      shell.showError(options.failureMessage);
      submitting = false;
    }).finally(() => {
      if (!options.trailId) return;
      pendingTrailIds.delete(options.trailId);
      if (host === dialogHost && dialogSession && librarySession === dialogSession) {
        renderLibrary(dialogSession);
      }
      if (
        host === dialogHost &&
        dialogSession &&
        librarySession === dialogSession &&
        !dialog.isConnected
      ) {
        restoreLibraryFocus({ trailId: options.trailId, action: "more" }, true);
      }
    });
  };

  submitButton.addEventListener("click", submit);
  input?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submit();
  });
  dialogHost.layer.appendChild(dialog);
  pushOverlaySurface("nameDialog", () => {
    dialog.remove();
    if (host !== dialogHost) return;
    syncLiveInteraction(dialogHost);
    dialogHost.flushLiveTrailUpdates();
    if (options.trailId && submitting) return;
    if (options.trailId) {
      restoreLibraryFocus({ trailId: options.trailId, action: "more" }, true);
    } else {
      restoreSurfaceFocus(dialogHost, options.opener);
    }
  });
  syncLiveInteraction(dialogHost);
  if (input) {
    input.focus({ preventScroll: true });
    input.select();
  } else {
    submitButton.focus({ preventScroll: true });
  }
}

export function openNameDialog(options: NameDialogOptions): void {
  openMutationDialog({
    shell: {
      idPrefix: "tabtrail-name-dialog",
      title: options.title,
      summary: options.summary,
      submitLabel: options.submitLabel,
      pendingLabel: options.pendingLabel,
      input: {
        initialValue: options.initialName,
        ariaLabel: "Trail name",
        maxLength: SAVED_TRAIL_NAME_MAX_LENGTH,
      },
    },
    opener: options.opener,
    trailId: options.trailId,
    closeLibrary: options.closeLibrary,
    closeLiveSurfaces: true,
    failureMessage: "Could not save changes",
    submit: (value) => options.submit(value ?? ""),
    onSuccess: (result, boundHost) => {
      boundHost.showNotice(options.successMessage(result.trail));
    },
  });
}

export function openSaveCapturedPathDialog(
  path: TrailEntry[] | null,
  opener: HTMLElement | null,
): void {
  if (!host) return;
  const client = host.client;
  if (!path || path.length === 0) {
    host.showNotice("Nothing to save on this row", { tone: "error" });
    return;
  }
  const endpoint = path[path.length - 1];
  openNameDialog({
    title: "Name this trail",
    summary: `${pagesLabel(path.length)} · ends at “${entryTitle(endpoint)}”`,
    initialName: suggestSavedTrailName(endpoint),
    submitLabel: "Save",
    pendingLabel: "Saving…",
    opener,
    closeLibrary: true,
    submit: (name) => client.save(path, name),
    successMessage: (trail) => `Saved “${trail.name}”`,
  });
}

export function openSaveTrailDialog(index: number, opener?: HTMLElement | null): void {
  if (!host) return;
  const state = host.getState();
  openSaveCapturedPathDialog(
    slicePathToIndex(state, index),
    opener ?? activeShadowElement(host),
  );
}

export function openSaveCurrentTrailDialog(opener: HTMLElement | null): void {
  if (!host) return;
  const state = host.getState();
  openSaveCapturedPathDialog(slicePathToIndex(state, state.cursor), opener);
}

export function openRenameDialog(trail: SavedTrail, opener: HTMLElement | null): void {
  if (!host) return;
  const client = host.client;
  openNameDialog({
    title: "Rename saved trail",
    summary: `${pagesLabel(trail.entries.length)} · current name “${trail.name}”`,
    initialName: trail.name,
    submitLabel: "Rename",
    pendingLabel: "Renaming…",
    opener,
    closeLibrary: false,
    trailId: trail.id,
    submit: (name) => client.rename(trail.id, name),
    successMessage: (renamed) => `Renamed to “${renamed.name}”`,
  });
}

export function openUpdateDialog(trail: SavedTrail, opener: HTMLElement | null): void {
  if (!host) return;
  const client = host.client;
  const path = currentCapturedPath();
  if (!path || path.length === 0) {
    host.showNotice("The current trail has no path to save", { tone: "error" });
    return;
  }
  const oldEndpoint = savedTrailEndpoint(trail);
  const newEndpoint = path[path.length - 1];
  openMutationDialog({
    shell: {
      idPrefix: "tabtrail-update-dialog",
      title: `Update “${trail.name}”?`,
      summary:
        `${pagesLabel(trail.entries.length)} ending at “${oldEndpoint ? entryTitle(oldEndpoint) : "Unknown"}” ` +
        `will become ${pagesLabel(path.length)} ending at “${entryTitle(newEndpoint)}”.`,
      submitLabel: "Replace path",
      pendingLabel: "Updating…",
    },
    opener,
    trailId: trail.id,
    failureMessage: "Could not update trail",
    submit: () => client.replace(trail.id, path, trail.entries),
    onSuccess: (result, boundHost, originSession) => {
      const previousTrail = result.previousTrail;
      if (!previousTrail) {
        boundHost.showNotice("Could not read the previous trail path", { tone: "error" });
        return;
      }
      if (savedTrailEntriesEqual(previousTrail.entries, result.trail.entries)) {
        boundHost.showNotice(`“${result.trail.name}” already matches the current path`);
        return;
      }
      offerUpdateUndo(boundHost, result.trail, previousTrail, originSession);
    },
  });
}

export function offerUpdateUndo(
  boundHost: SavedTrailsHost,
  updated: SavedTrail,
  previous: SavedTrail,
  originSession: LibrarySession | null,
): void {
  boundHost.showNotice(`Updated “${updated.name}”`, {
    actionLabel: "Undo",
    durationMs: UNDO_DURATION_MS,
    undo: true,
    action: async () => {
      const mutationGeneration = originSession?.loadRequest;
      try {
        const reverted = await boundHost.client.replace(
          updated.id,
          previous.entries,
          updated.entries,
        );
        if (host !== boundHost) return;
        if (!reverted.ok) {
          boundHost.showNotice(reverted.reason, { tone: "error", durationMs: 6000 });
          return;
        }
        acceptAuthoritativeTrails(reverted.trails, originSession, mutationGeneration);
        boundHost.showNotice(`Restored the previous path for “${reverted.trail.name}”`);
      } catch (_) {
        if (host !== boundHost) return;
        boundHost.showNotice("Could not undo the update", { tone: "error", durationMs: 6000 });
      }
    },
  });
}
