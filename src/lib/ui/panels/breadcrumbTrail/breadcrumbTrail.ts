// Compact vertical branch overlay showing the tab's navigation trail. Built
// on the shared Shadow DOM panel host so it stays isolated from page styles,
// but deliberately NON-modal. Saved-trails library/name/tree UI lives in
// savedTrailsPanel.ts; this file hosts the live bar, row menus, and wiring.

import styles from "./breadcrumbTrail.css";
import savedTrailStyles from "./savedTrailsPanel.css";
import {
  browserSavedTrailsClient,
  type SavedTrailsClient,
} from "../../../adapters/runtime/savedTrailsClient";
import {
  createPanelHost,
  dismissPanel,
  getBaseStyles,
  registerPanelCleanup,
} from "../../../common/utils/panelHost";
import { formatTrailTimestamp } from "../../../core/trail/trailCore";
import { showContextMenu } from "./contextMenu";
import { scheduleFocusWhenIdle } from "./focusRestore";
import { installOverlayInteractionShield } from "./interactionShield";
import {
  clearLiveNotices,
  showLiveNotice,
  type LiveNoticeHost,
} from "./liveTrailNotices";
import {
  createLiveTrailPreview,
  type LiveTrailPreviewController,
} from "./liveTrailPreview";
import {
  closeAllOverlaySurfaces,
  closeOverlaySurface,
  closeTopOverlaySurface,
  dropOverlaySurface,
  isOverlaySurfaceBlockingLiveRender,
  pushOverlaySurface,
} from "./overlaySurfaces";
import {
  bindSavedTrailsHost,
  openSaveTrailDialog,
  toggleSavedTrailsLibrary,
  unbindSavedTrailsHost,
} from "./savedTrailsPanel";
import type { SavedTrailsNoticeOptions } from "./savedTrailsPanel";
import {
  branchConnectorElement,
  entryTitle,
  entryUrlSubtitle,
} from "./trailPresentation";

export interface BreadcrumbTrailCallbacks {
  onJump(index: number): void;
  onOpenInNewTab(index: number): void;
  onOpenInNewWindow(index: number): void;
  onOpenOptions(): void;
  onClose(): void;
  onPositionChange(position: TabTrailOverlayPosition): void;
}

export interface BreadcrumbTrailOptions {
  settings: TabTrailSettings;
  callbacks: BreadcrumbTrailCallbacks;
  /** Persistence/navigation gateway; injectable for isolated rendering hosts. */
  savedTrailsClient?: SavedTrailsClient;
}

const DEFAULT_POSITION: TabTrailOverlayPosition = { xPercent: 50, yPercent: 8 };

interface OverlaySession extends LiveNoticeHost {
  options: BreadcrumbTrailOptions;
  state: TrailState;
  expanded: boolean;
  position: TabTrailOverlayPosition;
  liveRenderPending: boolean;
  preview: LiveTrailPreviewController;
}

let session: OverlaySession | null = null;
let mainDragStop: (() => void) | null = null;
let liveMenuTrigger: HTMLElement | null = null;
let liveMenuIndex: number | null = null;

export function isBreadcrumbTrailOpen(): boolean {
  return session !== null;
}

export function hideBreadcrumbTrail(): void {
  if (!session) return;
  dismissPanel();
}

export function updateBreadcrumbTrail(state: TrailState): void {
  if (!session) return;
  const previous = session.state;
  session.state = state;
  if (isOverlaySurfaceBlockingLiveRender()) {
    session.liveRenderPending = true;
    setLiveInteractionBlocked(true);
    return;
  }
  if (canPatchLiveTrail(previous, state, session)) {
    patchLiveTrail(previous, state);
    return;
  }
  renderBar();
}

export function updateBreadcrumbTrailSettings(settings: TabTrailSettings): void {
  if (!session) return;
  const visibleRowsChanged =
    session.options.settings.maxVisibleSegments !== settings.maxVisibleSegments;
  session.options.settings = settings;
  if (!visibleRowsChanged) return;
  if (isOverlaySurfaceBlockingLiveRender()) {
    session.liveRenderPending = true;
    setLiveInteractionBlocked(true);
    return;
  }
  renderBar();
}

