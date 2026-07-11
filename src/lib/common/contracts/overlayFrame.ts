// Wire contract between the top-frame content script and the isolated
// extension-origin overlay document. The page can observe window messages, so
// the one-time bootstrap is authenticated by the nonce that the background
// relays through OVERLAY_FRAME_CHALLENGE. After that handoff, all traffic uses
// the transferred MessagePort.

export const OVERLAY_FRAME_PROTOCOL_VERSION = 2 as const;
export const OVERLAY_FRAME_MAX_SURFACES = 32;

const OVERLAY_FRAME_NONCE_PATTERN = /^[a-f0-9]{32}$/;
const TRIGGER_KEY_CODE_PATTERN = /^(?:Key[A-Z]|Digit[0-9])$/;
const MAX_TRAIL_ENTRIES_ON_WIRE = 100;
const MAX_SAVED_TRAILS_ON_WIRE = 50;
const MIN_VISIBLE_SEGMENTS = 5;
const MAX_VISIBLE_SEGMENTS = 12;

export interface OverlaySurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayFrameConnectMessage {
  type: "TABTRAIL_OVERLAY_CONNECT";
  version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
  nonce: string;
}

export interface OverlayFrameConnection {
  message: OverlayFrameConnectMessage;
  port: MessagePort;
}

export type OverlayActionResult =
  | { ok: true }
  | { ok: false; reason?: string };

// Wire-side success shapes match the storage store. Failure reasons stay
// optional on the wire so older hosts can omit them.
export type OverlaySavedTrailsLoadResult =
  | { ok: true; trails: SavedTrail[] }
  | { ok: false; reason?: string };

export type OverlaySavedTrailMutationResult =
  | { ok: true; trail: SavedTrail; trails: SavedTrail[] }
  | { ok: false; reason?: string };

export type OverlayReplaceSavedTrailResult =
  | {
      ok: true;
      trail: SavedTrail;
      previousTrail: SavedTrail;
      trails: SavedTrail[];
    }
  | { ok: false; reason?: string };

/** Parameters for every command the isolated UI may ask the host to run. */
export interface OverlayRpcParamsMap {
  LIVE_JUMP: { index: number };
  LIVE_OPEN_NEW_TAB: { index: number };
  LIVE_OPEN_NEW_WINDOW: { index: number };
  LIVE_OPEN_OPTIONS: Record<string, never>;
  // Mouse-triggered closes carry the matched button so the page-side host can
  // keep swallowing that gesture's follow-up events after removing the frame.
  // Keyboard and control-triggered closes leave it absent.
  LIVE_CLOSE: { mouseButton?: number };
  LIVE_SET_POSITION: { position: TabTrailOverlayPosition };
  SAVED_LOAD: Record<string, never>;
  // Saved-trail push is session-scoped host policy (always on while open).
  // There is no subscribe/unsubscribe RPC.
  SAVED_OPEN: { path: TrailEntry[]; mode: SavedTrailOpenMode };
  SAVED_SAVE: { path: TrailEntry[]; name: string };
  SAVED_RENAME: { id: string; name: string };
  SAVED_REPLACE: { id: string; path: TrailEntry[]; expectedPath?: TrailEntry[] };
  SAVED_SET_PINNED: { id: string; pinned: boolean };
  SAVED_DELETE: { id: string };
  SAVED_RESTORE: { trail: SavedTrail };
}

/** Result payload paired with each RPC method. */
export interface OverlayRpcResultMap {
  LIVE_JUMP: OverlayActionResult;
  LIVE_OPEN_NEW_TAB: OverlayActionResult;
  LIVE_OPEN_NEW_WINDOW: OverlayActionResult;
  LIVE_OPEN_OPTIONS: OverlayActionResult;
  LIVE_CLOSE: OverlayActionResult;
  LIVE_SET_POSITION: OverlayActionResult;
  SAVED_LOAD: OverlaySavedTrailsLoadResult;
  SAVED_OPEN: OverlayActionResult;
  SAVED_SAVE: OverlaySavedTrailMutationResult;
  SAVED_RENAME: OverlaySavedTrailMutationResult;
  SAVED_REPLACE: OverlayReplaceSavedTrailResult;
  SAVED_SET_PINNED: OverlaySavedTrailMutationResult;
  SAVED_DELETE: OverlaySavedTrailMutationResult;
  SAVED_RESTORE: OverlaySavedTrailMutationResult;
}

