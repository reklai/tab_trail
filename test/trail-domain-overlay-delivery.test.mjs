import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadTrailDomain() {
  const tempDir = mkdtempSync(join(tmpdir(), "trail-domain-overlay-delivery-"));
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
              set: async () => undefined,
              remove: async () => undefined,
            };
            const event = { addListener: () => undefined };
            export default {
              storage: { session: storage, local: storage },
              tabs: {
                query: (...args) => globalThis.__trailDomainTabsQuery(...args),
                get: (...args) => globalThis.__trailDomainTabsGet(...args),
                sendMessage: (...args) => globalThis.__trailDomainSendMessage(...args),
                create: async () => ({}),
                update: async () => ({}),
                onUpdated: event,
                onRemoved: event,
              },
              scripting: {
                executeScript: (...args) => globalThis.__trailDomainExecuteScript(...args),
              },
              windows: { create: async () => ({}) },
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

function installBrowserHooks(sendMessage, executeScript = async () => undefined) {
  const calls = { sendMessage: [], get: [], executeScript: [] };
  globalThis.__trailDomainStorageGet = async () => ({});
  globalThis.__trailDomainTabsQuery = async () => [];
  globalThis.__trailDomainTabsGet = async (tabId) => {
    calls.get.push(tabId);
    return { id: tabId, url: "https://example.test/" };
  };
  globalThis.__trailDomainSendMessage = async (...args) => {
    calls.sendMessage.push(args);
    return sendMessage(...args);
  };
  globalThis.__trailDomainExecuteScript = async (details) => {
    calls.executeScript.push(details);
    return executeScript(details);
  };
  return calls;
}

function removeBrowserHooks() {
  delete globalThis.__trailDomainStorageGet;
  delete globalThis.__trailDomainTabsQuery;
  delete globalThis.__trailDomainTabsGet;
  delete globalThis.__trailDomainSendMessage;
  delete globalThis.__trailDomainExecuteScript;
}

test("an acknowledged overlay startup cancellation does not reinject or reopen it", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  t.after(removeBrowserHooks);
  const cancellation = { ok: false, reason: "Overlay startup cancelled" };
  const calls = installBrowserHooks(async () => cancellation);

  const result = await mod.createTrailDomain().toggleOverlay({ id: 7 });

  assert.deepEqual(result, cancellation);
  assert.equal(calls.sendMessage.length, 1);
  assert.deepEqual(calls.get, []);
  assert.deepEqual(calls.executeScript, []);
});

test("a TRAIL_SHOW transport failure still injects and retries delivery", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  t.after(removeBrowserHooks);
  let attempt = 0;
  const calls = installBrowserHooks(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("Receiving end does not exist");
    return { ok: true };
  });

  const requestedAtEpochMs = 12345.5;
  const result = await mod.createTrailDomain().toggleOverlay({ id: 9 }, requestedAtEpochMs);

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.sendMessage.length, 2);
  for (const [, message] of calls.sendMessage) {
    assert.equal(message.type, "TRAIL_SHOW");
    assert.equal(message.requestedAtEpochMs, requestedAtEpochMs);
  }
  assert.deepEqual(calls.get, [9]);
  assert.deepEqual(calls.executeScript, [
    {
      target: { tabId: 9, allFrames: true },
      files: ["contentScriptChord.js"],
    },
    {
      target: { tabId: 9 },
      files: ["contentScriptTop.js"],
    },
  ]);
});

test("invalid overlay timing input is omitted from content-script delivery", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  t.after(removeBrowserHooks);
  const calls = installBrowserHooks(async () => ({ ok: true }));

  const result = await mod.createTrailDomain().toggleOverlay({ id: 10 }, Number.POSITIVE_INFINITY);

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.sendMessage.length, 1);
  assert.equal("requestedAtEpochMs" in calls.sendMessage[0][1], false);
});

test("a chord-only split injection falls back to the combined top-frame host", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  t.after(removeBrowserHooks);
  let attempt = 0;
  const calls = installBrowserHooks(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("Receiving end does not exist");
    return { ok: true };
  }, async (details) => {
    if (details.files[0] === "contentScriptTop.js") {
      throw new Error("Tab navigated before top-frame injection");
    }
  });

  const result = await mod.createTrailDomain().toggleOverlay({ id: 11 });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.sendMessage.length, 2);
  assert.deepEqual(calls.executeScript, [
    {
      target: { tabId: 11, allFrames: true },
      files: ["contentScriptChord.js"],
    },
    {
      target: { tabId: 11 },
      files: ["contentScriptTop.js"],
    },
    {
      target: { tabId: 11 },
      files: ["contentScript.js"],
    },
  ]);
});

test("a chord-only injection is not treated as an overlay host when fallback fails", async (t) => {
  const { mod, cleanup } = await loadTrailDomain();
  t.after(cleanup);
  t.after(removeBrowserHooks);
  const calls = installBrowserHooks(async () => {
    throw new Error("Receiving end does not exist");
  }, async (details) => {
    if (details.files[0] !== "contentScriptChord.js") {
      throw new Error("Top-frame injection unavailable");
    }
  });

  const result = await mod.createTrailDomain().toggleOverlay({ id: 13 });

  assert.deepEqual(result, { ok: false, reason: "Overlay unavailable on this page" });
  assert.equal(calls.sendMessage.length, 1, "delivery is not retried without an overlay host");
  assert.deepEqual(
    calls.executeScript.map((details) => details.files),
    [["contentScriptChord.js"], ["contentScriptTop.js"], ["contentScript.js"]],
  );
});
