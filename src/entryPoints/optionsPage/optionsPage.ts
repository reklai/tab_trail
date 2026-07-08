// Options page: the full TabTrail settings surface. Every control saves on
// change and round-trips through the shared normalizers so stored data stays
// valid. The shortcut capture button records either a keydown (event.code) or
// a mousedown (event.button) — whichever the user performs first.

import browser from "webextension-polyfill";
import {
  DEFAULT_TABTRAIL_SETTINGS,
  DEFAULT_TABTRAIL_TRIGGER,
  EXTENSION_TITLE,
  formatTabTrailTriggerCombo,
  loadTabTrailSettings,
  saveTabTrailSettings,
} from "../../lib/common/contracts/tabtrail";
import { refreshTabTrailExtension } from "../../lib/adapters/runtime/tabtrailApi";
import {
  createShortcutCaptureController,
  populateModifierSelect,
  ShortcutCaptureController,
} from "../../lib/ui/settings/settingsControls";

let settings: TabTrailSettings = {
  ...DEFAULT_TABTRAIL_SETTINGS,
  trigger: { ...DEFAULT_TABTRAIL_TRIGGER },
};
let captureController: ShortcutCaptureController | null = null;

function element<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function renderSettings(): void {
  const modifierSelect = element<HTMLSelectElement>("triggerModifier");
  if (modifierSelect) populateModifierSelect(modifierSelect, settings.trigger.modifier);

  const shiftInput = element<HTMLInputElement>("triggerWithShift");
  if (shiftInput) shiftInput.checked = settings.trigger.withShift;

  captureController?.showTrigger(settings.trigger);

  const maxVisibleInput = element<HTMLInputElement>("maxVisibleSegments");
  if (maxVisibleInput && document.activeElement !== maxVisibleInput) {
    maxVisibleInput.value = String(settings.maxVisibleSegments);
  }

  const combo = formatTabTrailTriggerCombo(settings.trigger);
  const shortcutLabel = element("shortcutLabel");
  if (shortcutLabel) shortcutLabel.textContent = `Press ${combo} to show ${EXTENSION_TITLE}`;

  for (const node of document.querySelectorAll<HTMLElement>("[data-combo]")) {
    node.textContent = combo;
  }
}

async function persistSettings(): Promise<void> {
  await saveTabTrailSettings(settings);
  settings = await loadTabTrailSettings();
  renderSettings();
}

async function refreshTabTrail(): Promise<void> {
  const refreshBtn = element<HTMLButtonElement>("refreshBtn");
  if (!refreshBtn) return;
  const originalLabel = refreshBtn.textContent || "Refresh";
  refreshBtn.disabled = true;
  try {
    const result = await refreshTabTrailExtension().catch(() => ({
      ok: false,
      reason: "Refresh failed",
    }));
    refreshBtn.textContent = result.ok ? "Refreshed" : result.reason || "Refresh failed";
    window.setTimeout(() => {
      refreshBtn.textContent = originalLabel;
      refreshBtn.disabled = false;
    }, 1200);
  } catch (_) {
    refreshBtn.textContent = "Refresh failed";
    window.setTimeout(() => {
      refreshBtn.textContent = originalLabel;
      refreshBtn.disabled = false;
    }, 1200);
  }
}

function bindControls(): void {
  element<HTMLSelectElement>("triggerModifier")?.addEventListener("change", (event) => {
    const modifier = (event.target as HTMLSelectElement).value as TabTrailModifierKey;
    settings = { ...settings, trigger: { ...settings.trigger, modifier } };
    void persistSettings();
  });

  element<HTMLInputElement>("triggerWithShift")?.addEventListener("change", (event) => {
    const withShift = (event.target as HTMLInputElement).checked;
    settings = { ...settings, trigger: { ...settings.trigger, withShift } };
    void persistSettings();
  });

  element<HTMLInputElement>("maxVisibleSegments")?.addEventListener("change", (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    settings = { ...settings, maxVisibleSegments: value };
    void persistSettings();
  });

  element("resetPositionBtn")?.addEventListener("click", () => {
    settings = { ...settings, overlayPosition: null };
    void persistSettings();
  });

  element("resetShortcutBtn")?.addEventListener("click", () => {
    settings = { ...settings, trigger: { ...DEFAULT_TABTRAIL_TRIGGER } };
    void persistSettings();
  });

  element("refreshBtn")?.addEventListener("click", () => {
    void refreshTabTrail();
  });

  element("closeBtn")?.addEventListener("click", async () => {
    const tab = await browser.tabs.getCurrent().catch(() => null);
    if (tab?.id != null) {
      await browser.tabs.remove(tab.id).catch(() => {});
    }
  });
}

async function init(): Promise<void> {
  settings = await loadTabTrailSettings();
  const captureButton = element("triggerCaptureBtn");
  if (captureButton) {
    captureController = createShortcutCaptureController(captureButton, (patch) => {
      settings = { ...settings, trigger: { ...settings.trigger, ...patch } };
      void persistSettings();
    });
  }
  renderSettings();
  bindControls();
}

void init();
