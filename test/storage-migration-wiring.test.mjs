import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

function source(pathFromRoot) {
  return readFileSync(resolve(process.cwd(), pathFromRoot), "utf8");
}

async function loadMigrationRuntime() {
  const tempDir = mkdtempSync(join(tmpdir(), "storage-migration-runtime-"));
  const outfile = join(tempDir, "storageMigrationsRuntime.mjs");
  await build({
    entryPoints: ["src/lib/common/utils/storageMigrationsRuntime.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "migration-storage-stub",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^webextension-polyfill$/ }, () => ({
          path: "webextension-polyfill",
          namespace: "migration-stub",
        }));
        buildApi.onLoad({ filter: /.*/, namespace: "migration-stub" }, () => ({
          loader: "js",
          contents: `
            export default {
              storage: { local: {
                get(keys) { return globalThis.__migrationGet(keys); },
                set(items) { return globalThis.__migrationSet(items); },
                remove(keys) { return globalThis.__migrationRemove(keys); },
              } },
            };
          `,
        }));
      },
    }],
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return { mod, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
}

function installMigrationMemory(memory, hooks = {}) {
  const operations = [];
  globalThis.__migrationGet = async (keys) => {
    operations.push(["get", keys]);
    if (keys === null) {
      const snapshot = structuredClone(memory);
      hooks.afterSnapshot?.(memory);
      return snapshot;
    }
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requested.filter((key) => key in memory).map((key) => [key, structuredClone(memory[key])]),
    );
  };
  globalThis.__migrationSet = async (items) => {
    operations.push(["set", structuredClone(items)]);
    if (hooks.failSet?.(items)) throw new Error("simulated migration write failure");
    Object.assign(memory, structuredClone(items));
  };
  globalThis.__migrationRemove = async (keys) => {
    const requested = Array.isArray(keys) ? keys : [keys];
    operations.push(["remove", requested]);
    for (const key of requested) delete memory[key];
  };
  return operations;
}

test("background gates saved-trail storage messages on migration readiness", () => {
  const background = source("src/entryPoints/backgroundRuntime/background.ts");
  const handler = source("src/lib/backgroundRuntime/handlers/trailMessageHandler.ts");

  assert.match(background, /const storageMigration = migrateStorageIfNeeded\(\)/);
  assert.match(
    background,
    /const storageReady = storageMigration\.then\(\(\) => undefined, \(\) => undefined\)/,
  );
  assert.match(background, /createTrailMessageHandler\(trail, storageReady\)/);
  assert.ok(
    background.indexOf("registerRuntimeMessageRouter")
      < background.indexOf("async function bootstrapBackground"),
    "the MV3 message listener must still register before asynchronous bootstrap",
  );

  assert.match(handler, /storageReady: Promise<void> = Promise\.resolve\(\)/);
  assert.match(
    handler,
    /isDurableSavedTrailMutation\(message\.type\)[\s\S]*if \(durableSavedTrailMutation\)[\s\S]*await storageReady;[\s\S]*switch \(message\.type\)/,
  );
});

