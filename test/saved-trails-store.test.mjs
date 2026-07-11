import test from "node:test";
import assert from "node:assert/strict";
import { loadTsModule } from "./helpers/loadTsModule.mjs";

let storePromise = null;

function loadStoreModule() {
  if (!storePromise) {
    // Bundle so trailCore + storage key imports resolve under the test loader.
    storePromise = (async () => {
      const { build } = await import("esbuild");
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const { pathToFileURL } = await import("node:url");
      const tempDir = mkdtempSync(join(tmpdir(), "saved-trails-store-"));
      const outfile = join(tempDir, "savedTrailsStore.mjs");
      await build({
        entryPoints: ["src/lib/adapters/storage/savedTrailsStore.ts"],
        bundle: true,
        format: "esm",
        platform: "node",
        target: "es2022",
        outfile,
        logLevel: "silent",
        // Stub polyfill: in-memory local storage for the store.
        plugins: [{
          name: "stub-polyfill",
          setup(buildApi) {
            buildApi.onResolve({ filter: /^webextension-polyfill$/ }, () => ({
              path: "webextension-polyfill",
              namespace: "stub",
            }));
            buildApi.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
              contents: `
                  if (!globalThis.__tabtrailTestStorage) globalThis.__tabtrailTestStorage = {};
                  export default {
                    storage: {
                      local: {
                        async get(key) {
                          globalThis.__tabtrailTestGetCalls =
                            (globalThis.__tabtrailTestGetCalls || 0) + 1;
                          if (globalThis.__tabtrailTestGetError) {
                            throw globalThis.__tabtrailTestGetError;
                          }
                          if (globalThis.__tabtrailTestGetGate) {
                            await globalThis.__tabtrailTestGetGate;
                          }
                          const memory = globalThis.__tabtrailTestStorage;
                          const k = typeof key === "string" ? key : Object.keys(key || {})[0];
                          return { [k]: memory[k] };
                        },
                        async set(items) {
                          if (globalThis.__tabtrailTestSetError) {
                            throw globalThis.__tabtrailTestSetError;
                          }
                          Object.assign(globalThis.__tabtrailTestStorage, items);
                        },
                      },
                    },
                  };
                `,
              loader: "js",
            }));
          },
        }],
      });
      const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
      // Reset shared memory between tests via global.
      globalThis.__tabtrailTestStorage = {};
      return { mod, tempDir, rmSync };
    })();
  }
  return storePromise;
}

function sampleState(urls) {
  return {
    entries: urls.map((url, index) => ({
      url,
      title: `T${index}`,
      favIconUrl: "",
      timestamp: 1000 + index,
      transition: "link",
      redirected: false,
      historyBacked: true,
    })),
    cursor: urls.length - 1,
  };
}

function resetStorage() {
  globalThis.__tabtrailTestStorage = {};
  globalThis.__tabtrailTestGetCalls = 0;
  globalThis.__tabtrailTestGetError = null;
  globalThis.__tabtrailTestGetGate = null;
  globalThis.__tabtrailTestSetError = null;
}

test("saveTrailFromPath persists a named path and rejects duplicate names", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const state = sampleState(["https://a.test/", "https://b.test/"]);

  const first = await mod.saveTrailFromPath(state, 1, "My Path");
  assert.equal(first.ok, true);
  assert.equal(first.trail.entries.length, 2);
  assert.equal(first.trails.length, 1);

  const dup = await mod.saveTrailFromPath(sampleState(["https://other.test/"]), 0, "my path");
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /already exists/i);

  const empty = await mod.saveTrailFromPath(state, 0, "   ");
  assert.equal(empty.ok, false);

  const loaded = await mod.loadSavedTrails();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, "My Path");
});

test("save rejects equivalent paths but permits prefixes and structural differences", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const path = sampleState([
    "https://a.test/?mode=full#start",
    "https://b.test/end",
  ]).entries;
  const saved = await mod.saveCapturedTrail(path, "Original");
  assert.equal(saved.ok, true);

  const cosmeticVariant = path.map((entry, index) => ({
    ...entry,
    title: `Changed ${index}`,
    favIconUrl: `https://icons.test/${index}.png`,
    timestamp: entry.timestamp + 100,
    redirected: true,
  }));
  const equivalent = await mod.saveCapturedTrail(cosmeticVariant, "Cosmetic copy");
  assert.deepEqual(equivalent, {
    ok: false,
    reason: "This trail path is already saved as “Original”",
  });
  const pathAndNameConflict = await mod.saveCapturedTrail(cosmeticVariant, "original");
  assert.deepEqual(pathAndNameConflict, {
    ok: false,
    reason: "This trail path is already saved as “Original”",
  });

  assert.equal((await mod.saveCapturedTrail(path.slice(0, 1), "Prefix")).ok, true);
  assert.equal((await mod.saveCapturedTrail([
    { ...path[0], url: "https://a.test/?mode=compact#start" },
    path[1],
  ], "Query variant")).ok, true);
  assert.equal((await mod.saveCapturedTrail([
    { ...path[0], url: "https://a.test/?mode=full#other" },
    path[1],
  ], "Hash variant")).ok, true);
  assert.equal((await mod.saveCapturedTrail([...path].reverse(), "Reverse order")).ok, true);
  assert.equal((await mod.saveCapturedTrail([
    path[0],
    { ...path[1], transition: "typed" },
  ], "Transition variant")).ok, true);
  assert.equal((await mod.saveCapturedTrail([
    path[0],
    { ...path[1], historyBacked: false },
  ], "History variant")).ok, true);
});

