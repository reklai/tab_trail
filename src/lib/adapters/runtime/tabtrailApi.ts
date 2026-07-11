// Typed client wrappers over the runtime message transport. Surfaces (content
// script, popup, options) call these instead of hand-building message objects.
// Gesture-driven calls use the retry variant so a cold MV3 service worker still
// receives the first press; the transport only retries a not-yet-listening
// worker, so re-sending never repeats an action that already ran.

import { sendRuntimeMessage, sendRuntimeMessageWithRetry } from "./runtimeClient";
import type {
  DeleteSavedTrailResult,
  ReplaceSavedTrailResult,
  SaveNamedTrailResult,
  SavedTrailMutationResult,
} from "../storage/savedTrailsStore";

export async function toggleTrailOverlay(requestedAtEpochMs?: number): Promise<TabTrailActionResult> {
  return sendRuntimeMessageWithRetry<TabTrailActionResult>({
    type: "TRAIL_TOGGLE_OVERLAY",
    ...(Number.isFinite(requestedAtEpochMs) ? { requestedAtEpochMs } : {}),
  });
}

/** One-time authentication used only by the isolated overlay document. */
export async function claimOverlayFrame(nonce: string): Promise<TabTrailActionResult> {
  return sendRuntimeMessageWithRetry<TabTrailActionResult>({
    type: "OVERLAY_FRAME_CLAIM",
    nonce,
  });
}

export async function jumpToTrailEntry(index: number, tabId?: number): Promise<TabTrailActionResult> {
  return sendRuntimeMessageWithRetry<TabTrailActionResult>({ type: "TRAIL_JUMP", index, tabId });
}

export async function openTrailEntryInNewTab(index: number, tabId?: number): Promise<TabTrailActionResult> {
  return sendRuntimeMessageWithRetry<TabTrailActionResult>({ type: "TRAIL_OPEN_IN_NEW_TAB", index, tabId });
}

export async function openTrailEntryInNewWindow(index: number, tabId?: number): Promise<TabTrailActionResult> {
  return sendRuntimeMessageWithRetry<TabTrailActionResult>({ type: "TRAIL_OPEN_IN_NEW_WINDOW", index, tabId });
}

export async function reportTrailOverlayState(open: boolean): Promise<void> {
  await sendRuntimeMessage<TabTrailActionResult>({ type: "TRAIL_OVERLAY_STATE", open });
}

/** Report the current page viewport for the live trail session cache. */
export async function reportTrailScroll(
  url: string,
  viewport: TrailViewport,
  options?: { flush?: boolean },
): Promise<void> {
  await sendRuntimeMessage({
    type: "TRAIL_SCROLL_REPORT",
    url,
    viewport,
    ...(options?.flush ? { flush: true } : {}),
  });
}

/**
 * Unload/pagehide flush: retry so a cold MV3 worker still receives the last
 * sample, and request an immediate mirror write. Safe because the report is
 * idempotent (same cursor patch).
 */
export async function reportTrailScrollWithRetry(
  url: string,
  viewport: TrailViewport,
): Promise<void> {
  await sendRuntimeMessageWithRetry({
    type: "TRAIL_SCROLL_REPORT",
    url,
    viewport,
    flush: true,
  });
}

export async function openTabTrailOptions(): Promise<TabTrailActionResult> {
  return sendRuntimeMessageWithRetry<TabTrailActionResult>({ type: "TABTRAIL_OPEN_OPTIONS" });
}

export async function refreshTabTrailExtension(): Promise<TabTrailActionResult> {
  return sendRuntimeMessageWithRetry<TabTrailActionResult>({ type: "TABTRAIL_REFRESH_EXTENSION" });
}

export async function openSavedTrail(
  path: TrailEntry[],
  mode: SavedTrailOpenMode,
): Promise<TabTrailActionResult> {
  return sendRuntimeMessageWithRetry<TabTrailActionResult>({
    type: "SAVED_TRAIL_OPEN",
    path,
    mode,
  });
}

export async function saveNamedTrail(
  path: TrailEntry[],
  name: string,
): Promise<SaveNamedTrailResult> {
  return sendRuntimeMessageWithRetry<SaveNamedTrailResult>({
    type: "SAVED_TRAIL_SAVE",
    path,
    name,
  });
}

export async function renameNamedTrail(
  id: string,
  name: string,
): Promise<SavedTrailMutationResult> {
  return sendRuntimeMessageWithRetry<SavedTrailMutationResult>({
    type: "SAVED_TRAIL_RENAME",
    id,
    name,
  });
}

export async function replaceNamedTrail(
  id: string,
  path: TrailEntry[],
  expectedPath?: TrailEntry[],
): Promise<ReplaceSavedTrailResult> {
  return sendRuntimeMessageWithRetry<ReplaceSavedTrailResult>({
    type: "SAVED_TRAIL_REPLACE",
    id,
    path,
    expectedPath,
  });
}

export async function setNamedTrailPinned(
  id: string,
  pinned: boolean,
): Promise<SavedTrailMutationResult> {
  return sendRuntimeMessageWithRetry<SavedTrailMutationResult>({
    type: "SAVED_TRAIL_SET_PINNED",
    id,
    pinned,
  });
}

export async function deleteNamedTrail(id: string): Promise<DeleteSavedTrailResult> {
  return sendRuntimeMessageWithRetry<DeleteSavedTrailResult>({
    type: "SAVED_TRAIL_DELETE",
    id,
  });
}

export async function restoreNamedTrail(trail: SavedTrail): Promise<SavedTrailMutationResult> {
  return sendRuntimeMessageWithRetry<SavedTrailMutationResult>({
    type: "SAVED_TRAIL_RESTORE",
    trail,
  });
}
