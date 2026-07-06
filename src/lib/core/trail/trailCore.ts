// Pure trail decision logic — no browser APIs, no imports. Covers the toggle
// trigger matcher (keyboard or mouse chord), the trail reducer that turns
// webNavigation events into breadcrumb state, and the jump planner. Side-effect
// free so unit tests can exercise it without a browser.

// Hard cap per tab: the oldest entries fall off. Deep rabbit holes stay usable
// while a runaway SPA can't grow the trail without bound.
export const TRAIL_MAX_ENTRIES = 100;

export const EMPTY_TRAIL_STATE: TrailState = { entries: [], cursor: -1 };

// Minimal shape of a keydown/mousedown event this module reads. Accepting a
// plain object (rather than the DOM types) keeps the module testable outside a
// browser. "repeat" only exists on keyboard events.
export interface ToggleTriggerEvent {
  type: "keydown" | "mousedown";
  code?: string;
  button?: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isTrusted: boolean;
}

const MODIFIER_KEYS: readonly WayfindModifierKey[] = ["alt", "ctrl", "super"];

// True only when the event is exactly the configured chord: the chosen
// modifier held, every other modifier released, Shift matching the setting,
// and a trusted (real user) event. Requiring all other modifiers to be
// released also rejects AltGr, which the browser reports as Ctrl+Alt.
export function matchesToggleTrigger(
  event: ToggleTriggerEvent,
  trigger: WayfindTrigger,
): boolean {
  if (!event.isTrusted) return false;
  if (event.shiftKey !== trigger.withShift) return false;

  const modifierHeld: Record<WayfindModifierKey, boolean> = {
    alt: event.altKey,
    ctrl: event.ctrlKey,
    super: event.metaKey,
  };
  for (const modifier of MODIFIER_KEYS) {
    const shouldBeHeld = modifier === trigger.modifier;
    if (modifierHeld[modifier] !== shouldBeHeld) return false;
  }

  if (trigger.kind === "key") {
    return event.type === "keydown" && event.repeat !== true && event.code === trigger.keyCode;
  }
  return event.type === "mousedown" && event.button === trigger.mouseButton;
}

const KNOWN_TRANSITIONS: readonly TrailTransition[] = [
  "link",
  "typed",
  "reload",
  "spa",
  "fragment",
  "form",
  "back_forward",
  "other",
];

export function normalizeTrailTransition(value: unknown): TrailTransition {
  return KNOWN_TRANSITIONS.includes(value as TrailTransition)
    ? (value as TrailTransition)
    : "other";
}

// Maps a webNavigation event onto the display transition bucket.
function deriveTransition(event: TrailNavigationEvent): TrailTransition {
  if (event.kind === "historyState") return "spa";
  if (event.kind === "refFragment") return "fragment";
  switch (event.transitionType) {
    case "link":
      return "link";
    case "typed":
    case "generated":
    case "keyword":
    case "keyword_generated":
      return "typed";
    case "reload":
      return "reload";
    case "form_submit":
      return "form";
    default:
      return "other";
  }
}

function hasQualifier(event: TrailNavigationEvent, qualifier: string): boolean {
  return Array.isArray(event.qualifiers) && event.qualifiers.includes(qualifier);
}

function makeEntry(event: TrailNavigationEvent): TrailEntry {
  return {
    url: event.url,
    title: "",
    favIconUrl: "",
    timestamp: event.timestamp,
    transition: deriveTransition(event),
    redirected:
      hasQualifier(event, "client_redirect") || hasQualifier(event, "server_redirect"),
  };
}

// Refreshes the current entry in place (reload / replaceState churn) without
// growing the trail. Title/favicon are kept — they are patched by the domain.
function refreshEntry(entry: TrailEntry, event: TrailNavigationEvent): TrailEntry {
  return {
    ...entry,
    url: event.url,
    timestamp: event.timestamp,
    redirected: entry.redirected || hasQualifier(event, "client_redirect") ||
      hasQualifier(event, "server_redirect"),
  };
}

// Finds the trail index matching a URL for a back/forward navigation,
// preferring the immediate neighbors of the cursor, then scanning outward.
function findBackForwardIndex(state: TrailState, url: string): number {
  const { entries, cursor } = state;
  for (let distance = 1; distance < entries.length; distance += 1) {
    const before = cursor - distance;
    if (before >= 0 && entries[before].url === url) return before;
    const after = cursor + distance;
    if (after < entries.length && entries[after].url === url) return after;
  }
  return -1;
}

export interface TrailReduction {
  state: TrailState;
  changed: boolean;
}