test("deleteSavedTrail removes by id", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const state = sampleState(["https://a.test/"]);
  const saved = await mod.saveTrailFromPath(state, 0, "Delete Me");
  assert.equal(saved.ok, true);
  assert.equal((await mod.loadSavedTrails()).length, 1);
  const deleted = await mod.deleteSavedTrail(saved.trail.id);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.trail.name, "Delete Me");
  assert.equal(deleted.trails.length, 0);
  assert.equal((await mod.loadSavedTrails()).length, 0);
});

test("rename composes from the authoritative record and unchanged names are no-ops", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const saved = await mod.saveTrailFromPath(
    sampleState(["https://a.test/", "https://b.test/"]),
    1,
    "Original",
  );
  const pinned = await mod.setSavedTrailPinned(saved.trail.id, true);
  assert.equal(pinned.ok, true);
  const renamed = await mod.renameSavedTrail(saved.trail.id, "  Renamed  ");
  assert.equal(renamed.ok, true);
  assert.equal(renamed.trail.name, "Renamed");
  assert.equal(renamed.trail.pinned, true);
  assert.equal(renamed.trail.entries.length, 2);
  assert.ok(renamed.trail.updatedAt > saved.trail.updatedAt);

  const unchanged = await mod.renameSavedTrail(saved.trail.id, "Renamed");
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.trail.updatedAt, renamed.trail.updatedAt);

  await mod.saveTrailFromPath(sampleState(["https://other.test/"]), 0, "Other");
  const conflict = await mod.renameSavedTrail(saved.trail.id, "other");
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /already exists/i);
});

test("replace returns the previous snapshot, supports CAS undo, and preserves other fields", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const saved = await mod.saveTrailFromPath(sampleState(["https://old.test/"]), 0, "Path");
  await mod.renameSavedTrail(saved.trail.id, "Renamed");
  await mod.setSavedTrailPinned(saved.trail.id, true);

  const captured = sampleState(["https://new.test/", "https://end.test/"]).entries;
  const replacing = mod.replaceSavedTrail(saved.trail.id, captured, saved.trail.entries);
  captured[0].url = "https://mutated-after-call.test/";
  const replaced = await replacing;
  assert.equal(replaced.ok, true);
  assert.equal(replaced.trail.name, "Renamed");
  assert.equal(replaced.trail.pinned, true);
  assert.deepEqual(
    replaced.trail.entries.map((entry) => entry.url),
    ["https://new.test/", "https://end.test/"],
  );
  assert.deepEqual(replaced.previousTrail.entries, saved.trail.entries);

  const stale = await mod.replaceSavedTrail(
    saved.trail.id,
    sampleState(["https://stale.test/"]).entries,
    saved.trail.entries,
  );
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /changed/i);

  await mod.renameSavedTrail(saved.trail.id, "Renamed Again");
  await mod.setSavedTrailPinned(saved.trail.id, false);
  const undo = await mod.replaceSavedTrail(
    saved.trail.id,
    replaced.previousTrail.entries,
    replaced.trail.entries,
  );
  assert.equal(undo.ok, true);
  assert.equal(undo.trail.name, "Renamed Again");
  assert.equal(undo.trail.pinned, false);
  assert.deepEqual(undo.trail.entries, saved.trail.entries);
});

test("replace rejects another trail path but permits target-equivalent metadata updates", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const first = await mod.saveTrailFromPath(sampleState(["https://first.test/"]), 0, "First");
  const second = await mod.saveTrailFromPath(sampleState(["https://second.test/"]), 0, "Second");

  const metadataUpdate = first.trail.entries.map((entry) => ({
    ...entry,
    title: "Refreshed title",
    favIconUrl: "https://first.test/favicon.png",
    timestamp: entry.timestamp + 500,
    redirected: true,
  }));
  const updated = await mod.replaceSavedTrail(first.trail.id, metadataUpdate);
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.trail.entries, metadataUpdate);

  const collision = await mod.replaceSavedTrail(first.trail.id, second.trail.entries);
  assert.deepEqual(collision, {
    ok: false,
    reason: "This trail path is already saved as “Second”",
  });
});

