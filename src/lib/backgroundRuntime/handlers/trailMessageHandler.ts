// Translates trail runtime messages into domain calls. Returns the router's
// UNHANDLED marker for message types it does not own so additional handlers
// can be composed behind it.

import browser from "webextension-polyfill";
import {
  deleteSavedTrail,
  renameSavedTrail,
  replaceSavedTrail,
  restoreSavedTrail,
  saveCapturedTrail,
  setSavedTrailPinned,
} from "../../adapters/storage/savedTrailsStore";
import { TrailDomain } from "../domains/trailDomain";
import { RuntimeMessageHandler, UNHANDLED } from "./runtimeRouter";

export const PRIVATE_SAVED_TRAILS_REASON =
  "Saved trails can't be saved or changed in private browsing";

const OVERLAY_FRAME_PATH = "/overlayFrame/overlayFrame.html";
const OVERLAY_FRAME_NONCE = /^[a-f0-9]{32}$/;

function isOverlayFrameSender(sender: browser.Runtime.MessageSender): boolean {
  if (sender.id !== browser.runtime.id || sender.tab?.id == null) return false;
  if (typeof sender.frameId !== "number" || sender.frameId <= 0) return false;
  if (typeof sender.url !== "string") return false;
  try {
    const pathname = new URL(sender.url).pathname;
    // MV3 dynamic web-accessible URLs may insert a per-session segment before
    // the packaged path. Match the exact resource suffix without accepting a
    // different extension page.
    return pathname === OVERLAY_FRAME_PATH || pathname.endsWith(OVERLAY_FRAME_PATH);
  } catch (_) {
    return false;
  }
}

async function claimOverlayFrame(
  nonce: string,
  sender: browser.Runtime.MessageSender,
): Promise<TabTrailActionResult> {
  if (!OVERLAY_FRAME_NONCE.test(nonce) || !isOverlayFrameSender(sender)) {
    return { ok: false, reason: "Overlay frame authentication failed" };
  }
  try {
    const response = await browser.tabs.sendMessage(
      sender.tab!.id!,
      { type: "OVERLAY_FRAME_CHALLENGE", nonce },
      { frameId: 0 },
    ) as unknown;
    if (
      typeof response === "object" &&
      response !== null &&
      (response as { ok?: unknown }).ok === true
    ) {
      return { ok: true };
    }
  } catch (_) {
    // Missing, stale, or non-top-level controller: reject the claim below.
  }
  return { ok: false, reason: "Overlay frame authentication failed" };
}

function isDurableSavedTrailMutation(type: string): boolean {
  switch (type) {
    case "SAVED_TRAIL_SAVE":
    case "SAVED_TRAIL_RENAME":
    case "SAVED_TRAIL_REPLACE":
    case "SAVED_TRAIL_SET_PINNED":
    case "SAVED_TRAIL_DELETE":
    case "SAVED_TRAIL_RESTORE":
      return true;
    default:
      return false;
  }
}

async function openOptionsPage(): Promise<TabTrailActionResult> {
  try {
    await browser.runtime.openOptionsPage();
    return { ok: true };
  } catch (_) {
    return { ok: false, reason: "Settings unavailable" };
  }
}

export function createTrailMessageHandler(
  domain: TrailDomain,
  storageReady: Promise<void> = Promise.resolve(),
): RuntimeMessageHandler {
  return async (message, sender) => {
    const durableSavedTrailMutation =
      typeof message.type === "string" && isDurableSavedTrailMutation(message.type);
    // storage.local is shared with the regular profile. Refuse before waiting
    // on migrations or calling the store so private URLs/titles/favicons can
    // never become durable, and private tabs cannot mutate the regular library.
    if (durableSavedTrailMutation && sender.tab?.incognito === true) {
      return { ok: false, reason: PRIVATE_SAVED_TRAILS_REASON };
    }
    if (durableSavedTrailMutation) {
      await storageReady;
    }
    switch (message.type) {
      case "OVERLAY_FRAME_CLAIM":
        return await claimOverlayFrame(message.nonce, sender);

      case "TRAIL_TOGGLE_OVERLAY":
        return await domain.toggleOverlay(sender.tab);

      case "TRAIL_JUMP":
        return await domain.jumpTo(message.index, message.tabId, sender.tab);

      case "TRAIL_OPEN_IN_NEW_TAB":
        return await domain.openEntryInNewTab(message.index, message.tabId, sender.tab);

      case "TRAIL_OPEN_IN_NEW_WINDOW":
        return await domain.openEntryInNewWindow(message.index, message.tabId, sender.tab);

      case "SAVED_TRAIL_OPEN":
        return await domain.openSavedTrail(message.path, message.mode, sender.tab);

      case "SAVED_TRAIL_SAVE":
        return await saveCapturedTrail(message.path, message.name);

      case "SAVED_TRAIL_RENAME":
        return await renameSavedTrail(message.id, message.name);

      case "SAVED_TRAIL_REPLACE":
        return await replaceSavedTrail(message.id, message.path, message.expectedPath);

      case "SAVED_TRAIL_SET_PINNED":
        return await setSavedTrailPinned(message.id, message.pinned);

      case "SAVED_TRAIL_DELETE":
        return await deleteSavedTrail(message.id);

      case "SAVED_TRAIL_RESTORE":
        return await restoreSavedTrail(message.trail);

      case "TRAIL_OVERLAY_STATE":
        return domain.setOverlayOpen(sender.tab, message.open);

      case "TABTRAIL_OPEN_OPTIONS":
        return await openOptionsPage();

      case "TABTRAIL_REFRESH_EXTENSION":
        return await domain.refreshExtension();

      default:
        return UNHANDLED;
    }
  };
}
