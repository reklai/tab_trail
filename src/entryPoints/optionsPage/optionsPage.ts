// Options page: the full TabTrail settings surface. Every control saves on
// change and round-trips through the shared normalizers so stored data stays
// valid. The shortcut capture button records either a keydown (event.code) or
// a mousedown (event.button) — whichever the user performs first.

import browser from "webextension-polyfill";
import {
  DEFAULT_WAYFIND_SETTINGS,
  DEFAULT_WAYFIND_TRIGGER,
  formatTriggerKeyLabel,
  formatTriggerMouseLabel,
  formatWayfindTriggerCombo,
  isValidTriggerKeyCode,
  isValidTriggerMouseButton,
  loadWayfindSettings,
  saveWayfindSettings,
} from "../../lib/common/contracts/wayfind";
import { refreshWayfindExtension } from "../../lib/adapters/runtime/wayfindApi";
import { populateModifierSelect } from "../../lib/ui/settings/settingsControls";

let settings: WayfindSettings = {
  ...DEFAULT_WAYFIND_SETTINGS,
  trigger: { ...DEFAULT_WAYFIND_TRIGGER },
};
let capturing = false;
let suppressNextCaptureClick = false;

function element<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function triggerButtonLabel(): string {
  return settings.trigger.kind === "mouse"
    ? formatTriggerMouseLabel(settings.trigger.mouseButton)
    : formatTriggerKeyLabel(settings.trigger.keyCode);
}

function renderSettings(): void {
  const modifierSelect = element<HTMLSelectElement>("triggerModifier");
  if (modifierSelect) populateModifierSelect(modifierSelect, settings.trigger.modifier);

  const shiftInput = element<HTMLInputElement>("triggerWithShift");
  if (shiftInput) shiftInput.checked = settings.trigger.withShift;

  const captureButton = element("triggerCaptureBtn");
  if (captureButton && !capturing) {
    captureButton.textContent = triggerButtonLabel();
    captureButton.classList.remove("is-capturing");
  }

  const maxVisibleInput = element<HTMLInputElement>("maxVisibleSegments");
  if (maxVisibleInput && document.activeElement !== maxVisibleInput) {
    maxVisibleInput.value = String(settings.maxVisibleSegments);
  }

  const combo = formatWayfindTriggerCombo(settings.trigger);
  const shortcutLabel = element("shortcutLabel");
  if (shortcutLabel) shortcutLabel.textContent = `Press ${combo} to show your trail`;

  for (const node of document.querySelectorAll<HTMLElement>("[data-combo]")) {
    node.textContent = combo;
  }
}

async function persistSettings(): Promise<void> {
  await saveWayfindSettings(settings);
  settings = await loadWayfindSettings();
  renderSettings();
}

async function refreshWayfind(): Promise<void> {
  const refreshBtn = element<HTMLButtonElement>("refreshBtn");
  if (!refreshBtn) return;
  const originalLabel = refreshBtn.textContent || "Refresh";
  refreshBtn.disabled = true;
  try {
    const result = await refreshWayfindExtension().catch(() => ({
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

function captureKeydown(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    stopCapture();
    return;
  }
  if (isValidTriggerKeyCode(event.code)) {
    settings = {
      ...settings,
      trigger: { ...settings.trigger, kind: "key", keyCode: event.code },
    };
    stopCapture();
    void persistSettings();
  }
  // Modifier-only presses keep the capture open until a valid key arrives.
}

function captureMousedown(event: MouseEvent): void {
  if (!isValidTriggerMouseButton(event.button)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  suppressNextCaptureClick = true;
  window.setTimeout(() => {
    suppressNextCaptureClick = false;
  }, 250);
  settings = {
    ...settings,
    trigger: { ...settings.trigger, kind: "mouse", mouseButton: event.button },
  };
  stopCapture();
  void persistSettings();
}

function captureContextMenu(event: MouseEvent): void {
  // Right-button captures must not also open the page context menu.
  event.preventDefault();
  event.stopPropagation();
}

function startCapture(): void {
  if (capturing) return;
  capturing = true;
  const captureButton = element("triggerCaptureBtn");
  if (captureButton) {
    captureButton.textContent = "Press key / click";
    captureButton.classList.add("is-capturing");
  }
  // Delay the mousedown hook one tick so the click that opened the capture
  // does not immediately cancel it.
  window.setTimeout(() => {
    if (!capturing) return;
    window.addEventListener("keydown", captureKeydown, true);
    window.addEventListener("mousedown", captureMousedown, true);
    window.addEventListener("contextmenu", captureContextMenu, true);
  }, 0);
}

function stopCapture(): void {
  if (!capturing) return;
  capturing = false;
  window.removeEventListener("keydown", captureKeydown, true);
  window.removeEventListener("mousedown", captureMousedown, true);
  window.removeEventListener("contextmenu", captureContextMenu, true);
  renderSettings();
}

function bindControls(): void {
  element<HTMLSelectElement>("triggerModifier")?.addEventListener("change", (event) => {
    const modifier = (event.target as HTMLSelectElement).value as WayfindModifierKey;
    settings = { ...settings, trigger: { ...settings.trigger, modifier } };
    void persistSettings();
  });

  element<HTMLInputElement>("triggerWithShift")?.addEventListener("change", (event) => {
    const withShift = (event.target as HTMLInputElement).checked;
    settings = { ...settings, trigger: { ...settings.trigger, withShift } };
    void persistSettings();
  });

  element("triggerCaptureBtn")?.addEventListener("click", (event) => {
    if (suppressNextCaptureClick) {
      event.preventDefault();
      event.stopPropagation();
      suppressNextCaptureClick = false;
      return;
    }
    startCapture();
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
    settings = { ...settings, trigger: { ...DEFAULT_WAYFIND_TRIGGER } };
    void persistSettings();
  });

  element("refreshBtn")?.addEventListener("click", () => {
    void refreshWayfind();
  });

  element("closeBtn")?.addEventListener("click", async () => {
    const tab = await browser.tabs.getCurrent().catch(() => null);
    if (tab?.id != null) {
      await browser.tabs.remove(tab.id).catch(() => {});
    }
  });
}

async function init(): Promise<void> {
  settings = await loadWayfindSettings();
  renderSettings();
  bindControls();
}

void init();
