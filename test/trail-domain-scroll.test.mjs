import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadTrailDomain() {
  const tempDir = mkdtempSync(join(tmpdir(), "trail-domain-scroll-"));
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
              get: (...args) => globalThis.__trailScrollStorageGet(...args),
              set: (...args) => globalThis.__trailScrollStorageSet(...args),
              remove: async () => undefined,
            };
            const event = { addListener: () => undefined };
            const capture = (name) => ({
              addListener: (fn) => {
                globalThis.__trailScrollNavListeners =
                  globalThis.__trailScrollNavListeners || {};
                globalThis.__trailScrollNavListeners[name] = fn;
              },
            });
            export default {
              storage: { session: storage, local: storage },
              tabs: {
                query: (...args) => globalThis.__trailScrollTabsQuery(...args),
                get: (...args) => globalThis.__trailScrollTabsGet(...args),
                sendMessage: (...args) => globalThis.__trailScrollSendMessage(...args),
                create: (...args) => globalThis.__trailScrollTabsCreate(...args),
                update: (...args) => globalThis.__trailScrollTabsUpdate(...args),
                onUpdated: event,
                onRemoved: event,
              },
              scripting: {
                executeScript: (...args) => globalThis.__trailScrollExecuteScript(...args),
              },
              windows: {
                create: (...args) => globalThis.__trailScrollWindowsCreate(...args),
              },
              webNavigation: {
                onCommitted: capture("onCommitted"),
                onHistoryStateUpdated: capture("onHistoryStateUpdated"),
                onReferenceFragmentUpdated: capture("onReferenceFragmentUpdated"),
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

function entry(url, title = url, viewport) {
  return {
    url,
    title,
    favIconUrl: "",
    timestamp: 1,
    transition: "link",
    redirected: false,
    historyBacked: true,
    ...(viewport ? { viewport } : {}),
  };
}

function installHooks(options = {}) {
  const calls = {
    create: [],
    update: [],
    sendMessage: [],
    storageSet: [],
    executeScript: [],
    windowsCreate: [],
  };
  const mirror = options.mirror || {};

  globalThis.__trailScrollStorageGet = async (keys) => {
    if (keys === null) return { ...mirror };
    if (typeof keys === "string") {
      return keys in mirror ? { [keys]: mirror[keys] } : {};
    }
    if (Array.isArray(keys)) {
      const out = {};
      for (const key of keys) {
        if (key in mirror) out[key] = mirror[key];
      }
      return out;
    }
    return {};
  };
  globalThis.__trailScrollStorageSet = async (items) => {
    calls.storageSet.push(items);
    Object.assign(mirror, items);
  };
  globalThis.__trailScrollTabsQuery = async () => options.tabs || [];
  globalThis.__trailScrollTabsGet = async (tabId) => {
    const found = (options.tabs || []).find((tab) => tab.id === tabId);
    return found || {
      id: tabId,
      url: options.defaultUrl || "https://a.test/",
      index: 0,
      windowId: 1,
      incognito: false,
    };
  };
  globalThis.__trailScrollSendMessage = async (tabId, message, details) => {
    calls.sendMessage.push({ tabId, message, details });
    if (typeof options.sendMessage === "function") {
      return options.sendMessage(tabId, message, details, calls);
    }
    if (message?.type === "TRAIL_RESTORE_SCROLL") {
      return options.restoreResponse ?? { ok: true };
    }
    if (message?.type === "HISTORY_GO") return { ok: true };
    return undefined;
  };
  globalThis.__trailScrollTabsCreate = async (details) => {
    calls.create.push(details);
    return { id: options.createdTabId ?? 77, ...details };
  };
  globalThis.__trailScrollTabsUpdate = async (tabId, details) => {
    calls.update.push({ tabId, details });
    return { id: tabId };
  };
  globalThis.__trailScrollExecuteScript = async (...args) => {
    calls.executeScript.push(args);
  };
  globalThis.__trailScrollWindowsCreate = async (details) => {
    calls.windowsCreate.push(details);
    return {
      incognito: details.incognito === true,
      tabs: [{ id: options.windowTabId ?? 88 }],
    };
  };

  return {
    calls,
    mirror,
    cleanup: () => {
      delete globalThis.__trailScrollStorageGet;
      delete globalThis.__trailScrollStorageSet;
      delete globalThis.__trailScrollTabsQuery;
      delete globalThis.__trailScrollTabsGet;
      delete globalThis.__trailScrollSendMessage;
      delete globalThis.__trailScrollTabsCreate;
      delete globalThis.__trailScrollTabsUpdate;
      delete globalThis.__trailScrollExecuteScript;
      delete globalThis.__trailScrollWindowsCreate;
      delete globalThis.__trailScrollNavListeners;
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("applyScrollReport patches cursor viewport and coalesces mirror writes", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  const trailState = {
    entries: [entry("https://a.test/", "A")],
    cursor: 0,
  };
  const hooks = installHooks({
    mirror: { "tabtrailTrail:5": trailState },
    tabs: [{ id: 5, url: "https://a.test/", incognito: false }],
  });
  t.after(hooks.cleanup);

  const domain = mod.createTrailDomain();
  await domain.ensureLoaded();

  // Space reports past the 100ms wall-clock throttle so each applies in memory.
  for (let y = 100; y <= 500; y += 100) {
    domain.applyScrollReport(5, "https://a.test/", { x: 0, y, root: "document" });
    await sleep(120);
  }
  // Coalesce window is 750ms — wait for one flush after the last report.
  await sleep(900);

  const viewportWrites = hooks.calls.storageSet.filter(
    (items) => items["tabtrailTrail:5"]?.entries?.[0]?.viewport,
  );
  assert.ok(viewportWrites.length >= 1);
  assert.ok(
    viewportWrites.length < 5,
    `continuous reports must coalesce mirror writes, got ${viewportWrites.length}`,
  );
  assert.equal(viewportWrites.at(-1)["tabtrailTrail:5"].entries[0].viewport.y, 500);

  // URL mismatch is dropped.
  const before = hooks.calls.storageSet.length;
  domain.applyScrollReport(5, "https://other.test/", { x: 0, y: 999, root: "document" });
  await sleep(50);
  assert.equal(hooks.calls.storageSet.length, before);
});

test("openSavedTrail new-tab arms restore on created.id with force mode", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  let restoreResponses = [
    { ok: false, reason: "url-mismatch" },
    { ok: false, reason: "url-mismatch" },
    { ok: true },
  ];
  const hooks = installHooks({
    createdTabId: 42,
    sendMessage: async (tabId, message) => {
      if (message?.type !== "TRAIL_RESTORE_SCROLL") return undefined;
      assert.equal(tabId, 42, "restore must target created tab, not source");
      assert.equal(message.mode, "force");
      assert.equal(message.url, "https://end.test/");
      assert.equal(message.viewport.y, 1200);
      return restoreResponses.shift() ?? { ok: true };
    },
  });
  t.after(hooks.cleanup);

  const domain = mod.createTrailDomain();
  const path = [
    entry("https://a.test/", "A", { x: 0, y: 10, root: "document" }),
    entry("https://end.test/", "End", { x: 0, y: 1200, root: "document" }),
  ];
  const result = await domain.openSavedTrail(path, "new", {
    id: 3,
    index: 1,
    windowId: 2,
    incognito: false,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(hooks.calls.create[0].url, "https://end.test/");

  // Proactive ladder should keep trying until acceptance.
  await sleep(600);
  const restores = hooks.calls.sendMessage.filter((c) => c.message.type === "TRAIL_RESTORE_SCROLL");
  assert.ok(restores.length >= 2);
  assert.ok(restores.every((c) => c.tabId === 42));
});

test("openSavedTrail current-tab arms force pending before tabs.update", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  const order = [];
  const hooks = installHooks({
    sendMessage: async (tabId, message) => {
      if (message?.type === "TRAIL_RESTORE_SCROLL") {
        order.push("restore");
        return { ok: true };
      }
      return undefined;
    },
  });
  const originalUpdate = globalThis.__trailScrollTabsUpdate;
  globalThis.__trailScrollTabsUpdate = async (tabId, details) => {
    order.push("update");
    return originalUpdate(tabId, details);
  };
  t.after(hooks.cleanup);

  const domain = mod.createTrailDomain();
  const path = [
    entry("https://end.test/", "End", { x: 5, y: 900, root: "document" }),
  ];
  await domain.openSavedTrail(path, "current", {
    id: 11,
    url: "https://old.test/",
    incognito: false,
  });
  await sleep(100);
  assert.ok(order.includes("update"));
  const restores = hooks.calls.sendMessage.filter((c) => c.message.type === "TRAIL_RESTORE_SCROLL");
  assert.ok(restores.length >= 1);
  assert.equal(restores[0].tabId, 11);
  assert.equal(restores[0].message.mode, "force");
});

test("jumpTo historyGo uses corrective mode; navigate uses force", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  const trailState = {
    entries: [
      entry("https://a.test/", "A", { x: 0, y: 100, root: "document" }),
      entry("https://b.test/", "B", { x: 0, y: 200, root: "document" }),
      entry("https://c.test/", "C", { x: 0, y: 300, root: "document" }),
    ],
    cursor: 2,
  };
  const hooks = installHooks({
    mirror: { "tabtrailTrail:9": trailState },
    tabs: [{ id: 9, url: "https://c.test/", incognito: false }],
  });
  t.after(hooks.cleanup);

  const domain = mod.createTrailDomain();
  await domain.ensureLoaded();

  await domain.jumpTo(0, 9);
  await sleep(50);
  // historyGo path: HISTORY_GO sent; restore is corrective when pending is armed.
  const historyGo = hooks.calls.sendMessage.find((c) => c.message.type === "HISTORY_GO");
  assert.ok(historyGo);
  assert.equal(historyGo.message.delta, -2);

  // Land the historyGo jump so pending dispatches with corrective mode.
  hooks.calls.sendMessage.length = 0;
  domain.registerLifecycleListeners();
  const onCommitted = globalThis.__trailScrollNavListeners?.onCommitted;
  assert.ok(typeof onCommitted === "function");
  onCommitted({
    tabId: 9,
    frameId: 0,
    url: "https://a.test/",
    timeStamp: Date.now(),
    transitionType: "link",
    transitionQualifiers: ["forward_back"],
  });
  await sleep(50);
  const corrective = hooks.calls.sendMessage.filter(
    (c) => c.message.type === "TRAIL_RESTORE_SCROLL",
  );
  assert.ok(corrective.some((c) => c.message.mode === "corrective"));
  assert.ok(corrective.some((c) => c.message.viewport.y === 100));
});

test("jumpTo navigate path dispatches force restore after tabs.update", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  // Redirected middle edge forces navigate plan.
  const trailState = {
    entries: [
      entry("https://a.test/", "A", { x: 0, y: 111, root: "document" }),
      {
        ...entry("https://b.test/", "B", { x: 0, y: 222, root: "document" }),
        redirected: true,
      },
      entry("https://c.test/", "C", { x: 0, y: 333, root: "document" }),
    ],
    cursor: 2,
  };
  const hooks = installHooks({
    mirror: { "tabtrailTrail:12": trailState },
    tabs: [{ id: 12, url: "https://c.test/", incognito: false }],
  });
  t.after(hooks.cleanup);

  const domain = mod.createTrailDomain();
  await domain.ensureLoaded();
  await domain.jumpTo(0, 12);
  await sleep(50);
  assert.equal(hooks.calls.update.length, 1);
  assert.equal(hooks.calls.update[0].details.url, "https://a.test/");
  const restores = hooks.calls.sendMessage.filter(
    (c) => c.message.type === "TRAIL_RESTORE_SCROLL",
  );
  assert.ok(restores.some((c) => c.message.mode === "force" && c.message.viewport.y === 111));
});

test("flush:true writes mirror immediately without waiting for coalesce", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  const trailState = {
    entries: [entry("https://a.test/", "A")],
    cursor: 0,
  };
  const hooks = installHooks({
    mirror: { "tabtrailTrail:6": trailState },
    tabs: [{ id: 6, url: "https://a.test/", incognito: false }],
  });
  t.after(hooks.cleanup);

  const domain = mod.createTrailDomain();
  await domain.ensureLoaded();
  domain.applyScrollReport(
    6,
    "https://a.test/",
    { x: 0, y: 640, root: "document" },
    { flush: true },
  );
  // Immediate path should write well before the 750ms coalesce window.
  await sleep(80);
  const writes = hooks.calls.storageSet.filter(
    (items) => items["tabtrailTrail:6"]?.entries?.[0]?.viewport?.y === 640,
  );
  assert.ok(writes.length >= 1, "flush should mirror immediately");
});

test("browser forward_back synthesizes corrective pending when entry has viewport", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  const trailState = {
    entries: [
      entry("https://a.test/", "A", { x: 0, y: 50, root: "document" }),
      entry("https://b.test/", "B", { x: 0, y: 250, root: "document" }),
    ],
    cursor: 1,
  };
  const hooks = installHooks({
    mirror: { "tabtrailTrail:15": trailState },
    tabs: [{ id: 15, url: "https://b.test/", incognito: false }],
  });
  t.after(hooks.cleanup);

  const domain = mod.createTrailDomain();
  await domain.ensureLoaded();
  domain.registerLifecycleListeners();
  const onCommitted = globalThis.__trailScrollNavListeners?.onCommitted;
  assert.ok(typeof onCommitted === "function");

  onCommitted({
    tabId: 15,
    frameId: 0,
    url: "https://a.test/",
    timeStamp: Date.now(),
    transitionType: "link",
    transitionQualifiers: ["forward_back"],
  });
  await sleep(80);
  const restores = hooks.calls.sendMessage.filter(
    (c) => c.message.type === "TRAIL_RESTORE_SCROLL",
  );
  assert.ok(
    restores.some(
      (c) =>
        c.tabId === 15 &&
        c.message.mode === "corrective" &&
        c.message.viewport.y === 50 &&
        c.message.url === "https://a.test/",
    ),
    `expected corrective restore for forward_back, got ${JSON.stringify(restores)}`,
  );
});

