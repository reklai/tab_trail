// Saved-trails UI session state. Feature modules read/write through the
// active controller bound by bindSavedTrailsHost. The isolated overlay frame
// owns one document-lifetime controller so pending mutations survive hibernate.

import type { SavedTrailsClient } from "../../../adapters/runtime/savedTrailsClient";
import { normalizeSavedTrails, slicePathToIndex } from "../../../core/trail/trailCore";
import { scheduleFocusWhenIdle as focusWhenIdle } from "./focusRestore";
import {
  closeOverlaySurface,
  isOverlaySurfaceBlockingLiveRender,
} from "./overlaySurfaces";

export const LIBRARY_PANEL_GAP = 10;
export const VIEWPORT_MARGIN = 12;
export const UNDO_DURATION_MS = 8000;

export const LIBRARY_EMPTY_COPY =
  "Open ⋯ on any page in your trail, then choose Save trail up to this point in path.";

export interface SavedTrailsNoticeOptions {
  tone?: "info" | "error";
  actionLabel?: string;
  action?: () => void | Promise<void>;
  durationMs?: number;
  /** Undo notices persist independently from one another and transient status. */
  undo?: boolean;
}

export interface SavedTrailsHost {
  layer: HTMLElement;
  bar: HTMLElement;
  client: SavedTrailsClient;
  getState: () => TrailState;
  showNotice: (message: string, options?: SavedTrailsNoticeOptions) => void;
  hideTrail: () => void;
  /** Close live-row surfaces (iframe preview, live menu) before library opens. */
  closeLiveSurfaces: () => void;
  /** Render the newest live state once a blocking saved-trail surface closes. */
  flushLiveTrailUpdates: () => void;
  /** Restore a live-bar opener after a deferred render may have replaced it. */
  restoreLiveFocus: (opener: HTMLElement | null) => void;
  /** Disable stale live-row actions while a blocking saved-trail surface is open. */
  setLiveInteractionBlocked: (blocked: boolean) => void;
}

export interface LibrarySession {
  host: SavedTrailsHost;
  panel: HTMLDivElement;
  list: HTMLDivElement;
  search: HTMLInputElement;
  count: HTMLSpanElement;
  trails: SavedTrail[];
  query: string;
  loadRequest: number;
  state: "loading" | "ready" | "error";
  opener: HTMLElement | null;
  restoreFocusOnClose: boolean;
  unsubscribe: () => void;
}

export type LibraryAction = "pin" | "more";

export interface LibraryFocusIdentity {
  trailId: string;
  action: LibraryAction;
}

/** Owns mutable saved-trails UI session state for one overlay document. */
export class SavedTrailsUiController {
  host: SavedTrailsHost | null = null;
  librarySession: LibrarySession | null = null;
  libraryDragStop: (() => void) | null = null;
  treePreviewElement: HTMLDivElement | null = null;
  readonly pendingTrailIds = new Set<string>();
  private readonly pendingTrailOwners = new Map<string, symbol>();
  private nextDialogId = 0;
  private renderLibraryImpl: ((session: LibrarySession) => void) | null = null;

  setHost(next: SavedTrailsHost | null): void {
    this.host = next;
  }

  setLibrarySession(next: LibrarySession | null): void {
    this.librarySession = next;
  }

  setLibraryDragStop(next: (() => void) | null): void {
    this.libraryDragStop = next;
  }

  setTreePreviewElement(next: HTMLDivElement | null): void {
    this.treePreviewElement = next;
  }

  allocateDialogId(): number {
    this.nextDialogId += 1;
    return this.nextDialogId;
  }

  /**
   * Library registers its renderer when the panel opens (not at import time),
   * so dialogs/mutations can refresh without importing the library module.
   */
  registerRenderLibrary(fn: (session: LibrarySession) => void): void {
    this.renderLibraryImpl = fn;
  }

  renderLibrary(session: LibrarySession): void {
    this.renderLibraryImpl?.(session);
  }

  beginTrailMutation(trailId: string): symbol | null {
    if (this.pendingTrailOwners.has(trailId)) return null;
    const owner = Symbol(trailId);
    this.pendingTrailOwners.set(trailId, owner);
    this.pendingTrailIds.add(trailId);
    return owner;
  }

  finishTrailMutation(trailId: string, owner: symbol): boolean {
    if (this.pendingTrailOwners.get(trailId) !== owner) return false;
    this.pendingTrailOwners.delete(trailId);
    this.pendingTrailIds.delete(trailId);
    return true;
  }

  clear(): void {
    this.libraryDragStop?.();
    this.libraryDragStop = null;
    this.librarySession = null;
    this.treePreviewElement = null;
    // Pending RPCs outlive a hibernated overlay. Their ownership must remain
    // registered until the operation itself settles so a reopened overlay
    // cannot start an overlapping mutation for the same saved trail.
    this.host = null;
  }
}

