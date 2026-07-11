// Runtime message contracts between background, content scripts, and extension pages.

// Messages the background sends TO a content script (top frame of a tab).
export type ContentRuntimeMessage =
  | { type: "TABTRAIL_PING" }
  | { type: "TRAIL_SHOW"; state: TrailState; requestedAtEpochMs?: number }
  | { type: "TRAIL_UPDATED"; state: TrailState }
  | { type: "OVERLAY_FRAME_CHALLENGE"; nonce: string }
  | { type: "HISTORY_GO"; delta: number };

// Messages content scripts and extension pages send TO the background.
export type BackgroundRuntimeMessage =
  | { type: "TRAIL_TOGGLE_OVERLAY"; requestedAtEpochMs?: number }
  | { type: "OVERLAY_FRAME_CLAIM"; nonce: string }
  | { type: "TRAIL_JUMP"; index: number; tabId?: number }
  | { type: "TRAIL_OPEN_IN_NEW_TAB"; index: number; tabId?: number }
  | { type: "TRAIL_OPEN_IN_NEW_WINDOW"; index: number; tabId?: number }
  | { type: "TRAIL_OVERLAY_STATE"; open: boolean }
  | { type: "SAVED_TRAIL_SAVE"; path: TrailEntry[]; name: string }
  | { type: "SAVED_TRAIL_RENAME"; id: string; name: string }
  | {
      type: "SAVED_TRAIL_REPLACE";
      id: string;
      path: TrailEntry[];
      expectedPath?: TrailEntry[];
    }
  | { type: "SAVED_TRAIL_SET_PINNED"; id: string; pinned: boolean }
  | { type: "SAVED_TRAIL_DELETE"; id: string }
  | { type: "SAVED_TRAIL_RESTORE"; trail: SavedTrail }
  | { type: "SAVED_TRAIL_OPEN"; path: TrailEntry[]; mode: SavedTrailOpenMode }
  | { type: "TABTRAIL_OPEN_OPTIONS" }
  | { type: "TABTRAIL_REFRESH_EXTENSION" };