test("bare sendMessage resolve without ok does not clear pending; inject retries", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  let attempt = 0;
  const hooks = installHooks({
    createdTabId: 55,
    sendMessage: async (tabId, message) => {
      if (message?.type !== "TRAIL_RESTORE_SCROLL") return undefined;
      attempt += 1;
      if (attempt === 1) {
        // Transport succeeds but no acceptance (undefined response).
        return undefined;
      }
      if (attempt === 2) {
        return { ok: false, reason: "not-ready" };
      }
      return { ok: true };
    },
  });
  t.after(hooks.cleanup);

  const domain = mod.createTrailDomain();
  await domain.openSavedTrail(
    [entry("https://end.test/", "End", { x: 0, y: 50, root: "document" })],
    "new",
    { id: 1, index: 0, windowId: 1, incognito: false },
  );
  await sleep(700);
  assert.ok(attempt >= 2, "must keep dispatching until accepted");
  const restores = hooks.calls.sendMessage.filter((c) => c.message.type === "TRAIL_RESTORE_SCROLL");
  assert.ok(restores.every((c) => c.tabId === 55));
});

test("openEntryInNewWindow arms force restore on seeded tab", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  const trailState = {
    entries: [
      entry("https://a.test/", "A", { x: 0, y: 10, root: "document" }),
      entry("https://b.test/", "B", { x: 0, y: 777, root: "document" }),
    ],
    cursor: 1,
  };
  const hooks = installHooks({
    mirror: { "tabtrailTrail:7": trailState },
    tabs: [{ id: 7, url: "https://b.test/", incognito: false, index: 0, windowId: 1 }],
    windowTabId: 99,
  });
  t.after(hooks.cleanup);

  const domain = mod.createTrailDomain();
  await domain.ensureLoaded();
  const result = await domain.openEntryInNewWindow(1, 7, {
    id: 7,
    url: "https://b.test/",
    incognito: false,
  });
  assert.deepEqual(result, { ok: true });
  await sleep(100);
  const restores = hooks.calls.sendMessage.filter((c) => c.message.type === "TRAIL_RESTORE_SCROLL");
  assert.ok(restores.some((c) => c.tabId === 99 && c.message.mode === "force"));
  assert.ok(restores.some((c) => c.message.viewport.y === 777));
});
