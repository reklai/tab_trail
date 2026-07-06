// Background-side trail domain: owns every tab's navigation trail and the
// content-script lifecycle (install-time injection, ready tracking). It feeds
// webNavigation events through the pure trail reducer, mirrors each tab's
// state to session storage so an MV3 worker restart loses nothing, and
// orchestrates breadcrumb jumps (history.go via the content script, with a
// plain navigation as the fallback). Trails are session-only by design: on
// browsers without storage.session the mirror lives in storage.local and is
// wiped on browser startup, and incognito tabs are never mirrored at all.

import browser, { Tabs } from "webextension-polyfill";
import { TRAIL_MIRROR_KEY_PREFIX, trailMirrorKey } from "../../common/contracts/tabtrail";
import {
  applyNavigationEvent,
  EMPTY_TRAIL_STATE,
  normalizeTrailState,
  resolveJumpPlan,
} from "../../core/trail/trailCore";
import { createInFlightMemo, createKeyedTaskQueue } from "../../common/utils/asyncFlow";
import { isKnownBrowserStoreRestrictedUrl } from "../../common/utils/restrictedUrls";

// --- Surfaces not fully covered by the polyfill types ---

interface ScriptingApi {
  executeScript(details: { target: { tabId: number; allFrames?: boolean }; files: string[] }): Promise<unknown>;
}

