// Live trail bar rendering, topology-aware patch, and row context menus.
// Session lifecycle (open/hide/update routing) stays in breadcrumbTrail.ts.

import { formatTrailTimestamp } from "../../../core/trail/trailCore";
import { showContextMenu } from "./contextMenu";
import { scheduleFocusWhenIdle } from "./focusRestore";
import type { LiveTrailPreviewController } from "./liveTrailPreview";
import {
  closeOverlaySurface,
  dropOverlaySurface,
  isOverlaySurfaceBlockingLiveRender,
  pushOverlaySurface,
} from "./overlaySurfaces";
import { openSaveTrailDialog, toggleSavedTrailsLibrary } from "./savedTrailsPanel";
import {
  branchConnectorElement,
  entryTitle,
  entryUrlSubtitle,
} from "./trailPresentation";
export interface LiveTrailBarCallbacks {
  onJump(index: number): void;
  onOpenInNewTab(index: number): void;
  onOpenInNewWindow(index: number): void;
  onOpenOptions(): void;
  onClose(): void;
  onPositionChange(position: TabTrailOverlayPosition): void;
}

export interface LiveTrailBarOptions {
  settings: TabTrailSettings;
  callbacks: LiveTrailBarCallbacks;
}

export interface LiveTrailBarSession {
  shadow: ShadowRoot;
  bar: HTMLElement;
  layer: HTMLElement;
  options: LiveTrailBarOptions;
  state: TrailState;
  expanded: boolean;
  preview: LiveTrailPreviewController;
  liveRenderPending: boolean;
}

export interface LiveTrailBarDeps {
  getSession: () => LiveTrailBarSession | null;
  setLiveInteractionBlocked: (blocked: boolean) => void;
  hideTrail: () => void;
  startDrag: (event: PointerEvent) => void;
}

export interface LiveTrailBarController {
  restoreLiveFocus(opener: HTMLElement | null): void;
  canPatchLiveTrail(previous: TrailState, next: TrailState, current: LiveTrailBarSession): boolean;
  patchLiveTrail(previous: TrailState, next: TrailState): void;
  renderBar(): void;
  clearMenuState(): void;
}

