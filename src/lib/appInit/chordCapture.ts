// Lightweight toggle-chord capture used in every frame (including iframes).
// Top-frame overlay hosting lives in topFrameOverlay.ts and is not loaded into subframes
// when the dual content-script split is active.

import browser from "webextension-polyfill";
import {
  loadTabTrailSettings,
  normalizeTabTrailSettings,
  TABTRAIL_STORAGE_KEYS,
} from "../common/contracts/tabtrail";
import {
  matchesToggleTrigger,
  toToggleTriggerEvent,
} from "../core/trail/trailCore";
import { installMouseChordGuard } from "../common/utils/mouseChordGuard";
import { toggleTrailOverlay } from "../adapters/runtime/tabtrailApi";
import {
  retireBootstrapCleanup,
  retireLegacyCombinedBootstrap,
} from "./legacyBootstrap";

declare global {
  interface Window {
    __tabtrailChordCleanup?: () => void;
  }
}

export function initChordCapture(): void {
  retireLegacyCombinedBootstrap();
  retireBootstrapCleanup("__tabtrailChordCleanup");

  let settings = normalizeTabTrailSettings(null);
  let disposed = false;
  const mouseChordGuard = installMouseChordGuard(window);

  void loadTabTrailSettings().then((loaded) => {
    if (disposed) return;
    settings = loaded;
  });

  function fireToggle(): void {
    const requestedAtEpochMs = performance.timeOrigin + performance.now();
    void toggleTrailOverlay(requestedAtEpochMs).catch(() => {
      // Background unreachable even after retries; nothing useful to do here.
    });
  }

  const keydownHandler = (event: KeyboardEvent): void => {
    if (!matchesToggleTrigger(toToggleTriggerEvent(event), settings.trigger)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    fireToggle();
  };

  const mousedownHandler = (event: MouseEvent): void => {
    if (!matchesToggleTrigger(toToggleTriggerEvent(event), settings.trigger)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    mouseChordGuard.arm(event.button);
    fireToggle();
  };

  window.addEventListener("keydown", keydownHandler, true);
  window.addEventListener("mousedown", mousedownHandler, true);

  const storageChangedHandler = (
    changes: Record<string, browser.Storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local" || !changes[TABTRAIL_STORAGE_KEYS.settings]) return;
    settings = normalizeTabTrailSettings(changes[TABTRAIL_STORAGE_KEYS.settings].newValue);
  };
  browser.storage.onChanged.addListener(storageChangedHandler);

  window.__tabtrailChordCleanup = (): void => {
    disposed = true;
    window.removeEventListener("keydown", keydownHandler, true);
    window.removeEventListener("mousedown", mousedownHandler, true);
    mouseChordGuard.dispose();
    browser.storage.onChanged.removeListener(storageChangedHandler);
    delete window.__tabtrailChordCleanup;
  };
}
