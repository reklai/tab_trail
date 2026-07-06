// Runtime message contracts between background, content scripts, and extension pages.

// Messages the background sends TO a content script (top frame of a tab).
export type ContentRuntimeMessage =
  | { type: "TABTRAIL_PING" }
  | { type: "TRAIL_SHOW"; state: TrailState }
  | { type: "TRAIL_UPDATED"; state: TrailState }
  | { type: "HISTORY_GO"; delta: number };

// Messages content scripts and extension pages send TO the background.
export type BackgroundRuntimeMessage =
  | { type: "TRAIL_TOGGLE_OVERLAY" }
  | { type: "TRAIL_JUMP"; index: number; tabId?: number }
  | { type: "TRAIL_OPEN_IN_NEW_TAB"; index: number; tabId?: number }
  | { type: "TRAIL_OPEN_IN_NEW_WINDOW"; index: number; tabId?: number }
  | { type: "TRAIL_OVERLAY_STATE"; open: boolean }
  | { type: "TABTRAIL_OPEN_OPTIONS" }
  | { type: "TABTRAIL_REFRESH_EXTENSION" };
