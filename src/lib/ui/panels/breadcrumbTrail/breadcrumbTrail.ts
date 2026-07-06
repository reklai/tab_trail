// Compact vertical branch overlay showing the tab's navigation trail. Built
// on the shared Shadow DOM panel host so it stays isolated from page styles,
// but deliberately NON-modal: the host is click-through outside the bar, and
// the page keeps keyboard focus outside explicit controls. Rows are clicked to
// jump, opened through the right-side details button or right-clicked for a
// small in-shadow menu, and the bar is dragged by its handle to reposition
// (position persisted via a callback).

import styles from "./breadcrumbTrail.css";
import {
  createPanelHost,
  dismissPanel,
  getBaseStyles,
  registerPanelCleanup,
} from "../../../common/utils/panelHost";
import { extractDomain } from "../../../common/utils/helpers";
import { formatTrailTimestamp } from "../../../core/trail/trailCore";

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
}

let session: OverlaySession | null = null;

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
  renderBar();
}

export function showBreadcrumbTrail(state: TrailState, options: BreadcrumbTrailOptions): void {
  const { host, shadow } = createPanelHost();
  // Non-modal: only the bar itself accepts pointer events.
  host.style.pointerEvents = "none";

  const style = document.createElement("style");
  style.textContent = getBaseStyles() + styles;
  shadow.appendChild(style);

  const layer = document.createElement("div");
  layer.className = "wf-layer";
  shadow.appendChild(layer);

  const bar = document.createElement("div");
  bar.className = "wf-bar";
  bar.setAttribute("role", "navigation");
  bar.setAttribute("aria-label", "Navigation trail");
  layer.appendChild(bar);

  session = {
    shadow,
    bar,
    layer,
    options,
    state,
    expanded: false,
    position: options.settings.overlayPosition ?? DEFAULT_POSITION,
  };

  applyPosition();
  renderBar();

  const onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !session) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    hideBreadcrumbTrail();
  };
  document.addEventListener("keydown", onDocumentKeydown, true);

  registerPanelCleanup(() => {
    document.removeEventListener("keydown", onDocumentKeydown, true);
    closeEntryMenu();
    closeEntryPreview();
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

// --- Rendering ---

function entryTitle(entry: TrailEntry): string {
  if (entry.title.trim() !== "") return entry.title.trim();
  const domain = extractDomain(entry.url);
  return domain !== "" ? domain : entry.url;
}

function entryUrlSubtitle(entry: TrailEntry): string {
  try {
    const parsed = new URL(entry.url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const query = parsed.search ? "?..." : "";
    const hash = parsed.hash ? "#..." : "";
    return `${parsed.hostname}${path}${query}${hash}`;
  } catch (_) {
    return entry.url;
  }
}

function branchConnectorElement(nextEntry: TrailEntry): HTMLElement {
  const connector = document.createElement("div");
  connector.className = "wf-branch-connector";
  connector.setAttribute("aria-hidden", "true");
  // Differentiate how the next hop happened: a followed link vs an address-bar
  // entry vs in-page (SPA/hash) routing.
  if (nextEntry.transition === "typed") {
    connector.classList.add("wf-branch-connector-typed");
  } else if (nextEntry.transition === "spa" || nextEntry.transition === "fragment") {
    connector.classList.add("wf-branch-connector-spa");
  }
  connector.title = nextEntry.transition;
  return connector;
}

// Picks which entry indices render when the trail is longer than the visible
// budget: the first entry anchors the path, the current entry stays visible,
// the latest entry keeps the forward tail discoverable, and the rest of the
// budget expands around the current entry.
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
  const { bar, state, options } = session;
  const { settings, callbacks } = options;
  closeEntryMenu();
  closeEntryPreview();
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
    branchList.appendChild(buildBranchRow(index, state, callbacks));
    previousRendered = index;
  }

  if (session.expanded && state.entries.length > settings.maxVisibleSegments) {
    branchList.appendChild(buildCollapsePill());
  }
}

function buildBranchHeader(callbacks: BreadcrumbTrailCallbacks): HTMLDivElement {
  const header = document.createElement("div");
  header.className = "wf-branch-header";
  header.appendChild(buildSettingsButton(callbacks));
  const title = document.createElement("span");
  title.className = "wf-branch-title";
  title.textContent = "Page Trail";
  header.appendChild(title);
  header.appendChild(buildGrip());
  header.appendChild(buildCloseButton());
  return header;
}

function buildBranchList(): HTMLDivElement {
  const branchList = document.createElement("div");
  branchList.className = "wf-branch-list";
  return branchList;
}

function buildGrip(): HTMLElement {
  const grip = document.createElement("span");
  grip.className = "wf-grip";
  grip.textContent = "⠿";
  grip.title = "Drag to move";
  grip.addEventListener("pointerdown", startDrag);
  return grip;
}

function buildSettingsButton(callbacks: BreadcrumbTrailCallbacks): HTMLElement {
  const settings = document.createElement("span");
  settings.className = "wf-settings";
  settings.textContent = "⚙";
  settings.title = "Open settings";
  settings.addEventListener("click", () => callbacks.onOpenOptions());
  return settings;
}

function buildCloseButton(): HTMLElement {
  const close = document.createElement("span");
  close.className = "wf-close";
  close.textContent = "✕";
  close.title = "Hide (Esc)";
  close.addEventListener("click", () => hideBreadcrumbTrail());
  return close;
}

function buildMorePill(hiddenCount: number): HTMLElement {
  const pill = document.createElement("span");
  pill.className = "wf-more";
  pill.textContent = `+${hiddenCount} more`;
  pill.title = "Show the full trail";
  pill.addEventListener("click", () => {
    if (!session) return;
    session.expanded = true;
    renderBar();
  });
  return pill;
}

function buildCollapsePill(): HTMLElement {
  const pill = document.createElement("span");
  pill.className = "wf-more wf-more-collapse";
  pill.textContent = "Show less";
  pill.title = "Collapse the trail";
  pill.addEventListener("click", () => {
    if (!session) return;
    session.expanded = false;
    renderBar();
  });
  return pill;
}

function buildBranchRow(
  index: number,
  state: TrailState,
  callbacks: BreadcrumbTrailCallbacks,
): HTMLElement {
  const entry = state.entries[index];
  const row = document.createElement("div");
  row.className = "wf-branch-row";
  if (index === state.cursor) row.classList.add("wf-branch-row-current");
  if (index > state.cursor) row.classList.add("wf-branch-row-forward");
  row.setAttribute("aria-current", index === state.cursor ? "page" : "false");

  const node = document.createElement("span");
  node.className = "wf-branch-node";
  node.setAttribute("aria-hidden", "true");
  row.appendChild(node);

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

  row.appendChild(content);
  row.appendChild(buildRowMoreButton(row, index, entry, callbacks));

  row.addEventListener("click", (event) => {
    event.preventDefault();
    if (index !== state.cursor) callbacks.onJump(index);
  });
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openEntryMenu(row, index, entry, callbacks);
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
  more.setAttribute("aria-label", "More details and actions");
  more.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleEntryMenu(anchor, more, index, entry, callbacks);
  });
  return more;
}