export function showBreadcrumbTrail(state: TrailState, options: BreadcrumbTrailOptions): void {
  const { host, shadow } = createPanelHost();
  const removeInteractionShield = installOverlayInteractionShield(shadow);
  host.style.pointerEvents = "none";

  const style = document.createElement("style");
  style.textContent = getBaseStyles() + styles + savedTrailStyles;
  shadow.appendChild(style);

  const layer = document.createElement("div");
  layer.className = "wf-layer";
  shadow.appendChild(layer);

  const bar = document.createElement("div");
  bar.className = "wf-bar";
  bar.dataset.tabtrailHitSurface = "";
  bar.dataset.tabtrailWheelSurface = "";
  bar.setAttribute("role", "navigation");
  bar.setAttribute("aria-label", "Navigation trail");
  layer.appendChild(bar);

  const noticeStack = document.createElement("div");
  noticeStack.className = "wf-notice-stack";
  noticeStack.dataset.tabtrailWheelSurface = "";
  noticeStack.dataset.tabtrailScrollRegion = "";
  layer.appendChild(noticeStack);

  const preview = createLiveTrailPreview(
    () => session?.layer ?? null,
    () => session?.bar ?? null,
  );

  session = {
    shadow,
    bar,
    layer,
    options,
    state,
    expanded: false,
    position: options.settings.overlayPosition ?? DEFAULT_POSITION,
    noticeStack,
    statusNoticeCleanup: null,
    undoNoticeCleanups: new Set(),
    liveRenderPending: false,
    preview,
  };

  bindSavedTrailsHost({
    layer,
    bar,
    client: options.savedTrailsClient ?? browserSavedTrailsClient,
    getState: () => session?.state ?? { entries: [], cursor: -1 },
    showNotice,
    hideTrail: hideBreadcrumbTrail,
    closeLiveSurfaces: () => {
      closeOverlaySurface("menu");
      preview.close();
    },
    flushLiveTrailUpdates: () => {
      queueMicrotask(() => {
        if (!session?.liveRenderPending || isOverlaySurfaceBlockingLiveRender()) return;
        renderBar();
      });
    },
    restoreLiveFocus,
    setLiveInteractionBlocked,
  });

  applyPosition();
  renderBar();

  const onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !session) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (closeTopOverlaySurface()) return;
    if (session.preview.isOpen()) {
      session.preview.close(true);
      return;
    }
    hideBreadcrumbTrail();
  };
  document.addEventListener("keydown", onDocumentKeydown, true);

  registerPanelCleanup(() => {
    document.removeEventListener("keydown", onDocumentKeydown, true);
    mainDragStop?.();
    mainDragStop = null;
    removeInteractionShield();
    clearLiveNotices(session);
    closeAllOverlaySurfaces();
    session?.preview.close();
    unbindSavedTrailsHost();
    const closing = session;
    session = null;
    liveMenuTrigger = null;
    liveMenuIndex = null;
    closing?.options.callbacks.onClose();
  });
}

function showNotice(message: string, options: SavedTrailsNoticeOptions = {}): void {
  if (!session) return;
  const noticeHost = session;
  showLiveNotice(noticeHost, () => session === noticeHost, message, options);
}

function applyPosition(): void {
  if (!session) return;
  const { xPercent, yPercent } = session.position;
  session.bar.style.left = `${xPercent}%`;
  session.bar.style.top = `${yPercent}%`;
  session.preview.reposition();
}

function setLiveInteractionBlocked(blocked: boolean): void {
  if (!session) return;
  session.bar.inert = blocked;
  session.bar.classList.toggle("wf-bar-blocked", blocked);
  if (blocked) session.bar.setAttribute("aria-disabled", "true");
  else session.bar.removeAttribute("aria-disabled");
}

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
    if (!session) return null;
    let target: HTMLElement | null = null;
    if (identity) {
      const candidates = session.bar.querySelectorAll<HTMLElement>(
        `[data-live-control="${identity.control}"]`,
      );
      target = [...candidates].find(
        (candidate) => !identity.entryKey || candidate.dataset.liveEntryKey === identity.entryKey,
      ) ?? null;
      if (!target) {
        target = session.bar.querySelector<HTMLElement>("[data-live-control=library]");
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
  current: OverlaySession,
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
  if (!session) return;
  session.liveRenderPending = false;
  setLiveInteractionBlocked(isOverlaySurfaceBlockingLiveRender());
  const rows = session.bar.querySelectorAll<HTMLElement>(".wf-branch-row[data-trail-index]");
  for (const row of rows) {
    const index = Number(row.dataset.trailIndex);
    if (!Number.isInteger(index) || index < 0 || index >= next.entries.length) continue;
    const entry = next.entries[index];
    const previousEntry = previous.entries[index];
    const main = row.querySelector<HTMLElement>(".wf-branch-row-main");
    if (main) main.dataset.liveEntryKey = liveEntryKey(entry);
    const more = row.querySelector<HTMLElement>(".wf-row-more");
    if (more) more.dataset.liveEntryKey = liveEntryKey(entry);
    session.preview.update(row, entry);
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
  if (!session) return;
  setLiveInteractionBlocked(isOverlaySurfaceBlockingLiveRender());
  session.liveRenderPending = false;
  const { bar, state, options } = session;
  const { settings, callbacks } = options;
  const activeLiveControl = session.shadow.activeElement instanceof HTMLElement
    ? session.shadow.activeElement
    : null;
  const menuReturnFocus = liveMenuTrigger;
  const previewReturnFocus = session.preview.focusedReturnTarget();
  closeOverlaySurface("menu");
  session.preview.close();
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

  const indices = visibleIndices(state, settings.maxVisibleSegments, session.expanded);
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

  if (session.expanded && state.entries.length > settings.maxVisibleSegments) {
    branchList.appendChild(buildCollapsePill());
  }
}

function buildBranchHeader(callbacks: BreadcrumbTrailCallbacks): HTMLDivElement {
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
  grip.addEventListener("pointerdown", startDrag);
  return grip;
}

function buildSettingsButton(callbacks: BreadcrumbTrailCallbacks): HTMLElement {
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
  close.addEventListener("click", () => hideBreadcrumbTrail());
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
    if (!session) return;
    session.expanded = true;
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
    if (!session) return;
    session.expanded = false;
    renderBar();
    focusLiveControlWhenIdle("expand");
  });
  return pill;
}

