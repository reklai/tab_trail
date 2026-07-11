// Pure geometry used by the page-side iframe host. The extension document
// reports DOM rectangles; this module validates, clamps, sequences, and
// converts them into one clip-path with a separate closed subpath per surface.
// Separate subpaths preserve click-through gaps between disjoint surfaces.

import {
  OVERLAY_FRAME_MAX_SURFACES,
  type OverlaySurfaceRect,
} from "../../common/contracts/overlayFrame";

// Keep the iframe clip flush with each rendered surface. Firefox/Zen may paint
// an extension iframe's transparent canvas white, so exposing padding around a
// surface creates a visible white frame.
export const OVERLAY_SURFACE_PADDING_PX = 0;
export const OVERLAY_SURFACE_CLIP_RADIUS_PX = 8;
export const OVERLAY_EMPTY_CLIP_PATH = "inset(50%)";
const MAX_PADDING_PX = 64;

export interface OverlayViewport {
  width: number;
  height: number;
}

export interface NormalizedSurfaceUpdate {
  sequence: number;
  rects: OverlaySurfaceRect[];
  clipPath: string;
}

export type SurfaceUpdateRejectionReason =
  | "invalid-update"
  | "invalid-sequence"
  | "stale-sequence"
  | "invalid-viewport"
  | "stale-viewport"
  | "too-many-surfaces"
  | "invalid-surface"
  | "invalid-padding";

export type SurfaceUpdateValidationResult =
  | { ok: true; value: NormalizedSurfaceUpdate }
  | { ok: false; reason: SurfaceUpdateRejectionReason };

export interface SurfaceUpdateValidationOptions {
  paddingPx?: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidViewport(value: unknown): value is OverlayViewport {
  return isRecord(value) && isFiniteNumber(value.width) && value.width > 0 &&
    isFiniteNumber(value.height) && value.height > 0;
}

function isValidSurface(value: unknown): value is OverlaySurfaceRect {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !["x", "y", "width", "height"].every((key) => Object.prototype.hasOwnProperty.call(value, key))
  ) return false;
  return isFiniteNumber(value.x) && isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) && value.width > 0 &&
    isFiniteNumber(value.height) && value.height > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function clampSurface(
  surface: OverlaySurfaceRect,
  viewport: OverlayViewport,
  paddingPx: number,
): OverlaySurfaceRect | null {
  const left = clamp(surface.x - paddingPx, 0, viewport.width);
  const top = clamp(surface.y - paddingPx, 0, viewport.height);
  const right = clamp(surface.x + surface.width + paddingPx, 0, viewport.width);
  const bottom = clamp(surface.y + surface.height + paddingPx, 0, viewport.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function formatCoordinate(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Returns a fully clipped value for no surfaces, or one path with N closed subpaths. */
export function buildOverlaySurfaceClipPath(rects: readonly OverlaySurfaceRect[]): string {
  if (rects.length === 0) return OVERLAY_EMPTY_CLIP_PATH;
  const subpaths = rects.map((rect) => {
    const leftValue = rect.x;
    const topValue = rect.y;
    const rightValue = rect.x + rect.width;
    const bottomValue = rect.y + rect.height;
    const radiusValue = Math.min(
      OVERLAY_SURFACE_CLIP_RADIUS_PX,
      rect.width / 2,
      rect.height / 2,
    );
    const left = formatCoordinate(leftValue);
    const top = formatCoordinate(topValue);
    const right = formatCoordinate(rightValue);
    const bottom = formatCoordinate(bottomValue);
    const leftInner = formatCoordinate(leftValue + radiusValue);
    const rightInner = formatCoordinate(rightValue - radiusValue);
    const topInner = formatCoordinate(topValue + radiusValue);
    const bottomInner = formatCoordinate(bottomValue - radiusValue);
    return `M ${leftInner} ${top} H ${rightInner} ` +
      `Q ${right} ${top} ${right} ${topInner} V ${bottomInner} ` +
      `Q ${right} ${bottom} ${rightInner} ${bottom} H ${leftInner} ` +
      `Q ${left} ${bottom} ${left} ${bottomInner} V ${topInner} ` +
      `Q ${left} ${top} ${leftInner} ${top} Z`;
  });
  return `path("${subpaths.join(" ")}")`;
}

/**
 * Sequence numbers are monotonic within one authenticated frame session.
 * A new session must reset lastSequence to null; sequence wrap is deliberately
 * not accepted because restarting the session is safer than replaying geometry.
 */
export function isNewerSurfaceSequence(sequence: unknown, lastSequence: number | null): boolean {
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) return false;
  return lastSequence === null || sequence > lastSequence;
}

/** Validate an untrusted FRAME_SURFACES_UPDATED payload and build its clip. */
export function validateSurfaceUpdate(
  update: unknown,
  viewport: unknown,
  lastSequence: number | null,
  options: SurfaceUpdateValidationOptions = {},
): SurfaceUpdateValidationResult {
  if (
    !isRecord(update) ||
    !Array.isArray(update.rects) ||
    !isFiniteNumber(update.viewportWidth) || update.viewportWidth <= 0 ||
    !isFiniteNumber(update.viewportHeight) || update.viewportHeight <= 0
  ) {
    return { ok: false, reason: "invalid-update" };
  }
  if (
    typeof update.sequence !== "number" ||
    !Number.isSafeInteger(update.sequence) ||
    update.sequence < 0
  ) {
    return { ok: false, reason: "invalid-sequence" };
  }
  if (!isNewerSurfaceSequence(update.sequence, lastSequence)) {
    return { ok: false, reason: "stale-sequence" };
  }
  if (!isValidViewport(viewport)) {
    return { ok: false, reason: "invalid-viewport" };
  }
  if (update.viewportWidth !== viewport.width || update.viewportHeight !== viewport.height) {
    return { ok: false, reason: "stale-viewport" };
  }
  if (update.rects.length > OVERLAY_FRAME_MAX_SURFACES) {
    return { ok: false, reason: "too-many-surfaces" };
  }
  const paddingPx = options.paddingPx ?? OVERLAY_SURFACE_PADDING_PX;
  if (!isFiniteNumber(paddingPx) || paddingPx < 0 || paddingPx > MAX_PADDING_PX) {
    return { ok: false, reason: "invalid-padding" };
  }

  const rects: OverlaySurfaceRect[] = [];
  for (const surface of update.rects) {
    if (!isValidSurface(surface)) return { ok: false, reason: "invalid-surface" };
    const normalized = clampSurface(surface, viewport, paddingPx);
    if (normalized) rects.push(normalized);
  }

  return {
    ok: true,
    value: {
      sequence: update.sequence,
      rects,
      clipPath: buildOverlaySurfaceClipPath(rects),
    },
  };
}
