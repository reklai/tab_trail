// Isolated extension-origin renderer for the in-page trail. It remains inert
// until the background verifies the parent content script's one-time nonce;
// after that, a private MessagePort carries all state and privileged requests.

import {
  type SavedTrailsClient,
} from "../../lib/adapters/runtime/savedTrailsClient";
import { claimOverlayFrame } from "../../lib/adapters/runtime/tabtrailApi";
import type {
  DeleteSavedTrailResult,
  ReplaceSavedTrailResult,
  SaveNamedTrailResult,
  SavedTrailMutationResult,
} from "../../lib/adapters/storage/savedTrailsStore";
import {
  isOverlayHostToFrameMessage,
  OVERLAY_FRAME_MAX_SURFACES,
  OVERLAY_FRAME_PROTOCOL_VERSION,
  parseOverlayFrameConnectEvent,
  type OverlayFrameConnection,
  type OverlayFrameToHostMessage,
  type OverlayHostToFrameMessage,
  type OverlayRpcMethod,
  type OverlayRpcParamsMap,
  type OverlayRpcRequest,
  type OverlayRpcResultMap,
  type OverlaySurfaceRect,
} from "../../lib/common/contracts/overlayFrame";
import {
  matchesToggleTrigger,
  type ToggleTriggerEvent,
} from "../../lib/core/trail/trailCore";
import {
  hideBreadcrumbTrail,
  isBreadcrumbTrailOpen,
  showBreadcrumbTrail,
  updateBreadcrumbTrail,
  updateBreadcrumbTrailSettings,
} from "../../lib/ui/panels/breadcrumbTrail/breadcrumbTrail";
import { closeOverlaySurface } from "../../lib/ui/panels/breadcrumbTrail/overlaySurfaces";

const RPC_TIMEOUT_MS = 15000;
// Keep the guard alive long enough for click/auxclick/contextmenu events that
// the matched mousedown schedules after the overlay starts closing.
const MOUSE_CHORD_SWALLOW_WINDOW_MS = 600;
const HIT_SURFACE_SELECTOR = "[data-tabtrail-hit-surface]";

interface PendingRpc {
  method: OverlayRpcMethod;
  timeout: number;
  resolve: (result: unknown) => void;
  reject: (reason: Error) => void;
}

let port: MessagePort | null = null;
let initialized = false;
let shuttingDown = false;
let latestSettings: TabTrailSettings | null = null;
let nextRequestId = 0;
let nextSurfaceSequence = 0;
let geometryFrame = 0;
let previousSurfaceRects: OverlaySurfaceRect[] = [];
let previousLayoutKey = "";
let sendContractionNextFrame = false;
let swallowMouseUntil = 0;
let swallowedMouseButton = -1;
const pendingRpcs = new Map<number, PendingRpc>();
const savedTrailSubscribers = new Set<(trails: SavedTrail[]) => void>();
const candidatePorts = new Set<MessagePort>();

function postToHost(message: OverlayFrameToHostMessage): void {
  if (!port) return;
  port.postMessage(message);
}

function rejectPendingRpcs(reason: string): void {
  for (const pending of pendingRpcs.values()) {
    window.clearTimeout(pending.timeout);
    pending.reject(new Error(reason));
  }
  pendingRpcs.clear();
}

function requestHost<M extends OverlayRpcMethod>(
  method: M,
  params: OverlayRpcParamsMap[M],
): Promise<OverlayRpcResultMap[M]> {
  if (!port || shuttingDown) return Promise.reject(new Error("Overlay host disconnected"));
  const requestId = ++nextRequestId;
  const request = { requestId, method, params } as OverlayRpcRequest<M>;
  return new Promise<OverlayRpcResultMap[M]>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRpcs.delete(requestId);
      reject(new Error("Overlay request timed out"));
    }, RPC_TIMEOUT_MS);
    pendingRpcs.set(requestId, {
      method,
      timeout,
      resolve: resolve as (result: unknown) => void,
      reject,
    });
    postToHost({
      type: "FRAME_RPC_REQUEST",
      version: OVERLAY_FRAME_PROTOCOL_VERSION,
      request: request as unknown as OverlayRpcRequest,
    });
  });
}

function savedFailureReason(result: { ok: false; reason?: string }, fallback: string): string {
  return result.reason || fallback;
}

function asSavedMutationResult(
  result: OverlayRpcResultMap["SAVED_SAVE"],
  fallback: string,
): SavedTrailMutationResult {
  return result.ok
    ? result
    : { ok: false, reason: savedFailureReason(result, fallback) };
}

