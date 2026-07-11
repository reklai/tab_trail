// Isolated extension-origin renderer for the in-page trail. It remains inert
// until the background verifies the parent content script's one-time nonce;
// after that, a private MessagePort carries all state and privileged requests.

import { claimOverlayFrame } from "../../lib/adapters/runtime/tabtrailApi";
import {
  isOverlayHostToFrameMessage,
  OVERLAY_FRAME_PROTOCOL_VERSION,
  parseOverlayFrameConnectEvent,
  type OverlayFrameConnection,
  type OverlayFrameToHostMessage,
  type OverlayHostToFrameMessage,
} from "../../lib/common/contracts/overlayFrame";
import { installMouseChordGuard } from "../../lib/common/utils/mouseChordGuard";
import {
  matchesToggleTrigger,
  toToggleTriggerEvent,
} from "../../lib/core/trail/trailCore";
import {
  hideBreadcrumbTrail,
  isBreadcrumbTrailOpen,
  showBreadcrumbTrail,
  updateBreadcrumbTrail,
  updateBreadcrumbTrailSettings,
} from "../../lib/ui/panels/breadcrumbTrail/breadcrumbTrail";
import { closeOverlaySurface } from "../../lib/ui/panels/breadcrumbTrail/overlaySurfaces";
import {
  createSavedTrailsController,
  type SavedTrailsUiController,
} from "../../lib/ui/panels/breadcrumbTrail/savedTrailsSession";
import { createOverlayFrameGeometry } from "./overlayFrameGeometry";
import { createOverlayFrameHostClient } from "./overlayFrameHostClient";

let port: MessagePort | null = null;
let initialized = false;
let shuttingDown = false;
/** Suppress LIVE_CLOSE when the host is hibernating us (host already knows). */
let hibernating = false;
let latestSettings: TabTrailSettings | null = null;
const mouseChordGuard = installMouseChordGuard(document);
const candidatePorts = new Set<MessagePort>();
/** Document-lifetime controller so pending mutations survive hibernate remounts. */
const savedTrailsController: SavedTrailsUiController = createSavedTrailsController();

function isActive(): boolean {
  return port !== null && !shuttingDown;
}

function postToHost(message: OverlayFrameToHostMessage): void {
  if (!port) return;
  port.postMessage(message);
}

const hostClient = createOverlayFrameHostClient({
  postToHost,
  isActive,
});

const geometry = createOverlayFrameGeometry({
  postToHost,
  isActive,
  panelShadow: () => document.getElementById("ht-panel-host")?.shadowRoot ?? null,
});

function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function focusableControls(): HTMLElement[] {
  const root = document.getElementById("ht-panel-host")?.shadowRoot ?? null;
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

function onFrameKeyDown(event: KeyboardEvent): void {
  releaseFocusAtTabBoundary(event);
  if (!latestSettings || !matchesToggleTrigger(toToggleTriggerEvent(event), latestSettings.trigger)) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  void hostClient.requestHost("LIVE_CLOSE", {}).catch(() => {});
}

function onFrameMouseDown(event: MouseEvent): void {
  if (!latestSettings || !matchesToggleTrigger(toToggleTriggerEvent(event), latestSettings.trigger)) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  mouseChordGuard.arm(event.button);
  void hostClient.requestHost("LIVE_CLOSE", { mouseButton: event.button }).catch(() => {});
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
  geometry.dispose();
  mouseChordGuard.dispose();
  hostClient.rejectPending(reason);
  hostClient.clearSavedTrailSubscribers();
  if (isBreadcrumbTrailOpen()) hideBreadcrumbTrail();
  port?.close();
  port = null;
}

function mountTrailUi(state: TrailState, settings: TabTrailSettings): void {
  latestSettings = settings;
  if (isBreadcrumbTrailOpen()) {
    updateBreadcrumbTrail(state);
    updateBreadcrumbTrailSettings(settings);
    geometry.sendImmediately(true);
    return;
  }
  showBreadcrumbTrail(state, {
    settings,
    savedTrailsClient: hostClient.savedTrailsClient,
    savedTrailsController,
    callbacks: {
      onJump: (index) => {
        void hostClient.requestHost("LIVE_JUMP", { index }).catch(() => {});
      },
      onOpenInNewTab: (index) => {
        void hostClient.requestHost("LIVE_OPEN_NEW_TAB", { index }).catch(() => {});
      },
      onOpenInNewWindow: (index) => {
        void hostClient.requestHost("LIVE_OPEN_NEW_WINDOW", { index }).catch(() => {});
      },
      onOpenOptions: () => {
        void hostClient.requestHost("LIVE_OPEN_OPTIONS", {}).catch(() => {});
      },
      onClose: () => {
        if (!shuttingDown && !hibernating) {
          void hostClient.requestHost("LIVE_CLOSE", {}).catch(() => {});
        }
      },
      onPositionChange: (position) => {
        void hostClient.requestHost("LIVE_SET_POSITION", { position }).catch(() => {});
      },
    },
  });
  geometry.installObservers();
  geometry.sendImmediately(true);
}

/** Seed host protocol state only — never mount DOM (HOST_SHOW owns paint). */
function seedHostState(settings: TabTrailSettings): void {
  if (initialized) throw new Error("Overlay frame initialized twice");
  initialized = true;
  latestSettings = settings;
}

function hibernateUi(): void {
  hibernating = true;
  try {
    if (isBreadcrumbTrailOpen()) hideBreadcrumbTrail();
  } finally {
    hibernating = false;
  }
  geometry.reset();
  // Empty surfaces so a leftover clip-path cannot keep host hit-testing alive.
  geometry.sendEmpty();
}

// Host→frame boundary is intentionally hard: invalid or mismatched host traffic
// is a session integrity failure (FRAME_ERROR + stopFrame). Host-side geometry
// edges prefer soft resync; see overlayFrameController receiveFrameMessage.
// HOST_INIT marks initialized + settings only; trail DOM mounts only on HOST_SHOW.
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
        seedHostState(message.settings);
      } catch (_) {
        postToHost({
          type: "FRAME_ERROR",
          version: OVERLAY_FRAME_PROTOCOL_VERSION,
          reason: "Overlay UI failed to initialize",
        });
      }
      return;
    case "HOST_SHOW":
      try {
        if (!initialized) {
          // Defensive: cold open always sends INIT first; tolerate SHOW alone.
          seedHostState(message.settings);
        }
        mountTrailUi(message.state, message.settings);
      } catch (_) {
        postToHost({
          type: "FRAME_ERROR",
          version: OVERLAY_FRAME_PROTOCOL_VERSION,
          reason: "Overlay UI failed to show",
        });
      }
      return;
    case "HOST_HIBERNATE":
      hibernateUi();
      return;
    case "HOST_TRAIL_UPDATED":
      if (initialized && isBreadcrumbTrailOpen()) {
        updateBreadcrumbTrail(message.state);
        geometry.schedule();
      }
      return;
    case "HOST_SETTINGS_UPDATED":
      latestSettings = message.settings;
      if (initialized && isBreadcrumbTrailOpen()) {
        updateBreadcrumbTrailSettings(message.settings);
        geometry.schedule();
      }
      return;
    case "HOST_SAVED_TRAILS_UPDATED":
      hostClient.notifySavedTrails(message.trails);
      geometry.schedule();
      return;
    case "HOST_RPC_RESPONSE": {
      const status = hostClient.resolveRpcResponse(
        message.response.requestId,
        message.response.method,
        message.response.result,
      );
      if (status === "method-mismatch") {
        stopFrame("Overlay response method mismatch");
      }
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
      geometry.sendImmediately(true);
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
