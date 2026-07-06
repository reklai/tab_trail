// Typed client wrappers over the runtime message transport. Surfaces (content
// script, popup, options) call these instead of hand-building message objects.
// Gesture-driven calls use the retry variant so a cold MV3 service worker still
// receives the first press; the transport only retries a not-yet-listening
// worker, so re-sending never repeats an action that already ran.

import { sendRuntimeMessage, sendRuntimeMessageWithRetry } from "./runtimeClient";

export async function toggleTrailOverlay(): Promise<TabTrailActionResult> {
  return sendRuntimeMessageWithRetry<TabTrailActionResult>({ type: "TRAIL_TOGGLE_OVERLAY" });
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

export async function openTabTrailOptions(): Promise<TabTrailActionResult> {
  return sendRuntimeMessageWithRetry<TabTrailActionResult>({ type: "TABTRAIL_OPEN_OPTIONS" });
}

export async function refreshTabTrailExtension(): Promise<TabTrailActionResult> {
  return sendRuntimeMessageWithRetry<TabTrailActionResult>({ type: "TABTRAIL_REFRESH_EXTENSION" });
}
