// Shared project type declarations

// Allow importing .css files as text (esbuild text loader)
declare module "*.css" {
  const content: string;
  export default content;
}

// "super" is the OS/Windows/Command key — it maps to KeyboardEvent.metaKey.
type WayfindModifierKey = "alt" | "ctrl" | "super";

// The toggle trigger is a chord: one modifier (plus optional Shift) combined
// with either a letter/top-row digit key (matched by event.code) or left,
// middle, or right click (matched by event.button on mousedown). "kind" picks
// which half applies.
interface WayfindTrigger {
  modifier: WayfindModifierKey;
  withShift: boolean;
  kind: "key" | "mouse";
  keyCode: string;
  mouseButton: number;
}

interface WayfindOverlayPosition {
  xPercent: number;
  yPercent: number;
}

interface WayfindSettings {
  trigger: WayfindTrigger;
  showTransitionArrows: boolean;
  overlayPosition: WayfindOverlayPosition | null;
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

interface TrailEntry {
  url: string;
  title: string;
  favIconUrl: string;
  timestamp: number;
  transition: TrailTransition;
  // True when this commit carried a redirect qualifier: the browser replaced a
  // history entry, so delta-based history.go across this entry is unreliable.
  redirected: boolean;
}

// One tab's navigation trail. cursor points at the entry for the page the tab
// is currently on; entries after the cursor are the (dimmed) forward stack.
interface TrailState {
  entries: TrailEntry[];
  cursor: number;
}

// Input to the pure trail reducer, assembled by the domain from a
// webNavigation event. pendingJumpIndex is set when the extension itself
// initiated the navigation by clicking a branch row.
interface TrailNavigationEvent {
  kind: "committed" | "historyState" | "refFragment";
  url: string;
  timestamp: number;
  transitionType?: string;
  qualifiers?: string[];
  pendingJumpIndex?: number | null;
}

type TrailJumpPlan =
  | { kind: "historyGo"; delta: number }
  | { kind: "navigate"; url: string };

interface WayfindActionResult {
  ok: boolean;
  reason?: string;
}

// Snapshot returned to the overlay/popup for rendering.
interface TrailSnapshot {
  ok: boolean;
  tabId: number | null;
  state: TrailState;
}
