// Compact vertical branch overlay showing the tab's navigation trail. Built
// on the shared Shadow DOM panel host so it stays isolated from page styles,
// but deliberately NON-modal. Saved-trails library/name/tree UI lives in
// savedTrailsPanel.ts; this file hosts the live bar, iframe preview, and menus.

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
import { clampInViewport, startFreePixelDrag } from "./freePixelDrag";
import { scheduleFocusWhenIdle } from "./focusRestore";
import { installOverlayInteractionShield } from "./interactionShield";
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
const PREVIEW_VIEWPORT_MARGIN = 12;
const PREVIEW_GAP = 12;
const PREVIEW_SIDE_MIN_WIDTH = 460;
const PREVIEW_DESKTOP_WIDTH = 640;
const PREVIEW_DESKTOP_HEIGHT = 520;

interface OverlaySession {
  shadow: ShadowRoot;
  bar: HTMLDivElement;
  layer: HTMLDivElement;
  options: BreadcrumbTrailOptions;
  state: TrailState;
  expanded: boolean;
  position: TabTrailOverlayPosition;
  noticeStack: HTMLDivElement;
  statusNoticeCleanup: (() => void) | null;
  undoNoticeCleanups: Set<() => void>;
  liveRenderPending: boolean;
}

let session: OverlaySession | null = null;
let mainDragStop: (() => void) | null = null;

export function isBreadcrumbTrailOpen(): boolean {
  return session !== null;
}

export function hideBreadcrumbTrail(): void {
  if (!session) return;
  dismissPanel();
}

export function updateBreadcrumbTrail(state: TrailState): void {
  if (!session) return;
  session.state = state;
  if (isOverlaySurfaceBlockingLiveRender()) {
    session.liveRenderPending = true;
    setLiveInteractionBlocked(true);
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
      closeEntryPreview();
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
    if (previewElement) {
      closeEntryPreview(true);
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
    session?.statusNoticeCleanup?.();
    for (const cleanup of session?.undoNoticeCleanups ?? []) cleanup();
    closeAllOverlaySurfaces();
    closeEntryPreview();
    unbindSavedTrailsHost();
    const closing = session;
    session = null;
    closing?.options.callbacks.onClose();
  });
}

function applyPosition(): void {
  if (!session) return;
  const { xPercent, yPercent } = session.position;
  session.bar.style.left = `${xPercent}%`;
  session.bar.style.top = `${yPercent}%`;
  if (previewElement) positionPreviewPane(previewElement);
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

// --- Rendering ---

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
  const previewReturn = previewElement ? previewReturnFocus : null;
  closeOverlaySurface("menu");
  closeEntryPreview();
  if (activeLiveControl?.dataset.liveControl) restoreLiveFocus(activeLiveControl);
  if (menuReturnFocus) restoreLiveFocus(menuReturnFocus);
  if (previewReturn) restoreLiveFocus(previewReturn);
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
  const forkIndex = state.entries.reduce(
    (latest, entry, index) => index > 0 && !entry.historyBacked ? index : latest,
    -1,
  );
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

function restoreFocusAfterNotice(noticeSession: OverlaySession): void {
  scheduleFocusWhenIdle(() => {
    if (session !== noticeSession) return null;
    const target =
      noticeSession.noticeStack.querySelector<HTMLElement>(".wf-notice-action:not(:disabled)") ??
      noticeSession.layer.querySelector<HTMLElement>(".wf-library-search") ??
      noticeSession.layer.querySelector<HTMLElement>(".wf-library-row .wf-row-more") ??
      noticeSession.bar.querySelector<HTMLElement>("[data-live-control=library]");
    return target;
  });
}

function showNotice(message: string, options: SavedTrailsNoticeOptions = {}): void {
  if (!session) return;
  const noticeSession = session;
  const undoLane = options.undo === true;
  if (!undoLane) noticeSession.statusNoticeCleanup?.();

  const notice = document.createElement("div");
  notice.className = `wf-notice wf-notice-${options.tone ?? "info"} ${
    undoLane ? "wf-notice-undo" : "wf-notice-status"
  }`;
  notice.dataset.tabtrailHitSurface = "";
  notice.setAttribute("role", options.tone === "error" ? "alert" : "status");
  notice.setAttribute("aria-live", options.tone === "error" ? "assertive" : "polite");

  const copy = document.createElement("span");
  copy.className = "wf-notice-copy";
  copy.textContent = message;
  notice.appendChild(copy);

  if (options.actionLabel && options.action) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "wf-notice-action";
    action.textContent = options.actionLabel;
    action.addEventListener("click", () => {
      if (!options.action || action.disabled) return;
      action.disabled = true;
      action.textContent = "Working…";
      void Promise.resolve(options.action()).then(() => {
        if (notice.isConnected) remove();
      }).catch(() => {
        if (session === noticeSession) {
          showNotice("Action failed", { tone: "error", durationMs: 5000 });
        }
      });
    });
    notice.appendChild(action);
  }
  if (undoLane) {
    noticeSession.noticeStack.appendChild(notice);
  } else {
    noticeSession.noticeStack.prepend(notice);
  }

  let remainingMs = options.durationMs ?? (options.action ? 8000 : 2200);
  let startedAt = Date.now();
  let timer: number | null = null;
  const remove = (): void => {
    const ownedFocus = notice.contains(noticeSession.shadow.activeElement);
    if (timer != null) window.clearTimeout(timer);
    timer = null;
    notice.remove();
    if (undoLane) {
      noticeSession.undoNoticeCleanups.delete(remove);
    } else if (noticeSession.statusNoticeCleanup === remove) {
      noticeSession.statusNoticeCleanup = null;
    }
    if (ownedFocus) restoreFocusAfterNotice(noticeSession);
  };
  const resume = (): void => {
    if (timer != null || remainingMs <= 0) return;
    startedAt = Date.now();
    timer = window.setTimeout(remove, remainingMs);
  };
  const pause = (): void => {
    if (timer == null) return;
    window.clearTimeout(timer);
    timer = null;
    remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
  };
  notice.addEventListener("mouseenter", pause);
  notice.addEventListener("mouseleave", resume);
  notice.addEventListener("focusin", pause);
  notice.addEventListener("focusout", resume);
  if (undoLane) noticeSession.undoNoticeCleanups.add(remove);
  else noticeSession.statusNoticeCleanup = remove;
  resume();
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
    openEntryMenu(row, index, entry, callbacks, more, focusOnOpen);
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
    toggleEntryMenu(anchor, more, index, entry, callbacks, event.detail === 0);
  });
  return more;
}