const savedTrailsClient: SavedTrailsClient = {
  load: async () => {
    const result = await requestHost("SAVED_LOAD", {});
    if (result.ok) return result.trails;
    throw new Error(savedFailureReason(result, "Could not load saved trails"));
  },
  subscribe: (onChanged) => {
    // Host pushes HOST_SAVED_TRAILS_UPDATED for the whole overlay session.
    savedTrailSubscribers.add(onChanged);
    return () => {
      savedTrailSubscribers.delete(onChanged);
    };
  },
  open: (path, mode) => requestHost("SAVED_OPEN", { path, mode }),
  save: async (path, name): Promise<SaveNamedTrailResult> => asSavedMutationResult(
    await requestHost("SAVED_SAVE", { path, name }),
    "Could not save trail",
  ),
  rename: async (id, name): Promise<SavedTrailMutationResult> => asSavedMutationResult(
    await requestHost("SAVED_RENAME", { id, name }),
    "Could not rename trail",
  ),
  replace: async (id, path, expectedPath): Promise<ReplaceSavedTrailResult> => {
    const result = await requestHost("SAVED_REPLACE", { id, path, expectedPath });
    return result.ok
      ? result
      : { ok: false, reason: savedFailureReason(result, "Could not update trail") };
  },
  setPinned: async (id, pinned): Promise<SavedTrailMutationResult> => asSavedMutationResult(
    await requestHost("SAVED_SET_PINNED", { id, pinned }),
    "Could not change pinned state",
  ),
  delete: async (id): Promise<DeleteSavedTrailResult> => asSavedMutationResult(
    await requestHost("SAVED_DELETE", { id }),
    "Could not remove trail",
  ),
  restore: async (trail): Promise<SavedTrailMutationResult> => asSavedMutationResult(
    await requestHost("SAVED_RESTORE", { trail }),
    "Could not restore trail",
  ),
};

function currentPanelShadow(): ShadowRoot | null {
  return document.getElementById("ht-panel-host")?.shadowRoot ?? null;
}

function collectSurfaceRects(): OverlaySurfaceRect[] {
  const shadow = currentPanelShadow();
  if (!shadow) return [];
  const rects: OverlaySurfaceRect[] = [];
  let noticesRect: OverlaySurfaceRect | null = null;
  for (const element of shadow.querySelectorAll<HTMLElement>(HIT_SURFACE_SELECTOR)) {
    if (element.getClientRects().length === 0) continue;
    const rect = element.getBoundingClientRect();
    if (
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) continue;
    const surface = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    // Undo notices can coexist independently (up to the saved-trail limit).
    // They render as one compact stack, so report that stack as one hit region
    // instead of allowing ordinary rapid deletes to exceed the protocol cap.
    if (element.classList.contains("wf-notice")) {
      if (!noticesRect) {
        noticesRect = surface;
      } else {
        const left = Math.min(noticesRect.x, surface.x);
        const top = Math.min(noticesRect.y, surface.y);
        const right = Math.max(noticesRect.x + noticesRect.width, surface.x + surface.width);
        const bottom = Math.max(noticesRect.y + noticesRect.height, surface.y + surface.height);
        noticesRect = { x: left, y: top, width: right - left, height: bottom - top };
      }
      continue;
    }
    rects.push(surface);
  }
  if (noticesRect) rects.push(noticesRect);
  return rects;
}

function surfaceLayoutKey(rects: readonly OverlaySurfaceRect[]): string {
  return `${window.innerWidth}x${window.innerHeight}:` + rects.map((rect) => (
    `${rect.x.toFixed(2)},${rect.y.toFixed(2)},${rect.width.toFixed(2)},${rect.height.toFixed(2)}`
  )).join(";");
}

function uniqueRects(rects: readonly OverlaySurfaceRect[]): OverlaySurfaceRect[] {
  const seen = new Set<string>();
  const unique: OverlaySurfaceRect[] = [];
  for (const rect of rects) {
    const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(rect);
  }
  return unique;
}

function sendSurfaceRects(rects: OverlaySurfaceRect[]): void {
  if (rects.length > OVERLAY_FRAME_MAX_SURFACES) {
    postToHost({
      type: "FRAME_ERROR",
      version: OVERLAY_FRAME_PROTOCOL_VERSION,
      reason: "Overlay produced too many interaction surfaces",
    });
    return;
  }
  postToHost({
    type: "FRAME_SURFACES_UPDATED",
    version: OVERLAY_FRAME_PROTOCOL_VERSION,
    sequence: nextSurfaceSequence++,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    rects,
  });
}

