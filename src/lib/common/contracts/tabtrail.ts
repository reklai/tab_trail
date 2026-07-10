// Shared TabTrail contract: storage keys, setting defaults, and normalizers.
// Every surface (background, content script, popup, options) passes stored
// values through the normalizers here, so data stays valid even when written
// by an older version or changed outside the extension.

import browser from "webextension-polyfill";

// User-facing extension name. Static assets use the __EXTENSION_NAME__
// placeholder substituted at build time (esBuildConfig/build.mjs); keep the
// two in sync when rebranding.
export const EXTENSION_TITLE = "Current Tab History - In-Page Trail";

export const TABTRAIL_STORAGE_KEYS = {
  settings: "tabtrailSettings",
  // Durable named path snapshots (library). Distinct from session trail mirrors.
  savedTrails: "tabtrailSavedTrails",
} as const;

// Per-tab trail mirrors live under this prefix in session storage (or in
// local storage on browsers without storage.session, wiped at startup).
export const TRAIL_MIRROR_KEY_PREFIX = "tabtrailTrail:";

export function trailMirrorKey(tabId: number): string {
  return `${TRAIL_MIRROR_KEY_PREFIX}${tabId}`;
}

export const TABTRAIL_MODIFIER_KEYS: readonly TabTrailModifierKey[] = [
  "alt",
  "ctrl",
  "super",
] as const;

// event.code values we accept for a keyboard trigger: a letter or a top-row digit.
const TRIGGER_KEY_CODE_PATTERN = /^(?:Key[A-Z]|Digit[0-9])$/;

// event.button values we accept for a mouse trigger.
export const TRIGGER_MOUSE_BUTTONS: readonly number[] = [0, 1, 2] as const;

export const MIN_VISIBLE_SEGMENTS = 5;
export const MAX_VISIBLE_SEGMENTS = 12;

export const DEFAULT_TABTRAIL_TRIGGER: TabTrailTrigger = {
  modifier: "alt",
  withShift: false,
  kind: "key",
  keyCode: "KeyH",
  mouseButton: 1,
};

export const DEFAULT_TABTRAIL_SETTINGS: TabTrailSettings = {
  trigger: DEFAULT_TABTRAIL_TRIGGER,
  overlayPosition: null,
  maxVisibleSegments: 8,
};

function normalizeModifierKey(value: unknown, fallback: TabTrailModifierKey): TabTrailModifierKey {
  return TABTRAIL_MODIFIER_KEYS.includes(value as TabTrailModifierKey)
    ? (value as TabTrailModifierKey)
    : fallback;
}

export function isValidTriggerKeyCode(value: unknown): value is string {
  return typeof value === "string" && TRIGGER_KEY_CODE_PATTERN.test(value);
}

export function isValidTriggerMouseButton(value: unknown): value is number {
  return typeof value === "number" && TRIGGER_MOUSE_BUTTONS.includes(value);
}

function normalizeFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeTabTrailTrigger(value: unknown): TabTrailTrigger {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_TABTRAIL_TRIGGER };
  }
  const trigger = value as Partial<TabTrailTrigger>;
  const keyCode = isValidTriggerKeyCode(trigger.keyCode)
    ? trigger.keyCode
    : DEFAULT_TABTRAIL_TRIGGER.keyCode;
  const mouseButton = isValidTriggerMouseButton(trigger.mouseButton)
    ? trigger.mouseButton
    : DEFAULT_TABTRAIL_TRIGGER.mouseButton;
  return {
    modifier: normalizeModifierKey(trigger.modifier, DEFAULT_TABTRAIL_TRIGGER.modifier),
    withShift: normalizeFlag(trigger.withShift, DEFAULT_TABTRAIL_TRIGGER.withShift),
    kind: trigger.kind === "mouse" ? "mouse" : "key",
    keyCode,
    mouseButton,
  };
}

function normalizeOverlayPosition(value: unknown): TabTrailOverlayPosition | null {
  if (typeof value !== "object" || value === null) return null;
  const position = value as Partial<TabTrailOverlayPosition>;
  const x = Number(position.xPercent);
  const y = Number(position.yPercent);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    xPercent: Math.min(Math.max(x, 0), 100),
    yPercent: Math.min(Math.max(y, 0), 100),
  };
}

function normalizeMaxVisibleSegments(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return DEFAULT_TABTRAIL_SETTINGS.maxVisibleSegments;
  return Math.min(Math.max(numeric, MIN_VISIBLE_SEGMENTS), MAX_VISIBLE_SEGMENTS);
}

export function normalizeTabTrailSettings(value: unknown): TabTrailSettings {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_TABTRAIL_SETTINGS, trigger: { ...DEFAULT_TABTRAIL_TRIGGER } };
  }
  const settings = value as Partial<TabTrailSettings>;
  return {
    trigger: normalizeTabTrailTrigger(settings.trigger),
    overlayPosition: normalizeOverlayPosition(settings.overlayPosition),
    maxVisibleSegments: normalizeMaxVisibleSegments(settings.maxVisibleSegments),
  };
}

export function formatTabTrailModifierKey(modifier: TabTrailModifierKey): string {
  if (modifier === "ctrl") return "Ctrl / Control";
  if (modifier === "super") return "Super / Command";
  return "Alt / Option";
}

export function formatTriggerKeyLabel(keyCode: string): string {
  if (keyCode.startsWith("Key")) return keyCode.slice(3);
  if (keyCode.startsWith("Digit")) return keyCode.slice(5);
  return keyCode;
}

export function formatTriggerMouseLabel(button: number): string {
  if (button === 0) return "Left Click";
  if (button === 1) return "Middle Click";
  if (button === 2) return "Right Click";
  return `Mouse Button ${button}`;
}

export function formatTabTrailTriggerCombo(trigger: TabTrailTrigger): string {
  const parts = [formatTabTrailModifierKey(trigger.modifier).split(" / ")[0]];
  if (trigger.withShift) parts.push("Shift");
  parts.push(
    trigger.kind === "mouse"
      ? formatTriggerMouseLabel(trigger.mouseButton)
      : formatTriggerKeyLabel(trigger.keyCode),
  );
  return parts.join(" + ");
}

export async function loadTabTrailSettings(): Promise<TabTrailSettings> {
  try {
    const data = await browser.storage.local.get(TABTRAIL_STORAGE_KEYS.settings);
    return normalizeTabTrailSettings(data[TABTRAIL_STORAGE_KEYS.settings]);
  } catch (_) {
    return { ...DEFAULT_TABTRAIL_SETTINGS, trigger: { ...DEFAULT_TABTRAIL_TRIGGER } };
  }
}

export async function saveTabTrailSettings(settings: TabTrailSettings): Promise<void> {
  await browser.storage.local.set({
    [TABTRAIL_STORAGE_KEYS.settings]: normalizeTabTrailSettings(settings),
  });
}

// Named trail I/O lives in adapters/storage/savedTrailsStore.ts (load/save/delete
// with normalizers). Only the storage key is declared here.
