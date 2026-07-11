// Top-frame scroll sample + restore for trail viewport metadata.
// Installed from initTopFrameOverlay so combined contentScript also inherits.
// Chord content script stays free of scroll logic.

import {
  reportTrailScroll,
  reportTrailScrollWithRetry,
} from "../adapters/runtime/tabtrailApi";
import {
  clampViewportToLiveMax,
  isAllowedRootSelector,
  isFarFromTarget,
  normalizeViewport,
  shouldDeferClamp,
} from "../core/trail/viewportCore";

const SAMPLE_DEBOUNCE_MS = 175;
const SAFETY_POLL_MS = 2000;
const RESTORE_TIMEOUT_MS = 2000;
const RESTORE_MAX_ATTEMPTS = 12;
const STABILITY_PX = 4;
const FRAGMENT_NEAR_PX = 80;
const FRAGMENT_SKIP_WINDOW_MS = 300;
const CORRECTIVE_SETTLE_MS = 75;
const NESTED_MIN_RANGE = 200;
const DOCUMENT_MIN_RANGE = 32;
const ROOT_SELECTOR_MAX_DEPTH = 4;
/** Hard cap for nested-scroller DOM scan (main-thread budget on large pages). */
const NESTED_SCAN_MAX = 400;
const RESIZE_DEBOUNCE_MS = 50;

export interface ScrollRestoreMessage {
  url: string;
  viewport: TrailViewport;
  mode: TrailScrollRestoreMode;
  generation: number;
}

export interface ScrollRestoreResponse {
  ok: boolean;
  reason?: string;
}

export interface PageScrollBridge {
  dispose: () => void;
  handleRestoreScroll: (message: ScrollRestoreMessage) => Promise<ScrollRestoreResponse>;
  /** Test hook: whether sample reporting is suppressed. */
  isRestoreGateActive: () => boolean;
}

interface SampledViewport extends TrailViewport {
  x: number;
  y: number;
}

function roundCoord(value: number): number {
  return Math.round(value);
}

function readDocumentOffsets(): { x: number; y: number; scrollHeight: number; maxY: number } {
  const se = document.scrollingElement || document.documentElement;
  const seX = se ? se.scrollLeft : 0;
  const seY = se ? se.scrollTop : 0;
  const winX = typeof window.scrollX === "number" ? window.scrollX : window.pageXOffset || 0;
  const winY = typeof window.scrollY === "number" ? window.scrollY : window.pageYOffset || 0;
  const x = Math.max(seX, winX);
  const y = Math.max(seY, winY);
  const scrollHeight = se ? se.scrollHeight : document.documentElement.scrollHeight;
  const clientHeight = se ? se.clientHeight : window.innerHeight;
  const maxY = Math.max(0, scrollHeight - clientHeight);
  return { x, y, scrollHeight, maxY };
}

function isScrollableOverflow(style: CSSStyleDeclaration): boolean {
  const oy = style.overflowY;
  const ox = style.overflowX;
  return (
    oy === "auto" ||
    oy === "scroll" ||
    ox === "auto" ||
    ox === "scroll"
  );
}

/**
 * Build a short selector that passes `isAllowedRootSelector`. Emit only the
 * unescaped `#id` grammar (no CSS.escape) so normalize and restore agree.
 * Custom-element tags (hyphenated) are included in the path grammar.
 */
function buildShortSelector(el: Element): string | null {
  // Id must match allowlist as-is — never CSS.escape (would break the allowlist).
  if (el.id && isAllowedRootSelector(`#${el.id}`)) {
    return `#${el.id}`;
  }
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node !== document.documentElement && depth < ROOT_SELECTOR_MAX_DEPTH) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const tag = node.tagName.toLowerCase();
    // Path must stay allowlist-clean; bail rather than skip intermediates.
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(tag)) {
      return null;
    }
    const siblings = Array.from(parent.children).filter(
      (child) => child.tagName === node!.tagName,
    );
    if (siblings.length === 1) {
      parts.unshift(tag);
    } else {
      const index = siblings.indexOf(node) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
    }
    node = parent;
    depth += 1;
  }
  if (parts.length === 0) return null;
  const selector = parts.join(" > ");
  return isAllowedRootSelector(selector) ? selector : null;
}

