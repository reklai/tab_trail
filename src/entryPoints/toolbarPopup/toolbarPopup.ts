// Browser-action popup for TabTrail trigger controls.

import browser from "webextension-polyfill";
import {
  DEFAULT_TABTRAIL_TRIGGER,
  formatTabTrailTriggerCombo,
  loadTabTrailSettings,
  MAX_VISIBLE_SEGMENTS,
  MIN_VISIBLE_SEGMENTS,
  saveTabTrailSettings,
} from "../../lib/common/contracts/tabtrail";
import { refreshTabTrailExtension } from "../../lib/adapters/runtime/tabtrailApi";
import {
  createShortcutCaptureController,
  populateModifierSelect,
} from "../../lib/ui/settings/settingsControls";
import { isKnownBrowserStoreRestrictedUrl } from "../../lib/common/utils/restrictedUrls";

const EXTENSION_TITLE = "TabTrail";

type PageShortcutAvailability = "ready" | "restricted" | "unavailable";

interface FallbackNotice {
  title: string;
  message: string;
}

const BROWSER_RESTRICTED_NOTICE: FallbackNotice = {
  title: "Browser-Restricted Page",
  message: "The browser does not allow extension scripts on restricted pages. TabTrail cannot listen for keyboard or mouse shortcuts or show the in-page trail here. Use the popup controls below to change shortcut and overlay settings, reset the shortcut, or open Settings.",
};

const PAGE_SHORTCUT_UNAVAILABLE_NOTICE: FallbackNotice = {
  title: "Page Shortcut Not Ready",
  message: "TabTrail cannot reach this tab yet. Refresh the page, then try the shortcut again. You can still use the popup controls below to change shortcut and overlay settings, reset the shortcut, or open Settings.",
};

function isPageShortcutRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
    return isKnownBrowserStoreRestrictedUrl(parsed.href);
  } catch (_) {
    return true;
  }
}

async function detectPageShortcutAvailability(): Promise<PageShortcutAvailability> {
  const [activeTab] = await browser.tabs
    .query({ active: true, currentWindow: true })
    .catch(() => []);
  if (!activeTab || activeTab.id == null || activeTab.discarded === true) return "unavailable";
  if (isPageShortcutRestrictedUrl(activeTab.url)) return "restricted";

  try {
    const response = await browser.tabs.sendMessage(activeTab.id, { type: "TABTRAIL_PING" }, { frameId: 0 });
    return typeof response === "object" && response !== null && (response as TabTrailActionResult).ok === true
      ? "ready"
      : "unavailable";
  } catch (_) {
    return "unavailable";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  void initPopup().catch(() => {
    const toast = document.getElementById("popupToast");
    if (!toast) return;
    toast.textContent = "TabTrail popup failed to initialize.";
    toast.classList.add("is-visible");
  });
});