test("migration runtime writes a revalidated delta before removing stale keys", () => {
  const runtime = source("src/lib/common/utils/storageMigrationsRuntime.ts");

  assert.match(runtime, /storage\.local\.get\(STORAGE_SCHEMA_VERSION_KEY\)/);
  assert.match(runtime, /isStorageSchemaVersionCurrent/);
  assert.match(runtime, /storage\.local\.get\(null\)/);
  assert.match(
    runtime,
    /const deletedKeys = Object\.keys\(snapshot\)\.filter\(\(key\) => !\(key in result\.migratedStorage\)\)/,
  );
  assert.match(runtime, /await browser\.storage\.local\.remove\(deletedKeys\)/);
  assert.match(runtime, /const changedEntries = Object\.entries\(result\.migratedStorage\)\.filter\(/);
  assert.match(
    runtime,
    /!\(key in snapshot\) \|\| !Object\.is\(snapshot\[key\], value\)/,
  );
  assert.match(runtime, /const latestDestinations = changedKeys\.length > 0/);
  assert.match(runtime, /const latestSources = \(await browser\.storage\.local\.get\(deletedKeys\)\)/);
  assert.match(runtime, /return migrateStorageIfNeededAttempt\(attempt \+ 1\)/);
  assert.match(runtime, /storageValuesEqual\(latestDestinations\[key\], snapshot\[key\]\)/);
  assert.match(runtime, /const changedStorage = Object\.fromEntries\(/);
  assert.match(runtime, /await browser\.storage\.local\.set\(changedStorage\)/);
  assert.match(runtime, /await browser\.storage\.local\.set\(\{[\s\S]*STORAGE_SCHEMA_VERSION_KEY/);
  assert.doesNotMatch(runtime, /storage\.local\.set\(result\.migratedStorage\)/);
  assert.ok(
    runtime.indexOf("storage.local.set(changedStorage)")
      < runtime.indexOf("storage.local.remove(deletedKeys)"),
    "migrated destinations must be durable before legacy keys are removed",
  );
  assert.ok(
    runtime.indexOf("storage.local.remove(deletedKeys)")
      < runtime.lastIndexOf("storage.local.set({"),
    "the schema version must be stamped last so failed migrations resume",
  );
});

test("failed destination writes keep legacy settings and resume safely", async () => {
  const { mod, cleanup } = await loadMigrationRuntime();
  const legacy = { maxVisibleSegments: 10 };
  const memory = { storageSchemaVersion: 1, wayfindSettings: legacy };
  let failNextSet = true;
  const operations = installMigrationMemory(memory, {
    failSet: () => {
      if (!failNextSet) return false;
      failNextSet = false;
      return true;
    },
  });

  await assert.rejects(mod.migrateStorageIfNeeded(), /simulated migration write failure/);
  assert.deepEqual(memory.wayfindSettings, legacy);
  assert.equal("tabtrailSettings" in memory, false);
  assert.equal(operations.some(([kind]) => kind === "remove"), false);

  await mod.migrateStorageIfNeeded();
  assert.deepEqual(memory.tabtrailSettings, legacy);
  assert.equal("wayfindSettings" in memory, false);
  assert.equal(memory.storageSchemaVersion, 2);
  cleanup();
});

test("a concurrently written destination wins over a legacy snapshot", async () => {
  const { mod, cleanup } = await loadMigrationRuntime();
  const current = { maxVisibleSegments: 12, savedTrailsSort: "name" };
  const memory = {
    storageSchemaVersion: 1,
    wayfindSettings: { maxVisibleSegments: 8 },
  };
  let injected = false;
  installMigrationMemory(memory, {
    afterSnapshot: (liveMemory) => {
      if (injected) return;
      injected = true;
      liveMemory.tabtrailSettings = structuredClone(current);
    },
  });

  await mod.migrateStorageIfNeeded();
  assert.deepEqual(memory.tabtrailSettings, current);
  assert.equal("wayfindSettings" in memory, false);
  assert.equal(memory.storageSchemaVersion, 2);
  cleanup();
});

test("a concurrently changed legacy source is re-read before migration", async () => {
  const { mod, cleanup } = await loadMigrationRuntime();
  const currentLegacy = { maxVisibleSegments: 11, trigger: { modifier: "ctrl" } };
  const memory = {
    storageSchemaVersion: 1,
    wayfindSettings: { maxVisibleSegments: 8 },
  };
  let injected = false;
  installMigrationMemory(memory, {
    afterSnapshot: (liveMemory) => {
      if (injected) return;
      injected = true;
      liveMemory.wayfindSettings = structuredClone(currentLegacy);
    },
  });

  await mod.migrateStorageIfNeeded();
  assert.deepEqual(memory.tabtrailSettings, currentLegacy);
  assert.equal("wayfindSettings" in memory, false);
  assert.equal(memory.storageSchemaVersion, 2);
  cleanup();
});
