import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadTrailDomain() {
  const tempDir = mkdtempSync(join(tmpdir(), "trail-domain-open-throughput-"));
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
            const storage = {
              get: (...args) => globalThis.__trailDomainStorageGet(...args),
              set: (...args) => globalThis.__trailDomainStorageSet(...args),
              remove: async () => undefined,
            };
            const event = { addListener: () => undefined };
            export default {
              storage: { session: storage, local: storage },
              tabs: {
                query: (...args) => globalThis.__trailDomainTabsQuery(...args),
                get: (...args) => globalThis.__trailDomainTabsGet(...args),
                sendMessage: async () => undefined,
                create: (...args) => globalThis.__trailDomainTabsCreate(...args),
                update: (...args) => globalThis.__trailDomainTabsUpdate(...args),
                onUpdated: event,
                onRemoved: event,
              },
              scripting: { executeScript: async () => undefined },
              windows: {
                create: (...args) => globalThis.__trailDomainWindowsCreate(...args),
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

function entry(url, title = url) {
  return {
    url,
    title,
    favIconUrl: "",
    timestamp: 1,
    transition: "link",
    redirected: false,
    historyBacked: true,
  };
}

function installHooks() {
  const calls = {
    create: [],
    update: [],
    get: [],
    storageGet: [],
    storageSet: [],
    windowsCreate: [],
  };
  let seedResolve;
  const seedGate = new Promise((resolve) => {
    seedResolve = resolve;
  });

  globalThis.__trailDomainStorageGet = async (keys) => {
    calls.storageGet.push(keys);
    // Hold the full rehydrate path if someone requests null (all keys).
    if (keys === null) {
      await seedGate;
      return {};
    }
    return {};
  };
  globalThis.__trailDomainStorageSet = async (items) => {
    calls.storageSet.push(items);
  };
  globalThis.__trailDomainTabsQuery = async () => {
    await seedGate;
    return [];
  };
  globalThis.__trailDomainTabsGet = async (tabId) => {
    calls.get.push(tabId);
    return {
      id: tabId,
      url: "https://source.test/",
      index: 2,
      windowId: 9,
      incognito: false,
    };
  };
  globalThis.__trailDomainTabsCreate = async (details) => {
    calls.create.push(details);
    return { id: 77, ...details };
  };
  globalThis.__trailDomainTabsUpdate = async (tabId, details) => {
    calls.update.push({ tabId, details });
    return { id: tabId };
  };
  globalThis.__trailDomainWindowsCreate = async (details) => {
    calls.windowsCreate.push(details);
    return { incognito: false, tabs: [{ id: 88 }] };
  };

  return {
    calls,
    releaseRehydrate: () => seedResolve(),
    cleanup: () => {
      delete globalThis.__trailDomainStorageGet;
      delete globalThis.__trailDomainStorageSet;
      delete globalThis.__trailDomainTabsQuery;
      delete globalThis.__trailDomainTabsGet;
      delete globalThis.__trailDomainTabsCreate;
      delete globalThis.__trailDomainTabsUpdate;
      delete globalThis.__trailDomainWindowsCreate;
    },
  };
}

test("openSavedTrail new-tab creates immediately without awaiting seed mirror writes", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  const hooks = installHooks();
  t.after(hooks.cleanup);

  // Leave rehydrate blocked — openSavedTrail should not wait on it.
  const domain = mod.createTrailDomain();
  const path = [
    entry("https://a.test/", "A"),
    entry("https://b.test/", "B"),
  ];

  const resultPromise = domain.openSavedTrail(path, "new", {
    id: 3,
    index: 1,
    windowId: 2,
    incognito: false,
  });

  // Must settle without releasing the rehydrate gate.
  const result = await Promise.race([
    resultPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("openSavedTrail blocked on rehydrate")), 200),
    ),
  ]);
  assert.deepEqual(result, { ok: true });
  assert.equal(hooks.calls.create.length, 1);
  assert.equal(hooks.calls.create[0].url, "https://b.test/");
  assert.equal(hooks.calls.create[0].active, true);

  // Seed may schedule storage later; release rehydrate so pending work finishes cleanly.
  hooks.releaseRehydrate();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("openSavedTrail current-tab updates before seed bookkeeping completes", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  const hooks = installHooks();
  t.after(hooks.cleanup);

  const domain = mod.createTrailDomain();
  const path = [entry("https://endpoint.test/", "End")];
  const resultPromise = domain.openSavedTrail(path, "current", {
    id: 11,
    url: "https://old.test/",
    incognito: false,
  });

  const result = await Promise.race([
    resultPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("openSavedTrail current blocked on rehydrate")), 200),
    ),
  ]);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(hooks.calls.update, [{
    tabId: 11,
    details: { url: "https://endpoint.test/" },
  }]);
  hooks.releaseRehydrate();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("openEntryInNewTab uses senderTab and skips tabs.get when ids match", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  const hooks = installHooks();
  t.after(hooks.cleanup);

  // Put trail in memory by releasing rehydrate and writing via storage fast path:
  // ensureTabTrail reads single key — return a trail for tab 4.
  const trailState = {
    entries: [
      entry("https://one.test/", "One"),
      entry("https://two.test/", "Two"),
    ],
    cursor: 1,
  };
  globalThis.__trailDomainStorageGet = async (keys) => {
    hooks.calls.storageGet.push(keys);
    if (keys === "tabtrailTrail:4" || (typeof keys === "string" && keys.includes("4"))) {
      return { "tabtrailTrail:4": trailState };
    }
    if (Array.isArray(keys) && keys.includes("tabtrailTrail:4")) {
      return { "tabtrailTrail:4": trailState };
    }
    if (keys === null) {
      await new Promise(() => {});
      return {};
    }
    return {};
  };

  const domain = mod.createTrailDomain();
  const sender = {
    id: 4,
    index: 0,
    windowId: 1,
    incognito: false,
    url: "https://two.test/",
  };
  const result = await domain.openEntryInNewTab(0, undefined, sender);
  assert.deepEqual(result, { ok: true });
  assert.equal(hooks.calls.create.length, 1);
  assert.equal(hooks.calls.create[0].url, "https://one.test/");
  assert.equal(hooks.calls.get.length, 0, "should not tabs.get when sender matches");
  hooks.releaseRehydrate();
});
