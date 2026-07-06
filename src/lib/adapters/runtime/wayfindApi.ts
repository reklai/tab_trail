// Typed client wrappers over the runtime message transport. Surfaces (content
// script, popup, options) call these instead of hand-building message objects.
// Gesture-driven calls use the retry variant so a cold MV3 service worker
// still receives the first press.

import { sendRuntimeMessage, sendRuntimeMessageWithRetry } from "./runtimeClient";

export async function toggleTrailOverlay(): Promise<WayfindActionResult> {
  return sendRuntimeMessageWithRetry<WayfindActionResult>({ type: "TRAIL_TOGGLE_OVERLAY" });
}

export async function getTrailWithRetry(tabId?: number): Promise<TrailSnapshot> {
  return sendRuntimeMessageWithRetry<TrailSnapshot>({ type: "TRAIL_GET", tabId });
}

export async function jumpToTrailEntry(index: number, tabId?: number): Promise<WayfindActionResult> {
  return sendRuntimeMessageWithRetry<WayfindActionResult>({ type: "TRAIL_JUMP", index, tabId });
}

export async function openTrailEntryInNewTab(index: number, tabId?: number): Promise<WayfindActionResult> {
  return sendRuntimeMessage<WayfindActionResult>({ type: "TRAIL_OPEN_IN_NEW_TAB", index, tabId });
}

export async function openTrailEntryInNewWindow(index: number, tabId?: number): Promise<WayfindActionResult> {
  return sendRuntimeMessage<WayfindActionResult>({ type: "TRAIL_OPEN_IN_NEW_WINDOW", index, tabId });
}

export async function reportTrailOverlayState(open: boolean): Promise<void> {
  await sendRuntimeMessage<WayfindActionResult>({ type: "TRAIL_OVERLAY_STATE", open });
}

export async function announceTrailContentReady(): Promise<void> {
  await sendRuntimeMessage<WayfindActionResult>({ type: "TRAIL_CONTENT_READY" });
}

export async function openWayfindOptions(): Promise<WayfindActionResult> {
  return sendRuntimeMessageWithRetry<WayfindActionResult>({ type: "WAYFIND_OPEN_OPTIONS" });
}

export async function refreshWayfindExtension(): Promise<WayfindActionResult> {
  return sendRuntimeMessageWithRetry<WayfindActionResult>({ type: "WAYFIND_REFRESH_EXTENSION" });
}