/** Bounded DFS — never materializes the full `body *` NodeList. */
function collectNestedCandidates(max: number): Element[] {
  const out: Element[] = [];
  const body = document.body;
  if (!body || max <= 0) return out;

  const stack: Element[] = [];
  // Push children in reverse so left-to-right order is preserved on pop.
  for (let i = body.children.length - 1; i >= 0; i -= 1) {
    stack.push(body.children[i]);
  }
  while (stack.length > 0 && out.length < max) {
    const el = stack.pop()!;
    out.push(el);
    for (let i = el.children.length - 1; i >= 0; i -= 1) {
      stack.push(el.children[i]);
    }
  }
  return out;
}

function findPrimaryNestedScroller(): Element | null {
  const doc = readDocumentOffsets();
  if (doc.maxY >= DOCUMENT_MIN_RANGE) return null;

  let best: { el: Element; area: number; range: number } | null = null;
  const candidates = collectNestedCandidates(NESTED_SCAN_MAX);
  for (let i = 0; i < candidates.length; i += 1) {
    const el = candidates[i];
    if (!(el instanceof HTMLElement)) continue;
    const range = el.scrollHeight - el.clientHeight;
    if (range < NESTED_MIN_RANGE) continue;
    let style: CSSStyleDeclaration;
    try {
      style = window.getComputedStyle(el);
    } catch (_) {
      continue;
    }
    if (!isScrollableOverflow(style)) continue;
    const area = el.clientWidth * el.clientHeight;
    if (!best || range > best.range || (range === best.range && area > best.area)) {
      best = { el, area, range };
    }
  }
  // Only return a nested root we can re-resolve later via allowlisted selector.
  if (best && !buildShortSelector(best.el)) return null;
  return best?.el ?? null;
}

function readViewportFromRoot(root: Element | null): SampledViewport {
  if (
    root &&
    root !== document.documentElement &&
    root !== document.body &&
    root !== document.scrollingElement
  ) {
    const selector = buildShortSelector(root);
    // Only emit nested viewport when selector is allowlisted. Otherwise use true
    // document offsets — never keep nested x/y labeled as root:"document".
    if (selector && isAllowedRootSelector(selector)) {
      return {
        x: roundCoord(root.scrollLeft),
        y: roundCoord(root.scrollTop),
        scrollHeight: root.scrollHeight,
        root: "element",
        rootSelector: selector,
        capturedAt: Date.now(),
      };
    }
  }
  const doc = readDocumentOffsets();
  return {
    x: roundCoord(doc.x),
    y: roundCoord(doc.y),
    scrollHeight: doc.scrollHeight,
    root: "document",
    capturedAt: Date.now(),
  };
}

function applyScrollToRoot(
  root: Element | "window",
  x: number,
  y: number,
): void {
  if (root === "window") {
    try {
      window.scrollTo({ left: x, top: y, behavior: "instant" as ScrollBehavior });
    } catch (_) {
      window.scrollTo(x, y);
    }
    return;
  }
  root.scrollLeft = x;
  root.scrollTop = y;
}

function resolveRestoreRoot(viewport: TrailViewport): {
  root: Element | "window";
  isDocument: boolean;
} {
  if (viewport.root === "element" && viewport.rootSelector) {
    try {
      const el = document.querySelector(viewport.rootSelector);
      if (el instanceof HTMLElement && el.isConnected) {
        const range = el.scrollHeight - el.clientHeight;
        if (range >= 0) {
          return { root: el, isDocument: false };
        }
      }
    } catch (_) {
      // Invalid selector — fall through to document.
    }
  }
  const se = document.scrollingElement || document.documentElement;
  return { root: se || "window", isDocument: true };
}