// --- In-page preview (live row iframe) ---

let previewElement: HTMLDivElement | null = null;
let previewedRowElement: HTMLElement | null = null;
let previewManualPosition: { left: number; top: number } | null = null;
let previewDragStop: (() => void) | null = null;
let previewReturnFocus: HTMLElement | null = null;

function closeEntryPreview(restore = false): void {
  const returnFocus = previewReturnFocus;
  previewDragStop?.();
  previewDragStop = null;
  previewManualPosition = null;
  previewedRowElement?.classList.remove("wf-branch-row-previewed");
  previewedRowElement = null;
  previewElement?.remove();
  previewElement = null;
  previewReturnFocus = null;
  if (restore) scheduleFocusWhenIdle(() => returnFocus);
}

function openEntryPreview(
  anchor: HTMLElement | null,
  entry: TrailEntry,
  onOpenInNewTab: () => void,
  returnFocus: HTMLElement | null,
): void {
  if (!session) return;
  closeEntryPreview();
  if (anchor) {
    anchor.classList.add("wf-branch-row-previewed");
    previewedRowElement = anchor;
  }

  const preview = document.createElement("div");
  preview.className = "wf-preview-pane";
  preview.dataset.tabtrailHitSurface = "";
  preview.setAttribute("role", "dialog");
  preview.setAttribute("aria-modal", "false");

  const header = document.createElement("div");
  header.className = "wf-preview-pane-header";

  const identity = document.createElement("div");
  identity.className = "wf-preview-pane-identity";

  const kicker = document.createElement("div");
  kicker.className = "wf-preview-pane-kicker";
  kicker.textContent = "Preview";
  identity.appendChild(kicker);

  const title = document.createElement("div");
  title.id = "tabtrail-live-preview-title";
  title.className = "wf-preview-pane-title";
  title.textContent = entryTitle(entry);
  identity.appendChild(title);

  const url = document.createElement("div");
  url.id = "tabtrail-live-preview-url";
  url.className = "wf-preview-pane-url";
  url.textContent = entryUrlSubtitle(entry);
  identity.appendChild(url);
  preview.setAttribute("aria-labelledby", title.id);
  preview.setAttribute("aria-describedby", url.id);

  const actions = document.createElement("div");
  actions.className = "wf-preview-pane-actions";

  const drag = document.createElement("span");
  drag.className = "wf-preview-pane-drag";
  drag.textContent = "⠿";
  drag.title = "Move preview pane";
  drag.setAttribute("aria-hidden", "true");
  drag.addEventListener("pointerdown", (event) => {
    if (!previewElement) return;
    previewElement.classList.remove("wf-preview-pane-bottom");
    previewDragStop?.();
    previewDragStop = startFreePixelDrag(previewElement, event, {
      draggingClass: "wf-preview-pane-dragging",
      onMove: (position) => {
        previewManualPosition = position;
      },
      onEnd: () => {
        previewDragStop = null;
      },
    });
  });

  const open = document.createElement("button");
  open.className = "wf-preview-pane-action";
  open.type = "button";
  open.textContent = "↗";
  open.title = "Open in new tab";
  open.setAttribute("aria-label", "Open previewed page in a new tab");
  open.addEventListener("click", () => onOpenInNewTab());

  const close = document.createElement("button");
  close.className = "wf-preview-pane-close";
  close.type = "button";
  close.textContent = "✕";
  close.title = "Close preview";
  close.setAttribute("aria-label", "Close page preview");
  close.addEventListener("click", () => closeEntryPreview(true));

  actions.appendChild(drag);
  actions.appendChild(open);
  actions.appendChild(close);

  header.appendChild(identity);
  header.appendChild(actions);

  const frame = document.createElement("iframe");
  frame.className = "wf-preview-pane-frame";
  frame.title = `Preview: ${entryTitle(entry)}`;
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("sandbox", "allow-forms allow-popups allow-same-origin allow-scripts");
  frame.src = entry.url;

  preview.appendChild(header);
  preview.appendChild(frame);
  session.layer.appendChild(preview);
  positionPreviewPane(preview);
  previewElement = preview;
  previewReturnFocus = returnFocus;
  close.focus({ preventScroll: true });
}

