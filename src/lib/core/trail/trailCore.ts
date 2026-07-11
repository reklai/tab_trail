// Pure trail decision logic — no browser APIs. Covers the toggle trigger
// matcher (keyboard or mouse chord), the trail reducer that turns webNavigation
// events into breadcrumb state, and the jump planner. Side-effect free so unit
// tests can exercise it without a browser. Named-trail library helpers live in
// savedTrailCore.ts and are re-exported here for a stable import path.

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

// DOM event fields used to build a ToggleTriggerEvent. Avoids depending on
// global KeyboardEvent/MouseEvent types so core stays runnable under node:test.
export interface ToggleTriggerDomEventLike {
  type: string;
  code?: string;
  button?: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isTrusted: boolean;
}

const MODIFIER_KEYS: readonly TabTrailModifierKey[] = ["alt", "ctrl", "super"];

// How long after a matched mouse chord we swallow its follow-up events
// (click/auxclick/contextmenu) so middle-click does not autoscroll and
// right-click does not open the native context menu.
export const MOUSE_CHORD_SWALLOW_WINDOW_MS = 600;

export function toToggleTriggerEvent(event: ToggleTriggerDomEventLike): ToggleTriggerEvent {
  if (event.type === "keydown") {
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

/** Whether a click/auxclick/contextmenu belongs to a previously matched mouse chord. */
export function isMouseChordFollowUp(
  event: { type: string; button: number },
  swallowedButton: number,
): boolean {
  if (event.type === "contextmenu") return swallowedButton === 2;
  return event.button === swallowedButton;
}

// True only when the event is exactly the configured chord: the chosen
// modifier held, every other modifier released, Shift matching the setting,
// and a trusted (real user) event. Requiring all other modifiers to be
// released also rejects AltGr, which the browser reports as Ctrl+Alt.
export function matchesToggleTrigger(
  event: ToggleTriggerEvent,
  trigger: TabTrailTrigger,
): boolean {
  if (!event.isTrusted) return false;
  if (event.shiftKey !== trigger.withShift) return false;

  const modifierHeld: Record<TabTrailModifierKey, boolean> = {
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
    historyBacked: true,
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

  // Landing of an extension-initiated breadcrumb jump. A native history jump
  // retains its forward stack; direct navigation establishes a new branch and
  // drops descendants that no longer describe this tab's path.
  const jumpIndex = event.pendingJumpIndex;
  if (
    typeof jumpIndex === "number" &&
    jumpIndex >= 0 &&
    jumpIndex < entries.length &&
    entries[jumpIndex].url === event.url
  ) {
    if (event.pendingJumpKind === "navigate") {
      const branch = entries.slice(0, jumpIndex + 1);
      // A plain tabs.update landing creates a new native-history entry rather
      // than moving to the trail entry it represents. The abandoned native
      // entries are no longer modeled by this branch, so the landing edge must
      // break any later history.go span (including the jumpTo catch fallback).
      branch[jumpIndex] = {
        ...refreshEntry(branch[jumpIndex], event),
        historyBacked: false,
      };
      return {
        state: { entries: branch, cursor: branch.length - 1 },
        changed: true,
      };
    }
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
// session-history entry. Redirected and inherited edges do not, so those spans
// fall back to plain navigation. Returns null for a no-op (clicking the current
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
  // redirect or inherited edge in the span breaks the 1:1 mapping to history
  // entries.
  for (let index = low + 1; index <= high; index += 1) {
    if (entries[index].redirected || !entries[index].historyBacked) {
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

  // Keep only the most recent entries — this can drop items off the FRONT — and
  // track where the stored cursor lands so we can remap it to the same entry
  // after front/middle drops instead of naively clamping to a different page.
  const rawEntries = raw.entries;
  const windowed = rawEntries.slice(-TRAIL_MAX_ENTRIES);
  const droppedFromFront = rawEntries.length - windowed.length;
  const rawCursor =
    typeof raw.cursor === "number" && Number.isInteger(raw.cursor)
      ? raw.cursor
      : rawEntries.length - 1;
  const cursorInWindow = rawCursor - droppedFromFront;

  const entries: TrailEntry[] = [];
  let cursor = -1;
  for (let i = 0; i < windowed.length; i += 1) {
    const item = windowed[i];
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Partial<TrailEntry>;
    if (typeof entry.url !== "string" || entry.url === "") continue;
    // Follow the cursor onto the last surviving entry at or before its stored
    // position, so a skipped invalid entry or dropped prefix can't shift it.
    if (i <= cursorInWindow) cursor = entries.length;
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
      historyBacked: entry.historyBacked !== false,
    });
  }
  if (entries.length === 0) return { entries: [], cursor: -1 };
  // The cursor's target fell off the front — clamp to the oldest kept entry.
  if (cursor === -1) cursor = 0;
  return { entries, cursor };
}

// A new tab has only the endpoint in native session history. Preserve the
// prefix as provenance, but mark every edge in that prefix as inherited so a
// breadcrumb jump never mistakes it for a valid history.go span.
export function createInheritedTrailState(path: TrailEntry[]): TrailState {
  const normalized = normalizeTrailState({ entries: path, cursor: path.length - 1 });
  if (normalized.entries.length === 0) return EMPTY_TRAIL_STATE;
  return {
    entries: normalized.entries.map((entry, index) => ({
      ...entry,
      historyBacked: index === 0,
    })),
    cursor: normalized.entries.length - 1,
  };
}

// Path from the root through the selected node (inclusive). Null when the
// index is out of range or the trail is empty. Shared by live open-in-new-*
// and the saved-trail library.
export function slicePathToIndex(state: TrailState, index: number): TrailEntry[] | null {
  const { entries } = state;
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) return null;
  return entries.slice(0, index + 1).map((entry) => ({ ...entry }));
}

// Re-export library helpers after live-trail definitions so savedTrailCore can
// import normalizeTrailState without a circular-init race.
export {
  MAX_SAVED_TRAILS,
  SAVED_TRAIL_NAME_MAX_LENGTH,
  createSavedTrail,
  createSavedTrailId,
  isSavedTrailNameTaken,
  normalizeSavedTrail,
  normalizeSavedTrailEntries,
  normalizeSavedTrailName,
  normalizeSavedTrails,
  savedTrailEndpoint,
  savedTrailEntriesEqual,
  savedTrailNameKey,
  savedTrailPathsEqual,
  suggestSavedTrailName,
} from "./savedTrailCore";