// --- In-page preview ---

let previewElement: HTMLDivElement | null = null;
let previewedRowElement: HTMLElement | null = null;
let previewManualPosition: { left: number; top: number } | null = null;
let previewDragCleanup: (() => void) | null = null;

function closeEntryPreview(): void {
  stopPreviewPaneDrag();
  previewManualPosition = null;
  previewedRowElement?.classList.remove("wf-branch-row-previewed");
  previewedRowElement = null;
  previewElement?.remove();
  previewElement = null;
}

function stopPreviewPaneDrag(): void {
  if (previewDragCleanup) {
    previewDragCleanup();
    previewDragCleanup = null;
  }
  previewElement?.classList.remove("wf-preview-pane-dragging");
}

function openEntryPreview(
  anchor: HTMLElement,
  index: number,
  entry: TrailEntry,
  callbacks: BreadcrumbTrailCallbacks,
): void {
  if (!session) return;
  closeEntryPreview();
  anchor.classList.add("wf-branch-row-previewed");
  previewedRowElement = anchor;

  const preview = document.createElement("div");
  preview.className = "wf-preview-pane";

  const header = document.createElement("div");
  header.className = "wf-preview-pane-header";

  const identity = document.createElement("div");
  identity.className = "wf-preview-pane-identity";

  const kicker = document.createElement("div");
  kicker.className = "wf-preview-pane-kicker";
  kicker.textContent = "Preview";
  identity.appendChild(kicker);

  const title = document.createElement("div");
  title.className = "wf-preview-pane-title";
  title.textContent = entryTitle(entry);
  identity.appendChild(title);

  const url = document.createElement("div");
  url.className = "wf-preview-pane-url";
  url.textContent = entryUrlSubtitle(entry);
  identity.appendChild(url);

  const actions = document.createElement("div");
  actions.className = "wf-preview-pane-actions";

  const drag = document.createElement("button");
  drag.className = "wf-preview-pane-drag";
  drag.type = "button";
  drag.textContent = "⠿";
  drag.title = "Move preview pane";
  drag.addEventListener("pointerdown", startPreviewPaneDrag);

  const open = document.createElement("button");
  open.className = "wf-preview-pane-action";
  open.type = "button";
  open.textContent = "↗";
  open.title = "Open in new tab";
  open.addEventListener("click", () => callbacks.onOpenInNewTab(index));

  const close = document.createElement("button");
  close.className = "wf-preview-pane-close";
  close.type = "button";
  close.textContent = "✕";
  close.title = "Close preview";
  close.addEventListener("click", () => closeEntryPreview());

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
    const position = clampPreviewPanePosition(
      previewManualPosition.left,
      previewManualPosition.top,
      rect.width || PREVIEW_DESKTOP_WIDTH,
      rect.height || PREVIEW_DESKTOP_HEIGHT,
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

function clampPreviewPanePosition(
  left: number,
  top: number,
  width: number,
  height: number,
): { left: number; top: number } {
  const margin = PREVIEW_VIEWPORT_MARGIN;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  return {
    left: Math.min(Math.max(margin, left), maxLeft),
    top: Math.min(Math.max(margin, top), maxTop),
  };
}

function startPreviewPaneDrag(event: PointerEvent): void {
  if (!previewElement) return;
  event.preventDefault();
  event.stopPropagation();
  stopPreviewPaneDrag();

  const pane = previewElement;
  const paneRect = pane.getBoundingClientRect();
  const offsetX = event.clientX - paneRect.left;
  const offsetY = event.clientY - paneRect.top;
  pane.classList.remove("wf-preview-pane-bottom");
  pane.classList.add("wf-preview-pane-dragging");
  pane.style.width = `${paneRect.width}px`;
  pane.style.height = `${paneRect.height}px`;
  previewManualPosition = clampPreviewPanePosition(
    paneRect.left,
    paneRect.top,
    paneRect.width,
    paneRect.height,
  );
  pane.style.left = `${previewManualPosition.left}px`;
  pane.style.top = `${previewManualPosition.top}px`;

  const move = (moveEvent: PointerEvent): void => {
    const position = clampPreviewPanePosition(
      moveEvent.clientX - offsetX,
      moveEvent.clientY - offsetY,
      paneRect.width,
      paneRect.height,
    );
    previewManualPosition = position;
    pane.style.left = `${position.left}px`;
    pane.style.top = `${position.top}px`;
  };

  const end = (): void => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    previewDragCleanup = null;
    pane.classList.remove("wf-preview-pane-dragging");
  };

  previewDragCleanup = end;
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
}

// --- Row context menu (in-shadow; the native menu is suppressed) ---

let menuElement: HTMLDivElement | null = null;
let menuDismissCleanup: (() => void) | null = null;
let menuAnchorElement: HTMLElement | null = null;
let menuTriggerElement: HTMLElement | null = null;

function closeEntryMenu(): void {
  menuElement?.remove();
  menuElement = null;
  menuAnchorElement = null;
  menuTriggerElement = null;
  if (menuDismissCleanup) {
    menuDismissCleanup();
    menuDismissCleanup = null;
  }
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

function toggleEntryMenu(
  anchor: HTMLElement,
  trigger: HTMLElement,
  index: number,
  entry: TrailEntry,
  callbacks: BreadcrumbTrailCallbacks,
): void {
  if (menuElement && menuAnchorElement === anchor && menuTriggerElement === trigger) {
    closeEntryMenu();
    return;
  }
  openEntryMenu(anchor, index, entry, callbacks, trigger);
}

function openEntryMenu(
  anchor: HTMLElement,
  index: number,
  entry: TrailEntry,
  callbacks: BreadcrumbTrailCallbacks,
  trigger?: HTMLElement,
): void {
  if (!session) return;
  closeEntryMenu();

  const menu = document.createElement("div");
  menu.className = "wf-menu";

  const detail = document.createElement("div");
  detail.className = "wf-menu-detail";

  const title = document.createElement("div");
  title.className = "wf-menu-detail-title";
  title.textContent = entryTitle(entry);
  detail.appendChild(title);

  const url = document.createElement("div");
  url.className = "wf-menu-detail-url";
  url.textContent = entry.url;
  detail.appendChild(url);

  const time = document.createElement("div");
  time.className = "wf-menu-detail-time";
  time.textContent = `Visited ${formatTrailTimestamp(entry.timestamp, Date.now())}`;
  detail.appendChild(time);

  menu.appendChild(detail);

  const actions = document.createElement("div");
  actions.className = "wf-menu-actions";
  const items: Array<{ label: string; action: () => void }> = [
    { label: "Preview", action: () => openEntryPreview(anchor, index, entry, callbacks) },
    { label: "Open in new tab", action: () => callbacks.onOpenInNewTab(index) },
    { label: "Open in new window", action: () => callbacks.onOpenInNewWindow(index) },
    { label: "Copy URL", action: () => void copyText(entry.url) },
  ];
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "wf-menu-item";
    row.textContent = item.label;
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      closeEntryMenu();
      item.action();
    });
    actions.appendChild(row);
  }
  menu.appendChild(actions);
  session.layer.appendChild(menu);
  positionPopover(menu, anchor);
  menuElement = menu;
  menuAnchorElement = anchor;
  menuTriggerElement = trigger ?? null;

  const onOutsidePointer = (event: Event): void => {
    const path = event.composedPath();
    if (menuElement && path.includes(menuElement)) return;
    if (menuTriggerElement && path.includes(menuTriggerElement)) return;
    closeEntryMenu();
  };
  document.addEventListener("pointerdown", onOutsidePointer, true);
  menuDismissCleanup = () => {
    document.removeEventListener("pointerdown", onOutsidePointer, true);
  };
}