function buildBranchRow(
  index: number,
  state: TrailState,
  callbacks: BreadcrumbTrailCallbacks,
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
    const focusOnOpen = session?.shadow.activeElement instanceof HTMLElement &&
      row.contains(session.shadow.activeElement);
    openEntryMenu(row, index, callbacks, more, focusOnOpen);
  });
  return row;
}

function buildRowMoreButton(
  anchor: HTMLElement,
  index: number,
  entry: TrailEntry,
  callbacks: BreadcrumbTrailCallbacks,
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
  callbacks: BreadcrumbTrailCallbacks,
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
  callbacks: BreadcrumbTrailCallbacks,
  trigger: HTMLElement,
  focusOnOpen: boolean,
): void {
  if (!session) return;
  const entry = session.state.entries[index];
  if (!entry) return;
  closeOverlaySurface("menu");

  let closed = false;
  liveMenuTrigger = trigger;
  liveMenuIndex = index;
  const menuSession = session;
  const currentEntry = (): TrailEntry | null => {
    if (session !== menuSession) return null;
    return menuSession.state.entries[index] ?? null;
  };
  const handle = showContextMenu({
    layer: session.layer,
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
            () => callbacks.onOpenInNewTab(index),
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
  if (!session) return;
  const menu = session.layer.querySelector<HTMLElement>(".wf-menu[data-live-trail-index]");
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

// --- Main bar drag (percent position, persisted) ---

function startDrag(event: PointerEvent): void {
  if (!session) return;
  mainDragStop?.();
  mainDragStop = null;
  event.preventDefault();
  const dragSession = session;
  const { bar } = dragSession;
  const captureTarget = event.currentTarget instanceof HTMLElement ? event.currentTarget : bar;
  const pointerId = event.pointerId;
  try {
    captureTarget.setPointerCapture(pointerId);
  } catch (_) {
    // Synthetic events and older engines can lack an active pointer capture.
  }
  const barRect = bar.getBoundingClientRect();
  const grabOffsetX = event.clientX - (barRect.left + barRect.width / 2);
  const grabOffsetY = event.clientY - barRect.top;
  bar.classList.add("wf-dragging");

  const onMove = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== pointerId) return;
    if (session !== dragSession) return;
    const x = ((moveEvent.clientX - grabOffsetX) / window.innerWidth) * 100;
    const y = ((moveEvent.clientY - grabOffsetY) / window.innerHeight) * 100;
    dragSession.position = {
      xPercent: Math.min(Math.max(x, 0), 100),
      yPercent: Math.min(Math.max(y, 0), 96),
    };
    applyPosition();
  };

  let stopped = false;
  const finish = (persist: boolean): void => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onPointerEnd, true);
    window.removeEventListener("pointercancel", onPointerEnd, true);
    try {
      if (captureTarget.hasPointerCapture(pointerId)) {
        captureTarget.releasePointerCapture(pointerId);
      }
    } catch (_) {
      // Pointer capture may already be released if the overlay was removed.
    }
    bar.classList.remove("wf-dragging");
    if (mainDragStop === cancel) mainDragStop = null;
    if (persist && session === dragSession) {
      dragSession.options.callbacks.onPositionChange(dragSession.position);
    }
  };
  const onPointerEnd = (endEvent: PointerEvent): void => {
    if (endEvent.pointerId === pointerId) finish(true);
  };
  const cancel = (): void => finish(false);
  mainDragStop = cancel;

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onPointerEnd, true);
  window.addEventListener("pointercancel", onPointerEnd, true);
}