function liveMaxForRoot(root: Element | "window"): { maxX: number; maxY: number; scrollHeight: number } {
  if (root === "window") {
    const se = document.scrollingElement || document.documentElement;
    const scrollHeight = se ? se.scrollHeight : document.documentElement.scrollHeight;
    const clientHeight = se ? se.clientHeight : window.innerHeight;
    const clientWidth = se ? se.clientWidth : window.innerWidth;
    const scrollWidth = se ? se.scrollWidth : document.documentElement.scrollWidth;
    return {
      maxX: Math.max(0, scrollWidth - clientWidth),
      maxY: Math.max(0, scrollHeight - clientHeight),
      scrollHeight,
    };
  }
  return {
    maxX: Math.max(0, root.scrollWidth - root.clientWidth),
    maxY: Math.max(0, root.scrollHeight - root.clientHeight),
    scrollHeight: root.scrollHeight,
  };
}

function readLiveFromRoot(root: Element | "window"): { x: number; y: number } {
  if (root === "window") {
    const doc = readDocumentOffsets();
    return { x: doc.x, y: doc.y };
  }
  return { x: root.scrollLeft, y: root.scrollTop };
}

function isUserScrollKey(event: KeyboardEvent): boolean {
  const key = event.key;
  return (
    key === " " ||
    key === "PageUp" ||
    key === "PageDown" ||
    key === "Home" ||
    key === "End" ||
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight"
  );
}

function fragmentNearSkip(
  restoreUrl: string,
  currentY: number,
  landAt: number,
): boolean {
  if (Date.now() - landAt > FRAGMENT_SKIP_WINDOW_MS) return false;
  let hash = "";
  try {
    hash = new URL(restoreUrl).hash;
  } catch (_) {
    const idx = restoreUrl.indexOf("#");
    hash = idx >= 0 ? restoreUrl.slice(idx) : "";
  }
  if (!hash || hash === "#") return false;
  let id = "";
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch (_) {
    id = hash.slice(1);
  }
  if (!id) return false;
  const el =
    document.getElementById(id) ||
    (document.getElementsByName(id)[0] as Element | undefined);
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const elementTop = rect.top + window.scrollY;
  return Math.abs(elementTop - currentY) < FRAGMENT_NEAR_PX;
}