export function createLiveTrailBar(deps: LiveTrailBarDeps): LiveTrailBarController {
  let liveMenuTrigger: HTMLElement | null = null;
  let liveMenuIndex: number | null = null;

  interface LiveFocusIdentity {
    control: string;
    entryKey?: string;
  }

  function liveEntryKey(entry: TrailEntry): string {
    return `${entry.timestamp}:${entry.url}`;
  }

  function liveFocusIdentity(opener: HTMLElement | null): LiveFocusIdentity | null {
    const control = opener?.dataset.liveControl;
    if (!control) return null;
    return { control, entryKey: opener.dataset.liveEntryKey };
  }

  function restoreLiveFocus(opener: HTMLElement | null): void {
    const identity = liveFocusIdentity(opener);
    scheduleFocusWhenIdle(() => {
      if (!deps.getSession()) return null;
      let target: HTMLElement | null = null;
      if (identity) {
        const candidates = deps.getSession()!.bar.querySelectorAll<HTMLElement>(
          `[data-live-control="${identity.control}"]`,
        );
        target = [...candidates].find(
          (candidate) => !identity.entryKey || candidate.dataset.liveEntryKey === identity.entryKey,
        ) ?? null;
        if (!target) {
          target = deps.getSession()!.bar.querySelector<HTMLElement>("[data-live-control=library]");
        }
      } else if (opener?.isConnected) {
        target = opener;
      }
      return target;
    });
  }

  function focusLiveControlWhenIdle(control: string): void {
    const marker = document.createElement("span");
    marker.dataset.liveControl = control;
    restoreLiveFocus(marker);
  }

  // --- Topology-aware patch vs full rebuild ---

  function visibleIndices(state: TrailState, maxVisible: number, expanded: boolean): number[] {
    const total = state.entries.length;
    if (expanded || total <= maxVisible) {
      return state.entries.map((_, index) => index);
    }
    const budget = Math.min(Math.max(1, maxVisible), total);
    const selected = new Set<number>([0]);
    const addIndex = (index: number): void => {
      if (selected.size >= budget) return;
      if (index < 0 || index >= total) return;
      selected.add(index);
    };

    addIndex(state.cursor);
    addIndex(total - 1);

    for (let distance = 1; selected.size < budget && distance < total; distance += 1) {
      addIndex(state.cursor - distance);
      addIndex(state.cursor + distance);
    }

    return [...selected].sort((a, b) => a - b);
  }

  function trailStructureKey(state: TrailState): string {
    return state.entries
      .map((entry) => `${entry.url}\0${entry.historyBacked ? 1 : 0}\0${entry.redirected ? 1 : 0}`)
      .join("\n");
  }

  function canPatchLiveTrail(
    previous: TrailState,
    next: TrailState,
    current: LiveTrailBarSession,
  ): boolean {
    // Cursor/structure changes rebuild (current row is div vs button). Same
    // topology with title/url/timestamp metadata can patch in place.
    if (previous.cursor !== next.cursor) return false;
    if (trailStructureKey(previous) !== trailStructureKey(next)) return false;
    const maxVisible = current.options.settings.maxVisibleSegments;
    const prevVisible = visibleIndices(previous, maxVisible, current.expanded).join(",");
    const nextVisible = visibleIndices(next, maxVisible, current.expanded).join(",");
    return prevVisible === nextVisible;
  }

  function forkIndexFor(state: TrailState): number {
    return state.entries.reduce(
      (latest, entry, index) => index > 0 && !entry.historyBacked ? index : latest,
      -1,
    );
  }

  /** Metadata-only live update. Structural/cursor changes always take renderBar(). */
  function patchLiveTrail(previous: TrailState, next: TrailState): void {
    if (!deps.getSession()) return;
    deps.getSession()!.liveRenderPending = false;
    deps.setLiveInteractionBlocked(isOverlaySurfaceBlockingLiveRender());
    const rows = deps.getSession()!.bar.querySelectorAll<HTMLElement>(".wf-branch-row[data-trail-index]");
    for (const row of rows) {
      const index = Number(row.dataset.trailIndex);
      if (!Number.isInteger(index) || index < 0 || index >= next.entries.length) continue;
      const entry = next.entries[index];
      const previousEntry = previous.entries[index];
      const main = row.querySelector<HTMLElement>(".wf-branch-row-main");
      if (main) main.dataset.liveEntryKey = liveEntryKey(entry);
      const more = row.querySelector<HTMLElement>(".wf-row-more");
      if (more) more.dataset.liveEntryKey = liveEntryKey(entry);
      deps.getSession()!.preview.update(row, entry);
      if (liveMenuIndex === index) patchLiveMenuDetail(entry);

      if (
        !previousEntry ||
        previousEntry.title !== entry.title ||
        previousEntry.url !== entry.url
      ) {
        const title = row.querySelector(".wf-branch-entry-title");
        const url = row.querySelector(".wf-branch-entry-url");
        if (title) title.textContent = entryTitle(entry);
        if (url) url.textContent = entryUrlSubtitle(entry);
        // Fork rows embed the entry title in aria-label; refresh when title changes.
        if (main?.hasAttribute("aria-label")) {
          const isCurrent = index === next.cursor;
          main.setAttribute(
            "aria-label",
            isCurrent
              ? `${entryTitle(entry)}. Current page. Direct-navigation boundary; earlier pages are outside native browser history.`
              : `${entryTitle(entry)}. Direct-navigation boundary; selecting this page navigates directly.`,
          );
        }
      }
    }
  }

  // --- Full render ---

  function renderBar(): void {
    if (!deps.getSession()) return;
    deps.setLiveInteractionBlocked(isOverlaySurfaceBlockingLiveRender());
    deps.getSession()!.liveRenderPending = false;
    const { bar, state, options } = deps.getSession()!;
    const { settings, callbacks } = options;
    const activeElement = deps.getSession()!.shadow.activeElement;
    const activeLiveControl = activeElement instanceof HTMLElement ? activeElement : null;
    const menuReturnFocus = liveMenuTrigger;
    const previewReturnFocus = deps.getSession()!.preview.focusedReturnTarget();
    closeOverlaySurface("menu");
    deps.getSession()!.preview.close();
    if (activeLiveControl?.dataset.liveControl) restoreLiveFocus(activeLiveControl);
    if (menuReturnFocus) restoreLiveFocus(menuReturnFocus);
    if (previewReturnFocus) restoreLiveFocus(previewReturnFocus);
    bar.textContent = "";

    bar.appendChild(buildBranchHeader(callbacks));
    const branchList = buildBranchList();
    bar.appendChild(branchList);

    if (state.entries.length === 0) {
      const empty = document.createElement("span");
      empty.className = "wf-empty";
      empty.textContent = "No trail yet. Start clicking links to build one.";
      branchList.appendChild(empty);
      return;
    }

    const indices = visibleIndices(state, settings.maxVisibleSegments, deps.getSession()!.expanded);
    const forkIndex = forkIndexFor(state);
    let previousRendered: number | null = null;
    for (const index of indices) {
      if (previousRendered !== null) {
        if (index > previousRendered + 1) {
          const firstHiddenIndex = previousRendered + 1;
          branchList.appendChild(branchConnectorElement(state.entries[firstHiddenIndex]));
          branchList.appendChild(buildMorePill(index - previousRendered - 1));
        }
        branchList.appendChild(branchConnectorElement(state.entries[index]));
      }
      branchList.appendChild(buildBranchRow(index, state, callbacks, index === forkIndex));
      previousRendered = index;
    }

    if (deps.getSession()!.expanded && state.entries.length > settings.maxVisibleSegments) {
      branchList.appendChild(buildCollapsePill());
    }
  }

  function buildBranchHeader(callbacks: LiveTrailBarCallbacks): HTMLDivElement {
    const header = document.createElement("div");
    header.className = "wf-branch-header";

    const leftChrome = document.createElement("div");
    leftChrome.className = "wf-header-left";
    leftChrome.appendChild(buildSettingsButton(callbacks));
    leftChrome.appendChild(buildLibraryButton());
    header.appendChild(leftChrome);

    const title = document.createElement("span");
    title.className = "wf-branch-title";
    title.textContent = "In-Page Trail";
    header.appendChild(title);
    header.appendChild(buildGrip());
    header.appendChild(buildCloseButton());
    return header;
  }

  function buildBranchList(): HTMLDivElement {
    const branchList = document.createElement("div");
    branchList.className = "wf-branch-list";
    branchList.dataset.tabtrailScrollRegion = "";
    return branchList;
  }

  function buildGrip(): HTMLElement {
    const grip = document.createElement("span");
    grip.className = "wf-grip";
    grip.textContent = "⠿";
    grip.title = "Drag to move";
    grip.setAttribute("aria-hidden", "true");
    grip.addEventListener("pointerdown", deps.startDrag);
    return grip;
  }

  function buildSettingsButton(callbacks: LiveTrailBarCallbacks): HTMLElement {
    const settings = document.createElement("button");
    settings.className = "wf-settings";
    settings.type = "button";
    settings.textContent = "⚙";
    settings.title = "Open settings";
    settings.setAttribute("aria-label", "Open settings");
    settings.dataset.liveControl = "settings";
    settings.addEventListener("click", () => callbacks.onOpenOptions());
    return settings;
  }

  function buildLibraryButton(): HTMLElement {
    const library = document.createElement("button");
    library.className = "wf-library";
    library.type = "button";
    library.textContent = "☰";
    library.title = "Saved trails";
    library.setAttribute("aria-label", "Saved trails");
    library.setAttribute("aria-haspopup", "dialog");
    library.setAttribute("aria-expanded", "false");
    library.dataset.liveControl = "library";
    library.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleSavedTrailsLibrary();
    });
    return library;
  }

  function buildCloseButton(): HTMLElement {
    const close = document.createElement("button");
    close.className = "wf-close";
    close.type = "button";
    close.textContent = "✕";
    close.title = "Hide (Esc)";
    close.setAttribute("aria-label", "Hide trail");
    close.dataset.liveControl = "close";
    close.addEventListener("click", () => deps.hideTrail());
    return close;
  }

  function buildMorePill(hiddenCount: number): HTMLElement {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "wf-more";
    pill.dataset.liveControl = "expand";
    pill.textContent = `+${hiddenCount} more`;
    pill.title = "Show the full trail";
    pill.addEventListener("click", () => {
      if (!deps.getSession()) return;
      deps.getSession()!.expanded = true;
      renderBar();
      focusLiveControlWhenIdle("collapse");
    });
    return pill;
  }

  function buildCollapsePill(): HTMLElement {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "wf-more wf-more-collapse";
    pill.dataset.liveControl = "collapse";
    pill.textContent = "Show less";
    pill.title = "Collapse the trail";
    pill.addEventListener("click", () => {
      if (!deps.getSession()) return;
      deps.getSession()!.expanded = false;
      renderBar();
      focusLiveControlWhenIdle("expand");
    });
    return pill;
  }

  function buildBranchRow(
    index: number,
    state: TrailState,
    callbacks: LiveTrailBarCallbacks,
    isFork: boolean,
  ): HTMLElement {
    const entry = state.entries[index];
    const isCurrent = index === state.cursor;
    const row = document.createElement("div");
    row.className = "wf-branch-row";
    row.dataset.trailIndex = String(index);
    if (isCurrent) row.classList.add("wf-branch-row-current");
    if (index > state.cursor) row.classList.add("wf-branch-row-forward");
    if (isFork) {
      row.classList.add("wf-branch-row-fork");
      row.title = "Direct-navigation boundary — earlier pages are outside native browser history";
    }

    const main = document.createElement(isCurrent ? "div" : "button");
    if (!isCurrent) (main as HTMLButtonElement).type = "button";
    main.className = "wf-branch-row-main";
    main.dataset.liveControl = "row-main";
    main.dataset.liveEntryKey = liveEntryKey(entry);
    if (isCurrent) {
      main.setAttribute("role", "group");
      main.setAttribute("aria-current", "page");
    }
    if (isFork) {
      main.setAttribute(
        "aria-label",
        isCurrent
          ? `${entryTitle(entry)}. Current page. Direct-navigation boundary; earlier pages are outside native browser history.`
          : `${entryTitle(entry)}. Direct-navigation boundary; selecting this page navigates directly.`,
      );
    }

    const node = document.createElement("span");
    node.className = "wf-branch-node";
    node.setAttribute("aria-hidden", "true");
    main.appendChild(node);

    const content = document.createElement("div");
    content.className = "wf-branch-entry";

    const title = document.createElement("span");
    title.className = "wf-branch-entry-title";
    title.textContent = entryTitle(entry);
    content.appendChild(title);

    const url = document.createElement("span");
    url.className = "wf-branch-entry-url";
    url.textContent = entryUrlSubtitle(entry);
    content.appendChild(url);

    main.appendChild(content);
    row.appendChild(main);
    const more = buildRowMoreButton(row, index, entry, callbacks);
    row.appendChild(more);

    if (!isCurrent) {
      main.addEventListener("click", (event) => {
        event.preventDefault();
        callbacks.onJump(index);
      });
    }
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const focusOnOpen = deps.getSession()?.shadow.activeElement instanceof HTMLElement &&
        row.contains(deps.getSession()!.shadow.activeElement);
      openEntryMenu(row, index, callbacks, more, focusOnOpen);
    });
    return row;
  }

  function buildRowMoreButton(
    anchor: HTMLElement,
    index: number,
    entry: TrailEntry,
    callbacks: LiveTrailBarCallbacks,
  ): HTMLButtonElement {
    const more = document.createElement("button");
    more.className = "wf-row-more";
    more.type = "button";
    more.textContent = "⋯";
    more.title = "More";
    more.setAttribute("aria-label", "More options for this page");
    more.dataset.liveControl = "row-more";
    more.dataset.liveEntryKey = liveEntryKey(entry);
    more.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleEntryMenu(anchor, more, index, callbacks, event.detail === 0);
    });
    return more;
  }

  // --- Live row context menu ---

  function toggleEntryMenu(
    anchor: HTMLElement,
    trigger: HTMLElement,
    index: number,
    callbacks: LiveTrailBarCallbacks,
    focusOnOpen: boolean,
  ): void {
    if (liveMenuTrigger === trigger) {
      closeOverlaySurface("menu");
      return;
    }
    openEntryMenu(anchor, index, callbacks, trigger, focusOnOpen);
  }

  function openEntryMenu(
    anchor: HTMLElement,
    index: number,
    callbacks: LiveTrailBarCallbacks,
    trigger: HTMLElement,
    focusOnOpen: boolean,
  ): void {
    if (!deps.getSession()) return;
    const entry = deps.getSession()!.state.entries[index];
    if (!entry) return;
    closeOverlaySurface("menu");

    let closed = false;
    liveMenuTrigger = trigger;
    liveMenuIndex = index;
    const menuSession = deps.getSession()!;
    const currentEntry = (): TrailEntry | null => {
      if (deps.getSession() !== menuSession) return null;
      return menuSession.state.entries[index] ?? null;
    };
    const handle = showContextMenu({
      layer: deps.getSession()!.layer,
      anchor,
      trigger,
      detail: {
        title: entryTitle(entry),
        subtitle: entry.url,
        meta: `Visited ${formatTrailTimestamp(entry.timestamp, Date.now())}`,
      },
      items: [
        {
          label: "Preview",
          action: () => {
            const latest = currentEntry();
            if (!latest) return;
            menuSession.preview.open(
              anchor,
              latest,
              {
                onOpenInNewTab: () => callbacks.onOpenInNewTab(index),
                onJump: () => callbacks.onJump(index),
                onCopyUrl: () => {
                  const entry = currentEntry();
                  if (entry) void copyText(entry.url);
                },
              },
              trigger,
            );
          },
        },
        { label: "Open in new tab", action: () => callbacks.onOpenInNewTab(index) },
        { label: "Open in new window", action: () => callbacks.onOpenInNewWindow(index) },
        {
          label: "Copy URL",
          action: () => {
            const latest = currentEntry();
            if (latest) void copyText(latest.url);
          },
        },
        {
          label: "Save trail up to this point in path",
          action: () => openSaveTrailDialog(index, trigger),
        },
      ],
      focusOnOpen,
      onClose: () => {
        if (closed) return;
        closed = true;
        liveMenuTrigger = null;
        liveMenuIndex = null;
        dropOverlaySurface("menu");
      },
    });
    handle.element.dataset.liveTrailIndex = String(index);

    pushOverlaySurface("menu", () => {
      if (!closed) handle.close();
    });
  }

  function patchLiveMenuDetail(entry: TrailEntry): void {
    if (!deps.getSession()) return;
    const menu = deps.getSession()!.layer.querySelector<HTMLElement>(".wf-menu[data-live-trail-index]");
    if (!menu) return;
    const title = menu.querySelector<HTMLElement>(".wf-menu-detail-title");
    const subtitle = menu.querySelector<HTMLElement>(".wf-menu-detail-url");
    const meta = menu.querySelector<HTMLElement>(".wf-menu-detail-time");
    if (title) title.textContent = entryTitle(entry);
    if (subtitle) subtitle.textContent = entry.url;
    if (meta) meta.textContent = `Visited ${formatTrailTimestamp(entry.timestamp, Date.now())}`;
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_) {
      // Clipboard API can be unavailable in content scripts; fall back below.
    }
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
    document.body.appendChild(scratch);
    scratch.select();
    try {
      document.execCommand("copy");
    } finally {
      scratch.remove();
    }
  }


  return {
    restoreLiveFocus,
    canPatchLiveTrail,
    patchLiveTrail,
    renderBar,
    clearMenuState: () => {
      liveMenuTrigger = null;
      liveMenuIndex = null;
    },
  };
}
