// Saved trails library shell: open/load/render, rows, and context menus.

import {
  MAX_SAVED_TRAILS,
  normalizeSavedTrails,
  savedTrailEndpoint,
} from "../../../core/trail/trailCore";
import { showContextMenu } from "./contextMenu";
import { startFreePixelDrag } from "./freePixelDrag";
import {
  closeOverlaySurface,
  dropOverlaySurface,
  pushOverlaySurface,
} from "./overlaySurfaces";
import {
  createTrailSearchSnippet,
  MAX_TRAIL_SEARCH_QUERY_LENGTH,
  searchSavedTrails,
} from "./savedTrailsSearch";
import type { TrailSearchHit, TrailSearchRange } from "./savedTrailsSearch";
import { entryTitle, pagesLabel } from "./trailPresentation";
import {
  openRenameDialog,
  openSaveCurrentTrailDialog,
  openUpdateDialog,
} from "./savedTrailsDialogs";
import {
  navigateSavedTrail,
  removeTrail,
  togglePinned,
} from "./savedTrailsMutations";
import { openSavedTrailTreePreview } from "./savedTrailsTreePreview";
import {
  LIBRARY_EMPTY_COPY,
  LIBRARY_PANEL_GAP,
  VIEWPORT_MARGIN,
  activeShadowElement,
  currentCapturedPath,
  host,
  libraryDragStop,
  libraryFocusIdentity,
  librarySession,
  pendingTrailIds,
  registerRenderLibrary,
  restoreLibraryFocus,
  restoreLibraryPrimaryFocus,
  restoreSurfaceFocus,
  setLibraryDragStop,
  setLibrarySession,
  syncLiveInteraction,
  type LibrarySession,
} from "./savedTrailsSession";

export function openLibraryPanel(): void {
  if (!host) return;
  const openingHost = host;
  const opener = activeShadowElement(openingHost);
  openingHost.closeLiveSurfaces();
  closeOverlaySurface("nameDialog");
  closeOverlaySurface("treePreview");
  closeOverlaySurface("menu");
  closeOverlaySurface("library");

  const panel = document.createElement("div");
  panel.id = "tabtrail-saved-trails-library";
  panel.className = "wf-library-panel";
  panel.dataset.tabtrailHitSurface = "";
  panel.dataset.tabtrailWheelSurface = "";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "Saved trails");

  const header = document.createElement("div");
  header.className = "wf-library-header";

  const heading = document.createElement("div");
  heading.className = "wf-library-heading";
  const title = document.createElement("span");
  title.className = "wf-library-title";
  title.textContent = "Saved trails";
  const count = document.createElement("span");
  count.className = "wf-library-count";
  count.textContent = `0/${MAX_SAVED_TRAILS}`;
  count.setAttribute("aria-live", "polite");
  count.setAttribute("aria-atomic", "true");
  heading.appendChild(title);
  heading.appendChild(count);
  header.appendChild(heading);

  const grip = document.createElement("span");
  grip.className = "wf-grip";
  grip.textContent = "⠿";
  grip.title = "Drag to move";
  grip.setAttribute("aria-hidden", "true");
  grip.addEventListener("pointerdown", (event) => {
    libraryDragStop?.();
    setLibraryDragStop(startFreePixelDrag(panel, event, {
      draggingClass: "wf-library-panel-dragging",
      onEnd: () => {
        setLibraryDragStop(null);
      },
    }));
  });
  header.appendChild(grip);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "wf-library-close";
  close.textContent = "✕";
  close.title = "Close";
  close.setAttribute("aria-label", "Close saved trails");
  close.addEventListener("click", () => closeOverlaySurface("library"));
  header.appendChild(close);
  panel.appendChild(header);

  const tools = document.createElement("div");
  tools.className = "wf-library-tools";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "wf-library-search";
  search.placeholder = "Search trails…";
  search.setAttribute("aria-label", "Fuzzy-search saved trails");
  search.maxLength = MAX_TRAIL_SEARCH_QUERY_LENGTH;
  tools.appendChild(search);
  panel.appendChild(tools);

  const list = document.createElement("div");
  list.className = "wf-library-list";
  list.dataset.tabtrailScrollRegion = "";
  list.setAttribute("role", "list");
  panel.appendChild(list);
  openingHost.layer.appendChild(panel);
  if (opener?.dataset.liveControl === "library") {
    opener.setAttribute("aria-expanded", "true");
    opener.setAttribute("aria-controls", panel.id);
  }

  const savedTrailsChanged = (trails: SavedTrail[]): void => {
    const current = librarySession;
    if (!current || current.panel !== panel) return;
    closeOverlaySurface("treePreview");
    current.loadRequest += 1;
    current.trails = normalizeSavedTrails(trails);
    current.state = "ready";
    renderLibrary(current);
  };

  const session: LibrarySession = {
    host: openingHost,
    panel,
    list,
    search,
    count,
    trails: [],
    query: "",
    loadRequest: 0,
    state: "loading",
    opener,
    restoreFocusOnClose: true,
    unsubscribe: () => {},
  };
  setLibrarySession(session);

  search.addEventListener("input", () => {
    if (librarySession !== session) return;
    session.query = search.value.trim();
    renderLibrary(session);
  });

  session.unsubscribe = openingHost.client.subscribe(savedTrailsChanged);
  positionLibraryPanel(panel);
  pushOverlaySurface("library", () => {
    session.loadRequest += 1;
    session.unsubscribe();
    libraryDragStop?.();
    setLibraryDragStop(null);
    closeOverlaySurface("treePreview");
    closeOverlaySurface("menu");
    panel.remove();
    if (opener?.dataset.liveControl === "library") {
      opener.setAttribute("aria-expanded", "false");
      opener.removeAttribute("aria-controls");
    }
    if (librarySession === session) setLibrarySession(null);
    if (host === openingHost) {
      syncLiveInteraction(openingHost);
      openingHost.flushLiveTrailUpdates();
      if (session.restoreFocusOnClose) restoreSurfaceFocus(openingHost, opener);
    }
  });
  syncLiveInteraction(openingHost);

  renderLibrary(session);
  search.focus({ preventScroll: true });
  void loadLibrary(session);
}

