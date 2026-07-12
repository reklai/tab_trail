// Background-side trail domain: owns every tab's navigation trail and injects
// the content script into already-open tabs at install/refresh time. It feeds
// webNavigation events through the pure trail reducer, mirrors each tab's
// state to session storage so an MV3 worker restart loses nothing, and
// orchestrates breadcrumb jumps (history.go via the content script, with a
// plain navigation as the fallback). Trails are session-only by design: on
// browsers without storage.session the mirror lives in storage.local and is
// wiped on browser startup, and incognito tabs are never mirrored at all.
// Viewport scroll metadata rides TrailEntry; restore is dispatched via
// TRAIL_RESTORE_SCROLL (force for navigate/open, corrective for historyGo).

import browser, { Tabs } from "webextension-polyfill";
import { TRAIL_MIRROR_KEY_PREFIX, trailMirrorKey } from "../../common/contracts/tabtrail";
import type { ContentRuntimeMessage } from "../../common/contracts/runtimeMessages";
import {
  applyNavigationEvent,
  createInheritedTrailState,
  EMPTY_TRAIL_STATE,
  normalizeTrailState,
  normalizeViewport,
  resolveJumpPlan,
  shouldApplyInheritedSeed,
  slicePathToIndex,
  viewportEquals,
  type InheritedSeedPolicy,
} from "../../core/trail/trailCore";
import { createInFlightMemo, createKeyedTaskQueue, sleep } from "../../common/utils/asyncFlow";
import {
  activateExistingContentScripts,
  injectContentScriptIntoTab,
  type ContentScriptInjectionOutcome,
} from "./contentScriptActivation";

const PENDING_RESTORE_TTL_MS = 3000;
const DISPATCH_LADDER_MS = [50, 200, 500] as const;
const VIEWPORT_MIRROR_COALESCE_MS = 750;
const SCROLL_REPORT_MIN_INTERVAL_MS = 100;

// --- Surfaces not fully covered by the polyfill types ---

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

type ContentScriptMessageDelivery =
  | { delivered: true; response: unknown }
  | { delivered: false };

function didInjectContentScript(outcome: ContentScriptInjectionOutcome): boolean {
  return outcome === "injected-all-frames" || outcome === "injected-top-frame";
}