export type OverlayRpcMethod = keyof OverlayRpcParamsMap;

export type OverlayRpcRequest<M extends OverlayRpcMethod = OverlayRpcMethod> = {
  [K in M]: {
    requestId: number;
    method: K;
    params: OverlayRpcParamsMap[K];
  };
}[M];

export type OverlayRpcResponse<M extends OverlayRpcMethod = OverlayRpcMethod> = {
  [K in M]: {
    requestId: number;
    method: K;
    result: OverlayRpcResultMap[K];
  };
}[M];

export type OverlayHostToFrameMessage =
  | {
      // Seed frame protocol/settings only. DOM paint is always HOST_SHOW.
      type: "HOST_INIT";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      state: TrailState;
      settings: TabTrailSettings;
    }
  | {
      type: "HOST_TRAIL_UPDATED";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      state: TrailState;
    }
  | {
      type: "HOST_SETTINGS_UPDATED";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      settings: TabTrailSettings;
    }
  | {
      type: "HOST_SAVED_TRAILS_UPDATED";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      trails: SavedTrail[];
    }
  | {
      type: "HOST_RPC_RESPONSE";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      response: OverlayRpcResponse;
    }
  | {
      type: "HOST_DISMISS_TRANSIENTS";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
    }
  | {
      type: "HOST_ESCAPE";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
    }
  | {
      type: "HOST_FOCUS_RELEASED";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
    }
  | {
      type: "HOST_REQUEST_SURFACES";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
    }
  | {
      type: "HOST_PING";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      heartbeatId: number;
    }
  | {
      // Soft-hide the UI but keep the frame document and MessagePort warm so the
      // next open can skip iframe load + claim handshake.
      type: "HOST_HIBERNATE";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
    }
  | {
      // Re-show the live trail after HOST_HIBERNATE without re-authenticating.
      type: "HOST_SHOW";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      state: TrailState;
      settings: TabTrailSettings;
    }
  | {
      type: "HOST_SHUTDOWN";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      reason?: string;
    };

export type OverlayFrameToHostMessage =
  | {
      type: "FRAME_READY";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
    }
  | {
      type: "FRAME_RPC_REQUEST";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      request: OverlayRpcRequest;
    }
  | {
      type: "FRAME_SURFACES_UPDATED";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      sequence: number;
      viewportWidth: number;
      viewportHeight: number;
      rects: OverlaySurfaceRect[];
    }
  | {
      type: "FRAME_FOCUS_OWNERSHIP";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      owned: boolean;
    }
  | {
      type: "FRAME_PONG";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      heartbeatId: number;
    }
  | {
      type: "FRAME_ERROR";
      version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
      reason: string;
    };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  if (!required.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return false;
  const allowed = new Set([...required, ...optional]);
  return keys.every((key) => allowed.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isEmptyParams(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isOverlayPosition(value: unknown): value is TabTrailOverlayPosition {
  if (!isRecord(value) || !hasOnlyKeys(value, ["xPercent", "yPercent"])) return false;
  return isFiniteNumber(value.xPercent) && value.xPercent >= 0 && value.xPercent <= 100 &&
    isFiniteNumber(value.yPercent) && value.yPercent >= 0 && value.yPercent <= 100;
}

const TRAIL_TRANSITIONS = new Set([
  "link",
  "typed",
  "reload",
  "spa",
  "fragment",
  "form",
  "back_forward",
  "other",
]);

function isTrailEntry(value: unknown): value is TrailEntry {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "url",
      "title",
      "favIconUrl",
      "timestamp",
      "transition",
      "redirected",
      "historyBacked",
    ])
  ) return false;
  return typeof value.url === "string" && value.url.length > 0 &&
    typeof value.title === "string" &&
    typeof value.favIconUrl === "string" &&
    isFiniteNumber(value.timestamp) &&
    typeof value.transition === "string" && TRAIL_TRANSITIONS.has(value.transition) &&
    typeof value.redirected === "boolean" &&
    typeof value.historyBacked === "boolean";
}

function isTrailEntries(value: unknown): value is TrailEntry[] {
  return Array.isArray(value) && value.length <= MAX_TRAIL_ENTRIES_ON_WIRE && value.every(isTrailEntry);
}