function sendMeasuredSurfaceGeometry(force: boolean): void {
  const currentRects = collectSurfaceRects();
  const layoutKey = surfaceLayoutKey(currentRects);
  if (layoutKey !== previousLayoutKey) {
    const transitionalRects = uniqueRects([...previousSurfaceRects, ...currentRects]);
    sendSurfaceRects(transitionalRects);
    previousSurfaceRects = currentRects;
    previousLayoutKey = layoutKey;
    sendContractionNextFrame = true;
  } else if (force || sendContractionNextFrame) {
    sendSurfaceRects(currentRects);
    sendContractionNextFrame = false;
  }
}

function reportSurfaceGeometry(): void {
  if (!port || shuttingDown) return;
  sendMeasuredSurfaceGeometry(false);
  geometryFrame = requestAnimationFrame(reportSurfaceGeometry);
}

function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function focusableControls(): HTMLElement[] {
  const root = currentPanelShadow();
  if (!root) return [];
  const selector = [
    "button:not(:disabled)",
    "input:not(:disabled)",
    "select:not(:disabled)",
    "textarea:not(:disabled)",
    "a[href]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((element) => (
    !element.hidden && element.getClientRects().length > 0 && element.closest("[inert]") === null
  ));
}

function releaseFocusAtTabBoundary(event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const controls = focusableControls();
  const active = deepActiveElement();
  if (controls.length === 0 || !(active instanceof HTMLElement)) return;
  const atBoundary = event.shiftKey
    ? active === controls[0]
    : active === controls[controls.length - 1];
  if (!atBoundary) return;
  postToHost({
    type: "FRAME_FOCUS_OWNERSHIP",
    version: OVERLAY_FRAME_PROTOCOL_VERSION,
    owned: false,
  });
}

function triggerEvent(event: KeyboardEvent | MouseEvent): ToggleTriggerEvent {
  if (event instanceof KeyboardEvent) {
    return {
      type: "keydown",
      code: event.code,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      isTrusted: event.isTrusted,
    };
  }
  return {
    type: "mousedown",
    button: event.button,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isTrusted: event.isTrusted,
  };
}

function onFrameKeyDown(event: KeyboardEvent): void {
  releaseFocusAtTabBoundary(event);
  if (!latestSettings || !matchesToggleTrigger(triggerEvent(event), latestSettings.trigger)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void requestHost("LIVE_CLOSE", {}).catch(() => {});
}

function onFrameMouseDown(event: MouseEvent): void {
  if (!latestSettings || !matchesToggleTrigger(triggerEvent(event), latestSettings.trigger)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  swallowMouseUntil = performance.now() + MOUSE_CHORD_SWALLOW_WINDOW_MS;
  swallowedMouseButton = event.button;
  void requestHost("LIVE_CLOSE", { mouseButton: event.button }).catch(() => {});
}

function onFrameMouseFollowUp(event: MouseEvent): void {
  if (performance.now() > swallowMouseUntil) return;
  // contextmenu has no useful button identity across browsers, so only a
  // right-button chord may consume it. click/auxclick must match exactly.
  const relevant = event.type === "contextmenu"
    ? swallowedMouseButton === 2
    : event.button === swallowedMouseButton;
  if (!relevant) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function claimFocusOwnership(): void {
  postToHost({
    type: "FRAME_FOCUS_OWNERSHIP",
    version: OVERLAY_FRAME_PROTOCOL_VERSION,
    owned: true,
  });
}

function dispatchEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
  }));
}

function stopFrame(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  cancelAnimationFrame(geometryFrame);
  rejectPendingRpcs(reason);
  savedTrailSubscribers.clear();
  if (isBreadcrumbTrailOpen()) hideBreadcrumbTrail();
  port?.close();
  port = null;
}

function initializeUi(state: TrailState, settings: TabTrailSettings): void {
  if (initialized) throw new Error("Overlay frame initialized twice");
  initialized = true;
  latestSettings = settings;
  showBreadcrumbTrail(state, {
    settings,
    savedTrailsClient,
    callbacks: {
      onJump: (index) => {
        void requestHost("LIVE_JUMP", { index }).catch(() => {});
      },
      onOpenInNewTab: (index) => {
        void requestHost("LIVE_OPEN_NEW_TAB", { index }).catch(() => {});
      },
      onOpenInNewWindow: (index) => {
        void requestHost("LIVE_OPEN_NEW_WINDOW", { index }).catch(() => {});
      },
      onOpenOptions: () => {
        void requestHost("LIVE_OPEN_OPTIONS", {}).catch(() => {});
      },
      onClose: () => {
        if (!shuttingDown) void requestHost("LIVE_CLOSE", {}).catch(() => {});
      },
      onPositionChange: (position) => {
        void requestHost("LIVE_SET_POSITION", { position }).catch(() => {});
      },
    },
  });
  reportSurfaceGeometry();
}

