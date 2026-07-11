// Session model + DOM shell for the page-side isolated overlay host.
// Lifecycle orchestration (open/hibernate/teardown) stays in the controller.

import {
  OVERLAY_EMPTY_CLIP_PATH,
} from "./surfaceGeometry";

export const FRAME_HOST_ID = "tabtrail-isolated-overlay-host";
export const FRAME_DOCUMENT_PATH = "overlayFrame/overlayFrame.html";
export const STARTUP_TIMEOUT_MS = 3000;
export const HEARTBEAT_INTERVAL_MS = 2000;
export const HEARTBEAT_MISS_LIMIT = 3;
export const VIEWPORT_TOLERANCE_PX = 1;
export const DIAGNOSTIC_REASON_MAX_LEN = 120;

export type OverlayOpenKind = "cold" | "warm";

export interface OverlayOpenAttempt {
  hostStartedAt: number;
  requestedAtEpochMs?: number;
}

export interface OverlayFrameSession {
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

/** Explicit close intent: hibernate keeps the frame warm; destroy tears it down. */
export type OverlayCloseRequest =
  | { mode: "hibernate" }
  | { mode: "destroy"; reason: string };

/** Diagnostics that outlive host.remove() after hard teardown. */
export interface OverlayFrameDiagnostics {
  /** Last hard teardown reason, or null if never torn down / only hibernated. */
  lastFaultReason: string | null;
  /**
   * Soft geometry resyncs since the last armVisibleSession (diagnostics only).
   * Not a rate window — never treat this alone as a “storm”.
   */
  surfaceResyncCount: number;
  /** Last armed open kind, if any. */
  lastOpenKind: "cold" | "warm" | null;
  /** Last settled host-open latency ms, if any. */
  lastHostOpenLatencyMs: number | null;
}

export function setImportantStyle(
  element: HTMLElement,
  property: string,
  value: string,
): void {
  element.style.setProperty(property, value, "important");
}

export function hideFrameSurface(frame: HTMLIFrameElement): void {
  setImportantStyle(frame, "visibility", "hidden");
  setImportantStyle(frame, "pointer-events", "none");
  setImportantStyle(frame, "clip-path", OVERLAY_EMPTY_CLIP_PATH);
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createFrameHost(frameUrl: string): {
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

export function createColdSession(
  generation: number,
  state: TrailState,
  settings: TabTrailSettings,
  frameUrl: string,
): OverlayFrameSession {
  const { host, shadow, frame } = createFrameHost(frameUrl);
  return {
    generation,
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
}

export function activeElementBelongsToFrame(session: OverlayFrameSession): boolean {
  return session.shadow.activeElement === session.frame || document.activeElement === session.host;
}

export function restorablePageElement(element: HTMLElement | null): element is HTMLElement {
  return element !== null &&
    element.isConnected &&
    !element.matches(":disabled") &&
    element.closest("[inert]") === null;
}

export function actionFailure(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export function truncateDiagnosticReason(reason: string): string {
  return reason.length > DIAGNOSTIC_REASON_MAX_LEN
    ? reason.slice(0, DIAGNOSTIC_REASON_MAX_LEN)
    : reason;
}
