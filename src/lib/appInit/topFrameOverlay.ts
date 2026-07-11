// Top-frame-only overlay host: MessagePort iframe, trail updates, history.go.
// Chord capture is owned by chordCapture.ts (all frames).

import browser from "webextension-polyfill";
import {
  loadTabTrailSettings,
  normalizeTabTrailSettings,
  saveTabTrailSettings,
  TABTRAIL_STORAGE_KEYS,
} from "../common/contracts/tabtrail";
import { ContentRuntimeMessage } from "../common/contracts/runtimeMessages";
import {
  createOverlayFrameController,
  type OverlayFrameController,
} from "../ui/overlayFrame/overlayFrameController";
import {
  retireBootstrapCleanup,
  retireLegacyCombinedBootstrap,
} from "./legacyBootstrap";

declare global {
  interface Window {
    __tabtrailTopCleanup?: () => void;
  }
}

function isTopFrame(): boolean {
  try {
    return window.self === window.top;
  } catch (_) {
    return false;
  }
}

export function initTopFrameOverlay(): void {
  retireLegacyCombinedBootstrap();
  retireBootstrapCleanup("__tabtrailTopCleanup");
  if (!isTopFrame()) return;

  let settings = normalizeTabTrailSettings(null);
  let disposed = false;
  let overlayController: OverlayFrameController | null = createOverlayFrameController({
    onPositionChange: async (position) => {
      settings = { ...settings, overlayPosition: position };
      overlayController?.updateSettings(settings);
      await saveTabTrailSettings(settings);
    },
  });

  void loadTabTrailSettings().then((loaded) => {
    if (disposed) return;
    settings = loaded;
    overlayController?.updateSettings(settings);
  });

  const storageChangedHandler = (
    changes: Record<string, browser.Storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local" || !changes[TABTRAIL_STORAGE_KEYS.settings]) return;
    settings = normalizeTabTrailSettings(changes[TABTRAIL_STORAGE_KEYS.settings].newValue);
    overlayController?.updateSettings(settings);
  };
  browser.storage.onChanged.addListener(storageChangedHandler);

  const destroyOpenOverlay = (): void => {
    overlayController?.close({ mode: "destroy", reason: "Page became unavailable" });
  };

  const messageHandler = (message: unknown): Promise<unknown> | undefined => {
    if (typeof message !== "object" || message === null) return undefined;
    const typed = message as ContentRuntimeMessage;
    switch (typed.type) {
      case "TABTRAIL_PING":
        return Promise.resolve({ ok: true });
      case "OVERLAY_FRAME_CHALLENGE":
        return Promise.resolve(overlayController?.authorizeClaim(typed.nonce) ?? {
          ok: false,
          reason: "Overlay frame unavailable",
        });
      case "TRAIL_SHOW":
        if (overlayController?.isOpen()) {
          overlayController.close({ mode: "hibernate" });
          return Promise.resolve({ ok: true });
        }
        return (overlayController?.open(
          typed.state,
          settings,
          Number.isFinite(typed.requestedAtEpochMs)
            ? typed.requestedAtEpochMs
            : undefined,
        ) ?? Promise.resolve(false))
          .then((opened) => opened
            ? { ok: true }
            : { ok: false, reason: "Overlay unavailable on this page" });
      case "TRAIL_UPDATED":
        overlayController?.updateTrail(typed.state);
        return Promise.resolve({ ok: true });
      case "HISTORY_GO":
        try {
          window.history.go(typed.delta);
          return Promise.resolve({ ok: true });
        } catch (_) {
          return Promise.resolve({ ok: false, reason: "history.go failed" });
        }
      default:
        return undefined;
    }
  };
  browser.runtime.onMessage.addListener(messageHandler);

  const visibilityChangeHandler = (): void => {
    if (document.visibilityState !== "hidden") return;
    destroyOpenOverlay();
  };
  window.addEventListener("pagehide", destroyOpenOverlay);
  document.addEventListener("visibilitychange", visibilityChangeHandler);

  window.__tabtrailTopCleanup = (): void => {
    disposed = true;
    window.removeEventListener("pagehide", destroyOpenOverlay);
    document.removeEventListener("visibilitychange", visibilityChangeHandler);
    overlayController?.close({ mode: "destroy", reason: "Content script stopped" });
    overlayController?.dispose();
    overlayController = null;
    // Tear down page-owned state before touching extension APIs: those APIs
    // can throw after an update invalidates the previous script context.
    browser.storage.onChanged.removeListener(storageChangedHandler);
    browser.runtime.onMessage.removeListener(messageHandler);
    delete window.__tabtrailTopCleanup;
  };
}