test("replace preserves grandfathered duplicate identities", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const sharedPath = sampleState(["https://legacy.test/"]).entries;
  const otherPath = sampleState(["https://other.test/"]).entries;
  globalThis.__tabtrailTestStorage.tabtrailSavedTrails = [
    {
      id: "legacy-a",
      name: "Legacy A",
      pinned: false,
      createdAt: 100,
      updatedAt: 300,
      entries: sharedPath,
    },
    {
      id: "legacy-b",
      name: "Legacy B",
      pinned: false,
      createdAt: 100,
      updatedAt: 200,
      entries: sharedPath,
    },
    {
      id: "other",
      name: "Other",
      pinned: false,
      createdAt: 100,
      updatedAt: 100,
      entries: otherPath,
    },
  ];

  const metadataUpdate = sharedPath.map((entry) => ({ ...entry, title: "Updated" }));
  const retained = await mod.replaceSavedTrail("legacy-a", metadataUpdate);
  assert.equal(retained.ok, true);
  assert.equal(retained.trails.length, 3);
  assert.deepEqual(retained.trail.entries, metadataUpdate);

  const collision = await mod.replaceSavedTrail("legacy-a", otherPath);
  assert.deepEqual(collision, {
    ok: false,
    reason: "This trail path is already saved as “Other”",
  });
});

test("replace no-op and pin changes preserve updatedAt", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const saved = await mod.saveTrailFromPath(sampleState(["https://a.test/"]), 0, "Stable");
  const replaced = await mod.replaceSavedTrail(saved.trail.id, saved.trail.entries);
  assert.equal(replaced.ok, true);
  assert.equal(replaced.trail.updatedAt, saved.trail.updatedAt);
  const pinned = await mod.setSavedTrailPinned(saved.trail.id, true);
  assert.equal(pinned.ok, true);
  assert.equal(pinned.trail.updatedAt, saved.trail.updatedAt);
});

test("scroll-only replace mutates storage (entries equal includes viewport)", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const saved = await mod.saveTrailFromPath(
    sampleState(["https://a.test/", "https://b.test/"]),
    1,
    "Scroll Path",
  );
  assert.equal(saved.ok, true);
  const scrolled = saved.trail.entries.map((entry, index) => ({
    ...entry,
    viewport: { x: 0, y: 200 * (index + 1), scrollHeight: 4000, root: "document" },
  }));
  const replaced = await mod.replaceSavedTrail(saved.trail.id, scrolled);
  assert.equal(replaced.ok, true);
  assert.ok(replaced.trail.updatedAt > saved.trail.updatedAt);
  assert.deepEqual(replaced.trail.entries[1].viewport, {
    x: 0,
    y: 400,
    scrollHeight: 4000,
    root: "document",
  });
  // Same path without viewport still unique by path identity — no second save.
  const conflict = await mod.saveCapturedTrail(saved.trail.entries, "Other name");
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /already saved/i);
});

test("delete snapshot restores exactly and restore conflicts fail visibly", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const saved = await mod.saveTrailFromPath(sampleState(["https://a.test/"]), 0, "Restore Me");
  const pinned = await mod.setSavedTrailPinned(saved.trail.id, true);
  const deleted = await mod.deleteSavedTrail(saved.trail.id);
  assert.equal(deleted.ok, true);

  const restored = await mod.restoreSavedTrail(deleted.trail);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.trail, pinned.trail);
  const idempotent = await mod.restoreSavedTrail(deleted.trail);
  assert.equal(idempotent.ok, true);
  assert.equal(idempotent.trails.length, 1);

  const conflictingSnapshot = { ...deleted.trail, name: "Different" };
  const idConflict = await mod.restoreSavedTrail(conflictingSnapshot);
  assert.equal(idConflict.ok, false);
  assert.match(idConflict.reason, /ID/i);

  await mod.deleteSavedTrail(saved.trail.id);
  const samePath = await mod.saveCapturedTrail(deleted.trail.entries, "Restore Me");
  assert.equal(samePath.ok, true);
  const pathConflict = await mod.restoreSavedTrail(deleted.trail);
  assert.deepEqual(pathConflict, {
    ok: false,
    reason: "This trail path is already saved as “Restore Me”",
  });

  await mod.deleteSavedTrail(samePath.trail.id);
  await mod.saveTrailFromPath(sampleState(["https://replacement.test/"]), 0, "Restore Me");
  const nameConflict = await mod.restoreSavedTrail(deleted.trail);
  assert.equal(nameConflict.ok, false);
  assert.match(nameConflict.reason, /already exists/i);
});