function isTrailState(value: unknown): value is TrailState {
  if (!isRecord(value) || !hasOnlyKeys(value, ["entries", "cursor"])) return false;
  if (!isTrailEntries(value.entries) || !Number.isSafeInteger(value.cursor)) return false;
  const cursor = value.cursor as number;
  return value.entries.length === 0
    ? cursor === -1
    : cursor >= 0 && cursor < value.entries.length;
}

function isTrigger(value: unknown): value is TabTrailTrigger {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["modifier", "withShift", "kind", "keyCode", "mouseButton"])
  ) return false;
  return (value.modifier === "alt" || value.modifier === "ctrl" || value.modifier === "super") &&
    typeof value.withShift === "boolean" &&
    (value.kind === "key" || value.kind === "mouse") &&
    typeof value.keyCode === "string" && TRIGGER_KEY_CODE_PATTERN.test(value.keyCode) &&
    typeof value.mouseButton === "number" && [0, 1, 2].includes(value.mouseButton);
}

function isSettings(value: unknown): value is TabTrailSettings {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["trigger", "overlayPosition", "maxVisibleSegments"])
  ) return false;
  return isTrigger(value.trigger) &&
    (value.overlayPosition === null || isOverlayPosition(value.overlayPosition)) &&
    Number.isSafeInteger(value.maxVisibleSegments) &&
    (value.maxVisibleSegments as number) >= MIN_VISIBLE_SEGMENTS &&
    (value.maxVisibleSegments as number) <= MAX_VISIBLE_SEGMENTS;
}

function isSavedTrail(value: unknown): value is SavedTrail {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "name", "pinned", "createdAt", "updatedAt", "entries"])
  ) return false;
  return typeof value.id === "string" && value.id.length > 0 &&
    typeof value.name === "string" && value.name.length > 0 &&
    typeof value.pinned === "boolean" &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    isTrailEntries(value.entries) && value.entries.length > 0;
}

function isSavedTrails(value: unknown): value is SavedTrail[] {
  return Array.isArray(value) && value.length <= MAX_SAVED_TRAILS_ON_WIRE && value.every(isSavedTrail);
}

function isSurfaceRect(value: unknown): value is OverlaySurfaceRect {
  if (!isRecord(value) || !hasOnlyKeys(value, ["x", "y", "width", "height"])) return false;
  return isFiniteNumber(value.x) && isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) && isFiniteNumber(value.height) &&
    value.width > 0 && value.height > 0;
}

function isActionResult(value: unknown): value is OverlayActionResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ["ok"], ["reason"])) return false;
  if (value.ok === true) return value.reason === undefined;
  return value.ok === false && isOptionalString(value.reason);
}

function isSavedTrailsLoadResult(value: unknown): value is OverlaySavedTrailsLoadResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok === false) {
    return hasOnlyKeys(value, ["ok"], ["reason"]) && isOptionalString(value.reason);
  }
  return hasOnlyKeys(value, ["ok", "trails"]) && isSavedTrails(value.trails);
}

function isMutationResult(value: unknown): value is OverlaySavedTrailMutationResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok === false) {
    return hasOnlyKeys(value, ["ok"], ["reason"]) && isOptionalString(value.reason);
  }
  return hasOnlyKeys(value, ["ok", "trail", "trails"]) &&
    isSavedTrail(value.trail) && isSavedTrails(value.trails);
}

function isReplaceResult(value: unknown): value is OverlayReplaceSavedTrailResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok === false) {
    return hasOnlyKeys(value, ["ok"], ["reason"]) && isOptionalString(value.reason);
  }
  return hasOnlyKeys(value, ["ok", "trail", "previousTrail", "trails"]) &&
    isSavedTrail(value.trail) && isSavedTrail(value.previousTrail) && isSavedTrails(value.trails);
}

function isBaseProtocolMessage(value: unknown): value is UnknownRecord & {
  type: string;
  version: typeof OVERLAY_FRAME_PROTOCOL_VERSION;
} {
  return isRecord(value) && typeof value.type === "string" &&
    value.version === OVERLAY_FRAME_PROTOCOL_VERSION;
}

