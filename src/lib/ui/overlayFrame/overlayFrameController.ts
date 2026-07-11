// Page-side owner for the isolated overlay browsing context. The host page can
// neither observe nor cancel events dispatched inside the extension iframe;
// clipping the iframe to the reported UI surfaces keeps the rest of the page
// interactive.

import browser from "webextension-polyfill";
import { browserSavedTrailsClient } from "../../adapters/runtime/savedTrailsClient";
import { reportTrailOverlayState } from "../../adapters/runtime/tabtrailApi";
import {
  isOverlayFrameToHostMessage,
  OVERLAY_FRAME_PROTOCOL_VERSION,
  type OverlayFrameConnectMessage,
  type OverlayFrameToHostMessage,
  type OverlayHostToFrameMessage,
} from "../../common/contracts/overlayFrame";
import { installMouseChordGuard } from "../../common/utils/mouseChordGuard";
import { MOUSE_CHORD_SWALLOW_WINDOW_MS } from "../../core/trail/trailCore";
import { createOverlayRpcExecutor } from "./overlayFrameRpc";
import {
  actionFailure,
  activeElementBelongsToFrame,
  createColdSession,
  FRAME_DOCUMENT_PATH,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISS_LIMIT,
  hideFrameSurface,
  restorablePageElement,
  setImportantStyle,
  STARTUP_TIMEOUT_MS,
  truncateDiagnosticReason,
  VIEWPORT_TOLERANCE_PX,
  type OverlayCloseRequest,
  type OverlayFrameDiagnostics,
  type OverlayFrameSession,
  type OverlayOpenKind,
} from "./overlayFrameSession";
import { validateSurfaceUpdate } from "./surfaceGeometry";

export type {
  OverlayCloseRequest,
  OverlayFrameDiagnostics,
} from "./overlayFrameSession";

interface OverlayFrameControllerOptions {
  onPositionChange: (position: TabTrailOverlayPosition) => void | Promise<void>;
}

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
  getDiagnostics(): OverlayFrameDiagnostics;
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
  // Outlive host DOM so destroy diagnosis does not depend on attributes.
  let lastFaultReason: string | null = null;
  let surfaceResyncCount = 0;
  let lastOpenKind: "cold" | "warm" | null = null;
  let lastHostOpenLatencyMs: number | null = null;

  const executeRpc = createOverlayRpcExecutor({
    onPositionChange: options.onPositionChange,
  });

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
      lastHostOpenLatencyMs = hostLatency;
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
    lastFaultReason = truncateDiagnosticReason(reason);
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
    surfaceResyncCount += 1;
    current.host.setAttribute(
      "data-tabtrail-surface-resync-count",
      String(surfaceResyncCount),
    );
    hideFrameSurface(current.frame);
    postToFrame(current, {
      type: "HOST_REQUEST_SURFACES",
      version: OVERLAY_FRAME_PROTOCOL_VERSION,
    });
  };

  // Bidirectional failure classes (host half). Geometry prefers soft resync;
  // auth, capability, heartbeat, FRAME_ERROR, and unexpected ready hard-destroy.
  // Soft (frame→host): malformed message drop; stale surface sequence; stale RPC id.
  // Soft resync (frame→host): viewport mismatch; invalid non-stale surfaces.
  // Hard (frame→host): unexpected FRAME_READY, heartbeat miss limit, FRAME_ERROR,
  // unsupported clip-path, messageerror, startup timeout, unexpected reload.
  const receiveFrameMessage = (
    current: OverlayFrameSession,
    received: unknown,
  ): void => {
    if (session !== current) return;
    if (!isOverlayFrameToHostMessage(received)) {
      // Soft drop: a single malformed message must not kill a live overlay.
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
        // HOST_INIT seeds protocol/settings only; HOST_SHOW always owns DOM mount.
        postToFrame(current, {
          type: "HOST_INIT",
          version: OVERLAY_FRAME_PROTOCOL_VERSION,
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
        // Ignore stale/duplicate request ids rather than tearing down.
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
        // Surfaces are live: settle the open Promise.
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
    window.clearTimeout(current.startupTimer);
    current.startupTimer = 0;
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
    // Diagnostics counter resets at the start of each visible attempt only.
    surfaceResyncCount = 0;
    lastOpenKind = kind;
    current.host.setAttribute("data-tabtrail-surface-resync-count", "0");
    hideFrameSurface(current.frame);
    beginOpenMetrics(current, kind, hostStartedAt, requestedAtEpochMs);
    const opened = beginOpenPromise(current);
    reportOpenState(current, true);
    // Always drop prior listeners before reinstall (re-arm footgun).
    current.cleanupPageListeners();
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
    const current = createColdSession(++nextGeneration, state, settings, frameUrl);
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

    current.frame.addEventListener("error", () => teardown(current, "Overlay frame failed to load"), {
      once: true,
    });
    current.frame.addEventListener("load", () => {
      if (session !== current || current.connected || !current.frame.contentWindow) {
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
        current.frame.contentWindow.postMessage(
          connect,
          new URL(current.frame.src).origin,
          [channel.port2],
        );
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
    getDiagnostics: () => ({
      lastFaultReason,
      surfaceResyncCount,
      lastOpenKind,
      lastHostOpenLatencyMs,
    }),
  };
}
