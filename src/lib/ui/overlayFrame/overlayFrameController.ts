// Page-side owner for the isolated overlay browsing context. The host page can
// neither observe nor cancel events dispatched inside the extension iframe;
// clipping the iframe to the reported UI surfaces keeps the rest of the page
// interactive.

import browser from "webextension-polyfill";
import { browserSavedTrailsClient } from "../../adapters/runtime/savedTrailsClient";
import {
  jumpToTrailEntry,
  openTabTrailOptions,
  openTrailEntryInNewTab,
  openTrailEntryInNewWindow,
  reportTrailOverlayState,
} from "../../adapters/runtime/tabtrailApi";
import {
  isOverlayFrameToHostMessage,
  OVERLAY_FRAME_PROTOCOL_VERSION,
  type OverlayFrameConnectMessage,
  type OverlayFrameToHostMessage,
  type OverlayHostToFrameMessage,
  type OverlayRpcMethod,
  type OverlayRpcRequest,
  type OverlayRpcResponse,
  type OverlayRpcResultMap,
} from "../../common/contracts/overlayFrame";
import {
  OVERLAY_EMPTY_CLIP_PATH,
  validateSurfaceUpdate,
} from "./surfaceGeometry";

const FRAME_HOST_ID = "tabtrail-isolated-overlay-host";
const FRAME_DOCUMENT_PATH = "overlayFrame/overlayFrame.html";
const STARTUP_TIMEOUT_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 2000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const VIEWPORT_TOLERANCE_PX = 1;
// The frame is removed as soon as a close RPC completes. Preserve its matched
// mouse-chord guard on the host long enough for click/auxclick/contextmenu,
// which browsers may retarget to the newly exposed page.
const MOUSE_CHORD_SWALLOW_WINDOW_MS = 600;

interface OverlayFrameControllerOptions {
  onPositionChange: (position: TabTrailOverlayPosition) => void | Promise<void>;
}

interface OverlayFrameSession {
  generation: number;
  nonce: string;
  host: HTMLDivElement;
  shadow: ShadowRoot;
  frame: HTMLIFrameElement;
  state: TrailState;
  settings: TabTrailSettings;
  port: MessagePort | null;
  ready: boolean;
  claimed: boolean;
  connected: boolean;
  focusOwned: boolean;
  lastRequestId: number;
  lastSequence: number | null;
  lastPongAt: number;
  heartbeatId: number;
  startupTimer: number;
  heartbeatTimer: number;
  unsubscribeSavedTrails: (() => void) | null;
  reportedOpen: boolean;
  settled: boolean;
  resolveOpened: (opened: boolean) => void;
  opened: Promise<boolean>;
  lastPageFocus: HTMLElement | null;
  cleanupPageListeners: () => void;
}

