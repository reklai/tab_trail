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
import { installMouseChordGuard } from "../../common/utils/mouseChordGuard";
import { MOUSE_CHORD_SWALLOW_WINDOW_MS } from "../../core/trail/trailCore";
import {
  OVERLAY_EMPTY_CLIP_PATH,
  validateSurfaceUpdate,
} from "./surfaceGeometry";

const FRAME_HOST_ID = "tabtrail-isolated-overlay-host";
const FRAME_DOCUMENT_PATH = "overlayFrame/overlayFrame.html";
const STARTUP_TIMEOUT_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 2000;
const HEARTBEAT_MISS_LIMIT = 3;
const VIEWPORT_TOLERANCE_PX = 1;

interface OverlayFrameControllerOptions {
  onPositionChange: (position: TabTrailOverlayPosition) => void | Promise<void>;
}

type OverlayOpenKind = "cold" | "warm";

interface OverlayOpenAttempt {
  hostStartedAt: number;
  requestedAtEpochMs?: number;
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
  /** True while the trail UI is visible to the user (not warm-hibernated). */
  visible: boolean;
  focusOwned: boolean;
  lastRequestId: number;
  lastSequence: number | null;
  lastPongAt: number;
  missedHeartbeats: number;
  heartbeatId: number;
  startupTimer: number;
  heartbeatTimer: number;
  unsubscribeSavedTrails: (() => void) | null;
  reportedOpen: boolean;
  settled: boolean;
  resolveOpened: (opened: boolean) => void;
  opened: Promise<boolean>;
  pendingOpenAttempt: OverlayOpenAttempt | null;
  lastPageFocus: HTMLElement | null;
  cleanupPageListeners: () => void;
}

function hideFrameSurface(frame: HTMLIFrameElement): void {
  setImportantStyle(frame, "visibility", "hidden");
  setImportantStyle(frame, "pointer-events", "none");
  setImportantStyle(frame, "clip-path", OVERLAY_EMPTY_CLIP_PATH);
}

/** Explicit close intent: hibernate keeps the frame warm; destroy tears it down. */
export type OverlayCloseRequest =
  | { mode: "hibernate" }
  | { mode: "destroy"; reason: string };

export interface OverlayFrameController {
  isOpen(): boolean;
  open(
    state: TrailState,
    settings: TabTrailSettings,
    requestedAtEpochMs?: number,
  ): Promise<boolean>;
  close(request?: OverlayCloseRequest): void;
  /** Drop host-lifetime listeners (mouse follow-up shield). */
  dispose(): void;
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
  setImportantStyle(host, "outline", "0");
  setImportantStyle(host, "box-shadow", "none");
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
  setImportantStyle(frame, "outline", "0");
  setImportantStyle(frame, "box-shadow", "none");
  setImportantStyle(frame, "display", "block");
  setImportantStyle(frame, "margin", "0");
  setImportantStyle(frame, "padding", "0");
  // Geometry updates briefly expose the union of old and new surface bounds,
  // and merged bounds can contain intentional gaps. Those pixels must reveal
  // the page; each rendered overlay surface supplies its own background.
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
  let nextOpenSequence = 0;
  // Host-side guard outlives the iframe after a mouse-triggered close so
  // click/auxclick/contextmenu retargeted to the page stay swallowed. One
  // guard for the controller lifetime; arm() on close, dispose() on teardown.
  const mouseFollowUpGuard = installMouseChordGuard(window);
  let mouseFollowUpGuardTimer = 0;
  let disposed = false;