export function installPageScrollBridge(): PageScrollBridge {
  // Capture page globals for the lifetime of this install so async restore
  // cleanup remains safe if a host tears down the DOM environment (tests).
  const win = window;
  const doc = document;
  const histObj = win.history;

  let disposed = false;
  let restoreGenerationLive: number | null = null;
  let restoreUrl: string | null = null;
  let restoreCancel: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastReportedKey = "";
  let nestedRoot: Element | null = null;
  let nestedBoundEl: Element | null = null;
  let pageshowPersisted = false;
  let safetyPollId: ReturnType<typeof setInterval> | null = null;

  const isRestoreGateActive = (): boolean => restoreGenerationLive != null;

  const clearRestoreGate = (): void => {
    restoreGenerationLive = null;
    restoreUrl = null;
    if (restoreCancel) {
      restoreCancel();
      restoreCancel = null;
    }
  };

  const readViewport = (): SampledViewport => {
    // Prefer bound nested root when active (selector was validated at bind).
    if (nestedRoot && nestedRoot.isConnected) {
      const sample = readViewportFromRoot(nestedRoot);
      if (sample.root === "element") return sample;
      // Selector became unusable — drop nested bind and sample document.
      unbindNestedListeners();
      nestedRoot = null;
    }
    const doc = readDocumentOffsets();
    if (doc.maxY < DOCUMENT_MIN_RANGE) {
      const nested = findPrimaryNestedScroller();
      if (nested) {
        bindNestedRoot(nested);
        return readViewportFromRoot(nested);
      }
    }
    return readViewportFromRoot(null);
  };

  const unbindNestedListeners = (): void => {
    if (!nestedBoundEl) return;
    nestedBoundEl.removeEventListener("scroll", onNestedScroll);
    nestedBoundEl.removeEventListener("scrollend", onNestedScrollEnd as EventListener);
    nestedBoundEl = null;
  };

  const bindNestedRoot = (el: Element): void => {
    nestedRoot = el;
    if (nestedBoundEl === el) return;
    unbindNestedListeners();
    nestedBoundEl = el;
    el.addEventListener("scroll", onNestedScroll, { passive: true });
    el.addEventListener("scrollend", onNestedScrollEnd as EventListener, {
      passive: true,
    } as AddEventListenerOptions);
  };

  /**
   * @param mode
   * - `"debounced"` normal scroll sample (throttled, coalesced mirror)
   * - `"immediate"` cancel debounce and send now without unload mirror force
   *   (soft-nav: still rate-limited by domain wall-clock; no flush:true)
   * - `"unload"` pagehide/visibility — flush:true + retry for worker survival
   */
  const sendSample = (
    viewport: SampledViewport,
    mode: "debounced" | "immediate" | "unload",
  ): void => {
    if (disposed || isRestoreGateActive()) return;
    const key = `${viewport.x},${viewport.y},${viewport.root ?? "document"},${viewport.rootSelector ?? ""}`;
    if (mode === "debounced" && key === lastReportedKey) return;
    if (mode === "immediate" && key === lastReportedKey) return;
    lastReportedKey = key;
    const url = location.href;
    if (mode === "unload") {
      void reportTrailScrollWithRetry(url, viewport).catch(() => {});
    } else {
      // Soft-nav and continuous samples never force mirror flush (availability).
      void reportTrailScroll(url, viewport).catch(() => {});
    }
  };

  const sampleNow = (mode: "debounced" | "immediate" | "unload" = "debounced"): void => {
    if (disposed || isRestoreGateActive()) return;
    try {
      sendSample(readViewport(), mode);
    } catch (_) {
      // Page may be tearing down.
    }
  };

  const scheduleSample = (): void => {
    if (disposed || isRestoreGateActive()) return;
    if (debounceTimer != null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      sampleNow("debounced");
    }, SAMPLE_DEBOUNCE_MS);
  };

  /** Cancel debounce and sample immediately without unload-style mirror force. */
  const flushSampleSoft = (): void => {
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    sampleNow("immediate");
  };

  /** Unload/pagehide path only — flush:true + retry. */
  const flushSampleUnload = (): void => {
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    sampleNow("unload");
  };

  function onWindowScroll(): void {
    scheduleSample();
  }

  function onNestedScroll(): void {
    scheduleSample();
  }

  function onScrollEnd(): void {
    if (isRestoreGateActive()) return;
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    sampleNow("debounced");
  }

  function onNestedScrollEnd(): void {
    onScrollEnd();
  }

  function onPageHide(): void {
    if (isRestoreGateActive()) return;
    flushSampleUnload();
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden" && !isRestoreGateActive()) {
      flushSampleUnload();
    }
  }

  function onPopState(): void {
    if (isRestoreGateActive()) {
      if (restoreUrl && location.href !== restoreUrl) {
        clearRestoreGate();
      }
      return;
    }
    // Soft-nav: immediate sample without unload mirror force.
    flushSampleSoft();
  }

  function onPageShow(event: PageTransitionEvent): void {
    pageshowPersisted = event.persisted === true;
  }

  // Soft-nav flush: pushState/replaceState do not fire popstate; capture last
  // sample before the SPA URL changes when not mid-restore. Must NOT use
  // unload flush:true (history API loops must not force unthrottled mirrors).
  const originalPushState = histObj.pushState.bind(histObj);
  const originalReplaceState = histObj.replaceState.bind(histObj);
  histObj.pushState = function wrappedPushState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    if (!isRestoreGateActive()) {
      flushSampleSoft();
    }
    originalPushState(data, unused, url);
    if (isRestoreGateActive() && restoreUrl && location.href !== restoreUrl) {
      clearRestoreGate();
    }
  };
  histObj.replaceState = function wrappedReplaceState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    if (!isRestoreGateActive()) {
      flushSampleSoft();
    }
    originalReplaceState(data, unused, url);
    if (isRestoreGateActive() && restoreUrl && location.href !== restoreUrl) {
      clearRestoreGate();
    }
  };

  window.addEventListener("scroll", onWindowScroll, { capture: true, passive: true });
  window.addEventListener("scrollend", onScrollEnd as EventListener, {
    passive: true,
  } as AddEventListenerOptions);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("popstate", onPopState);
  window.addEventListener("pageshow", onPageShow as EventListener);

  safetyPollId = setInterval(() => {
    if (disposed || document.visibilityState !== "visible") return;
    if (isRestoreGateActive()) return;
    // Re-resolve nested root if node was replaced.
    if (nestedRoot && !nestedRoot.isConnected) {
      unbindNestedListeners();
      nestedRoot = null;
      const found = findPrimaryNestedScroller();
      if (found) bindNestedRoot(found);
    }
    sampleNow("debounced");
  }, SAFETY_POLL_MS);

  const handleRestoreScroll = async (
    message: ScrollRestoreMessage,
  ): Promise<ScrollRestoreResponse> => {
    if (disposed) return { ok: false, reason: "not-ready" };
    if (!document.documentElement) return { ok: false, reason: "not-ready" };

    // Ignore stale generations without cancelling a newer live restore.
    if (
      restoreGenerationLive != null &&
      Number.isFinite(message.generation) &&
      message.generation < restoreGenerationLive
    ) {
      return { ok: false, reason: "stale-generation" };
    }

    const viewport = normalizeViewport(message.viewport);
    if (!viewport) return { ok: false, reason: "not-ready" };

    // Optional force hold: wait briefly for href match (reduces ladder chatter).
    const holdUntil = message.mode === "force" ? Date.now() + 2000 : Date.now();
    while (location.href !== message.url && Date.now() < holdUntil) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      if (disposed) return { ok: false, reason: "not-ready" };
      // A newer restore may have started while we waited.
      if (
        restoreGenerationLive != null &&
        Number.isFinite(message.generation) &&
        message.generation < restoreGenerationLive
      ) {
        return { ok: false, reason: "stale-generation" };
      }
    }
    if (location.href !== message.url) {
      return { ok: false, reason: "url-mismatch" };
    }

    // Supersede any in-flight restore of an older/same generation.
    if (restoreCancel) {
      restoreCancel();
      restoreCancel = null;
    }
    restoreGenerationLive = message.generation;
    restoreUrl = message.url;
    const landAt = Date.now();
    // Snapshot BFCache flag for corrective before any settle delay. One-shot:
    // clear the live flag so a later restore does not reuse a stale pageshow.
    // (Previously clearing here before snapshot made BFCache preference dead.)
    const bfcachePersisted = pageshowPersisted;
    pageshowPersisted = false;

    // { ok: true } means *accepted* (URL gate passed, generation armed, multi-
    // attempt started) — not that scroll has finished settling. Domain clears
    // pending on this ack only (generation-scoped on the domain side).
    void runRestoreAttempts(message, viewport, landAt, bfcachePersisted);

    return { ok: true };
  };

  async function runRestoreAttempts(
    message: ScrollRestoreMessage,
    viewport: TrailViewport,
    landAt: number,
    bfcachePersisted: boolean,
  ): Promise<void> {
    let cancelled = false;
    const generation = message.generation;
    let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelListeners: Array<() => void> = [];
    const onUserCancel = (event: Event): void => {
      if (!event.isTrusted) return;
      if (event.type === "keydown" && !isUserScrollKey(event as KeyboardEvent)) return;
      cancelled = true;
      clearRestoreGate();
    };
    win.addEventListener("wheel", onUserCancel, { passive: true, capture: true });
    win.addEventListener("touchmove", onUserCancel, { passive: true, capture: true });
    win.addEventListener("keydown", onUserCancel, { passive: true, capture: true });
    cancelListeners.push(() => {
      try {
        win.removeEventListener("wheel", onUserCancel, true);
        win.removeEventListener("touchmove", onUserCancel, true);
        win.removeEventListener("keydown", onUserCancel, true);
      } catch (_) {
        // Page environment already torn down.
      }
    });

    restoreCancel = () => {
      cancelled = true;
      if (resizeDebounceTimer != null) clearTimeout(resizeDebounceTimer);
      for (const off of cancelListeners) off();
    };

    const stillActive = (): boolean =>
      !cancelled &&
      !disposed &&
      restoreGenerationLive === generation &&
      location.href === message.url;

    try {
      if (message.mode === "corrective") {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            setTimeout(resolve, CORRECTIVE_SETTLE_MS);
          });
        });
        if (!stillActive()) return;
        const { root } = resolveRestoreRoot(viewport);
        const live = readLiveFromRoot(root);
        const { scrollHeight } = liveMaxForRoot(root);
        if (bfcachePersisted && !isFarFromTarget(live, viewport, scrollHeight)) {
          clearRestoreGate();
          return;
        }
        if (!isFarFromTarget(live, viewport, scrollHeight)) {
          clearRestoreGate();
          return;
        }
      }

      const { root, isDocument } = resolveRestoreRoot(viewport);

      // Fragment near-anchor skip: document root + force only.
      if (message.mode === "force" && isDocument) {
        const live = readLiveFromRoot(root);
        if (fragmentNearSkip(message.url, live.y, landAt)) {
          clearRestoreGate();
          return;
        }
      }

      let attempts = 0;
      const deadline = Date.now() + RESTORE_TIMEOUT_MS;
      let resizeObserver: ResizeObserver | null = null;
      let loadHandler: (() => void) | null = null;

      const tryApply = (): boolean => {
        if (!stillActive()) return true;
        attempts += 1;
        const liveMax = liveMaxForRoot(root);
        if (
          shouldDeferClamp(viewport.scrollHeight, liveMax.maxY, viewport.y) &&
          attempts < RESTORE_MAX_ATTEMPTS &&
          Date.now() < deadline
        ) {
          return false;
        }
        const clamped = clampViewportToLiveMax(viewport, liveMax.maxX, liveMax.maxY);
        applyScrollToRoot(root, clamped.x, clamped.y);
        const after = readLiveFromRoot(root);
        const nearX = Math.abs(after.x - clamped.x) <= STABILITY_PX;
        const nearY = Math.abs(after.y - clamped.y) <= STABILITY_PX;
        const atMaxY =
          viewport.y > liveMax.maxY && Math.abs(after.y - liveMax.maxY) <= STABILITY_PX;
        const atMaxX =
          viewport.x > liveMax.maxX && Math.abs(after.x - liveMax.maxX) <= STABILITY_PX;
        if ((nearX || atMaxX) && (nearY || atMaxY)) {
          clearRestoreGate();
          return true;
        }
        return false;
      };

      const scheduleTicks = async (): Promise<void> => {
        // rAF × 2
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (tryApply()) return;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (tryApply()) return;

        while (stillActive() && attempts < RESTORE_MAX_ATTEMPTS && Date.now() < deadline) {
          if (tryApply()) return;
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        if (stillActive()) clearRestoreGate();
      };

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          if (!stillActive()) return;
          if (resizeDebounceTimer != null) clearTimeout(resizeDebounceTimer);
          resizeDebounceTimer = setTimeout(() => {
            resizeDebounceTimer = null;
            if (stillActive()) tryApply();
          }, RESIZE_DEBOUNCE_MS);
        });
        resizeObserver.observe(document.documentElement);
        if (root !== "window" && root instanceof Element) {
          resizeObserver.observe(root);
        }
      }

      if (document.readyState !== "complete") {
        loadHandler = () => {
          if (stillActive()) tryApply();
        };
        win.addEventListener("load", loadHandler, { once: true });
      }

      await scheduleTicks();

      if (resizeDebounceTimer != null) clearTimeout(resizeDebounceTimer);
      if (resizeObserver) resizeObserver.disconnect();
      if (loadHandler) {
        try {
          win.removeEventListener("load", loadHandler);
        } catch (_) {
          // Environment already torn down.
        }
      }
    } finally {
      for (const off of cancelListeners) off();
      if (restoreGenerationLive === generation) {
        clearRestoreGate();
      }
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearRestoreGate();
    if (debounceTimer != null) clearTimeout(debounceTimer);
    if (safetyPollId != null) clearInterval(safetyPollId);
    unbindNestedListeners();
    try {
      histObj.pushState = originalPushState;
      histObj.replaceState = originalReplaceState;
      win.removeEventListener("scroll", onWindowScroll, true);
      win.removeEventListener("scrollend", onScrollEnd as EventListener);
      win.removeEventListener("pagehide", onPageHide);
      doc.removeEventListener("visibilitychange", onVisibilityChange);
      win.removeEventListener("popstate", onPopState);
      win.removeEventListener("pageshow", onPageShow as EventListener);
    } catch (_) {
      // Environment already torn down.
    }
  };

  return {
    dispose,
    handleRestoreScroll,
    isRestoreGateActive,
  };
}