// The trail reducer. Cursor+truncate model: revisiting an existing entry moves
// the cursor (forward entries stay as a dimmed forward stack); navigating
// somewhere new from mid-trail drops the forward entries — mirroring what the
// browser itself does to session history, which keeps trail deltas valid for
// history.go jumps.
export function applyNavigationEvent(
  state: TrailState,
  event: TrailNavigationEvent,
): TrailReduction {
  const { entries, cursor } = state;
  const current = cursor >= 0 && cursor < entries.length ? entries[cursor] : null;

  // First navigation for this tab.
  if (!current) {
    return { state: { entries: [makeEntry(event)], cursor: 0 }, changed: true };
  }

  // Landing of an extension-initiated breadcrumb jump: move the cursor only.
  const jumpIndex = event.pendingJumpIndex;
  if (
    typeof jumpIndex === "number" &&
    jumpIndex >= 0 &&
    jumpIndex < entries.length &&
    entries[jumpIndex].url === event.url
  ) {
    if (jumpIndex === cursor) return { state, changed: false };
    return { state: { entries, cursor: jumpIndex }, changed: true };
  }

  // Reload, replaceState churn, or a self-link: refresh in place, never append.
  if (event.transitionType === "reload" || event.url === current.url) {
    const next = entries.slice();
    next[cursor] = refreshEntry(current, event);
    return { state: { entries: next, cursor }, changed: true };
  }

  // Browser back/forward: move the cursor to the matching entry when one
  // exists. Qualifier-driven, with the URL match as the actual authority —
  // Firefox's qualifiers are known to be imperfect.
  if (hasQualifier(event, "forward_back")) {
    const index = findBackForwardIndex(state, event.url);
    if (index !== -1) {
      return { state: { entries, cursor: index }, changed: true };
    }
  }

  // New navigation: truncate the forward stack, append, advance the cursor.
  const next = entries.slice(0, cursor + 1);
  next.push(makeEntry(event));
  let nextCursor = next.length - 1;
  const overflow = next.length - TRAIL_MAX_ENTRIES;
  if (overflow > 0) {
    next.splice(0, overflow);
    nextCursor -= overflow;
  }
  return { state: { entries: next, cursor: nextCursor }, changed: true };
}

// Plans how to fulfil a breadcrumb click. history.go(delta) preserves scroll
// position and bfcache, but only when every hop in the span maps to a real
// session-history entry — a redirect in the span replaced one, so fall back to
// a plain navigation there. Returns null for a no-op (clicking the current
// segment) or an invalid index.
export function resolveJumpPlan(
  state: TrailState,
  targetIndex: number,
): TrailJumpPlan | null {
  const { entries, cursor } = state;
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= entries.length) {
    return null;
  }
  if (targetIndex === cursor) return null;

  const low = Math.min(cursor, targetIndex);
  const high = Math.max(cursor, targetIndex);
  // Entries strictly after `low` were each created by a forward navigation; a
  // redirect flag on any of them breaks the 1:1 mapping to history entries.
  for (let index = low + 1; index <= high; index += 1) {
    if (entries[index].redirected) {
      return { kind: "navigate", url: entries[targetIndex].url };
    }
  }
  return { kind: "historyGo", delta: targetIndex - cursor };
}

// --- Presentation helpers (pure, shared by the overlay and the popup) ---

export function truncateTrailTitle(title: string, maxLength = 28): string {
  const trimmed = title.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

// Compact relative timestamp. `now` is injected so the function stays pure.
export function formatTrailTimestamp(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function normalizeTrailState(value: unknown): TrailState {
  if (typeof value !== "object" || value === null) {
    return { entries: [], cursor: -1 };
  }
  const raw = value as Partial<TrailState>;
  if (!Array.isArray(raw.entries)) return { entries: [], cursor: -1 };
  const entries: TrailEntry[] = [];
  for (const item of raw.entries.slice(-TRAIL_MAX_ENTRIES)) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Partial<TrailEntry>;
    if (typeof entry.url !== "string" || entry.url === "") continue;
    entries.push({
      url: entry.url,
      title: typeof entry.title === "string" ? entry.title : "",
      favIconUrl: typeof entry.favIconUrl === "string" ? entry.favIconUrl : "",
      timestamp:
        typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
          ? entry.timestamp
          : 0,
      transition: normalizeTrailTransition(entry.transition),
      redirected: entry.redirected === true,
    });
  }
  if (entries.length === 0) return { entries: [], cursor: -1 };
  const cursor =
    typeof raw.cursor === "number" && Number.isInteger(raw.cursor)
      ? Math.min(Math.max(raw.cursor, 0), entries.length - 1)
      : entries.length - 1;
  return { entries, cursor };
}
