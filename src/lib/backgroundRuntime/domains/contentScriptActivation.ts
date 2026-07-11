// Content-script inject/retry policy for already-open tabs.
// Trail domain decides *when* to activate; this module owns *how*.

import browser, { Tabs } from "webextension-polyfill";
import { sleep } from "../../common/utils/asyncFlow";
import { isKnownBrowserStoreRestrictedUrl } from "../../common/utils/restrictedUrls";

// On install/update we inject into already-open tabs (the manifest only
// auto-injects on navigation). A tab that's momentarily inaccessible then —
// mid-navigation, "cannot access contents", closing — fails; retry those over
// this backoff so a transient miss doesn't leave the tab without the shortcut.
const CONTENT_SCRIPT_RETRY_DELAYS_MS = [400, 1200];

/**
 * Combined `contentScript.js` remains as a last-resort inject for upgrade
 * resilience when the split chord/top injects fail. Drop the combined bundle
 * only after: (1) activateExistingContentScripts always succeeds with split
 * injects across supported browsers for at least one release cycle, and
 * (2) no store-upgrade path still depends on the single-file entry.
 * Until then, do not add new behavior only to the combined entry.
 */
const COMBINED_CONTENT_SCRIPT_FALLBACK = "contentScript.js";

interface ScriptingApi {
  executeScript(details: {
    target: { tabId: number; allFrames?: boolean };
    files: string[];
  }): Promise<unknown>;
}

export type ContentScriptInjectionOutcome =
  | "injected-all-frames"
  | "injected-top-frame"
  | "skipped"
  | "failed";

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

async function executeScriptFiles(
  tabId: number,
  files: string[],
  allFrames: boolean,
): Promise<boolean> {
  const runtimeBrowser = browser as typeof browser & {
    scripting?: ScriptingApi;
    tabs: typeof browser.tabs & {
      executeScript?: (tabId: number, details: {
        file: string;
        runAt?: string;
        allFrames?: boolean;
      }) => Promise<unknown>;
    };
  };
  try {
    if (runtimeBrowser.scripting?.executeScript) {
      await runtimeBrowser.scripting.executeScript({
        target: { tabId, ...(allFrames ? { allFrames: true } : {}) },
        files,
      });
      return true;
    }
    if (runtimeBrowser.tabs.executeScript) {
      // MV2 executeScript takes one file per call.
      for (const file of files) {
        await runtimeBrowser.tabs.executeScript(tabId, {
          file,
          runAt: "document_start",
          ...(allFrames ? { allFrames: true } : {}),
        });
      }
      return true;
    }
  } catch (_) {
    return false;
  }
  return false;
}

export async function injectContentScriptIntoTab(
  tab: Tabs.Tab,
): Promise<ContentScriptInjectionOutcome> {
  if (tab.id == null || tab.discarded === true || isPageGestureRestrictedUrl(tab.url)) {
    return "skipped";
  }
  // Chord capture in every frame; overlay host only needs the top frame.
  // The two split injects are independent — run them in parallel.
  const [chordOk, topOk] = await Promise.all([
    executeScriptFiles(tab.id, ["contentScriptChord.js"], true),
    executeScriptFiles(tab.id, ["contentScriptTop.js"], false),
  ]);
  if (chordOk && topOk) return "injected-all-frames";
  if (topOk) return "injected-top-frame";
  // Last resort: combined bundle into the top frame only.
  return await executeScriptFiles(tab.id, [COMBINED_CONTENT_SCRIPT_FALLBACK], false)
    ? "injected-top-frame"
    : "failed";
}

function shouldRetryContentScriptInjection(outcome: ContentScriptInjectionOutcome): boolean {
  return outcome === "failed" || outcome === "injected-top-frame";
}

export async function activateExistingContentScripts(): Promise<void> {
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