export function isOverlayFrameConnectMessage(value: unknown): value is OverlayFrameConnectMessage {
  return isBaseProtocolMessage(value) &&
    hasOnlyKeys(value, ["type", "version", "nonce"]) &&
    value.type === "TABTRAIL_OVERLAY_CONNECT" &&
    typeof value.nonce === "string" && OVERLAY_FRAME_NONCE_PATTERN.test(value.nonce);
}

function isMessagePortLike(value: unknown): value is MessagePort {
  if (!isRecord(value)) return false;
  return typeof value.postMessage === "function" &&
    typeof value.start === "function" &&
    typeof value.close === "function" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function";
}

/**
 * Parses the one permitted window-message bootstrap shape. Callers must also
 * verify event.source against the expected iframe window (host) or parent
 * window (frame); this helper deliberately handles data and transfer only.
 */
export function parseOverlayFrameConnectEvent(event: unknown): OverlayFrameConnection | null {
  if (!isRecord(event) || !isOverlayFrameConnectMessage(event.data)) return null;
  if (!Array.isArray(event.ports) || event.ports.length !== 1) return null;
  const port = event.ports[0];
  if (!isMessagePortLike(port)) return null;
  return { message: event.data, port };
}

function isRpcParams(method: OverlayRpcMethod, params: unknown): boolean {
  if (!isRecord(params)) return false;
  switch (method) {
    case "LIVE_JUMP":
    case "LIVE_OPEN_NEW_TAB":
    case "LIVE_OPEN_NEW_WINDOW":
      return hasOnlyKeys(params, ["index"]) && isNonNegativeSafeInteger(params.index);
    case "LIVE_OPEN_OPTIONS":
    case "SAVED_LOAD":
      return isEmptyParams(params);
    case "LIVE_CLOSE":
      return hasOnlyKeys(params, [], ["mouseButton"]) &&
        (params.mouseButton === undefined ||
          (typeof params.mouseButton === "number" && [0, 1, 2].includes(params.mouseButton)));
    case "LIVE_SET_POSITION":
      return hasOnlyKeys(params, ["position"]) && isOverlayPosition(params.position);
    case "SAVED_OPEN":
      return hasOnlyKeys(params, ["path", "mode"]) &&
        isTrailEntries(params.path) && params.path.length > 0 &&
        (params.mode === "current" || params.mode === "new");
    case "SAVED_SAVE":
      return hasOnlyKeys(params, ["path", "name"]) &&
        isTrailEntries(params.path) && params.path.length > 0 && typeof params.name === "string";
    case "SAVED_RENAME":
      return hasOnlyKeys(params, ["id", "name"]) &&
        typeof params.id === "string" && typeof params.name === "string";
    case "SAVED_DELETE":
      return hasOnlyKeys(params, ["id"]) && typeof params.id === "string";
    case "SAVED_REPLACE":
      return hasOnlyKeys(params, ["id", "path"], ["expectedPath"]) &&
        typeof params.id === "string" &&
        isTrailEntries(params.path) && params.path.length > 0 &&
        (params.expectedPath === undefined || isTrailEntries(params.expectedPath));
    case "SAVED_SET_PINNED":
      return hasOnlyKeys(params, ["id", "pinned"]) &&
        typeof params.id === "string" && typeof params.pinned === "boolean";
    case "SAVED_RESTORE":
      return hasOnlyKeys(params, ["trail"]) && isSavedTrail(params.trail);
  }
}

function isRpcMethod(value: unknown): value is OverlayRpcMethod {
  return typeof value === "string" && [
    "LIVE_JUMP",
    "LIVE_OPEN_NEW_TAB",
    "LIVE_OPEN_NEW_WINDOW",
    "LIVE_OPEN_OPTIONS",
    "LIVE_CLOSE",
    "LIVE_SET_POSITION",
    "SAVED_LOAD",
    "SAVED_OPEN",
    "SAVED_SAVE",
    "SAVED_RENAME",
    "SAVED_REPLACE",
    "SAVED_SET_PINNED",
    "SAVED_DELETE",
    "SAVED_RESTORE",
  ].includes(value);
}

export function isOverlayRpcRequest(value: unknown): value is OverlayRpcRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["requestId", "method", "params"])) return false;
  return isNonNegativeSafeInteger(value.requestId) &&
    isRpcMethod(value.method) && isRpcParams(value.method, value.params);
}