export interface OverlayFrameController {
  isOpen(): boolean;
  open(state: TrailState, settings: TabTrailSettings): Promise<boolean>;
  close(reason?: string): void;
  updateTrail(state: TrailState): void;
  updateSettings(settings: TabTrailSettings): void;
  authorizeClaim(nonce: string): TabTrailActionResult;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function setImportantStyle(element: HTMLElement, property: string, value: string): void {
  element.style.setProperty(property, value, "important");
}

function createFrameHost(frameUrl: string): {
  host: HTMLDivElement;
  shadow: ShadowRoot;
  frame: HTMLIFrameElement;
} {
  document.getElementById(FRAME_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = FRAME_HOST_ID;
  setImportantStyle(host, "all", "initial");
  setImportantStyle(host, "position", "fixed");
  setImportantStyle(host, "inset", "0");
  setImportantStyle(host, "width", "100vw");
  setImportantStyle(host, "height", "100vh");
  setImportantStyle(host, "z-index", "2147483647");
  setImportantStyle(host, "pointer-events", "none");
  setImportantStyle(host, "overflow", "hidden");
  setImportantStyle(host, "background", "transparent");
  setImportantStyle(host, "border", "0");
  setImportantStyle(host, "margin", "0");
  setImportantStyle(host, "padding", "0");
  setImportantStyle(host, "color-scheme", "dark");

  const shadow = host.attachShadow({ mode: "closed" });
  const frame = document.createElement("iframe");
  frame.title = "TabTrail navigation overlay";
  frame.tabIndex = 0;
  frame.setAttribute("aria-label", "TabTrail navigation overlay");
  setImportantStyle(frame, "position", "fixed");
  setImportantStyle(frame, "inset", "0");
  setImportantStyle(frame, "width", "100vw");
  setImportantStyle(frame, "height", "100vh");
  setImportantStyle(frame, "border", "0");
  setImportantStyle(frame, "margin", "0");
  setImportantStyle(frame, "padding", "0");
  setImportantStyle(frame, "background", "transparent");
  setImportantStyle(frame, "pointer-events", "none");
  setImportantStyle(frame, "visibility", "hidden");
  setImportantStyle(frame, "clip-path", OVERLAY_EMPTY_CLIP_PATH);
  setImportantStyle(frame, "overscroll-behavior", "none");
  frame.src = frameUrl;
  shadow.appendChild(frame);
  (document.documentElement || document.body).appendChild(host);

  const popoverHost = host as HTMLDivElement & {
    popover?: string | null;
    showPopover?: () => void;
  };
  if (typeof popoverHost.showPopover === "function") {
    try {
      popoverHost.popover = "manual";
      popoverHost.showPopover();
    } catch (_) {
      popoverHost.removeAttribute("popover");
    }
  }
  return { host, shadow, frame };
}

function activeElementBelongsToFrame(session: OverlayFrameSession): boolean {
  return session.shadow.activeElement === session.frame || document.activeElement === session.host;
}

function restorablePageElement(element: HTMLElement | null): element is HTMLElement {
  return element !== null &&
    element.isConnected &&
    !element.matches(":disabled") &&
    element.closest("[inert]") === null;
}

function actionFailure(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export function createOverlayFrameController(
  options: OverlayFrameControllerOptions,
): OverlayFrameController {
  let session: OverlayFrameSession | null = null;
  let nextGeneration = 0;
  let clearMouseFollowUpShield: (() => void) | null = null;

  const armMouseFollowUpShield = (mouseButton: number): void => {
    clearMouseFollowUpShield?.();
    const swallowUntil = performance.now() + MOUSE_CHORD_SWALLOW_WINDOW_MS;
    let cleanupTimer = 0;
    const onMouseFollowUp = (event: MouseEvent): void => {
      if (performance.now() > swallowUntil) return;
      const relevant = event.type === "contextmenu"
        ? mouseButton === 2
        : event.button === mouseButton;
      if (!relevant) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const clear = (): void => {
      window.clearTimeout(cleanupTimer);
      window.removeEventListener("auxclick", onMouseFollowUp, true);
      window.removeEventListener("click", onMouseFollowUp, true);
      window.removeEventListener("contextmenu", onMouseFollowUp, true);
      if (clearMouseFollowUpShield === clear) clearMouseFollowUpShield = null;
    };
    clearMouseFollowUpShield = clear;
    window.addEventListener("auxclick", onMouseFollowUp, true);
    window.addEventListener("click", onMouseFollowUp, true);
    window.addEventListener("contextmenu", onMouseFollowUp, true);
    cleanupTimer = window.setTimeout(clear, MOUSE_CHORD_SWALLOW_WINDOW_MS);
  };

  const postToFrame = (current: OverlayFrameSession, message: OverlayHostToFrameMessage): void => {
    if (session !== current || !current.port) return;
    current.port.postMessage(message);
  };

  const settleOpened = (current: OverlayFrameSession, opened: boolean): void => {
    if (current.settled) return;
    current.settled = true;
    current.resolveOpened(opened);
  };

  const teardown = (current: OverlayFrameSession, reason = "Overlay closed"): void => {
    if (session !== current) return;
    const restoreTarget = current.lastPageFocus;
    const restoreFocus = activeElementBelongsToFrame(current);
    session = null;
    settleOpened(current, false);
    window.clearTimeout(current.startupTimer);
    window.clearInterval(current.heartbeatTimer);
    current.cleanupPageListeners();
    current.unsubscribeSavedTrails?.();
    current.unsubscribeSavedTrails = null;
    if (current.port) {
      try {
        current.port.postMessage({
          type: "HOST_SHUTDOWN",
          version: OVERLAY_FRAME_PROTOCOL_VERSION,
          reason,
        } satisfies OverlayHostToFrameMessage);
      } catch (_) {
        // The frame or its browsing context already disappeared.
      }
      current.port.close();
      current.port = null;
    }
    current.host.remove();
    if (current.reportedOpen) {
      void reportTrailOverlayState(false).catch(() => {});
    }
    if (restoreFocus && restorablePageElement(restoreTarget)) {
      requestAnimationFrame(() => {
        if (!restorablePageElement(restoreTarget) || document.activeElement !== document.body) return;
        restoreTarget.focus({ preventScroll: true });
      });
    }
  };

  const closeCurrent = (reason?: string): void => {
    if (session) teardown(session, reason);
  };

  const normalizeAction = async (
    operation: () => Promise<TabTrailActionResult>,
    fallback: string,
  ): Promise<TabTrailActionResult> => {
    try {
      return await operation();
    } catch (_) {
      return actionFailure(fallback);
    }
  };

  const rpcResponse = <M extends OverlayRpcMethod>(
    request: OverlayRpcRequest<M>,
    result: OverlayRpcResultMap[M],
  ): OverlayRpcResponse =>
    ({
      requestId: request.requestId,
      method: request.method,
      result,
    }) as OverlayRpcResponse;

  const runRpc = async <M extends OverlayRpcMethod>(
    request: OverlayRpcRequest<M>,
    operation: () => Promise<OverlayRpcResultMap[M]>,
    fallback: string,
  ): Promise<OverlayRpcResponse> => {
    try {
      return rpcResponse(request, await operation());
    } catch (_) {
      return rpcResponse(request, actionFailure(fallback) as OverlayRpcResultMap[M]);
    }
  };

  const executeRpc = async (request: OverlayRpcRequest): Promise<OverlayRpcResponse> => {
    switch (request.method) {
      case "LIVE_JUMP":
        return runRpc(
          request,
          () => normalizeAction(
            () => jumpToTrailEntry(request.params.index),
            "Could not navigate to that trail entry",
          ),
          "Could not navigate to that trail entry",
        );
      case "LIVE_OPEN_NEW_TAB":
        return runRpc(
          request,
          () => normalizeAction(
            () => openTrailEntryInNewTab(request.params.index),
            "Could not open that entry in a new tab",
          ),
          "Could not open that entry in a new tab",
        );
      case "LIVE_OPEN_NEW_WINDOW":
        return runRpc(
          request,
          () => normalizeAction(
            () => openTrailEntryInNewWindow(request.params.index),
            "Could not open that entry in a new window",
          ),
          "Could not open that entry in a new window",
        );
      case "LIVE_OPEN_OPTIONS":
        return runRpc(
          request,
          () => normalizeAction(openTabTrailOptions, "Settings unavailable"),
          "Settings unavailable",
        );
      case "LIVE_CLOSE":
        return rpcResponse(request, { ok: true });
      case "LIVE_SET_POSITION":
        return runRpc(
          request,
          async () => {
            await options.onPositionChange(request.params.position);
            return { ok: true };
          },
          "Could not save overlay position",
        );
      case "SAVED_LOAD":
        return runRpc(
          request,
          async () => ({ ok: true, trails: await browserSavedTrailsClient.load() }),
          "Could not load saved trails",
        );
      case "SAVED_OPEN":
        return runRpc(
          request,
          () => normalizeAction(
            () => browserSavedTrailsClient.open(request.params.path, request.params.mode),
            "Could not open saved trail",
          ),
          "Could not open saved trail",
        );
      case "SAVED_SAVE":
        return runRpc(
          request,
          () => browserSavedTrailsClient.save(request.params.path, request.params.name),
          "Could not save trail",
        );
      case "SAVED_RENAME":
        return runRpc(
          request,
          () => browserSavedTrailsClient.rename(request.params.id, request.params.name),
          "Could not rename trail",
        );
      case "SAVED_REPLACE":
        return runRpc(
          request,
          () => browserSavedTrailsClient.replace(
            request.params.id,
            request.params.path,
            request.params.expectedPath,
          ),
          "Could not update trail",
        );
      case "SAVED_SET_PINNED":
        return runRpc(
          request,
          () => browserSavedTrailsClient.setPinned(request.params.id, request.params.pinned),
          "Could not change pinned state",
        );
      case "SAVED_DELETE":
        return runRpc(
          request,
          () => browserSavedTrailsClient.delete(request.params.id),
          "Could not remove trail",
        );
      case "SAVED_RESTORE":
        return runRpc(
          request,
          () => browserSavedTrailsClient.restore(request.params.trail),
          "Could not restore trail",
        );
    }
  };

  const installPageListeners = (current: OverlayFrameSession): (() => void) => {
    const onPointerDown = (): void => {
      if (session !== current) return;
      current.focusOwned = false;
      postToFrame(current, {
        type: "HOST_FOCUS_RELEASED",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
      });
      postToFrame(current, {
        type: "HOST_DISMISS_TRANSIENTS",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
      });
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (session !== current) return;
      if (event.target instanceof HTMLElement && event.target !== current.host) {
        current.lastPageFocus = event.target;
      }
      if (!current.focusOwned || !document.hasFocus()) return;
      requestAnimationFrame(() => {
        if (session !== current || !current.focusOwned || !document.hasFocus()) return;
        current.frame.focus({ preventScroll: true });
      });
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (session !== current || event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      postToFrame(current, {
        type: "HOST_ESCAPE",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
      } as OverlayHostToFrameMessage);
    };
    const invalidateGeometry = (): void => {
      if (session !== current) return;
      setImportantStyle(current.frame, "visibility", "hidden");
      setImportantStyle(current.frame, "pointer-events", "none");
      setImportantStyle(current.frame, "clip-path", OVERLAY_EMPTY_CLIP_PATH);
      postToFrame(current, {
        type: "HOST_REQUEST_SURFACES",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
      });
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", invalidateGeometry);
    window.visualViewport?.addEventListener("resize", invalidateGeometry);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", invalidateGeometry);
      window.visualViewport?.removeEventListener("resize", invalidateGeometry);
    };
  };

  const receiveFrameMessage = (
    current: OverlayFrameSession,
    received: unknown,
  ): void => {
    if (session !== current) return;
    if (!isOverlayFrameToHostMessage(received)) {
      teardown(current, "Invalid overlay frame message");
      return;
    }
    const message: OverlayFrameToHostMessage = received;
    switch (message.type) {
      case "FRAME_READY":
        if (!current.claimed || current.ready) {
          teardown(current, "Unexpected overlay frame readiness");
          return;
        }
        current.ready = true;
        postToFrame(current, {
          type: "HOST_INIT",
          version: OVERLAY_FRAME_PROTOCOL_VERSION,
          state: current.state,
          settings: current.settings,
        });
        return;
      case "FRAME_RPC_REQUEST":
        if (message.request.requestId <= current.lastRequestId) {
          teardown(current, "Duplicate or stale overlay request");
          return;
        }
        current.lastRequestId = message.request.requestId;
        if (
          message.request.method === "LIVE_CLOSE" &&
          message.request.params.mouseButton !== undefined
        ) {
          armMouseFollowUpShield(message.request.params.mouseButton);
        }
        void executeRpc(message.request).then((response) => {
          if (session !== current) return;
          postToFrame(current, {
            type: "HOST_RPC_RESPONSE",
            version: OVERLAY_FRAME_PROTOCOL_VERSION,
            response,
          });
          if (message.request.method === "LIVE_CLOSE") {
            queueMicrotask(() => teardown(current));
          }
        });
        return;
      case "FRAME_SURFACES_UPDATED": {
        const frameWidth = current.frame.clientWidth || window.innerWidth;
        const frameHeight = current.frame.clientHeight || window.innerHeight;
        if (
          Math.abs(message.viewportWidth - frameWidth) > VIEWPORT_TOLERANCE_PX ||
          Math.abs(message.viewportHeight - frameHeight) > VIEWPORT_TOLERANCE_PX
        ) {
          setImportantStyle(current.frame, "visibility", "hidden");
          setImportantStyle(current.frame, "pointer-events", "none");
          return;
        }
        const validated = validateSurfaceUpdate(
          {
            sequence: message.sequence,
            viewportWidth: frameWidth,
            viewportHeight: frameHeight,
            rects: message.rects,
          },
          { width: frameWidth, height: frameHeight },
          current.lastSequence,
        );
        if (!validated.ok) {
          teardown(current, `Invalid overlay geometry: ${validated.reason}`);
          return;
        }
        current.lastSequence = validated.value.sequence;
        if (validated.value.rects.length === 0) {
          setImportantStyle(current.frame, "visibility", "hidden");
          setImportantStyle(current.frame, "pointer-events", "none");
          setImportantStyle(current.frame, "clip-path", OVERLAY_EMPTY_CLIP_PATH);
          return;
        }
        if (
          typeof CSS === "undefined" ||
          typeof CSS.supports !== "function" ||
          !CSS.supports("clip-path", validated.value.clipPath)
        ) {
          teardown(current, "Browser does not support isolated overlay hit testing");
          return;
        }
        setImportantStyle(current.frame, "clip-path", validated.value.clipPath);
        setImportantStyle(current.frame, "visibility", "visible");
        setImportantStyle(current.frame, "pointer-events", "auto");
        // Surfaces are live: settle the open Promise. Overlay-open was already
        // reported when the session started so TRAIL_UPDATED is not dropped
        // during the iframe handshake.
        if (!current.settled) {
          window.clearTimeout(current.startupTimer);
          settleOpened(current, true);
        }
        return;
      }
      case "FRAME_FOCUS_OWNERSHIP":
        current.focusOwned = message.owned;
        if (message.owned && document.hasFocus()) {
          current.frame.focus({ preventScroll: true });
        }
        return;
      case "FRAME_PONG":
        if (message.heartbeatId === current.heartbeatId) {
          current.lastPongAt = performance.now();
        }
        return;
      case "FRAME_ERROR":
        teardown(current, message.reason || "Overlay frame error");
        return;
    }
  };

  const open = (state: TrailState, settings: TabTrailSettings): Promise<boolean> => {
    if (session) return session.opened;
    const frameUrl = browser.runtime.getURL(FRAME_DOCUMENT_PATH);
    const { host, shadow, frame } = createFrameHost(frameUrl);
    const active = document.activeElement;
    let resolveOpened = (_opened: boolean): void => {};
    const opened = new Promise<boolean>((resolve) => {
      resolveOpened = resolve;
    });
    const current: OverlayFrameSession = {
      generation: ++nextGeneration,
      nonce: randomNonce(),
      host,
      shadow,
      frame,
      state,
      settings,
      port: null,
      ready: false,
      claimed: false,
      connected: false,
      focusOwned: false,
      lastRequestId: 0,
      lastSequence: null,
      lastPongAt: performance.now(),
      heartbeatId: 0,
      startupTimer: 0,
      heartbeatTimer: 0,
      unsubscribeSavedTrails: null,
      reportedOpen: false,
      settled: false,
      resolveOpened,
      opened,
      lastPageFocus: active instanceof HTMLElement ? active : null,
      cleanupPageListeners: () => {},
    };
    session = current;
    // Report open as soon as the host session exists so the background keeps
    // pushing TRAIL_UPDATED. updateTrail always writes session.state; HOST_INIT
    // and later HOST_TRAIL_UPDATED deliver the latest snapshot once the port
    // is ready. Teardown reports closed if this early report ran.
    current.reportedOpen = true;
    void reportTrailOverlayState(true).catch(() => {});
    current.cleanupPageListeners = installPageListeners(current);
    current.unsubscribeSavedTrails = browserSavedTrailsClient.subscribe((trails) => {
      postToFrame(current, {
        type: "HOST_SAVED_TRAILS_UPDATED",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
        trails,
      });
    });

    frame.addEventListener("error", () => teardown(current, "Overlay frame failed to load"), {
      once: true,
    });
    frame.addEventListener("load", () => {
      if (session !== current || current.connected || !frame.contentWindow) {
        if (session === current) teardown(current, "Overlay frame reloaded unexpectedly");
        return;
      }
      current.connected = true;
      const channel = new MessageChannel();
      current.port = channel.port1;
      current.port.addEventListener("message", (event) => {
        receiveFrameMessage(current, event.data);
      });
      current.port.addEventListener("messageerror", () => {
        teardown(current, "Overlay frame message could not be decoded");
      });
      current.port.start();
      const connect: OverlayFrameConnectMessage = {
        type: "TABTRAIL_OVERLAY_CONNECT",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
        nonce: current.nonce,
      };
      try {
        frame.contentWindow.postMessage(connect, new URL(frame.src).origin, [channel.port2]);
      } catch (_) {
        teardown(current, "Overlay frame connection failed");
      }
    });
    current.startupTimer = window.setTimeout(() => {
      teardown(current, "Overlay frame startup timed out");
    }, STARTUP_TIMEOUT_MS);
    current.heartbeatTimer = window.setInterval(() => {
      if (session !== current || !current.ready) return;
      if (performance.now() - current.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        teardown(current, "Overlay frame stopped responding");
        return;
      }
      current.heartbeatId += 1;
      postToFrame(current, {
        type: "HOST_PING",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
        heartbeatId: current.heartbeatId,
      });
    }, HEARTBEAT_INTERVAL_MS);
    return opened;
  };

  return {
    isOpen: () => session !== null,
    open,
    close: closeCurrent,
    updateTrail: (state) => {
      if (!session) return;
      session.state = state;
      postToFrame(session, {
        type: "HOST_TRAIL_UPDATED",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
        state,
      });
    },
    updateSettings: (settings) => {
      if (!session) return;
      session.settings = settings;
      postToFrame(session, {
        type: "HOST_SETTINGS_UPDATED",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
        settings,
      });
    },
    authorizeClaim: (nonce) => {
      if (!session || session.nonce !== nonce || session.claimed || !session.connected) {
        return actionFailure("Overlay frame authentication failed");
      }
      session.claimed = true;
      return { ok: true };
    },
  };
}
