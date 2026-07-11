// Shared project type declarations

// Allow importing .css files as text (esbuild text loader)
declare module "*.css" {
  const content: string;
  export default content;
}

// "super" is the OS/Windows/Command key — it maps to KeyboardEvent.metaKey.
type TabTrailModifierKey = "alt" | "ctrl" | "super";

// The toggle trigger is a chord: one modifier (plus optional Shift) combined
// with either a letter/top-row digit key (matched by event.code) or left,
// middle, or right click (matched by event.button on mousedown). "kind" picks
// which half applies.
interface TabTrailTrigger {
  modifier: TabTrailModifierKey;
  withShift: boolean;
  kind: "key" | "mouse";
  keyCode: string;
  mouseButton: number;
}

interface TabTrailOverlayPosition {
  xPercent: number;
  yPercent: number;
}

interface TabTrailSettings {
  trigger: TabTrailTrigger;
  overlayPosition: TabTrailOverlayPosition | null;
  maxVisibleSegments: number;
}

// Display bucket for how a trail entry was reached. "spa" = history.pushState,
// "fragment" = hash change; the rest map from webNavigation transition types.
type TrailTransition =
  | "link"
  | "typed"
  | "reload"
  | "spa"
  | "fragment"
  | "form"
  | "back_forward"
  | "other";

/** Last-known viewport for a trail entry. Coordinates are CSS pixels. */
interface TrailViewport {
  /** Horizontal offset of the restored scroll root. */
  x: number;
  /** Vertical offset of the restored scroll root. */
  y: number;
  /**
   * Scroll height of the root when sampled (for clamping after reflow).
   * Optional; missing ⇒ clamp only against live max at restore time.
   */
  scrollHeight?: number;
  /**
   * Which root was sampled.
   * - "document": document.scrollingElement / window
   * - "element": a single primary nested scroller (selector best-effort)
   */
  root?: "document" | "element";
  /** CSS selector for root === "element"; ignored for document. */
  rootSelector?: string;
  /** Epoch ms when sampled (debug / staleness). */
  capturedAt?: number;
}

/** How the content script should apply a restore. Chosen by the domain. */
type TrailScrollRestoreMode = "force" | "corrective";

interface TrailEntry {
  url: string;
  title: string;
  favIconUrl: string;
  timestamp: number;
  transition: TrailTransition;
  // True when this commit carried a redirect qualifier: the browser replaced a
  // history entry, so delta-based history.go across this entry is unreliable.
  redirected: boolean;
  // Whether the edge from the preceding entry exists in this tab's native
  // session history. False for lineage inherited when a new tab forks.
  historyBacked: boolean;
  /** Optional last-known viewport; absent ⇒ no restore attempt. */
  viewport?: TrailViewport;
}

// One tab's navigation trail. cursor points at the entry for the page the tab
// is currently on; entries after the cursor are the (dimmed) forward stack.
interface TrailState {
  entries: TrailEntry[];
  cursor: number;
}

// Input to the pure trail reducer, assembled by the domain from a
// webNavigation event. pendingJumpIndex is set when the extension itself
// initiated the navigation by clicking a branch row; pendingJumpKind tells the
// reducer whether to retain a native forward stack or establish a new branch.
interface TrailNavigationEvent {
  kind: "committed" | "historyState" | "refFragment";
  url: string;
  timestamp: number;
  transitionType?: string;
  qualifiers?: string[];
  pendingJumpIndex?: number | null;
  pendingJumpKind?: "historyGo" | "navigate" | null;
}

type TrailJumpPlan =
  | { kind: "historyGo"; delta: number }
  | { kind: "navigate"; url: string };

interface TabTrailActionResult {
  ok: boolean;
  reason?: string;
}

// A durable, user-named snapshot of a path segment (root → selected node).
// Lives in storage.local until the user deletes it — unlike live session trails.
interface SavedTrail {
  id: string;
  name: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  entries: TrailEntry[];
}

type SavedTrailOpenMode = "current" | "new";