function isRpcResult(method: OverlayRpcMethod, result: unknown): boolean {
  switch (method) {
    case "SAVED_LOAD":
      return isSavedTrailsLoadResult(result);
    case "SAVED_SAVE":
    case "SAVED_RENAME":
    case "SAVED_SET_PINNED":
    case "SAVED_DELETE":
    case "SAVED_RESTORE":
      return isMutationResult(result);
    case "SAVED_REPLACE":
      return isReplaceResult(result);
    default:
      return isActionResult(result);
  }
}

export function isOverlayRpcResponse(value: unknown): value is OverlayRpcResponse {
  if (!isRecord(value) || !hasOnlyKeys(value, ["requestId", "method", "result"])) return false;
  return isNonNegativeSafeInteger(value.requestId) &&
    isRpcMethod(value.method) && isRpcResult(value.method, value.result);
}

export function isOverlayHostToFrameMessage(value: unknown): value is OverlayHostToFrameMessage {
  if (!isBaseProtocolMessage(value)) return false;
  switch (value.type) {
    case "HOST_INIT":
      return hasOnlyKeys(value, ["type", "version", "state", "settings"]) &&
        isTrailState(value.state) && isSettings(value.settings);
    case "HOST_TRAIL_UPDATED":
      return hasOnlyKeys(value, ["type", "version", "state"]) && isTrailState(value.state);
    case "HOST_SETTINGS_UPDATED":
      return hasOnlyKeys(value, ["type", "version", "settings"]) && isSettings(value.settings);
    case "HOST_SAVED_TRAILS_UPDATED":
      return hasOnlyKeys(value, ["type", "version", "trails"]) && isSavedTrails(value.trails);
    case "HOST_RPC_RESPONSE":
      return hasOnlyKeys(value, ["type", "version", "response"]) &&
        isOverlayRpcResponse(value.response);
    case "HOST_DISMISS_TRANSIENTS":
    case "HOST_ESCAPE":
    case "HOST_FOCUS_RELEASED":
    case "HOST_REQUEST_SURFACES":
      return hasOnlyKeys(value, ["type", "version"]);
    case "HOST_PING":
      return hasOnlyKeys(value, ["type", "version", "heartbeatId"]) &&
        isNonNegativeSafeInteger(value.heartbeatId);
    case "HOST_HIBERNATE":
      return hasOnlyKeys(value, ["type", "version"]);
    case "HOST_SHOW":
      return hasOnlyKeys(value, ["type", "version", "state", "settings"]) &&
        isTrailState(value.state) && isSettings(value.settings);
    case "HOST_SHUTDOWN":
      return hasOnlyKeys(value, ["type", "version"], ["reason"]) &&
        isOptionalString(value.reason);
    default:
      return false;
  }
}

export function isOverlayFrameToHostMessage(value: unknown): value is OverlayFrameToHostMessage {
  if (!isBaseProtocolMessage(value)) return false;
  switch (value.type) {
    case "FRAME_READY":
      return hasOnlyKeys(value, ["type", "version"]);
    case "FRAME_RPC_REQUEST":
      return hasOnlyKeys(value, ["type", "version", "request"]) &&
        isOverlayRpcRequest(value.request);
    case "FRAME_SURFACES_UPDATED":
      return hasOnlyKeys(value, [
        "type",
        "version",
        "sequence",
        "viewportWidth",
        "viewportHeight",
        "rects",
      ]) &&
        isNonNegativeSafeInteger(value.sequence) &&
        isFiniteNumber(value.viewportWidth) && value.viewportWidth > 0 &&
        isFiniteNumber(value.viewportHeight) && value.viewportHeight > 0 &&
        Array.isArray(value.rects) && value.rects.length <= OVERLAY_FRAME_MAX_SURFACES &&
        value.rects.every(isSurfaceRect);
    case "FRAME_FOCUS_OWNERSHIP":
      return hasOnlyKeys(value, ["type", "version", "owned"]) && typeof value.owned === "boolean";
    case "FRAME_PONG":
      return hasOnlyKeys(value, ["type", "version", "heartbeatId"]) &&
        isNonNegativeSafeInteger(value.heartbeatId);
    case "FRAME_ERROR":
      return hasOnlyKeys(value, ["type", "version", "reason"]) && typeof value.reason === "string";
    default:
      return false;
  }
}