  const armMouseFollowUpShield = (mouseButton: number): void => {
    if (disposed) return;
    window.clearTimeout(mouseFollowUpGuardTimer);
    mouseFollowUpGuard.arm(mouseButton);
    mouseFollowUpGuardTimer = window.setTimeout(() => {
      mouseFollowUpGuardTimer = 0;
    }, MOUSE_CHORD_SWALLOW_WINDOW_MS);
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

  const beginOpenMetrics = (
    current: OverlayFrameSession,
    kind: OverlayOpenKind,
    hostStartedAt: number,
    requestedAtEpochMs?: number,
  ): void => {
    const validRequestedAt = Number.isFinite(requestedAtEpochMs)
      ? requestedAtEpochMs
      : undefined;
    current.pendingOpenAttempt = {
      hostStartedAt,
      ...(validRequestedAt !== undefined ? { requestedAtEpochMs: validRequestedAt } : {}),
    };
    current.host.setAttribute("data-tabtrail-open-sequence", String(++nextOpenSequence));
    current.host.setAttribute("data-tabtrail-open-kind", kind);
    current.host.removeAttribute("data-tabtrail-host-open-latency-ms");
    current.host.removeAttribute("data-tabtrail-toggle-latency-ms");
  };

  const settleOpenMetrics = (current: OverlayFrameSession): void => {
    const attempt = current.pendingOpenAttempt;
    if (!attempt) return;
    current.pendingOpenAttempt = null;
    const settledAt = performance.now();
    const hostLatency = settledAt - attempt.hostStartedAt;
    if (Number.isFinite(hostLatency) && hostLatency >= 0) {
      current.host.setAttribute(
        "data-tabtrail-host-open-latency-ms",
        hostLatency.toFixed(2),
      );
    }
    if (attempt.requestedAtEpochMs === undefined) return;
    const toggleLatency = performance.timeOrigin + settledAt - attempt.requestedAtEpochMs;
    if (Number.isFinite(toggleLatency) && toggleLatency >= 0) {
      current.host.setAttribute(
        "data-tabtrail-toggle-latency-ms",
        toggleLatency.toFixed(2),
      );
    }
  };

  const reportOpenState = (current: OverlayFrameSession, open: boolean): void => {
    if (current.reportedOpen === open) return;
    current.reportedOpen = open;
    void reportTrailOverlayState(open).catch(() => {});
  };

  const restorePageFocusIfNeeded = (
    current: OverlayFrameSession,
    restoreFocus: boolean,
  ): void => {
    const restoreTarget = current.lastPageFocus;
    if (restoreFocus && restorablePageElement(restoreTarget)) {
      requestAnimationFrame(() => {
        if (!restorablePageElement(restoreTarget) || document.activeElement !== document.body) return;
        restoreTarget.focus({ preventScroll: true });
      });
    }
  };

  const hibernate = (current: OverlayFrameSession): void => {
    if (session !== current || !current.visible) return;
    const restoreFocus = activeElementBelongsToFrame(current);
    current.visible = false;
    current.focusOwned = false;
    current.pendingOpenAttempt = null;
    settleOpened(current, false);
    window.clearTimeout(current.startupTimer);
    current.startupTimer = 0;
    current.cleanupPageListeners();
    current.cleanupPageListeners = () => {};
    hideFrameSurface(current.frame);
    postToFrame(current, {
      type: "HOST_HIBERNATE",
      version: OVERLAY_FRAME_PROTOCOL_VERSION,
    });
    reportOpenState(current, false);
    restorePageFocusIfNeeded(current, restoreFocus);
  };

  const teardown = (current: OverlayFrameSession, reason: string): void => {
    if (session !== current) return;
    const restoreFocus = activeElementBelongsToFrame(current);
    session = null;
    current.visible = false;
    current.pendingOpenAttempt = null;
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
      current.reportedOpen = false;
    }
    restorePageFocusIfNeeded(current, restoreFocus);
  };

