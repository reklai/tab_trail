import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadHandler() {
  const tempDir = mkdtempSync(join(tmpdir(), "private-saved-trails-"));
  const outfile = join(tempDir, "trailMessageHandler.mjs");
  await build({
    entryPoints: ["src/lib/backgroundRuntime/handlers/trailMessageHandler.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "saved-trail-handler-stubs",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^webextension-polyfill$/ }, () => ({
          path: "webextension-polyfill",
          namespace: "handler-stub",
        }));
        buildApi.onResolve({ filter: /adapters\/storage\/savedTrailsStore$/ }, () => ({
          path: "savedTrailsStore",
          namespace: "handler-stub",
        }));
        buildApi.onLoad({ filter: /^webextension-polyfill$/, namespace: "handler-stub" }, () => ({
          loader: "js",
          contents: `
            export default {
              runtime: {
                id: "tabtrail-test-extension",
                openOptionsPage: async () => undefined,
              },
              tabs: {
                sendMessage: (...args) => globalThis.__overlayFrameChallenge(...args),
              },
            };
          `,
        }));
        buildApi.onLoad({ filter: /^savedTrailsStore$/, namespace: "handler-stub" }, () => ({
          loader: "js",
          contents: `
            const call = (operation, args) => globalThis.__savedTrailStoreCall(operation, args);
            export const saveCapturedTrail = (...args) => call("save", args);
            export const renameSavedTrail = (...args) => call("rename", args);
            export const replaceSavedTrail = (...args) => call("replace", args);
            export const setSavedTrailPinned = (...args) => call("pin", args);
            export const deleteSavedTrail = (...args) => call("delete", args);
            export const restoreSavedTrail = (...args) => call("restore", args);
          `,
        }));
      },
    }],
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return { mod, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
}

const mutationMessages = [
  { type: "SAVED_TRAIL_SAVE", path: [], name: "Private path" },
  { type: "SAVED_TRAIL_RENAME", id: "trail", name: "Renamed" },
  { type: "SAVED_TRAIL_REPLACE", id: "trail", path: [] },
  { type: "SAVED_TRAIL_SET_PINNED", id: "trail", pinned: true },
  { type: "SAVED_TRAIL_DELETE", id: "trail" },
  { type: "SAVED_TRAIL_RESTORE", trail: { id: "trail", entries: [] } },
];

test("private tabs cannot persist or mutate saved trails", async (t) => {
  const { mod, cleanup } = await loadHandler();
  t.after(cleanup);
  const storeCalls = [];
  globalThis.__savedTrailStoreCall = async (operation, args) => {
    storeCalls.push([operation, args]);
    return { ok: true };
  };
  t.after(() => delete globalThis.__savedTrailStoreCall);

  // An unresolved migration proves the privacy rejection occurs before any
  // storage readiness wait as well as before the store call.
  const neverReady = new Promise(() => undefined);
  const handler = mod.createTrailMessageHandler({}, neverReady);
  const blocked = await Promise.race([
    Promise.all(mutationMessages.map((message) => handler(message, {
      tab: { id: 7, incognito: true },
    }))),
    new Promise((resolve) => setTimeout(() => resolve("timed out"), 100)),
  ]);

  assert.notEqual(blocked, "timed out");
  assert.deepEqual(
    blocked,
    mutationMessages.map(() => ({
      ok: false,
      reason: mod.PRIVATE_SAVED_TRAILS_REASON,
    })),
  );
  assert.equal(
    mod.PRIVATE_SAVED_TRAILS_REASON,
    "Saved trails can't be saved or changed in private browsing",
  );
  assert.deepEqual(storeCalls, []);
});

test("regular tabs retain saved-trail mutations", async (t) => {
  const { mod, cleanup } = await loadHandler();
  t.after(cleanup);
  const storeCalls = [];
  globalThis.__savedTrailStoreCall = async (operation, args) => {
    storeCalls.push([operation, args]);
    return { ok: true };
  };
  t.after(() => delete globalThis.__savedTrailStoreCall);

  const handler = mod.createTrailMessageHandler({}, Promise.resolve());
  assert.deepEqual(
    await handler(mutationMessages[0], { tab: { id: 8, incognito: false } }),
    { ok: true },
  );
  assert.deepEqual(storeCalls.map(([operation]) => operation), ["save"]);
});

test("opening an already supplied saved path remains non-durable in private tabs", async (t) => {
  const { mod, cleanup } = await loadHandler();
  t.after(cleanup);
  const calls = [];
  globalThis.__savedTrailStoreCall = async () => {
    throw new Error("saved-trail open must not touch storage");
  };
  t.after(() => delete globalThis.__savedTrailStoreCall);

  const domain = {
    openSavedTrail: async (...args) => {
      calls.push(args);
      return { ok: true };
    },
  };
  const handler = mod.createTrailMessageHandler(domain, new Promise(() => undefined));
  const path = [{ url: "https://saved.test/" }];
  assert.deepEqual(
    await handler(
      { type: "SAVED_TRAIL_OPEN", path, mode: "current" },
      { tab: { id: 9, incognito: true } },
    ),
    { ok: true },
  );
  assert.deepEqual(calls, [[path, "current", { id: 9, incognito: true }]]);
});

test("only an extension overlay subframe can claim a host nonce", async (t) => {
  const { mod, cleanup } = await loadHandler();
  t.after(cleanup);
  globalThis.__savedTrailStoreCall = async () => ({ ok: true });
  const challenges = [];
  globalThis.__overlayFrameChallenge = async (...args) => {
    challenges.push(args);
    return { ok: true };
  };
  t.after(() => {
    delete globalThis.__savedTrailStoreCall;
    delete globalThis.__overlayFrameChallenge;
  });

  const handler = mod.createTrailMessageHandler({});
  const nonce = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(await handler(
    { type: "OVERLAY_FRAME_CLAIM", nonce },
    {
      id: "tabtrail-test-extension",
      frameId: 4,
      url: "moz-extension://randomized-origin/overlayFrame/overlayFrame.html",
      tab: { id: 31, incognito: false },
    },
  ), { ok: true });
  assert.deepEqual(challenges, [[
    31,
    { type: "OVERLAY_FRAME_CHALLENGE", nonce },
    { frameId: 0 },
  ]]);

  for (const sender of [
    {
      id: "host-page",
      frameId: 4,
      url: "https://example.test/overlayFrame/overlayFrame.html",
      tab: { id: 31 },
    },
    {
      id: "tabtrail-test-extension",
      frameId: 0,
      url: "moz-extension://randomized-origin/overlayFrame/overlayFrame.html",
      tab: { id: 31 },
    },
  ]) {
    assert.equal((await handler(
      { type: "OVERLAY_FRAME_CLAIM", nonce },
      sender,
    )).ok, false);
  }
  assert.equal(challenges.length, 1);
});