async function loadLibrary(
  session: LibrarySession,
  focusAfterLoad = false,
): Promise<void> {
  const request = ++session.loadRequest;
  session.state = "loading";
  renderLibrary(session);
  try {
    const trails = await session.host.client.load();
    if (
      librarySession !== session ||
      session.loadRequest !== request ||
      !session.panel.isConnected ||
      host !== session.host
    ) return;
    session.trails = trails;
    session.state = "ready";
    renderLibrary(session);
    if (focusAfterLoad) restoreLibraryPrimaryFocus(session);
  } catch (_) {
    if (
      librarySession !== session ||
      session.loadRequest !== request ||
      !session.panel.isConnected ||
      host !== session.host
    ) return;
    session.state = "error";
    renderLibrary(session);
    if (focusAfterLoad) restoreLibraryPrimaryFocus(session);
  }
}

function renderLibrary(session: LibrarySession): void {
  if (librarySession !== session || !session.panel.isConnected) return;
  closeOverlaySurface("menu");
  const activeControl = activeShadowElement(session.host);
  const focusedRow = libraryFocusIdentity(activeControl);
  const hadLibraryFocus = activeControl !== null && session.panel.contains(activeControl);
  const restoreRenderedFocus = (): void => {
    if (focusedRow) restoreLibraryFocus(focusedRow, true);
    else if (hadLibraryFocus) restoreLibraryPrimaryFocus(session);
  };
  session.count.textContent = `${session.trails.length}/${MAX_SAVED_TRAILS}`;
  session.panel.setAttribute("aria-busy", session.state === "loading" ? "true" : "false");
  session.search.disabled = false;
  session.list.textContent = "";

  if (session.state === "loading") {
    session.list.appendChild(buildLibraryState("Loading saved trails…", "status"));
    restoreRenderedFocus();
    return;
  }
  if (session.state === "error") {
    const error = buildLibraryState("Couldn’t load saved trails.", "alert");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "wf-library-state-action";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => void loadLibrary(session, true));
    error.appendChild(retry);
    session.list.appendChild(error);
    restoreRenderedFocus();
    return;
  }

  const visible = searchSavedTrails(session.trails, session.query);
  if (session.query !== "") {
    session.count.textContent = `${visible.length} ${visible.length === 1 ? "match" : "matches"} · ` +
      `${session.trails.length}/${MAX_SAVED_TRAILS}`;
  }
  if (visible.length === 0) {
    if (session.query !== "") {
      const empty = buildLibraryState("No trails match your search.");
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "wf-library-state-action";
      clear.textContent = "Clear search";
      clear.addEventListener("click", () => {
        session.search.value = "";
        session.query = "";
        renderLibrary(session);
        session.search.focus({ preventScroll: true });
      });
      empty.appendChild(clear);
      session.list.appendChild(empty);
      restoreRenderedFocus();
      return;
    }
    const empty = buildLibraryState("No saved trails yet");
    const description = document.createElement("span");
    description.className = "wf-library-state-copy";
    description.textContent = LIBRARY_EMPTY_COPY;
    empty.appendChild(description);
    const state = session.host.getState();
    if (state.cursor >= 0) {
      const save = document.createElement("button");
      save.type = "button";
      save.className = "wf-library-state-action";
      save.textContent = "Save current trail";
      save.addEventListener("click", () => openSaveCurrentTrailDialog(session.opener));
      empty.appendChild(save);
    }
    session.list.appendChild(empty);
    restoreRenderedFocus();
    return;
  }

  if (session.trails.length >= MAX_SAVED_TRAILS) {
    const limit = document.createElement("div");
    limit.className = "wf-library-limit";
    limit.textContent = "Saved-trail limit reached. Remove one before saving.";
    session.list.appendChild(limit);
  }
  for (const hit of visible) {
    session.list.appendChild(buildLibraryRow(session, hit));
  }
  restoreRenderedFocus();
}

