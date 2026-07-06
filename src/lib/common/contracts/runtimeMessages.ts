// Runtime message contracts between background, content scripts, and extension pages.

// Messages the background sends TO a content script (top frame of a tab).
export type ContentRuntimeMessage =
  | { type: "WAYFIND_PING" }
  | { type: "TRAIL_SHOW"; state: TrailState }
  | { type: "TRAIL_UPDATED"; state: TrailState }
  | { type: "HISTORY_GO"; delta: number };

// Messages content scripts and extension pages send TO the background.
export type BackgroundRuntimeMessage =
  | { type: "TRAIL_CONTENT_READY" }
  | { type: "TRAIL_GET"; tabId?: number }
  | { type: "TRAIL_TOGGLE_OVERLAY" }
  | { type: "TRAIL_JUMP"; index: number; tabId?: number }
  | { type: "TRAIL_OPEN_IN_NEW_TAB"; index: number; tabId?: number }
  | { type: "TRAIL_OPEN_IN_NEW_WINDOW"; index: number; tabId?: number }
  | { type: "TRAIL_OVERLAY_STATE"; open: boolean }
  | { type: "WAYFIND_OPEN_OPTIONS" }
  | { type: "WAYFIND_REFRESH_EXTENSION" };
