// Translates trail runtime messages into domain calls. Returns the router's
// UNHANDLED marker for message types it does not own so additional handlers
// can be composed behind it.

import browser from "webextension-polyfill";
import { TrailDomain } from "../domains/trailDomain";
import { RuntimeMessageHandler, UNHANDLED } from "./runtimeRouter";

async function openOptionsPage(): Promise<WayfindActionResult> {
  try {
    await browser.runtime.openOptionsPage();
    return { ok: true };
  } catch (_) {
    return { ok: false, reason: "Settings unavailable" };
  }
}

export function createTrailMessageHandler(domain: TrailDomain): RuntimeMessageHandler {
  return async (message, sender) => {
    switch (message.type) {
      case "TRAIL_CONTENT_READY":
        return domain.markContentScriptReady(sender.tab);

      case "TRAIL_GET":
        return await domain.getTrail(message.tabId, sender.tab);

      case "TRAIL_TOGGLE_OVERLAY":
        return await domain.toggleOverlay(sender.tab);

      case "TRAIL_JUMP":
        return await domain.jumpTo(message.index, message.tabId, sender.tab);

      case "TRAIL_OPEN_IN_NEW_TAB":
        return await domain.openEntryInNewTab(message.index, message.tabId, sender.tab);

      case "TRAIL_OPEN_IN_NEW_WINDOW":
        return await domain.openEntryInNewWindow(message.index, message.tabId, sender.tab);

      case "TRAIL_OVERLAY_STATE":
        return domain.setOverlayOpen(sender.tab, message.open);

      case "WAYFIND_OPEN_OPTIONS":
        return await openOptionsPage();

      case "WAYFIND_REFRESH_EXTENSION":
        return await domain.refreshExtension();

      default:
        return UNHANDLED;
    }
  };
}