interface SessionStorageArea {
  get(keys: null | string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface NavigationDetails {
  tabId: number;
  frameId: number;
  url: string;
  timeStamp: number;
  transitionType?: string;
  transitionQualifiers?: string[];
}

export interface TrailDomain {
  ensureLoaded(): Promise<void>;
  toggleOverlay(senderTab?: Tabs.Tab): Promise<TabTrailActionResult>;
  jumpTo(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult>;
  openEntryInNewTab(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult>;
  openEntryInNewWindow(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult>;
  setOverlayOpen(senderTab: Tabs.Tab | undefined, open: boolean): TabTrailActionResult;
  refreshExtension(): Promise<TabTrailActionResult>;
  activateExistingContentScripts(): Promise<void>;
  registerLifecycleListeners(): void;
}

function normalizePageUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch (_) {
    return null;
  }
}

function isPageGestureRestrictedUrl(url: string | undefined): boolean {
  return !normalizePageUrl(url) || isKnownBrowserStoreRestrictedUrl(url);
}

export function createTrailDomain(): TrailDomain {
  // Authoritative per-tab state for this worker lifetime; the storage mirror
  // exists only to survive MV3 worker restarts within a browser session.
  const trailsByTabId = new Map<number, TrailState>();
  const incognitoTabIds = new Set<number>();
  const overlayOpenTabIds = new Set<number>();
  const pendingJumpByTabId = new Map<number, number>();

  // Serializes reducer runs + mirror writes per tab so a fast SPA can't
  // interleave two navigation events for the same tab.
  const tabQueue = createKeyedTaskQueue();
  const ensureLoaded = createInFlightMemo(rehydrate);

  function getSessionStore(): SessionStorageArea | null {
    const store = (browser.storage as unknown as { session?: SessionStorageArea }).session;
    return store && typeof store.get === "function" ? store : null;
  }

  // Firefox MV2 has no storage.session; fall back to storage.local, which
  // handleStartup wipes so the trail still clears when the browser closes.
  const sessionStore = getSessionStore();
  const mirrorStore: SessionStorageArea = sessionStore ?? (browser.storage.local as unknown as SessionStorageArea);
  const mirrorIsSessionScoped = sessionStore !== null;

  async function rehydrate(): Promise<void> {
    const [stored, tabs] = await Promise.all([
      mirrorStore.get(null).catch(() => ({} as Record<string, unknown>)),
      browser.tabs.query({}).catch(() => [] as Tabs.Tab[]),
    ]);
    const liveTabIds = new Set<number>();
    for (const tab of tabs) {
      if (tab.id == null) continue;
      liveTabIds.add(tab.id);
      if (tab.incognito) incognitoTabIds.add(tab.id);
    }
    const staleKeys: string[] = [];
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(TRAIL_MIRROR_KEY_PREFIX)) continue;
      const tabId = Number(key.slice(TRAIL_MIRROR_KEY_PREFIX.length));
      if (!Number.isInteger(tabId) || !liveTabIds.has(tabId)) {
        staleKeys.push(key);
        continue;
      }
      if (!trailsByTabId.has(tabId)) {
        const state = normalizeTrailState(value);
        if (state.entries.length > 0) trailsByTabId.set(tabId, state);
      }
    }
    if (staleKeys.length > 0) await mirrorStore.remove(staleKeys).catch(() => {});
  }

  function mirrorTrail(tabId: number): void {
    if (incognitoTabIds.has(tabId) && !mirrorIsSessionScoped) return;
    const state = trailsByTabId.get(tabId);
    void tabQueue.run(tabId, async () => {
      if (!state || state.entries.length === 0) {
        await mirrorStore.remove(trailMirrorKey(tabId)).catch(() => {});
        return;
      }
      await mirrorStore.set({ [trailMirrorKey(tabId)]: state }).catch(() => {});
    });
  }

  async function isIncognitoTab(tabId: number): Promise<boolean> {
    if (incognitoTabIds.has(tabId)) return true;
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (tab?.incognito) {
      incognitoTabIds.add(tabId);
      return true;
    }
    return false;
  }

  function getTrailState(tabId: number): TrailState {
    return trailsByTabId.get(tabId) ?? EMPTY_TRAIL_STATE;
  }

  // --- Pushing state to the overlay ---

  async function pushTrailToTab(tabId: number, type: "TRAIL_SHOW" | "TRAIL_UPDATED"): Promise<boolean> {
    const state = getTrailState(tabId);
    try {
      await browser.tabs.sendMessage(tabId, { type, state }, { frameId: 0 });
      return true;
    } catch (_) {
      return false;
    }
  }

  function notifyOverlayIfOpen(tabId: number): void {
    if (!overlayOpenTabIds.has(tabId)) return;
    void pushTrailToTab(tabId, "TRAIL_UPDATED");
  }

  // --- Title / favicon patching (not known at commit time) ---

  function patchCursorEntry(tabId: number, tab: Pick<Tabs.Tab, "url" | "title" | "favIconUrl">): void {
    const state = trailsByTabId.get(tabId);
    if (!state || state.cursor < 0) return;
    const entry = state.entries[state.cursor];
    if (!entry || tab.url !== entry.url) return;
    const title = typeof tab.title === "string" ? tab.title : entry.title;
    const favIconUrl = typeof tab.favIconUrl === "string" ? tab.favIconUrl : entry.favIconUrl;
    if (title === entry.title && favIconUrl === entry.favIconUrl) return;
    const entries = state.entries.slice();
    entries[state.cursor] = { ...entry, title, favIconUrl };
    trailsByTabId.set(tabId, { entries, cursor: state.cursor });
    mirrorTrail(tabId);
    notifyOverlayIfOpen(tabId);
  }

  async function patchCursorEntryFromLiveTab(tabId: number): Promise<void> {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (tab) patchCursorEntry(tabId, tab);
  }

  // --- Navigation event intake ---

  function handleNavigationDetails(
    kind: TrailNavigationEvent["kind"],
    details: NavigationDetails,
  ): void {
    if (details.frameId !== 0) return;
    const tabId = details.tabId;
    void tabQueue.run(tabId, async () => {
      await ensureLoaded();
      // Populate the incognito cache before the first mirror write so the
      // local-storage fallback never sees a private tab's trail.
      await isIncognitoTab(tabId);
      const pendingJumpIndex = pendingJumpByTabId.get(tabId) ?? null;
      pendingJumpByTabId.delete(tabId);
      const event: TrailNavigationEvent = {
        kind,
        url: details.url,
        timestamp: Date.now(),
        transitionType: details.transitionType,
        qualifiers: details.transitionQualifiers,
        pendingJumpIndex,
      };
      const { state, changed } = applyNavigationEvent(getTrailState(tabId), event);
      if (!changed) return;
      trailsByTabId.set(tabId, state);
      mirrorTrail(tabId);
      notifyOverlayIfOpen(tabId);
    }).then(() => patchCursorEntryFromLiveTab(tabId));
  }

  // --- Content script injection (mirrors the reference extension) ---

  async function executeContentScriptInTab(tabId: number, allFrames: boolean): Promise<boolean> {
    const runtimeBrowser = browser as typeof browser & {
      scripting?: ScriptingApi;
      tabs: typeof browser.tabs & {
        executeScript?: (tabId: number, details: { file: string; runAt?: string; allFrames?: boolean }) => Promise<unknown>;
      };
    };
    try {
      if (runtimeBrowser.scripting?.executeScript) {
        await runtimeBrowser.scripting.executeScript({
          target: { tabId, ...(allFrames ? { allFrames: true } : {}) },
          files: ["contentScript.js"],
        });
        return true;
      }
      if (runtimeBrowser.tabs.executeScript) {
        await runtimeBrowser.tabs.executeScript(tabId, {
          file: "contentScript.js",
          runAt: "document_start",
          ...(allFrames ? { allFrames: true } : {}),
        });
        return true;
      }
    } catch (_) {
      return false;
    }
    return false;
  }

  async function injectContentScriptIntoTab(tab: Tabs.Tab): Promise<"injected" | "skipped" | "failed"> {
    if (tab.id == null || tab.discarded === true || isPageGestureRestrictedUrl(tab.url)) return "skipped";
    if (await executeContentScriptInTab(tab.id, true)) return "injected";
    return await executeContentScriptInTab(tab.id, false) ? "injected" : "failed";
  }

  async function activateExistingContentScripts(): Promise<void> {
    const tabs = await browser.tabs.query({}).catch(() => []);
    await Promise.all(tabs.map((tab) => injectContentScriptIntoTab(tab)));
  }

  // --- Domain methods ---

  async function resolveTargetTabId(tabId: number | undefined, senderTab?: Tabs.Tab): Promise<number | null> {
    if (tabId != null) return tabId;
    if (senderTab?.id != null) return senderTab.id;
    const [active] = await browser.tabs
      .query({ active: true, currentWindow: true })
      .catch(() => [] as Tabs.Tab[]);
    return active?.id ?? null;
  }

  async function toggleOverlay(senderTab?: Tabs.Tab): Promise<TabTrailActionResult> {
    await ensureLoaded();
    const tabId = await resolveTargetTabId(undefined, senderTab);
    if (tabId == null) return { ok: false, reason: "No tab for overlay" };
    let delivered = await pushTrailToTab(tabId, "TRAIL_SHOW");
    if (!delivered) {
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (tab && await injectContentScriptIntoTab(tab) === "injected") {
        delivered = await pushTrailToTab(tabId, "TRAIL_SHOW");
      }
    }
    return delivered ? { ok: true } : { ok: false, reason: "Overlay unavailable on this page" };
  }

  async function jumpTo(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult> {
    await ensureLoaded();
    const targetTabId = await resolveTargetTabId(tabId, senderTab);
    if (targetTabId == null) return { ok: false, reason: "No tab to navigate" };
    const state = getTrailState(targetTabId);
    const plan = resolveJumpPlan(state, index);
    if (!plan) return { ok: true };

    pendingJumpByTabId.set(targetTabId, index);
    if (plan.kind === "historyGo") {
      try {
        await browser.tabs.sendMessage(targetTabId, { type: "HISTORY_GO", delta: plan.delta }, { frameId: 0 });
        return { ok: true };
      } catch (_) {
        // No content script in that tab (privileged page); fall through to a
        // plain navigation on the same trail target.
      }
    }
    const url = state.entries[index]?.url;
    if (!url) {
      pendingJumpByTabId.delete(targetTabId);
      return { ok: false, reason: "Trail entry missing" };
    }
    try {
      await browser.tabs.update(targetTabId, { url });
      return { ok: true };
    } catch (_) {
      pendingJumpByTabId.delete(targetTabId);
      return { ok: false, reason: "Navigation failed" };
    }
  }

  async function openEntryInNewTab(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult> {
    await ensureLoaded();
    const targetTabId = await resolveTargetTabId(tabId, senderTab);
    if (targetTabId == null) return { ok: false, reason: "No source tab" };
    const entry = getTrailState(targetTabId).entries[index];
    if (!entry) return { ok: false, reason: "Trail entry missing" };
    const sourceTab = await browser.tabs.get(targetTabId).catch(() => null);
    try {
      await browser.tabs.create({
        url: entry.url,
        active: false,
        ...(sourceTab?.windowId != null ? { windowId: sourceTab.windowId } : {}),
        ...(sourceTab?.index != null ? { index: sourceTab.index + 1 } : {}),
      });
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: "Could not open tab" };
    }
  }

  async function openEntryInNewWindow(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult> {
    await ensureLoaded();
    const targetTabId = await resolveTargetTabId(tabId, senderTab);
    if (targetTabId == null) return { ok: false, reason: "No source tab" };
    const entry = getTrailState(targetTabId).entries[index];
    if (!entry) return { ok: false, reason: "Trail entry missing" };
    try {
      await browser.windows.create({ url: entry.url });
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: "Could not open window" };
    }
  }

  function setOverlayOpen(senderTab: Tabs.Tab | undefined, open: boolean): TabTrailActionResult {
    const tabId = senderTab?.id;
    if (tabId == null) return { ok: false, reason: "No tab" };
    if (open) overlayOpenTabIds.add(tabId);
    else overlayOpenTabIds.delete(tabId);
    return { ok: true };
  }

  async function refreshExtension(): Promise<TabTrailActionResult> {
    try {
      await activateExistingContentScripts();
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: "Refresh failed" };
    }
  }

  // --- Lifecycle ---

  async function handleStartup(): Promise<void> {
    // Fresh browser session: tab ids restarted, trails are session-only.
    trailsByTabId.clear();
    overlayOpenTabIds.clear();
    pendingJumpByTabId.clear();
    incognitoTabIds.clear();
    if (mirrorIsSessionScoped) return;
    // The local-storage fallback survives a restart; wipe it so the trail
    // still behaves as session storage.
    const stored = await browser.storage.local.get(null).catch(() => ({} as Record<string, unknown>));
    const keys = Object.keys(stored).filter((key) => key.startsWith(TRAIL_MIRROR_KEY_PREFIX));
    if (keys.length > 0) await browser.storage.local.remove(keys).catch(() => {});
  }

  function handleTabRemoved(tabId: number): void {
    trailsByTabId.delete(tabId);
    overlayOpenTabIds.delete(tabId);
    pendingJumpByTabId.delete(tabId);
    const wasIncognito = incognitoTabIds.delete(tabId);
    if (!(wasIncognito && !mirrorIsSessionScoped)) {
      void mirrorStore.remove(trailMirrorKey(tabId)).catch(() => {});
    }
  }

  function registerLifecycleListeners(): void {
    browser.webNavigation.onCommitted.addListener((details) => {
      handleNavigationDetails("committed", details as NavigationDetails);
    });

    browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
      handleNavigationDetails("historyState", details as NavigationDetails);
    });

    browser.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
      handleNavigationDetails("refFragment", details as NavigationDetails);
    });

    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.title == null && changeInfo.favIconUrl == null) return;
      patchCursorEntry(tabId, tab);
    });

    browser.tabs.onRemoved.addListener((tabId) => {
      handleTabRemoved(tabId);
    });

    browser.runtime.onInstalled.addListener(() => {
      void activateExistingContentScripts();
    });

    browser.runtime.onStartup.addListener(() => {
      void handleStartup();
    });
  }

  return {
    ensureLoaded,
    toggleOverlay,
    jumpTo,
    openEntryInNewTab,
    openEntryInNewWindow,
    setOverlayOpen,
    refreshExtension,
    activateExistingContentScripts,
    registerLifecycleListeners,
  };
}
