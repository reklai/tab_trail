// Pure viewport helpers for trail scroll capture/restore. No browser APIs.

const VIEWPORT_COORD_MAX = 1e7;
const ROOT_SELECTOR_MAX_LENGTH = 256;
/** Upper bound for capturedAt epoch ms (far future; rejects garbage magnitudes). */
const CAPTURED_AT_MAX = 1e15;

/** Last-known viewport for a trail entry. Coordinates are CSS pixels. */
export interface TrailViewportNormalized {
  x: number;
  y: number;
  scrollHeight?: number;
  root?: "document" | "element";
  rootSelector?: string;
  capturedAt?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampCoord(value: number): number {
  if (value < 0) return 0;
  if (value > VIEWPORT_COORD_MAX) return VIEWPORT_COORD_MAX;
  return value;
}

/**
 * Allowlist for nested-root selectors produced by the sampler grammar:
 * - `#id` where id is `[A-Za-z][\w-]*` (no CSS.escape form; no `:` that needs escape)
 * - `tag(:nth-of-type(n))?` segments joined by ` > ` (depth ≤ 4)
 * - tags may be hyphenated custom elements (`app-shell`)
 * Rejects arbitrary CSS that would be a querySelector footgun / DoS surface.
 */
export function isAllowedRootSelector(value: string): boolean {
  if (value.length === 0 || value.length > ROOT_SELECTOR_MAX_LENGTH) return false;
  // Unescaped id only — sampler must not emit CSS.escape forms.
  if (/^#[A-Za-z][\w-]*$/.test(value)) return true;
  // tag / custom-element tag, optional :nth-of-type(n), chained with " > "
  return /^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?::nth-of-type\(\d+\))?)(?: > [a-z][a-z0-9]*(?:-[a-z0-9]+)*(?::nth-of-type\(\d+\))?){0,3}$/i
    .test(value);
}

/**
 * Accept a raw viewport only when x/y are finite numbers. Clamps to >= 0 and
 * magnitude caps; drops invalid root / rootSelector; returns null if invalid.
 */
export function normalizeViewport(value: unknown): TrailViewport | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<TrailViewport>;
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return null;
  const x = clampCoord(raw.x);
  const y = clampCoord(raw.y);
  const viewport: TrailViewport = { x, y };

  if (isFiniteNumber(raw.scrollHeight) && raw.scrollHeight >= 0) {
    viewport.scrollHeight = Math.min(raw.scrollHeight, VIEWPORT_COORD_MAX * 2);
  }

  const allowedSelector =
    typeof raw.rootSelector === "string" && isAllowedRootSelector(raw.rootSelector)
      ? raw.rootSelector
      : undefined;

  if (raw.root === "element") {
    // Nested coords are only valid with a resolvable allowlisted selector.
    // Never demote to document while keeping nested x/y (wrong coordinate space).
    if (!allowedSelector) return null;
    viewport.root = "element";
    viewport.rootSelector = allowedSelector;
  } else {
    if (raw.root === "document") viewport.root = "document";
    // Document root ignores rootSelector (not used for restore root resolution).
  }

  if (
    isFiniteNumber(raw.capturedAt) &&
    raw.capturedAt >= 0 &&
    raw.capturedAt <= CAPTURED_AT_MAX
  ) {
    viewport.capturedAt = Math.floor(raw.capturedAt);
  }

  return viewport;
}

/** Deep equality of normalized viewport fields (missing ≡ missing). */
export function viewportEquals(
  left: TrailViewport | undefined | null,
  right: TrailViewport | undefined | null,
): boolean {
  if (left == null && right == null) return true;
  if (left == null || right == null) return false;
  const a = normalizeViewport(left);
  const b = normalizeViewport(right);
  if (!a || !b) return false;
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.scrollHeight === b.scrollHeight &&
    a.root === b.root &&
    a.rootSelector === b.rootSelector
  );
  // capturedAt intentionally ignored — sampling time is not identity
}

/** Euclidean-ish distance used by corrective restore distance gates. */
export function viewportDistance(
  left: Pick<TrailViewport, "x" | "y">,
  right: Pick<TrailViewport, "x" | "y">,
): { dx: number; dy: number; significant: boolean } {
  const dx = Math.abs(left.x - right.x);
  const dy = Math.abs(left.y - right.y);
  return { dx, dy, significant: dx > 0 || dy > 0 };
}

/**
 * Whether the live position is far enough from the target to warrant a
 * corrective re-apply. Threshold: max(80px, 5% of scrollHeight) per axis that
 * has a meaningful target offset, with y always checked.
 */
export function isFarFromTarget(
  live: Pick<TrailViewport, "x" | "y">,
  target: Pick<TrailViewport, "x" | "y">,
  scrollHeight: number,
): boolean {
  const threshold = Math.max(80, scrollHeight * 0.05);
  const { dx, dy } = viewportDistance(live, target);
  return dy > threshold || dx > threshold;
}

/** Clamp absolute offsets against the live scroll range of a root. */
export function clampViewportToLiveMax(
  viewport: Pick<TrailViewport, "x" | "y">,
  liveMaxX: number,
  liveMaxY: number,
): { x: number; y: number } {
  const maxX = Math.max(0, liveMaxX);
  const maxY = Math.max(0, liveMaxY);
  return {
    x: Math.min(Math.max(0, viewport.x), maxX),
    y: Math.min(Math.max(0, viewport.y), maxY),
  };
}

/**
 * Prefer retry over permanent clamp-to-zero when layout is temporarily short
 * relative to the stored scrollHeight (e.g. late content). Returns true when
 * the apply should be deferred.
 */
export function shouldDeferClamp(
  storedScrollHeight: number | undefined,
  liveMax: number,
  targetY: number,
): boolean {
  if (storedScrollHeight == null || storedScrollHeight <= 0) return false;
  if (liveMax >= 0.5 * storedScrollHeight) return false;
  return targetY > liveMax;
}
