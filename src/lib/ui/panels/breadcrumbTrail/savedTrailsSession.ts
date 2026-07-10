// Shared types, module state, and focus helpers for the saved-trails UI.
// Feature modules import this instead of reaching across one another.

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

export let host: SavedTrailsHost | null = null;
export let librarySession: LibrarySession | null = null;
export let libraryDragStop: (() => void) | null = null;
export let treePreviewElement: HTMLDivElement | null = null;
export const pendingTrailIds = new Set<string>();

let nextDialogId = 0;
let renderLibraryImpl: ((session: LibrarySession) => void) | null = null;

export function setHost(next: SavedTrailsHost | null): void {
  host = next;
}

export function setLibrarySession(next: LibrarySession | null): void {
  librarySession = next;
}

export function setLibraryDragStop(next: (() => void) | null): void {
  libraryDragStop = next;
}

export function setTreePreviewElement(next: HTMLDivElement | null): void {
  treePreviewElement = next;
}

export function allocateDialogId(): number {
  return ++nextDialogId;
}

/** Library module registers its renderer so dialogs/mutations avoid circular imports. */
export function registerRenderLibrary(fn: (session: LibrarySession) => void): void {
  renderLibraryImpl = fn;
}

export function renderLibrary(session: LibrarySession): void {
  renderLibraryImpl?.(session);
}

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
  if (!librarySession) return null;
  const row = [...librarySession.list.querySelectorAll<HTMLElement>(".wf-library-row")]
    .find((candidate) => candidate.dataset.trailId === trailId);
  return row?.querySelector<HTMLElement>(`[data-library-action="${action}"]`) ?? null;
}

export function libraryPrimaryControl(): HTMLElement | null {
  if (!librarySession) return null;
  return librarySession.list.querySelector<HTMLElement>(
    ".wf-library-row .wf-row-more:not(:disabled), .wf-library-state-action:not(:disabled)",
  ) ?? librarySession.search;
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
    if (librarySession !== session) return null;
    return libraryPrimaryControl();
  });
}

export function acceptAuthoritativeTrails(
  trails: SavedTrail[],
  expectedSession?: LibrarySession | null,
  expectedGeneration?: number,
): void {
  const current = librarySession;
  if (
    !current ||
    (expectedSession !== undefined && current !== expectedSession) ||
    (expectedGeneration !== undefined && current.loadRequest !== expectedGeneration)
  ) return;
  closeOverlaySurface("treePreview");
  current.trails = normalizeSavedTrails(trails);
  current.state = "ready";
  renderLibrary(current);
}

export function currentCapturedPath(): TrailEntry[] | null {
  if (!host) return null;
  const state = host.getState();
  return slicePathToIndex(state, state.cursor);
}