test("storage read failures reject without replacing the saved library", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const state = sampleState(["https://kept.test/"]);
  const saved = await mod.saveTrailFromPath(state, 0, "Keep Me");
  assert.equal(saved.ok, true);

  globalThis.__tabtrailTestGetError = new Error("storage temporarily unavailable");
  await assert.rejects(mod.loadSavedTrails(), /temporarily unavailable/);
  await assert.rejects(
    mod.saveTrailFromPath(sampleState(["https://new.test/"]), 0, "New Trail"),
    /temporarily unavailable/,
  );

  globalThis.__tabtrailTestGetError = null;
  const loaded = await mod.loadSavedTrails();
  assert.deepEqual(loaded.map((trail) => trail.name), ["Keep Me"]);
});

test("storage write failures reject without changing the saved library", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const saved = await mod.saveTrailFromPath(sampleState(["https://kept.test/"]), 0, "Keep Me");
  globalThis.__tabtrailTestSetError = new Error("storage is read-only");
  await assert.rejects(mod.renameSavedTrail(saved.trail.id, "Lost Rename"), /read-only/);
  await assert.rejects(mod.deleteSavedTrail(saved.trail.id), /read-only/);

  globalThis.__tabtrailTestSetError = null;
  const loaded = await mod.loadSavedTrails();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, "Keep Me");
});

test("overlapping mutations are serialized before read-modify-write", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  let releaseFirstRead;
  globalThis.__tabtrailTestGetGate = new Promise((resolve) => {
    releaseFirstRead = resolve;
  });

  const first = mod.saveTrailFromPath(sampleState(["https://one.test/"]), 0, "One");
  const second = mod.saveTrailFromPath(sampleState(["https://two.test/"]), 0, "Two");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(globalThis.__tabtrailTestGetCalls, 1, "only the first mutation may read while queued");

  releaseFirstRead();
  globalThis.__tabtrailTestGetGate = null;
  const results = await Promise.all([first, second]);
  assert.equal(results.every((result) => result.ok), true);
  const loaded = await mod.loadSavedTrails();
  assert.deepEqual(new Set(loaded.map((trail) => trail.name)), new Set(["One", "Two"]));
});

test("concurrent rename and replace compose, while an edit queued after delete fails", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const saved = await mod.saveTrailFromPath(sampleState(["https://old.test/"]), 0, "Before");
  let releaseFirstRead;
  globalThis.__tabtrailTestGetGate = new Promise((resolve) => {
    releaseFirstRead = resolve;
  });

  const rename = mod.renameSavedTrail(saved.trail.id, "After");
  const replace = mod.replaceSavedTrail(
    saved.trail.id,
    sampleState(["https://new.test/"]).entries,
  );
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirstRead();
  globalThis.__tabtrailTestGetGate = null;
  const [renamed, replaced] = await Promise.all([rename, replace]);
  assert.equal(renamed.ok, true);
  assert.equal(replaced.ok, true);
  assert.equal(replaced.trail.name, "After");
  assert.equal(replaced.trail.entries[0].url, "https://new.test/");

  const deleting = mod.deleteSavedTrail(saved.trail.id);
  const lateRename = mod.renameSavedTrail(saved.trail.id, "Too Late");
  const [deleted, missing] = await Promise.all([deleting, lateRename]);
  assert.equal(deleted.ok, true);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no longer exists/i);
});

test("save path conflicts precede capacity, while restore enforces capacity", async () => {
  const { mod } = await loadStoreModule();
  resetStorage();
  const sourceState = sampleState(["https://0.test/"]);
  const source = await mod.saveTrailFromPath(sourceState, 0, "Trail 0");
  const deleted = await mod.deleteSavedTrail(source.trail.id);
  assert.equal(deleted.ok, true);

  for (let index = 0; index < 50; index += 1) {
    const result = await mod.saveTrailFromPath(
      sampleState([`https://${index + 1}.test/`]),
      0,
      `Trail ${index + 1}`,
    );
    assert.equal(result.ok, true);
  }
  const fullLibrary = await mod.loadSavedTrails();
  const duplicatePath = await mod.saveCapturedTrail(fullLibrary[0].entries, "New name");
  assert.deepEqual(duplicatePath, {
    ok: false,
    reason: `This trail path is already saved as “${fullLibrary[0].name}”`,
  });
  const restore = await mod.restoreSavedTrail(deleted.trail);
  assert.equal(restore.ok, false);
  assert.match(restore.reason, /remove/i);
});