  const closeCurrent = (request: OverlayCloseRequest = { mode: "hibernate" }): void => {
    if (!session) return;
    if (request.mode === "destroy") teardown(session, request.reason);
    else hibernate(session);
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
      hideFrameSurface(current.frame);
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

  const requestSurfaceResync = (current: OverlayFrameSession): void => {
    if (session !== current || !current.visible) return;
    hideFrameSurface(current.frame);
    postToFrame(current, {
      type: "HOST_REQUEST_SURFACES",
      version: OVERLAY_FRAME_PROTOCOL_VERSION,
    });
  };

  const receiveFrameMessage = (
    current: OverlayFrameSession,
    received: unknown,
  ): void => {
    if (session !== current) return;
    if (!isOverlayFrameToHostMessage(received)) {
      // Soft drop: a single malformed message must not kill a live overlay.
      // Auth, startup, and heartbeat still own hard teardown.
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
        // HOST_INIT seeds protocol state only; HOST_SHOW always owns DOM mount.
        // Cold open and warm-from-loading both paint via SHOW when visible.
        postToFrame(current, {
          type: "HOST_INIT",
          version: OVERLAY_FRAME_PROTOCOL_VERSION,
          state: current.state,
          settings: current.settings,
        });
        if (current.visible) {
          postToFrame(current, {
            type: "HOST_SHOW",
            version: OVERLAY_FRAME_PROTOCOL_VERSION,
            state: current.state,
            settings: current.settings,
          });
        }
        return;
      case "FRAME_RPC_REQUEST":
        // Ignore stale/duplicate request ids rather than tearing down. A
        // reconnecting or double-posted RPC must not destroy the session.
        if (message.request.requestId <= current.lastRequestId) {
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
            queueMicrotask(() => hibernate(current));
          }
        });
        return;
      case "FRAME_SURFACES_UPDATED": {
        if (!current.visible) return;
        const frameWidth = current.frame.clientWidth || window.innerWidth;
        const frameHeight = current.frame.clientHeight || window.innerHeight;
        if (
          Math.abs(message.viewportWidth - frameWidth) > VIEWPORT_TOLERANCE_PX ||
          Math.abs(message.viewportHeight - frameHeight) > VIEWPORT_TOLERANCE_PX
        ) {
          requestSurfaceResync(current);
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
          // Stale sequences and transient geometry glitches resync; only the
          // permanent capability miss below hard-fails.
          if (validated.reason === "stale-sequence") return;
          requestSurfaceResync(current);
          return;
        }
        current.lastSequence = validated.value.sequence;
        if (validated.value.rects.length === 0) {
          hideFrameSurface(current.frame);
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
          settleOpenMetrics(current);
          settleOpened(current, true);
        }
        return;
      }
      case "FRAME_FOCUS_OWNERSHIP":
        if (!current.visible) return;
        current.focusOwned = message.owned;
        if (message.owned && document.hasFocus()) {
          current.frame.focus({ preventScroll: true });
        }
        return;
      case "FRAME_PONG":
        if (message.heartbeatId === current.heartbeatId) {
          current.lastPongAt = performance.now();
          current.missedHeartbeats = 0;
        }
        return;
      case "FRAME_ERROR":
        teardown(current, message.reason || "Overlay frame error");
        return;
    }
  };

  const beginOpenPromise = (current: OverlayFrameSession): Promise<boolean> => {
    let resolveOpened = (_opened: boolean): void => {};
    const opened = new Promise<boolean>((resolve) => {
      resolveOpened = resolve;
    });
    current.settled = false;
    current.resolveOpened = resolveOpened;
    current.opened = opened;
    current.startupTimer = window.setTimeout(() => {
      if (session !== current || current.settled) return;
      // Warm resume failure falls back to a full destroy so the next open is cold.
      teardown(current, "Overlay frame startup timed out");
    }, STARTUP_TIMEOUT_MS);
    return opened;
  };

  /** Shared path for cold start, resume-loading, and warm reopen: become visible. */
  const armVisibleSession = (
    current: OverlayFrameSession,
    state: TrailState,
    settings: TabTrailSettings,
    kind: OverlayOpenKind,
    hostStartedAt: number,
    requestedAtEpochMs: number | undefined,
  ): Promise<boolean> => {
    const active = document.activeElement;
    current.state = state;
    current.settings = settings;
    current.visible = true;
    current.focusOwned = false;
    current.lastSequence = null;
    current.lastPageFocus = active instanceof HTMLElement ? active : null;
    hideFrameSurface(current.frame);
    beginOpenMetrics(current, kind, hostStartedAt, requestedAtEpochMs);
    const opened = beginOpenPromise(current);
    reportOpenState(current, true);
    current.cleanupPageListeners = installPageListeners(current);
    return opened;
  };

  const resumeWarm = (
    current: OverlayFrameSession,
    state: TrailState,
    settings: TabTrailSettings,
    requestedAtEpochMs: number | undefined,
    hostStartedAt: number,
  ): Promise<boolean> => {
    if (!current.ready || !current.port) {
      teardown(current, "Warm overlay frame was not ready");
      return open(state, settings, requestedAtEpochMs);
    }
    const opened = armVisibleSession(
      current,
      state,
      settings,
      "warm",
      hostStartedAt,
      requestedAtEpochMs,
    );
    postToFrame(current, {
      type: "HOST_SHOW",
      version: OVERLAY_FRAME_PROTOCOL_VERSION,
      state,
      settings,
    });
    return opened;
  };

  const open = (
    state: TrailState,
    settings: TabTrailSettings,
    requestedAtEpochMs?: number,
  ): Promise<boolean> => {
    if (session) {
      if (session.visible) return session.opened;
      const hostStartedAt = performance.now();
      if (session.ready) {
        return resumeWarm(session, state, settings, requestedAtEpochMs, hostStartedAt);
      }
      // Frame is loading; arm visibility and paint when FRAME_READY arrives.
      return armVisibleSession(
        session,
        state,
        settings,
        "cold",
        hostStartedAt,
        requestedAtEpochMs,
      );
    }
    const hostStartedAt = performance.now();
    const frameUrl = browser.runtime.getURL(FRAME_DOCUMENT_PATH);
    const { host, shadow, frame } = createFrameHost(frameUrl);
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
      visible: false,
      focusOwned: false,
      lastRequestId: 0,
      lastSequence: null,
      lastPongAt: performance.now(),
      missedHeartbeats: 0,
      heartbeatId: 0,
      startupTimer: 0,
      heartbeatTimer: 0,
      unsubscribeSavedTrails: null,
      reportedOpen: false,
      settled: false,
      resolveOpened: () => {},
      opened: Promise.resolve(false),
      pendingOpenAttempt: null,
      lastPageFocus: null,
      cleanupPageListeners: () => {},
    };
    session = current;
    const opened = armVisibleSession(
      current,
      state,
      settings,
      "cold",
      hostStartedAt,
      requestedAtEpochMs,
    );
    // Report open as soon as the host session exists so the background keeps
    // pushing TRAIL_UPDATED. updateTrail always writes session.state; HOST_INIT
    // and later HOST_TRAIL_UPDATED deliver the latest snapshot once the port
    // is ready. Teardown reports closed if this early report ran.
    current.unsubscribeSavedTrails = browserSavedTrailsClient.subscribe((trails) => {
      if (!current.visible) return;
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
    current.heartbeatTimer = window.setInterval(() => {
      if (session !== current || !current.ready) return;
      if (performance.now() - current.lastPongAt > HEARTBEAT_INTERVAL_MS) {
        current.missedHeartbeats += 1;
        if (current.missedHeartbeats >= HEARTBEAT_MISS_LIMIT) {
          teardown(current, "Overlay frame stopped responding");
          return;
        }
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
    isOpen: () => session !== null && session.visible,
    open,
    close: closeCurrent,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(mouseFollowUpGuardTimer);
      mouseFollowUpGuardTimer = 0;
      mouseFollowUpGuard.dispose();
      if (session) teardown(session, "Overlay controller disposed");
    },
    updateTrail: (state) => {
      if (!session) return;
      session.state = state;
      if (!session.visible) return;
      postToFrame(session, {
        type: "HOST_TRAIL_UPDATED",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
        state,
      });
    },
    updateSettings: (settings) => {
      if (!session) return;
      session.settings = settings;
      if (!session.visible) return;
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