function receiveHostMessage(received: unknown): void {
  if (!isOverlayHostToFrameMessage(received)) {
    postToHost({
      type: "FRAME_ERROR",
      version: OVERLAY_FRAME_PROTOCOL_VERSION,
      reason: "Invalid overlay host message",
    });
    stopFrame("Invalid overlay host message");
    return;
  }
  const message: OverlayHostToFrameMessage = received;
  switch (message.type) {
    case "HOST_INIT":
      try {
        initializeUi(message.state, message.settings);
      } catch (_) {
        postToHost({
          type: "FRAME_ERROR",
          version: OVERLAY_FRAME_PROTOCOL_VERSION,
          reason: "Overlay UI failed to initialize",
        });
      }
      return;
    case "HOST_TRAIL_UPDATED":
      if (initialized) updateBreadcrumbTrail(message.state);
      return;
    case "HOST_SETTINGS_UPDATED":
      latestSettings = message.settings;
      if (initialized) updateBreadcrumbTrailSettings(message.settings);
      return;
    case "HOST_SAVED_TRAILS_UPDATED":
      for (const subscriber of savedTrailSubscribers) subscriber(message.trails);
      return;
    case "HOST_RPC_RESPONSE": {
      const pending = pendingRpcs.get(message.response.requestId);
      if (!pending) return;
      if (pending.method !== message.response.method) {
        stopFrame("Overlay response method mismatch");
        return;
      }
      pendingRpcs.delete(message.response.requestId);
      window.clearTimeout(pending.timeout);
      pending.resolve(message.response.result);
      return;
    }
    case "HOST_DISMISS_TRANSIENTS":
      closeOverlaySurface("menu");
      return;
    case "HOST_FOCUS_RELEASED":
      return;
    case "HOST_REQUEST_SURFACES":
      // A hidden iframe may not receive another animation frame promptly, so
      // answer the invalidation request immediately even when layout is unchanged.
      sendMeasuredSurfaceGeometry(true);
      return;
    case "HOST_ESCAPE":
      dispatchEscape();
      return;
    case "HOST_PING":
      postToHost({
        type: "FRAME_PONG",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
        heartbeatId: message.heartbeatId,
      });
      return;
    case "HOST_SHUTDOWN":
      stopFrame(message.reason || "Overlay host closed");
      return;
  }
}

function acceptConnection(connection: OverlayFrameConnection): void {
  port = connection.port;
  for (const candidate of candidatePorts) {
    if (candidate !== port) candidate.close();
  }
  candidatePorts.clear();
  window.removeEventListener("message", onBootstrapMessage);
  port.addEventListener("message", (event) => receiveHostMessage(event.data));
  port.addEventListener("messageerror", () => stopFrame("Overlay message could not be decoded"));
  port.start();
  document.addEventListener("focusin", claimFocusOwnership, true);
  document.addEventListener("pointerdown", claimFocusOwnership, true);
  document.addEventListener("keydown", onFrameKeyDown, true);
  document.addEventListener("mousedown", onFrameMouseDown, true);
  document.addEventListener("auxclick", onFrameMouseFollowUp, true);
  document.addEventListener("click", onFrameMouseFollowUp, true);
  document.addEventListener("contextmenu", onFrameMouseFollowUp, true);
  postToHost({ type: "FRAME_READY", version: OVERLAY_FRAME_PROTOCOL_VERSION });
}

function onBootstrapMessage(event: MessageEvent): void {
  if (event.source !== window.parent || port) return;
  const connection = parseOverlayFrameConnectEvent(event);
  if (!connection) return;
  candidatePorts.add(connection.port);
  void claimOverlayFrame(connection.message.nonce).then((result) => {
    if (port || !result.ok) {
      candidatePorts.delete(connection.port);
      connection.port.close();
      return;
    }
    acceptConnection(connection);
  }).catch(() => {
    candidatePorts.delete(connection.port);
    connection.port.close();
  });
}

window.addEventListener("message", onBootstrapMessage);
