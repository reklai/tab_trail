// Background-side trail domain: owns every tab's navigation trail and injects
// the content script into already-open tabs at install/refresh time. It feeds
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
  createInheritedTrailState,
  EMPTY_TRAIL_STATE,
  normalizeTrailState,
  resolveJumpPlan,
  slicePathToIndex,
} from "../../core/trail/trailCore";
import { createInFlightMemo, createKeyedTaskQueue, sleep } from "../../common/utils/asyncFlow";
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

type ContentScriptInjectionOutcome =
  | "injected-all-frames"
  | "injected-top-frame"
  | "skipped"
  | "failed";

type ContentScriptMessageDelivery =
  | { delivered: true; response: unknown }
  | { delivered: false };

export interface TrailDomain {
  ensureLoaded(): Promise<void>;
  toggleOverlay(senderTab?: Tabs.Tab): Promise<TabTrailActionResult>;
  jumpTo(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult>;
  openEntryInNewTab(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult>;
  openEntryInNewWindow(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult>;
  openSavedTrail(
    path: TrailEntry[],
    mode: SavedTrailOpenMode,
    senderTab?: Tabs.Tab,
  ): Promise<TabTrailActionResult>;
  setOverlayOpen(senderTab: Tabs.Tab | undefined, open: boolean): TabTrailActionResult;
  refreshExtension(): Promise<TabTrailActionResult>;
  activateExistingContentScripts(): Promise<void>;
  registerLifecycleListeners(): void;
}

// On install/update we inject into already-open tabs (the manifest only
// auto-injects on navigation). A tab that's momentarily inaccessible then —
// mid-navigation, "cannot access contents", closing — fails; retry those over
// this backoff so a transient miss doesn't leave the tab without the shortcut.
const CONTENT_SCRIPT_RETRY_DELAYS_MS = [400, 1200];

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
  const pendingJumpByTabId = new Map<
    number,
    { index: number; kind: TrailJumpPlan["kind"] }
  >();

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

  async function pushTrailToTab(
    tabId: number,
    type: "TRAIL_SHOW" | "TRAIL_UPDATED",
  ): Promise<ContentScriptMessageDelivery> {
    const state = getTrailState(tabId);
    try {
      const response = await browser.tabs.sendMessage(
        tabId,
        { type, state },
        { frameId: 0 },
      ) as unknown;
      return { delivered: true, response };
    } catch (_) {
      return { delivered: false };
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
      const pendingJump = pendingJumpByTabId.get(tabId) ?? null;
      pendingJumpByTabId.delete(tabId);
      const event: TrailNavigationEvent = {
        kind,
        url: details.url,
        timestamp: Date.now(),
        transitionType: details.transitionType,
        qualifiers: details.transitionQualifiers,
        pendingJumpIndex: pendingJump?.index ?? null,
        pendingJumpKind: pendingJump?.kind ?? null,
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

  async function injectContentScriptIntoTab(tab: Tabs.Tab): Promise<ContentScriptInjectionOutcome> {
    if (tab.id == null || tab.discarded === true || isPageGestureRestrictedUrl(tab.url)) return "skipped";
    if (await executeContentScriptInTab(tab.id, true)) return "injected-all-frames";
    return await executeContentScriptInTab(tab.id, false) ? "injected-top-frame" : "failed";
  }

  function shouldRetryContentScriptInjection(outcome: ContentScriptInjectionOutcome): boolean {
    return outcome === "failed" || outcome === "injected-top-frame";
  }

  function didInjectContentScript(outcome: ContentScriptInjectionOutcome): boolean {
    return outcome === "injected-all-frames" || outcome === "injected-top-frame";
  }

  async function activateExistingContentScripts(): Promise<void> {
    const tabs = await browser.tabs.query({}).catch(() => [] as Tabs.Tab[]);
    const outcomes = await Promise.all(
      tabs.map(async (tab) => ({ tab, outcome: await injectContentScriptIntoTab(tab) })),
    );
    // "injected-top-frame" is usable as a fallback, but subframes may still
    // need a retry so the shortcut works when focus is inside them.
    let pending = outcomes
      .filter((entry) => shouldRetryContentScriptInjection(entry.outcome))
      .map((entry) => entry.tab);

    for (const delay of CONTENT_SCRIPT_RETRY_DELAYS_MS) {
      if (pending.length === 0) break;
      await sleep(delay);
      const retried = await Promise.all(
        pending.map(async (tab) => {
          // Re-fetch first: the tab may have navigated (the manifest already
          // injected it — a re-inject is a no-op via __tabtrailCleanup) or closed.
          const fresh = tab.id != null ? await browser.tabs.get(tab.id).catch(() => null) : null;
          if (!fresh) return "skipped" as const;
          return injectContentScriptIntoTab(fresh);
        }),
      );
      pending = pending.filter((_, index) =>
        shouldRetryContentScriptInjection(retried[index]));
    }
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

  async function seedInheritedTrail(tabId: number, state: TrailState): Promise<void> {
    await tabQueue.run(tabId, async () => {
      await ensureLoaded();
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (!tab) return;
      if (tab.incognito) incognitoTabIds.add(tabId);
      const endpoint = state.entries[state.cursor];
      const liveUrl = normalizePageUrl(tab.url);
      const endpointUrl = normalizePageUrl(endpoint?.url);
      // A cached redirect can commit before tabs.create resolves. Preserve the
      // inherited prefix, then append the already-live destination so seeding
      // never moves the trail cursor behind the actual page.
      const seeded = liveUrl && endpointUrl && liveUrl !== endpointUrl
        ? applyNavigationEvent(state, {
            kind: "committed",
            url: liveUrl,
            timestamp: Date.now(),
            transitionType: "other",
            qualifiers: ["server_redirect"],
          }).state
        : state;
      trailsByTabId.set(tabId, seeded);
      mirrorTrail(tabId);
      patchCursorEntry(tabId, tab);
    });
  }

  async function createTabFromInheritedTrail(
    state: TrailState,
    sourceTab: Tabs.Tab | null | undefined,
    active: boolean,
  ): Promise<TabTrailActionResult> {
    const endpoint = state.entries[state.cursor];
    if (!endpoint) return { ok: false, reason: "Trail endpoint missing" };
    try {
      const created = await browser.tabs.create({
        url: endpoint.url,
        active,
        ...(sourceTab?.windowId != null ? { windowId: sourceTab.windowId } : {}),
        ...(sourceTab?.index != null ? { index: sourceTab.index + 1 } : {}),
      });
      if (created.id != null) {
        await seedInheritedTrail(created.id, state);
      }
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: "Could not open tab" };
    }
  }

  async function toggleOverlay(senderTab?: Tabs.Tab): Promise<TabTrailActionResult> {
    await ensureLoaded();
    const tabId = await resolveTargetTabId(undefined, senderTab);
    if (tabId == null) return { ok: false, reason: "No tab for overlay" };
    let delivery = await pushTrailToTab(tabId, "TRAIL_SHOW");
    if (!delivery.delivered) {
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (tab && didInjectContentScript(await injectContentScriptIntoTab(tab))) {
        delivery = await pushTrailToTab(tabId, "TRAIL_SHOW");
      }
    }
    if (!delivery.delivered) {
      return { ok: false, reason: "Overlay unavailable on this page" };
    }
    const response = delivery.response;
    if (typeof response !== "object" || response === null) {
      return { ok: false, reason: "Overlay unavailable on this page" };
    }
    const result = response as { ok?: unknown; reason?: unknown };
    if (result.ok === true) return { ok: true };
    return {
      ok: false,
      ...(typeof result.reason === "string" ? { reason: result.reason } : {
        reason: "Overlay unavailable on this page",
      }),
    };
  }

  async function jumpTo(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult> {
    await ensureLoaded();
    const targetTabId = await resolveTargetTabId(tabId, senderTab);
    if (targetTabId == null) return { ok: false, reason: "No tab to navigate" };
    const state = getTrailState(targetTabId);
    const plan = resolveJumpPlan(state, index);
    if (!plan) return { ok: true };

    pendingJumpByTabId.set(targetTabId, { index, kind: plan.kind });
    if (plan.kind === "historyGo") {
      try {
        await browser.tabs.sendMessage(targetTabId, { type: "HISTORY_GO", delta: plan.delta }, { frameId: 0 });
        return { ok: true };
      } catch (_) {
        // No content script in that tab (privileged page); fall through to a
        // plain navigation on the same trail target.
        pendingJumpByTabId.set(targetTabId, { index, kind: "navigate" });
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
    const path = slicePathToIndex(getTrailState(targetTabId), index);
    if (!path) return { ok: false, reason: "Trail entry missing" };
    const inherited = createInheritedTrailState(path);
    const sourceTab = await browser.tabs.get(targetTabId).catch(() => null);
    return createTabFromInheritedTrail(inherited, sourceTab, false);
  }

  async function openEntryInNewWindow(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult> {
    await ensureLoaded();
    const targetTabId = await resolveTargetTabId(tabId, senderTab);
    if (targetTabId == null) return { ok: false, reason: "No source tab" };
    const path = slicePathToIndex(getTrailState(targetTabId), index);
    if (!path) return { ok: false, reason: "Trail entry missing" };
    const inherited = createInheritedTrailState(path);
    const endpoint = inherited.entries[inherited.cursor];
    if (!endpoint) return { ok: false, reason: "Trail endpoint missing" };
    const sourceTab = senderTab?.id === targetTabId
      ? senderTab
      : await browser.tabs.get(targetTabId).catch(() => null);
    if (!sourceTab) return { ok: false, reason: "No source tab" };
    const sourceIncognito = sourceTab.incognito === true;
    try {
      const created = await browser.windows.create({
        url: endpoint.url,
        incognito: sourceIncognito,
      });
      const seededTabId = created.tabs?.find((tab) => tab.id != null)?.id;
      // Never copy lineage between regular and private profiles, even if a
      // browser ignores or cannot honor the requested window profile.
      if (seededTabId != null && created.incognito === sourceIncognito) {
        await seedInheritedTrail(seededTabId, inherited);
      }
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: "Could not open window" };
    }
  }

  // Open a saved path at its endpoint with the full path as inherited lineage.
  // New-tab mode creates a tab; current-tab mode navigates the active tab and
  // seeds the same non-historyBacked prefix so jumps still work.
  async function openSavedTrail(
    path: TrailEntry[],
    mode: SavedTrailOpenMode,
    senderTab?: Tabs.Tab,
  ): Promise<TabTrailActionResult> {
    await ensureLoaded();
    const inherited = createInheritedTrailState(path);
    const endpoint = inherited.entries[inherited.cursor];
    if (!endpoint) return { ok: false, reason: "Trail endpoint missing" };
    const targetTabId = await resolveTargetTabId(undefined, senderTab);
    if (mode === "current") {
      if (targetTabId == null) return { ok: false, reason: "No tab to navigate" };
      try {
        await browser.tabs.update(targetTabId, { url: endpoint.url });
        await seedInheritedTrail(targetTabId, inherited);
        return { ok: true };
      } catch (_) {
        return { ok: false, reason: "Navigation failed" };
      }
    }
    const sourceTab =
      senderTab ??
      (targetTabId != null ? await browser.tabs.get(targetTabId).catch(() => null) : null);
    return createTabFromInheritedTrail(inherited, sourceTab, true);
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
    openSavedTrail,
    setOverlayOpen,
    refreshExtension,
    activateExistingContentScripts,
    registerLifecycleListeners,
  };
}
