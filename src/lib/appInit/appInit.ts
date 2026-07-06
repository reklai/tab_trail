// Content-script application: captures the toggle chord (keyboard or mouse)
// on every page and, in the top frame, hosts the branch overlay and
// executes history.go jumps. initApp() runs once per frame and is safe to
// re-run — it first calls the previous instance's window.__tabtrailCleanup, so
// re-injecting from code (installs, updates) never stacks listeners.

import browser from "webextension-polyfill";
import {
  loadTabTrailSettings,
  normalizeTabTrailSettings,
  saveTabTrailSettings,
  TABTRAIL_STORAGE_KEYS,
} from "../common/contracts/tabtrail";
import { ContentRuntimeMessage } from "../common/contracts/runtimeMessages";
import { matchesToggleTrigger } from "../core/trail/trailCore";
import type { ToggleTriggerEvent } from "../core/trail/trailCore";
import {
  jumpToTrailEntry,
  openTrailEntryInNewTab,
  openTrailEntryInNewWindow,
  openTabTrailOptions,
  reportTrailOverlayState,
  toggleTrailOverlay,
} from "../adapters/runtime/tabtrailApi";
import {
  hideBreadcrumbTrail,
  isBreadcrumbTrailOpen,
  showBreadcrumbTrail,
  updateBreadcrumbTrail,
} from "../ui/panels/breadcrumbTrail/breadcrumbTrail";

declare global {
  interface Window {
    __tabtrailCleanup?: () => void;
  }
}

// After a matched mouse chord we swallow the gesture's follow-up events
// (auxclick/click/contextmenu) for this long, so a right-button chord does not
// also open the native context menu and a middle-button chord does not paste
// or autoscroll.
const MOUSE_CHORD_SWALLOW_WINDOW_MS = 600;

function isTopFrame(): boolean {
  try {
    return window.self === window.top;
  } catch (_) {
    return false;
  }
}

export function initApp(): void {
  window.__tabtrailCleanup?.();

  let settings = normalizeTabTrailSettings(null);
  let disposed = false;
  const topFrame = isTopFrame();
  let swallowMouseUntil = 0;
  let swallowedButton = -1;

  void loadTabTrailSettings().then((loaded) => {
    if (!disposed) settings = loaded;
  });

  // --- Chord capture (all frames) ---

  function toTriggerEvent(event: KeyboardEvent | MouseEvent): ToggleTriggerEvent {
    if (event instanceof KeyboardEvent) {
      return {
        type: "keydown",
        code: event.code,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isTrusted: event.isTrusted,
      };
    }
    return {
      type: "mousedown",
      button: event.button,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isTrusted: event.isTrusted,
    };
  }

  function fireToggle(): void {
    void toggleTrailOverlay().catch(() => {
      // Background unreachable even after retries; nothing useful to do here.
    });
  }

  const keydownHandler = (event: KeyboardEvent): void => {
    if (!matchesToggleTrigger(toTriggerEvent(event), settings.trigger)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    fireToggle();
  };

  const mousedownHandler = (event: MouseEvent): void => {
    if (!matchesToggleTrigger(toTriggerEvent(event), settings.trigger)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    swallowMouseUntil = performance.now() + MOUSE_CHORD_SWALLOW_WINDOW_MS;
    swallowedButton = event.button;
    fireToggle();
  };

  const mouseFollowUpHandler = (event: MouseEvent): void => {
    if (performance.now() > swallowMouseUntil) return;
    // A contextmenu follow-up only belongs to a right-button chord; other
    // follow-ups (click/auxclick) must match the button that armed the window.
    // This keeps a left/middle chord from eating an unrelated right-click menu.
    const relevant = event.type === "contextmenu"
      ? swallowedButton === 2
      : event.button === swallowedButton;
    if (!relevant) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  window.addEventListener("keydown", keydownHandler, true);
  window.addEventListener("mousedown", mousedownHandler, true);
  window.addEventListener("auxclick", mouseFollowUpHandler, true);
  window.addEventListener("click", mouseFollowUpHandler, true);
  window.addEventListener("contextmenu", mouseFollowUpHandler, true);

  // --- Settings hot-reload ---

  const storageChangedHandler = (
    changes: Record<string, browser.Storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local" || !changes[TABTRAIL_STORAGE_KEYS.settings]) return;
    settings = normalizeTabTrailSettings(changes[TABTRAIL_STORAGE_KEYS.settings].newValue);
  };
  browser.storage.onChanged.addListener(storageChangedHandler);

  // --- Overlay lifecycle + background messages (top frame only) ---

  let messageHandler:
    | ((message: unknown, sender: browser.Runtime.MessageSender) => Promise<unknown> | undefined)
    | null = null;
  let pageHideHandler: (() => void) | null = null;

  if (topFrame) {
    const openOverlay = (state: TrailState): void => {
      showBreadcrumbTrail(state, {
        settings,
        // Every callback swallows its own rejection on purpose. If the
        // background is briefly unreachable and one of these rejects, an
        // unhandled rejection would reach panelHost's global handler, which
        // reads any extension-scoped fault as fatal and closes the overlay.
        callbacks: {
          onJump: (index) => {
            void jumpToTrailEntry(index).catch(() => {});
          },
          onOpenInNewTab: (index) => {
            void openTrailEntryInNewTab(index).catch(() => {});
          },
          onOpenInNewWindow: (index) => {
            void openTrailEntryInNewWindow(index).catch(() => {});
          },
          onOpenOptions: () => {
            void openTabTrailOptions().catch(() => {});
          },
          onClose: () => {
            void reportTrailOverlayState(false).catch(() => {});
          },
          onPositionChange: (position) => {
            void saveTabTrailSettings({ ...settings, overlayPosition: position }).catch(() => {});
          },
        },
      });
      void reportTrailOverlayState(true).catch(() => {});
    };

    messageHandler = (message: unknown): Promise<unknown> | undefined => {
      if (typeof message !== "object" || message === null) return undefined;
      const typed = message as ContentRuntimeMessage;
      switch (typed.type) {
        case "TABTRAIL_PING":
          return Promise.resolve({ ok: true });
        case "TRAIL_SHOW":
          if (isBreadcrumbTrailOpen()) {
            hideBreadcrumbTrail();
          } else {
            openOverlay(typed.state);
          }
          return Promise.resolve({ ok: true });
        case "TRAIL_UPDATED":
          if (isBreadcrumbTrailOpen()) updateBreadcrumbTrail(typed.state);
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

    pageHideHandler = (): void => {
      if (!isBreadcrumbTrailOpen()) return;
      hideBreadcrumbTrail();
    };
    window.addEventListener("pagehide", pageHideHandler);
  }

  window.__tabtrailCleanup = (): void => {
    disposed = true;
    window.removeEventListener("keydown", keydownHandler, true);
    window.removeEventListener("mousedown", mousedownHandler, true);
    window.removeEventListener("auxclick", mouseFollowUpHandler, true);
    window.removeEventListener("click", mouseFollowUpHandler, true);
    window.removeEventListener("contextmenu", mouseFollowUpHandler, true);
    browser.storage.onChanged.removeListener(storageChangedHandler);
    if (messageHandler) browser.runtime.onMessage.removeListener(messageHandler);
    if (pageHideHandler) window.removeEventListener("pagehide", pageHideHandler);
    if (isBreadcrumbTrailOpen()) hideBreadcrumbTrail();
    delete window.__tabtrailCleanup;
  };
}
