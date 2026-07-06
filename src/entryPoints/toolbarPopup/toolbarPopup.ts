// Browser-action popup for Wayfind trigger controls.

import browser from "webextension-polyfill";
import {
  DEFAULT_WAYFIND_TRIGGER,
  formatTriggerKeyLabel,
  formatTriggerMouseLabel,
  formatWayfindTriggerCombo,
  isValidTriggerKeyCode,
  isValidTriggerMouseButton,
  loadWayfindSettings,
  MAX_VISIBLE_SEGMENTS,
  MIN_VISIBLE_SEGMENTS,
  saveWayfindSettings,
} from "../../lib/common/contracts/wayfind";
import { refreshWayfindExtension } from "../../lib/adapters/runtime/wayfindApi";
import { populateModifierSelect } from "../../lib/ui/settings/settingsControls";

const EXTENSION_TITLE = "Wayfind";

type PageShortcutAvailability = "ready" | "restricted" | "unavailable";

interface FallbackNotice {
  title: string;
  message: string;
}

const BROWSER_RESTRICTED_NOTICE: FallbackNotice = {
  title: "Browser-Restricted Page",
  message: "The browser does not allow extension scripts on restricted pages. Wayfind cannot listen for keyboard or mouse shortcuts or show the in-page trail here. Use the popup controls below to change shortcut and overlay settings, reset the shortcut, or open Settings.",
};

const PAGE_SHORTCUT_UNAVAILABLE_NOTICE: FallbackNotice = {
  title: "Page Shortcut Not Ready",
  message: "Wayfind cannot reach this tab yet. Refresh the page, then try the shortcut again. You can still use the popup controls below to change shortcut and overlay settings, reset the shortcut, or open Settings.",
};

const BROWSER_STORE_RESTRICTED_HOSTS = new Set([
  "addons.mozilla.org",
  "chromewebstore.google.com",
  "microsoftedge.microsoft.com",
]);

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function isKnownBrowserStoreRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = normalizeHostname(parsed.hostname);
    if (BROWSER_STORE_RESTRICTED_HOSTS.has(hostname)) return true;
    return hostname === "chrome.google.com" && parsed.pathname.toLowerCase().startsWith("/webstore");
  } catch (_) {
    return false;
  }
}

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
    const response = await browser.tabs.sendMessage(activeTab.id, { type: "WAYFIND_PING" }, { frameId: 0 });
    return typeof response === "object" && response !== null && (response as WayfindActionResult).ok === true
      ? "ready"
      : "unavailable";
  } catch (_) {
    return "unavailable";
  }
}

function triggerButtonLabel(trigger: WayfindTrigger): string {
  return trigger.kind === "mouse"
    ? formatTriggerMouseLabel(trigger.mouseButton)
    : formatTriggerKeyLabel(trigger.keyCode);
}

document.addEventListener("DOMContentLoaded", () => {
  void initPopup().catch(() => {
    const toast = document.getElementById("popupToast");
    if (!toast) return;
    toast.textContent = "Wayfind popup failed to initialize.";
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
  const refreshBtn = document.getElementById("refreshWayfindBtn") as HTMLButtonElement;
  const modifierSelect = document.getElementById("triggerModifier") as HTMLSelectElement;
  const shiftInput = document.getElementById("triggerWithShift") as HTMLInputElement;
  const captureButton = document.getElementById("triggerCaptureBtn") as HTMLButtonElement;
  const maxVisibleInput = document.getElementById("maxVisibleSegments") as HTMLInputElement;
  const resetShortcutBtn = document.getElementById("resetShortcutBtn") as HTMLButtonElement;
  const resetPositionBtn = document.getElementById("resetPositionBtn") as HTMLButtonElement;
  const settingsBtn = document.getElementById("settingsBtn") as HTMLButtonElement;
  const closeBtn = document.getElementById("closePopupBtn") as HTMLButtonElement;

  const [loadedSettings, initialShortcutAvailability] = await Promise.all([
    loadWayfindSettings(),
    detectPageShortcutAvailability(),
  ]);
  let settings = loadedSettings;
  let shortcutAvailability = initialShortcutAvailability;
  let capturing = false;
  let suppressNextCaptureClick = false;
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

    const combo = formatWayfindTriggerCombo(settings.trigger);
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

    if (!capturing) {
      captureButton.textContent = triggerButtonLabel(settings.trigger);
      captureButton.classList.remove("is-capturing");
    }
  }

  async function persistSettings(nextSettings: WayfindSettings, message = "Saved"): Promise<void> {
    settings = nextSettings;
    await saveWayfindSettings(settings);
    settings = await loadWayfindSettings();
    shortcutAvailability = await detectPageShortcutAvailability();
    renderSettings();
    showStatus(message);
  }

  async function persistTrigger(patch: Partial<WayfindTrigger>): Promise<void> {
    await persistSettings({ ...settings, trigger: { ...settings.trigger, ...patch } });
  }

  async function refreshWayfind(): Promise<void> {
    refreshBtn.disabled = true;
    try {
      const result = await refreshWayfindExtension().catch(() => ({
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

  function captureKeydown(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopCapture();
      return;
    }
    if (isValidTriggerKeyCode(event.code)) {
      stopCapture();
      void persistTrigger({ kind: "key", keyCode: event.code });
    }
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
    stopCapture();
    void persistTrigger({ kind: "mouse", mouseButton: event.button });
  }

  function captureContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  function startCapture(): void {
    if (capturing) return;
    capturing = true;
    captureButton.textContent = "Press key / click";
    captureButton.classList.add("is-capturing");
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

  modifierSelect.addEventListener("change", () => {
    void persistTrigger({ modifier: modifierSelect.value as WayfindModifierKey });
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

  captureButton.addEventListener("click", (event) => {
    if (suppressNextCaptureClick) {
      event.preventDefault();
      event.stopPropagation();
      suppressNextCaptureClick = false;
      return;
    }
    startCapture();
  });

  resetShortcutBtn.addEventListener("click", () => {
    void persistSettings({ ...settings, trigger: { ...DEFAULT_WAYFIND_TRIGGER } }, "Shortcut reset");
  });

  refreshBtn.addEventListener("click", () => {
    void refreshWayfind();
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