registerRenderLibrary(renderLibrary);

function buildLibraryState(message: string, role?: "status" | "alert"): HTMLDivElement {
  const state = document.createElement("div");
  state.className = "wf-library-state";
  if (role) state.setAttribute("role", role);
  const title = document.createElement("strong");
  title.textContent = message;
  state.appendChild(title);
  return state;
}

function positionLibraryPanel(panel: HTMLElement): void {
  if (!host) return;
  const barRect = host.bar.getBoundingClientRect();
  const margin = VIEWPORT_MARGIN;
  const availableWidth = Math.max(0, window.innerWidth - margin * 2);
  const width = Math.min(380, Math.max(280, barRect.width), availableWidth);
  panel.style.width = `${width}px`;
  panel.style.left = `${Math.min(
    Math.max(margin, barRect.left),
    Math.max(margin, window.innerWidth - width - margin),
  )}px`;
  const preferredTop = barRect.bottom + LIBRARY_PANEL_GAP;
  const height = Math.min(panel.getBoundingClientRect().height || 340, window.innerHeight - margin * 2);
  let top = preferredTop;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, barRect.top - height - LIBRARY_PANEL_GAP);
  }
  panel.style.top = `${top}px`;
  panel.style.maxHeight = `${Math.max(180, window.innerHeight - top - margin)}px`;
}

function appendHighlightedText(
  container: HTMLElement,
  value: string,
  ranges: readonly TrailSearchRange[],
): void {
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(value.length, range.start));
    const end = Math.max(start, Math.min(value.length, range.end));
    if (start > cursor) container.appendChild(document.createTextNode(value.slice(cursor, start)));
    if (end > start) {
      const mark = document.createElement("mark");
      mark.className = "wf-library-search-match";
      mark.textContent = value.slice(start, end);
      container.appendChild(mark);
    }
    cursor = end;
  }
  if (cursor < value.length) container.appendChild(document.createTextNode(value.slice(cursor)));
}

