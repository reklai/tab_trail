import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadTrailDomain() {
  const tempDir = mkdtempSync(join(tmpdir(), "trail-domain-private-window-"));
  const outfile = join(tempDir, "trailDomain.mjs");
  await build({
    entryPoints: ["src/lib/backgroundRuntime/domains/trailDomain.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "trail-domain-browser-stub",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^webextension-polyfill$/ }, () => ({
          path: "webextension-polyfill",
          namespace: "trail-domain-stub",
        }));
        buildApi.onLoad({ filter: /.*/, namespace: "trail-domain-stub" }, () => ({
          loader: "js",
          contents: `
            const local = {
              get: (...args) => globalThis.__privateWindowStorageGet(...args),
              set: (...args) => globalThis.__privateWindowStorageSet(...args),
              remove: (...args) => globalThis.__privateWindowStorageRemove(...args),
            };
            const event = { addListener: () => undefined };
            export default {
              storage: { local },
              tabs: {
                query: (...args) => globalThis.__privateWindowTabsQuery(...args),
                get: (...args) => globalThis.__privateWindowTabsGet(...args),
                sendMessage: async () => undefined,
                create: async () => ({}),
                update: async () => ({}),
                onUpdated: event,
                onRemoved: event,
              },
              scripting: { executeScript: async () => undefined },
              windows: {
                create: (...args) => globalThis.__privateWindowCreate(...args),
              },
              webNavigation: {
                onCommitted: event,
                onHistoryStateUpdated: event,
                onReferenceFragmentUpdated: event,
              },
              runtime: { onInstalled: event, onStartup: event },
            };
          `,
        }));
      },
    }],
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return { mod, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
}

const endpointUrl = "https://private.example.test/second";
const privateTrail = {
  entries: [
    {
      url: "https://private.example.test/first",
      title: "First private page",
      favIconUrl: "",
      timestamp: 1,
      transition: "typed",
      redirected: false,
      historyBacked: true,
    },
    {
      url: endpointUrl,
      title: "Second private page",
      favIconUrl: "",
      timestamp: 2,
      transition: "link",
      redirected: false,
      historyBacked: true,
    },
  ],
  cursor: 1,
};

function installBrowserHooks(createdWindow) {
  const calls = { storageSet: [], tabsGet: [], windowsCreate: [] };
  const sourceTab = { id: 7, incognito: true, url: endpointUrl };
  globalThis.__privateWindowStorageGet = async () => ({
    "tabtrailTrail:7": privateTrail,
  });
  globalThis.__privateWindowStorageSet = async (items) => {
    calls.storageSet.push(items);
  };
  globalThis.__privateWindowStorageRemove = async () => undefined;
  globalThis.__privateWindowTabsQuery = async () => [sourceTab];
  globalThis.__privateWindowTabsGet = async (tabId) => {
    calls.tabsGet.push(tabId);
    if (tabId === sourceTab.id) return sourceTab;
    const createdTab = createdWindow.tabs?.find((tab) => tab.id === tabId);
    return createdTab ? { ...createdTab, url: endpointUrl } : null;
  };
  globalThis.__privateWindowCreate = async (details) => {
    calls.windowsCreate.push(details);
    return createdWindow;
  };
  return calls;
}

function removeBrowserHooks() {
  delete globalThis.__privateWindowStorageGet;
  delete globalThis.__privateWindowStorageSet;
  delete globalThis.__privateWindowStorageRemove;
  delete globalThis.__privateWindowTabsQuery;
  delete globalThis.__privateWindowTabsGet;
  delete globalThis.__privateWindowCreate;
}

async function waitFor(predicate, label, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("open in new window preserves a private source profile without mirroring its lineage to disk", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  t.after(removeBrowserHooks);
  const calls = installBrowserHooks({
    incognito: true,
    tabs: [{ id: 70, incognito: true }],
  });

  const result = await mod.createTrailDomain().openEntryInNewWindow(1, 7);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.windowsCreate, [{ url: endpointUrl, incognito: true }]);
  // Seed runs off the open critical path; wait for the lineage read of the new tab.
  await waitFor(() => calls.tabsGet.includes(70), "seed tabs.get for private window tab");
  assert.deepEqual(calls.tabsGet, [7, 70]);
  assert.deepEqual(calls.storageSet, []);
});

test("open in new window does not seed private lineage if the destination profile differs", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  t.after(removeBrowserHooks);
  const calls = installBrowserHooks({
    incognito: false,
    tabs: [{ id: 80, incognito: false }],
  });

  const result = await mod.createTrailDomain().openEntryInNewWindow(1, 7);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.windowsCreate, [{ url: endpointUrl, incognito: true }]);
  // Allow a microtask tick so a mistaken seed would still register.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls.tabsGet, [7]);
  assert.deepEqual(calls.storageSet, []);
});