// Places a popover under its anchor row, clamped to the viewport.
function positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const anchorRect = anchor.getBoundingClientRect();
  popover.style.left = "0px";
  popover.style.top = "0px";
  const popoverRect = popover.getBoundingClientRect();
  const width = popoverRect.width || 240;
  const left = Math.min(
    Math.max(8, anchorRect.left),
    Math.max(8, window.innerWidth - width - 8),
  );
  let top = anchorRect.bottom + 6;
  if (top + popoverRect.height > window.innerHeight - 8) {
    top = Math.max(8, anchorRect.top - popoverRect.height - 6);
  }
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

// --- Dragging ---

function startDrag(event: PointerEvent): void {
  if (!session) return;
  event.preventDefault();
  const { bar } = session;
  const barRect = bar.getBoundingClientRect();
  const grabOffsetX = event.clientX - (barRect.left + barRect.width / 2);
  const grabOffsetY = event.clientY - barRect.top;
  bar.classList.add("wf-dragging");

  const onMove = (moveEvent: PointerEvent): void => {
    if (!session) return;
    const x = ((moveEvent.clientX - grabOffsetX) / window.innerWidth) * 100;
    const y = ((moveEvent.clientY - grabOffsetY) / window.innerHeight) * 100;
    session.position = {
      xPercent: Math.min(Math.max(x, 0), 100),
      yPercent: Math.min(Math.max(y, 0), 96),
    };
    applyPosition();
  };

  const onEnd = (): void => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onEnd, true);
    window.removeEventListener("pointercancel", onEnd, true);
    if (!session) return;
    session.bar.classList.remove("wf-dragging");
    session.options.callbacks.onPositionChange(session.position);
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onEnd, true);
  window.addEventListener("pointercancel", onEnd, true);
}