function positionPreviewPane(preview: HTMLElement): void {
  if (!session) return;
  const barRect = session.bar.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const margin = PREVIEW_VIEWPORT_MARGIN;
  const availableHeight = Math.max(160, viewportHeight - margin * 2);
  const rightSpace = viewportWidth - barRect.right - PREVIEW_GAP - margin;
  const leftSpace = barRect.left - PREVIEW_GAP - margin;
  const canUseRight = viewportWidth >= 760 && rightSpace >= PREVIEW_SIDE_MIN_WIDTH;
  const canUseLeft = viewportWidth >= 760 && leftSpace >= PREVIEW_SIDE_MIN_WIDTH;

  preview.classList.remove("wf-preview-pane-bottom");

  if (previewManualPosition) {
    const rect = preview.getBoundingClientRect();
    const position = clampInViewport(
      previewManualPosition.left,
      previewManualPosition.top,
      rect.width || PREVIEW_DESKTOP_WIDTH,
      rect.height || PREVIEW_DESKTOP_HEIGHT,
      margin,
    );
    previewManualPosition = position;
    preview.style.left = `${position.left}px`;
    preview.style.top = `${position.top}px`;
    return;
  }

  preview.style.width = "";
  preview.style.height = "";
  preview.style.left = "";
  preview.style.top = "";

  if (canUseRight || canUseLeft) {
    const useRight = canUseRight && (!canUseLeft || rightSpace >= leftSpace);
    const availableWidth = useRight ? rightSpace : leftSpace;
    const width = Math.min(PREVIEW_DESKTOP_WIDTH, availableWidth);
    const height = Math.min(PREVIEW_DESKTOP_HEIGHT, availableHeight);
    const left = useRight ? barRect.right + PREVIEW_GAP : barRect.left - PREVIEW_GAP - width;
    const top = Math.min(
      Math.max(margin, barRect.top),
      Math.max(margin, viewportHeight - height - margin),
    );
    preview.style.width = `${width}px`;
    preview.style.height = `${height}px`;
    preview.style.left = `${left}px`;
    preview.style.top = `${top}px`;
    return;
  }

  preview.classList.add("wf-preview-pane-bottom");
  const width = Math.max(0, viewportWidth - margin * 2);
  const targetHeight = Math.round(viewportHeight * 0.66);
  const height = Math.min(Math.max(260, targetHeight), availableHeight);
  preview.style.width = `${width}px`;
  preview.style.height = `${height}px`;
  preview.style.left = `${margin}px`;
  preview.style.top = `${Math.max(margin, viewportHeight - height - margin)}px`;
}

// --- Live row context menu ---

function toggleEntryMenu(
  anchor: HTMLElement,
  trigger: HTMLElement,
  index: number,
  entry: TrailEntry,
  callbacks: BreadcrumbTrailCallbacks,
  focusOnOpen: boolean,
): void {
  // Toggle: if this trigger already owns the open menu, close it.
  if (liveMenuTrigger === trigger) {
    closeOverlaySurface("menu");
    return;
  }
  openEntryMenu(anchor, index, entry, callbacks, trigger, focusOnOpen);
}

let liveMenuTrigger: HTMLElement | null = null;

function openEntryMenu(
  anchor: HTMLElement,
  index: number,
  entry: TrailEntry,
  callbacks: BreadcrumbTrailCallbacks,
  trigger: HTMLElement,
  focusOnOpen: boolean,
): void {
  if (!session) return;
  closeOverlaySurface("menu");

  let closed = false;
  liveMenuTrigger = trigger;
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
        action: () =>
          openEntryPreview(anchor, entry, () => callbacks.onOpenInNewTab(index), trigger),
      },
      { label: "Open in new tab", action: () => callbacks.onOpenInNewTab(index) },
      { label: "Open in new window", action: () => callbacks.onOpenInNewWindow(index) },
      { label: "Copy URL", action: () => void copyText(entry.url) },
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
      dropOverlaySurface("menu");
    },
  });

  pushOverlaySurface("menu", () => {
    if (!closed) handle.close();
  });
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