async function initPopup(): Promise<void> {
  const shortcutLabel = document.getElementById("shortcutLabel")!;
  const shortcutStatus = document.getElementById("shortcutStatus")!;
  const fallbackPanel = document.getElementById("fallbackPanel")!;
  const fallbackTitle = document.getElementById("fallbackTitle")!;
  const fallbackMessage = document.getElementById("fallbackMessage")!;
  const triggerSummary = document.getElementById("triggerSummary")!;
  const overlaySummary = document.getElementById("overlaySummary")!;
  const titlebarText = document.getElementById("titlebarText")!;
  const toast = document.getElementById("popupToast")!;
  const refreshBtn = document.getElementById("refreshTabTrailBtn") as HTMLButtonElement;
  const modifierSelect = document.getElementById("triggerModifier") as HTMLSelectElement;
  const shiftInput = document.getElementById("triggerWithShift") as HTMLInputElement;
  const captureButton = document.getElementById("triggerCaptureBtn") as HTMLButtonElement;
  const maxVisibleInput = document.getElementById("maxVisibleSegments") as HTMLInputElement;
  const resetShortcutBtn = document.getElementById("resetShortcutBtn") as HTMLButtonElement;
  const resetPositionBtn = document.getElementById("resetPositionBtn") as HTMLButtonElement;
  const settingsBtn = document.getElementById("settingsBtn") as HTMLButtonElement;
  const closeBtn = document.getElementById("closePopupBtn") as HTMLButtonElement;

  const [loadedSettings, initialShortcutAvailability] = await Promise.all([
    loadTabTrailSettings(),
    detectPageShortcutAvailability(),
  ]);
  let settings = loadedSettings;
  let shortcutAvailability = initialShortcutAvailability;
  let statusTimer = 0;

  function clearStatusTimer(): void {
    if (statusTimer) window.clearTimeout(statusTimer);
    statusTimer = 0;
  }

  function hideStatus(): void {
    clearStatusTimer();
    toast.classList.remove("is-visible");
    toast.textContent = "";
  }

  function showStatus(message: string): void {
    clearStatusTimer();
    toast.textContent = message;
    toast.classList.add("is-visible");
    statusTimer = window.setTimeout(() => {
      hideStatus();
    }, 1800);
  }

  function renderSettings(): void {
    titlebarText.textContent = EXTENSION_TITLE;
    populateModifierSelect(modifierSelect, settings.trigger.modifier);
    shiftInput.checked = settings.trigger.withShift;
    maxVisibleInput.min = String(MIN_VISIBLE_SEGMENTS);
    maxVisibleInput.max = String(MAX_VISIBLE_SEGMENTS);
    maxVisibleInput.value = String(settings.maxVisibleSegments);

    const combo = formatTabTrailTriggerCombo(settings.trigger);
    shortcutLabel.textContent = `Press ${combo} to show your trail`;
    const pageShortcutsReady = shortcutAvailability === "ready";
    fallbackPanel.hidden = pageShortcutsReady;
    shortcutStatus.hidden = !pageShortcutsReady;
    if (pageShortcutsReady) {
      shortcutStatus.textContent = settings.trigger.kind === "mouse"
        ? "Mouse shortcut active on normal web pages."
        : "Keyboard shortcut active on normal web pages.";
    } else {
      const notice = shortcutAvailability === "restricted"
        ? BROWSER_RESTRICTED_NOTICE
        : PAGE_SHORTCUT_UNAVAILABLE_NOTICE;
      fallbackTitle.textContent = notice.title;
      fallbackMessage.textContent = notice.message;
      shortcutStatus.textContent = "";
    }
    triggerSummary.textContent = combo;
    overlaySummary.textContent = `${settings.maxVisibleSegments} visible rows`;

    captureController.showTrigger(settings.trigger);
  }

  async function persistSettings(nextSettings: TabTrailSettings, message = "Saved"): Promise<void> {
    settings = nextSettings;
    await saveTabTrailSettings(settings);
    settings = await loadTabTrailSettings();
    shortcutAvailability = await detectPageShortcutAvailability();
    renderSettings();
    showStatus(message);
  }

  async function persistTrigger(patch: Partial<TabTrailTrigger>): Promise<void> {
    await persistSettings({ ...settings, trigger: { ...settings.trigger, ...patch } });
  }

  async function refreshTabTrail(): Promise<void> {
    refreshBtn.disabled = true;
    try {
      const result = await refreshTabTrailExtension().catch(() => ({
        ok: false,
        reason: "Refresh failed",
      }));
      shortcutAvailability = await detectPageShortcutAvailability();
      renderSettings();
      showStatus(result.ok ? "Refreshed" : result.reason || "Refresh failed");
    } finally {
      refreshBtn.disabled = false;
    }
  }

  const captureController = createShortcutCaptureController(captureButton, (patch) => {
    void persistTrigger(patch);
  });

  modifierSelect.addEventListener("change", () => {
    void persistTrigger({ modifier: modifierSelect.value as TabTrailModifierKey });
  });

  shiftInput.addEventListener("change", () => {
    void persistTrigger({ withShift: shiftInput.checked });
  });

  maxVisibleInput.addEventListener("change", () => {
    void persistSettings({ ...settings, maxVisibleSegments: Number(maxVisibleInput.value) });
  });

  resetPositionBtn.addEventListener("click", () => {
    void persistSettings({ ...settings, overlayPosition: null }, "Position reset");
  });

  resetShortcutBtn.addEventListener("click", () => {
    void persistSettings({ ...settings, trigger: { ...DEFAULT_TABTRAIL_TRIGGER } }, "Shortcut reset");
  });

  refreshBtn.addEventListener("click", () => {
    void refreshTabTrail();
  });

  settingsBtn.addEventListener("click", () => {
    void browser.runtime.openOptionsPage().catch(() => {});
    window.close();
  });

  closeBtn.addEventListener("click", () => {
    window.close();
  });

  renderSettings();
}