export function createSavedTrailsController(): SavedTrailsUiController {
  return new SavedTrailsUiController();
}

/** Controller bound while a saved-trails host is active (and between hibernate remounts). */
let activeController: SavedTrailsUiController | null = null;

export function activateSavedTrailsController(controller: SavedTrailsUiController): void {
  activeController = controller;
}

export function getSavedTrailsUi(): SavedTrailsUiController {
  if (!activeController) {
    activeController = createSavedTrailsController();
  }
  return activeController;
}

/**
 * Compatibility surface for feature modules. Prefer getSavedTrailsUi() in new
 * code; this alias keeps existing call sites readable while the owner is the
 * document-lifetime controller activated by bindSavedTrailsHost.
 */
export const savedTrailsUi: SavedTrailsUiController = new Proxy({} as SavedTrailsUiController, {
  get(_target, prop, receiver) {
    const ui = getSavedTrailsUi();
    const value = Reflect.get(ui, prop, ui);
    return typeof value === "function" ? value.bind(ui) : value;
  },
  set(_target, prop, value) {
    const ui = getSavedTrailsUi();
    return Reflect.set(ui, prop, value, ui);
  },
});

export function syncLiveInteraction(boundHost: SavedTrailsHost): void {
  boundHost.setLiveInteractionBlocked(isOverlaySurfaceBlockingLiveRender());
}

export function activeShadowElement(boundHost: SavedTrailsHost): HTMLElement | null {
  const root = boundHost.layer.getRootNode();
  if (!(root instanceof ShadowRoot)) return null;
  return root.activeElement instanceof HTMLElement ? root.activeElement : null;
}

export function restoreFocus(element: HTMLElement | null): void {
  focusWhenIdle(() => element);
}

export function libraryFocusIdentity(element: HTMLElement | null): LibraryFocusIdentity | null {
  const row = element?.closest<HTMLElement>(".wf-library-row");
  const action = element?.dataset.libraryAction ?? element?.dataset.libraryFocusAction;
  if (!row?.dataset.trailId || (action !== "pin" && action !== "more")) {
    return null;
  }
  return { trailId: row.dataset.trailId, action };
}

export function findTrailControl(
  trailId: string,
  action: LibraryAction = "more",
): HTMLElement | null {
  const session = savedTrailsUi.librarySession;
  if (!session) return null;
  const row = [...session.list.querySelectorAll<HTMLElement>(".wf-library-row")]
    .find((candidate) => candidate.dataset.trailId === trailId);
  return row?.querySelector<HTMLElement>(`[data-library-action="${action}"]`) ?? null;
}

export function libraryPrimaryControl(): HTMLElement | null {
  const session = savedTrailsUi.librarySession;
  if (!session) return null;
  return session.list.querySelector<HTMLElement>(
    ".wf-library-row .wf-row-more:not(:disabled), .wf-library-state-action:not(:disabled)",
  ) ?? session.search;
}

export function restoreLibraryFocus(
  identity: LibraryFocusIdentity | null,
  fallbackToLibrary = false,
): void {
  if (!identity) return;
  focusWhenIdle(() => {
    const exact = findTrailControl(identity.trailId, identity.action);
    if (exact && !exact.matches(":disabled")) return exact;
    const pendingRow = exact?.closest<HTMLElement>(".wf-library-row[aria-busy=\"true\"]");
    if (pendingRow) {
      pendingRow.dataset.libraryFocusAction = identity.action;
      return pendingRow;
    }
    return fallbackToLibrary ? libraryPrimaryControl() : null;
  });
}

export function restoreSurfaceFocus(
  boundHost: SavedTrailsHost,
  element: HTMLElement | null,
): void {
  const savedIdentity = libraryFocusIdentity(element);
  if (savedIdentity) {
    restoreLibraryFocus(savedIdentity, true);
    return;
  }
  if (element?.dataset.liveControl) {
    boundHost.restoreLiveFocus(element);
    return;
  }
  restoreFocus(element);
}

export function restoreLibraryPrimaryFocus(session: LibrarySession): void {
  focusWhenIdle(() => {
    if (savedTrailsUi.librarySession !== session) return null;
    return libraryPrimaryControl();
  });
}

export function acceptAuthoritativeTrails(
  trails: SavedTrail[],
  expectedSession?: LibrarySession | null,
  expectedGeneration?: number,
): void {
  const current = savedTrailsUi.librarySession;
  if (
    !current ||
    (expectedSession !== undefined && current !== expectedSession) ||
    (expectedGeneration !== undefined && current.loadRequest !== expectedGeneration)
  ) return;
  closeOverlaySurface("treePreview");
  current.trails = normalizeSavedTrails(trails);
  current.state = "ready";
  savedTrailsUi.renderLibrary(current);
}

export function currentCapturedPath(): TrailEntry[] | null {
  const bound = savedTrailsUi.host;
  if (!bound) return null;
  const state = bound.getState();
  return slicePathToIndex(state, state.cursor);
}