export interface TrailDomain {
  ensureLoaded(): Promise<void>;
  toggleOverlay(
    senderTab?: Tabs.Tab,
    requestedAtEpochMs?: number,
  ): Promise<TabTrailActionResult>;
  jumpTo(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult>;
  openEntryInNewTab(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult>;
  openEntryInNewWindow(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult>;
  openSavedTrail(
    path: TrailEntry[],
    mode: SavedTrailOpenMode,
    senderTab?: Tabs.Tab,
  ): Promise<TabTrailActionResult>;
  applyScrollReport(
    tabId: number,
    url: string,
    viewport: TrailViewport,
    options?: { flush?: boolean },
  ): void;
  setOverlayOpen(senderTab: Tabs.Tab | undefined, open: boolean): TabTrailActionResult;
  refreshExtension(): Promise<TabTrailActionResult>;
  activateExistingContentScripts(): Promise<void>;
  registerLifecycleListeners(): void;
}

interface PendingRestore {
  url: string;
  viewport: TrailViewport;
  mode: TrailScrollRestoreMode;
  generation: number;
  createdAt: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

type TopFrameSendResult =
  | { transported: false }
  | { transported: true; accepted: boolean; reason?: string };

function normalizePageUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch (_) {
    return null;
  }
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
  const pendingRestoreByTabId = new Map<number, PendingRestore>();
  const restoreGenerationByTabId = new Map<number, number>();
  const viewportMirrorTimerByTabId = new Map<number, ReturnType<typeof setTimeout>>();
  const lastScrollReportAtByTabId = new Map<number, number>();

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

  // Navigation critical path: use memory or a single mirror key. Full rehydrate
  // only blocks when this tab's trail is still missing after the fast read.
  // After every await, re-check the map so a concurrent navigation/seed writer
  // is never overwritten by a stale mirror snapshot (same fill-if-missing
  // discipline as rehydrate).
  async function ensureTabTrail(tabId: number): Promise<void> {
    if (trailsByTabId.has(tabId)) {
      void ensureLoaded();
      return;
    }
    const key = trailMirrorKey(tabId);
    const stored = await mirrorStore.get(key).catch(() => ({} as Record<string, unknown>));
    if (trailsByTabId.has(tabId)) {
      void ensureLoaded();
      return;
    }
    const value = stored[key];
    if (value !== undefined) {
      const state = normalizeTrailState(value);
      if (state.entries.length > 0) {
        if (!trailsByTabId.has(tabId)) {
          trailsByTabId.set(tabId, state);
        }
        void ensureLoaded();
        return;
      }
    }
    if (trailsByTabId.has(tabId)) {
      void ensureLoaded();
      return;
    }
    await ensureLoaded();
  }

  function resolveSourceTab(
    targetTabId: number,
    senderTab?: Tabs.Tab,
  ): Promise<Tabs.Tab | null> {
    if (senderTab?.id === targetTabId) return Promise.resolve(senderTab);
    return browser.tabs.get(targetTabId).catch(() => null);
  }

  // Mirror always re-reads the authoritative map at write time so a queued
  // snapshot cannot resurrect a trail after handleTabRemoved, and never races
  // a later reducer result. All map mutations go through tabQueue so title
  // patches and navigation events cannot interleave.
  function scheduleMirrorTrail(tabId: number): void {
    clearViewportMirrorCoalesce(tabId);
    if (incognitoTabIds.has(tabId) && !mirrorIsSessionScoped) return;
    void tabQueue.run(tabId, async () => {
      if (incognitoTabIds.has(tabId) && !mirrorIsSessionScoped) return;
      const state = trailsByTabId.get(tabId);
      if (!state || state.entries.length === 0) {
        await mirrorStore.remove(trailMirrorKey(tabId)).catch(() => {});
        return;
      }
      await mirrorStore.set({ [trailMirrorKey(tabId)]: state }).catch(() => {});
    });
  }

  function clearViewportMirrorCoalesce(tabId: number): void {
    const timer = viewportMirrorTimerByTabId.get(tabId);
    if (timer != null) {
      clearTimeout(timer);
      viewportMirrorTimerByTabId.delete(tabId);
    }
  }

  // Viewport-only patches coalesce mirror writes (500–1000 ms quiet period)
  // so continuous scroll does not thrash storage every debounce tick.
  function scheduleMirrorTrailCoalesced(tabId: number): void {
    if (incognitoTabIds.has(tabId) && !mirrorIsSessionScoped) return;
    clearViewportMirrorCoalesce(tabId);
    const timer = setTimeout(() => {
      viewportMirrorTimerByTabId.delete(tabId);
      scheduleMirrorTrail(tabId);
    }, VIEWPORT_MIRROR_COALESCE_MS);
    viewportMirrorTimerByTabId.set(tabId, timer);
  }

  function flushMirrorTrailImmediate(tabId: number): void {
    clearViewportMirrorCoalesce(tabId);
    scheduleMirrorTrail(tabId);
  }

  function nextRestoreGeneration(tabId: number): number {
    const next = (restoreGenerationByTabId.get(tabId) ?? 0) + 1;
    restoreGenerationByTabId.set(tabId, next);
    return next;
  }

  function clearPendingRestore(tabId: number): void {
    const prev = pendingRestoreByTabId.get(tabId);
    if (prev?.timeoutId != null) clearTimeout(prev.timeoutId);
    pendingRestoreByTabId.delete(tabId);
  }

  function setPendingRestore(
    tabId: number,
    spec: { url: string; viewport: TrailViewport; mode: TrailScrollRestoreMode },
    options?: { proactiveDispatch?: boolean },
  ): void {
    const normalized = normalizeViewport(spec.viewport);
    if (!normalized) return;
    clearPendingRestore(tabId);
    const generation = nextRestoreGeneration(tabId);
    const createdAt = Date.now();
    const timeoutId = setTimeout(() => {
      const cur = pendingRestoreByTabId.get(tabId);
      if (cur && cur.generation === generation) pendingRestoreByTabId.delete(tabId);
    }, PENDING_RESTORE_TTL_MS);
    pendingRestoreByTabId.set(tabId, {
      url: spec.url,
      viewport: normalized,
      mode: spec.mode,
      generation,
      createdAt,
      timeoutId,
    });
    if (options?.proactiveDispatch) {
      void dispatchPendingRestore(tabId, spec.url);
      for (const delay of DISPATCH_LADDER_MS) {
        void sleep(delay).then(() => dispatchPendingRestore(tabId, spec.url));
      }
    }
  }

  function armPendingFromEntry(
    tabId: number,
    entry: TrailEntry | undefined,
    mode: TrailScrollRestoreMode,
    options?: { proactiveDispatch?: boolean },
  ): void {
    if (!entry?.viewport) return;
    const viewport = normalizeViewport(entry.viewport);
    if (!viewport) return;
    setPendingRestore(
      tabId,
      { url: entry.url, viewport, mode },
      options,
    );
  }

  async function sendRestoreToTopFrame(
    tabId: number,
    message: ContentRuntimeMessage,
  ): Promise<TopFrameSendResult> {
    try {
      const response = await browser.tabs.sendMessage(tabId, message, { frameId: 0 }) as unknown;
      const ok =
        typeof response === "object" &&
        response !== null &&
        (response as { ok?: unknown }).ok === true;
      return {
        transported: true,
        accepted: ok,
        reason: !ok && typeof (response as { reason?: unknown })?.reason === "string"
          ? (response as { reason: string }).reason
          : undefined,
      };
    } catch (_) {
      return { transported: false };
    }
  }

  async function dispatchPendingRestore(tabId: number, landedUrl: string): Promise<void> {
    const pending = pendingRestoreByTabId.get(tabId);
    if (!pending || pending.url !== landedUrl) return;
    if (Date.now() - pending.createdAt > PENDING_RESTORE_TTL_MS) {
      clearPendingRestore(tabId);
      return;
    }
    // Snapshot generation before awaits so a superseding pending is not cleared
    // when an older ladder tick's accept finally returns.
    const acceptedGeneration = pending.generation;
    const message: ContentRuntimeMessage = {
      type: "TRAIL_RESTORE_SCROLL",
      url: pending.url,
      viewport: pending.viewport,
      mode: pending.mode,
      generation: acceptedGeneration,
    };
    let result = await sendRestoreToTopFrame(tabId, message);
    if (!result.transported) {
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (tab && didInjectContentScript(await injectContentScriptIntoTab(tab))) {
        await sleep(50);
        result = await sendRestoreToTopFrame(tabId, message);
      }
    }
    // Clear only on content acceptance of *this* generation — never on bare
    // transport success, and never if a newer pending superseded us mid-flight.
    if (result.transported && result.accepted) {
      const cur = pendingRestoreByTabId.get(tabId);
      if (cur && cur.generation === acceptedGeneration) {
        clearPendingRestore(tabId);
      }
    }
  }

  function applyScrollReport(
    tabId: number,
    url: string,
    viewport: TrailViewport,
    options?: { flush?: boolean },
  ): void {
    const flush = options?.flush === true;
    const now = Date.now();
    if (!flush) {
      const lastAt = lastScrollReportAtByTabId.get(tabId) ?? 0;
      // Wall-clock throttle independent of mirror coalesce (skip on unload flush).
      if (now - lastAt < SCROLL_REPORT_MIN_INTERVAL_MS) return;
    }
    lastScrollReportAtByTabId.set(tabId, now);

    void tabQueue.run(tabId, async () => {
      // Worker restart / cold map: rehydrate this tab's trail before patching.
      await ensureTabTrail(tabId);
      const state = trailsByTabId.get(tabId);
      if (!state || state.cursor < 0) return;
      const entry = state.entries[state.cursor];
      // Strict URL match — mismatch drops are expected after nav races.
      if (!entry || entry.url !== url) return;
      const normalized = normalizeViewport(viewport);
      if (!normalized) return;
      if (viewportEquals(entry.viewport, normalized)) {
        if (flush) flushMirrorTrailImmediate(tabId);
        return;
      }
      const entries = state.entries.slice();
      entries[state.cursor] = { ...entry, viewport: normalized };
      trailsByTabId.set(tabId, { entries, cursor: state.cursor });
      if (flush) {
        flushMirrorTrailImmediate(tabId);
      } else {
        scheduleMirrorTrailCoalesced(tabId);
      }
      // Do NOT notify overlay — viewport is not UI chrome state.
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
    requestedAtEpochMs?: number,
  ): Promise<ContentScriptMessageDelivery> {
    const state = getTrailState(tabId);
    try {
      const response = await browser.tabs.sendMessage(
        tabId,
        {
          type,
          state,
          ...(type === "TRAIL_SHOW" && Number.isFinite(requestedAtEpochMs)
            ? { requestedAtEpochMs }
            : {}),
        },
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

  function applyCursorEntryPatch(
    tabId: number,
    tab: Pick<Tabs.Tab, "url" | "title" | "favIconUrl">,
  ): boolean {
    const state = trailsByTabId.get(tabId);
    if (!state || state.cursor < 0) return false;
    const entry = state.entries[state.cursor];
    if (!entry || tab.url !== entry.url) return false;
    const title = typeof tab.title === "string" ? tab.title : entry.title;
    const favIconUrl = typeof tab.favIconUrl === "string" ? tab.favIconUrl : entry.favIconUrl;
    if (title === entry.title && favIconUrl === entry.favIconUrl) return false;
    const entries = state.entries.slice();
    entries[state.cursor] = { ...entry, title, favIconUrl };
    trailsByTabId.set(tabId, { entries, cursor: state.cursor });
    return true;
  }

  function scheduleCursorEntryPatch(
    tabId: number,
    tab: Pick<Tabs.Tab, "url" | "title" | "favIconUrl">,
  ): void {
    void tabQueue.run(tabId, async () => {
      if (!applyCursorEntryPatch(tabId, tab)) return;
      scheduleMirrorTrail(tabId);
      notifyOverlayIfOpen(tabId);
    });
  }

  async function patchCursorEntryFromLiveTab(tabId: number): Promise<void> {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (tab) scheduleCursorEntryPatch(tabId, tab);
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
      const landedUrl = details.url;
      const { state, changed } = applyNavigationEvent(getTrailState(tabId), event);
      if (changed) {
        trailsByTabId.set(tabId, state);
        scheduleMirrorTrail(tabId);
        notifyOverlayIfOpen(tabId);
      }
      // Restore dispatch is NOT gated on changed — duplicate commits / same-URL
      // races must still deliver pending restore when URL matches.
      void dispatchPendingRestore(tabId, landedUrl);

      // Browser chrome back/forward without an extension jump: synthesize
      // corrective pending when the landed entry already has a viewport.
      if (!pendingJump && Array.isArray(event.qualifiers) && event.qualifiers.includes("forward_back")) {
        const live = trailsByTabId.get(tabId) ?? state;
        const entry = live.cursor >= 0 ? live.entries[live.cursor] : undefined;
        if (
          entry?.viewport &&
          entry.url === landedUrl &&
          !pendingRestoreByTabId.has(tabId)
        ) {
          setPendingRestore(tabId, {
            url: entry.url,
            viewport: entry.viewport,
            mode: "corrective",
          });
          void dispatchPendingRestore(tabId, landedUrl);
        }
      }
    }).then(() => {
      void patchCursorEntryFromLiveTab(tabId);
    });
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

  async function seedInheritedTrail(
    tabId: number,
    state: TrailState,
    policy: InheritedSeedPolicy,
  ): Promise<void> {
    let redispatchUrl: string | null = null;
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
      // Re-read after awaits: nav jobs enqueued before this seed may have built
      // a richer live trail. fill policy refuses to clobber those; replace
      // (open-in-current) always installs the chosen path.
      const existing = getTrailState(tabId);
      if (!shouldApplyInheritedSeed(existing, seeded, policy)) {
        // Still re-dispatch restore when the live URL matches pending — seed
        // losing the map race must not strand force restore.
        const pending = pendingRestoreByTabId.get(tabId);
        if (pending && (tab.url === pending.url || liveUrl === normalizePageUrl(pending.url))) {
          redispatchUrl = pending.url;
        }
        return;
      }
      trailsByTabId.set(tabId, seeded);
      // Title/favicon patch runs in this same queue turn before the mirror so
      // the first durable snapshot includes live metadata when available.
      applyCursorEntryPatch(tabId, tab);
      scheduleMirrorTrail(tabId);

      // Post-seed re-dispatch: land-before-pending / inject races can leave
      // pending present after create; retry once when live URL matches.
      const pending = pendingRestoreByTabId.get(tabId);
      if (pending && (tab.url === pending.url || liveUrl === normalizePageUrl(pending.url))) {
        redispatchUrl = pending.url;
      }
    });
    if (redispatchUrl != null) {
      void dispatchPendingRestore(tabId, redispatchUrl);
    }
  }

  // Open/window responses stay on the critical path; lineage is eventual.
  // Callers return { ok: true } before seed finishes, so a brief empty trail
  // on the destination tab is expected. Quiet rejections so fire-and-forget
  // cannot surface as unhandled promise rejections.
  function scheduleSeedInheritedTrail(
    tabId: number,
    state: TrailState,
    policy: InheritedSeedPolicy,
  ): void {
    void seedInheritedTrail(tabId, state, policy).catch(() => {});
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
      // Seed after the tab exists; do not block the open response on bookkeeping.
      // CRITICAL: arm pending on created.id — never on the source tab.
      if (created.id != null) {
        armPendingFromEntry(created.id, endpoint, "force", { proactiveDispatch: true });
        // New tab: fill-if-missing. Early nav/redirect hops must not be
        // collapsed by a late seed.
        scheduleSeedInheritedTrail(created.id, state, "fill");
      }
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: "Could not open tab" };
    }
  }

  async function toggleOverlay(
    senderTab?: Tabs.Tab,
    requestedAtEpochMs?: number,
  ): Promise<TabTrailActionResult> {
    await ensureLoaded();
    const tabId = await resolveTargetTabId(undefined, senderTab);
    if (tabId == null) return { ok: false, reason: "No tab for overlay" };
    const validRequestedAt = Number.isFinite(requestedAtEpochMs)
      ? requestedAtEpochMs
      : undefined;
    let delivery = await pushTrailToTab(tabId, "TRAIL_SHOW", validRequestedAt);
    if (!delivery.delivered) {
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (tab && didInjectContentScript(await injectContentScriptIntoTab(tab))) {
        delivery = await pushTrailToTab(tabId, "TRAIL_SHOW", validRequestedAt);
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
    const targetTabId = await resolveTargetTabId(tabId, senderTab);
    if (targetTabId == null) return { ok: false, reason: "No tab to navigate" };
    await ensureTabTrail(targetTabId);
    const state = getTrailState(targetTabId);
    const plan = resolveJumpPlan(state, index);
    if (!plan) return { ok: true };

    const targetEntry = state.entries[index];
    pendingJumpByTabId.set(targetTabId, { index, kind: plan.kind });
    if (plan.kind === "historyGo") {
      armPendingFromEntry(targetTabId, targetEntry, "corrective");
      try {
        await browser.tabs.sendMessage(targetTabId, { type: "HISTORY_GO", delta: plan.delta }, { frameId: 0 });
        return { ok: true };
      } catch (_) {
        // No content script in that tab (privileged page); fall through to a
        // plain navigation on the same trail target. Flip restore mode to force.
        pendingJumpByTabId.set(targetTabId, { index, kind: "navigate" });
        armPendingFromEntry(targetTabId, targetEntry, "force");
      }
    } else {
      armPendingFromEntry(targetTabId, targetEntry, "force");
    }
    const url = targetEntry?.url;
    if (!url) {
      pendingJumpByTabId.delete(targetTabId);
      clearPendingRestore(targetTabId);
      return { ok: false, reason: "Trail entry missing" };
    }
    try {
      await browser.tabs.update(targetTabId, { url });
      // Match openSavedTrail current: one proactive dispatch covers inject races
      // before the next nav event lands.
      void dispatchPendingRestore(targetTabId, url);
      return { ok: true };
    } catch (_) {
      pendingJumpByTabId.delete(targetTabId);
      clearPendingRestore(targetTabId);
      return { ok: false, reason: "Navigation failed" };
    }
  }

  async function openEntryInNewTab(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult> {
    const targetTabId = await resolveTargetTabId(tabId, senderTab);
    if (targetTabId == null) return { ok: false, reason: "No source tab" };
    await ensureTabTrail(targetTabId);
    const path = slicePathToIndex(getTrailState(targetTabId), index);
    if (!path) return { ok: false, reason: "Trail entry missing" };
    const inherited = createInheritedTrailState(path);
    const sourceTab = await resolveSourceTab(targetTabId, senderTab);
    return createTabFromInheritedTrail(inherited, sourceTab, false);
  }

  async function openEntryInNewWindow(index: number, tabId?: number, senderTab?: Tabs.Tab): Promise<TabTrailActionResult> {
    const targetTabId = await resolveTargetTabId(tabId, senderTab);
    if (targetTabId == null) return { ok: false, reason: "No source tab" };
    await ensureTabTrail(targetTabId);
    const path = slicePathToIndex(getTrailState(targetTabId), index);
    if (!path) return { ok: false, reason: "Trail entry missing" };
    const inherited = createInheritedTrailState(path);
    const endpoint = inherited.entries[inherited.cursor];
    if (!endpoint) return { ok: false, reason: "Trail endpoint missing" };
    const sourceTab = await resolveSourceTab(targetTabId, senderTab);
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
      // Seed off the critical path so the window appears immediately.
      if (seededTabId != null && created.incognito === sourceIncognito) {
        armPendingFromEntry(seededTabId, endpoint, "force", { proactiveDispatch: true });
        scheduleSeedInheritedTrail(seededTabId, inherited, "fill");
      }
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: "Could not open window" };
    }
  }

  // Open a saved path at its endpoint with the full path as inherited lineage.
  // New-tab mode creates a tab; current-tab mode navigates the active tab and
  // seeds the same non-historyBacked prefix so jumps still work. The path is
  // already on the wire, so open does not wait on full trail rehydrate.
  // Seed is eventual-consistent with the open response (see scheduleSeedInheritedTrail).
  async function openSavedTrail(
    path: TrailEntry[],
    mode: SavedTrailOpenMode,
    senderTab?: Tabs.Tab,
  ): Promise<TabTrailActionResult> {
    const inherited = createInheritedTrailState(path);
    const endpoint = inherited.entries[inherited.cursor];
    if (!endpoint) return { ok: false, reason: "Trail endpoint missing" };
    const targetTabId = await resolveTargetTabId(undefined, senderTab);
    if (mode === "current") {
      if (targetTabId == null) return { ok: false, reason: "No tab to navigate" };
      try {
        // Arm force pending on the navigated tab BEFORE tabs.update so land
        // can restore even if seed loses the race with a cold makeEntry.
        armPendingFromEntry(targetTabId, endpoint, "force");
        await browser.tabs.update(targetTabId, { url: endpoint.url });
        void dispatchPendingRestore(targetTabId, endpoint.url);
        // Current-tab open intentionally replaces whatever live trail the tab
        // had with the chosen path.
        scheduleSeedInheritedTrail(targetTabId, inherited, "replace");
        return { ok: true };
      } catch (_) {
        clearPendingRestore(targetTabId);
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
    for (const tabId of pendingRestoreByTabId.keys()) clearPendingRestore(tabId);
    for (const tabId of viewportMirrorTimerByTabId.keys()) clearViewportMirrorCoalesce(tabId);
    trailsByTabId.clear();
    overlayOpenTabIds.clear();
    pendingJumpByTabId.clear();
    pendingRestoreByTabId.clear();
    restoreGenerationByTabId.clear();
    lastScrollReportAtByTabId.clear();
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
    clearPendingRestore(tabId);
    clearViewportMirrorCoalesce(tabId);
    restoreGenerationByTabId.delete(tabId);
    lastScrollReportAtByTabId.delete(tabId);
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
      scheduleCursorEntryPatch(tabId, tab);
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
    applyScrollReport,
    setOverlayOpen,
    refreshExtension,
    activateExistingContentScripts,
    registerLifecycleListeners,
  };
}