function buildLibraryRow(session: LibrarySession, hit: TrailSearchHit): HTMLElement {
  const { trail, match } = hit;
  const endpoint = savedTrailEndpoint(trail);
  const pending = pendingTrailIds.has(trail.id);
  const row = document.createElement("div");
  row.className = "wf-library-row";
  row.dataset.trailId = trail.id;
  row.setAttribute("role", "listitem");
  if (trail.pinned) row.classList.add("wf-library-row-pinned");
  if (pending) {
    row.setAttribute("aria-busy", "true");
    row.tabIndex = -1;
  }

  const main = document.createElement("div");
  main.className = "wf-library-row-main";

  const name = document.createElement("span");
  name.className = "wf-library-row-name";
  if (match?.field === "name") {
    const snippet = createTrailSearchSnippet(trail.name, match.ranges, 48);
    appendHighlightedText(name, snippet.value, snippet.ranges);
  } else name.textContent = trail.name;
  main.appendChild(name);

  const meta = document.createElement("span");
  meta.className = "wf-library-row-meta";
  if (match && match.field !== "name") {
    const pageNumber = match.entryIndex === null ? "" : ` · Page ${match.entryIndex + 1}`;
    meta.appendChild(document.createTextNode(`${pagesLabel(trail.entries.length)}${pageNumber} · `));
    const snippet = createTrailSearchSnippet(match.value, match.ranges, 52);
    appendHighlightedText(meta, snippet.value, snippet.ranges);
  } else {
    const endLabel = endpoint ? entryTitle(endpoint) : "";
    meta.textContent = endLabel
      ? `${pagesLabel(trail.entries.length)} · ${endLabel}`
      : pagesLabel(trail.entries.length);
  }
  main.appendChild(meta);
  row.appendChild(main);

  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = "wf-library-pin";
  pin.dataset.libraryAction = "pin";
  pin.textContent = trail.pinned ? "★" : "☆";
  pin.title = trail.pinned ? "Unpin trail" : "Pin trail";
  pin.setAttribute("aria-label", `${trail.pinned ? "Unpin" : "Pin"} ${trail.name}`);
  pin.setAttribute("aria-pressed", trail.pinned ? "true" : "false");
  pin.disabled = pending;
  pin.addEventListener("click", () => void togglePinned(session, trail));
  row.appendChild(pin);

  const more = document.createElement("button");
  more.type = "button";
  more.className = "wf-row-more";
  more.dataset.libraryAction = "more";
  more.textContent = pending ? "…" : "⋯";
  more.title = "More";
  more.setAttribute("aria-label", `More options for ${trail.name}`);
  more.disabled = pending;
  more.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleLibraryMenu(session, row, more, trail, event.detail === 0);
  });
  row.appendChild(more);

  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const active = activeShadowElement(session.host);
    if (!pending) openLibraryMenu(session, row, more, trail, !!active && row.contains(active));
  });
  return row;
}

let libraryMenuTrigger: HTMLElement | null = null;

function toggleLibraryMenu(
  session: LibrarySession,
  anchor: HTMLElement,
  trigger: HTMLElement,
  trail: SavedTrail,
  focusOnOpen: boolean,
): void {
  if (libraryMenuTrigger === trigger) {
    closeOverlaySurface("menu");
    return;
  }
  openLibraryMenu(session, anchor, trigger, trail, focusOnOpen);
}

function openLibraryMenu(
  session: LibrarySession,
  anchor: HTMLElement,
  trigger: HTMLElement,
  trail: SavedTrail,
  focusOnOpen: boolean,
): void {
  const endpoint = savedTrailEndpoint(trail);
  const canUpdate = currentCapturedPath() !== null;
  openMenu(anchor, trigger, {
    title: trail.name,
    subtitle: endpoint?.url,
    meta: pagesLabel(trail.entries.length),
  }, [
    { label: "Preview", action: () => openSavedTrailTreePreview(trail, trigger) },
    { label: "Open in current tab", disabled: !endpoint, action: () => void navigateSavedTrail(trail, "current") },
    { label: "Open in new tab", disabled: !endpoint, action: () => void navigateSavedTrail(trail, "new") },
    { label: "Update from current path", disabled: !canUpdate, action: () => openUpdateDialog(trail, trigger) },
    { label: "Rename", action: () => openRenameDialog(trail, trigger) },
    { label: trail.pinned ? "Unpin" : "Pin", action: () => void togglePinned(session, trail) },
    { label: "Remove trail", danger: true, action: () => void removeTrail(session, trail) },
  ], focusOnOpen);
}

function openMenu(
  anchor: HTMLElement,
  trigger: HTMLElement | null,
  detail: { title: string; subtitle?: string; meta?: string },
  items: Array<{
    label: string;
    action: () => void;
    disabled?: boolean;
    danger?: boolean;
  }>,
  focusOnOpen = true,
): void {
  if (!host) return;
  closeOverlaySurface("menu");
  let closed = false;
  libraryMenuTrigger = trigger;
  const handle = showContextMenu({
    layer: host.layer,
    anchor,
    trigger,
    detail,
    items,
    focusOnOpen,
    onClose: () => {
      if (closed) return;
      closed = true;
      libraryMenuTrigger = null;
      dropOverlaySurface("menu");
    },
  });
  pushOverlaySurface("menu", () => {
    if (!closed) handle.close();
  });
}
