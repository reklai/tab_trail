// Applies the storage schema migration at background startup. Reads only the
// version key first — an already-migrated profile skips the full storage
// snapshot. The pure migration steps live in storageMigrations.ts.

import browser from "webextension-polyfill";
import {
  createCurrentVersionMigrationResult,
  isStorageSchemaVersionCurrent,
  migrateStorageSnapshot,
  STORAGE_SCHEMA_VERSION_KEY,
  StorageMigrationResult,
} from "./storageMigrations";

function storageValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch (_) {
    return false;
  }
}

export async function migrateStorageIfNeeded(): Promise<StorageMigrationResult> {
  return migrateStorageIfNeededAttempt(0);
}

async function migrateStorageIfNeededAttempt(attempt: number): Promise<StorageMigrationResult> {
  const versionSnapshot = (await browser.storage.local.get(STORAGE_SCHEMA_VERSION_KEY)) as Record<string, unknown>;
  if (isStorageSchemaVersionCurrent(versionSnapshot[STORAGE_SCHEMA_VERSION_KEY])) {
    return createCurrentVersionMigrationResult();
  }
  const snapshot = (await browser.storage.local.get(null)) as Record<string, unknown>;
  const result = migrateStorageSnapshot(snapshot);
  if (!result.changed) return result;
  const deletedKeys = Object.keys(snapshot).filter((key) => !(key in result.migratedStorage));
  if (deletedKeys.length > 0) {
    const latestSources = (await browser.storage.local.get(deletedKeys)) as Record<string, unknown>;
    const sourceChanged = deletedKeys.some((key) =>
      (key in snapshot) !== (key in latestSources) ||
      !storageValuesEqual(snapshot[key], latestSources[key]));
    if (sourceChanged) {
      if (attempt >= 3) {
        throw new Error("Storage kept changing during migration");
      }
      // Nothing has been written or removed yet. Recompute from a fresh
      // snapshot so a still-running legacy context cannot lose its last edit.
      return migrateStorageIfNeededAttempt(attempt + 1);
    }
  }
  // Write only keys the migration actually introduced or changed. Rewriting
  // the entire snapshot can roll back an unrelated setting or saved trail
  // that changed while this startup migration was awaiting storage I/O.
  const changedEntries = Object.entries(result.migratedStorage).filter(
    ([key, value]) =>
      key !== STORAGE_SCHEMA_VERSION_KEY &&
      (!(key in snapshot) || !Object.is(snapshot[key], value)),
  );
  const changedKeys = changedEntries.map(([key]) => key);
  const latestDestinations = changedKeys.length > 0
    ? await browser.storage.local.get(changedKeys) as Record<string, unknown>
    : {};
  const changedStorage = Object.fromEntries(
    changedEntries.filter(([key]) =>
      // A destination introduced by this migration may have been written by
      // the current build since the snapshot. Preserve that newer value.
      !(key in latestDestinations) ||
      (key in snapshot && storageValuesEqual(latestDestinations[key], snapshot[key]))),
  );
  if (Object.keys(changedStorage).length > 0) {
    await browser.storage.local.set(changedStorage);
  }

  // Never delete the only copy before its replacement is durable. Keeping the
  // old key after a failed remove is harmless; because the version is stamped
  // last, the next startup retries and destination-wins keeps it idempotent.
  if (deletedKeys.length > 0) {
    await browser.storage.local.remove(deletedKeys);
  }

  const latestVersion = (await browser.storage.local.get(
    STORAGE_SCHEMA_VERSION_KEY,
  )) as Record<string, unknown>;
  const latestVersionNumber = Number(latestVersion[STORAGE_SCHEMA_VERSION_KEY]);
  if (!Number.isFinite(latestVersionNumber) || latestVersionNumber <= result.toVersion) {
    await browser.storage.local.set({
      [STORAGE_SCHEMA_VERSION_KEY]: result.toVersion,
    });
  }
  return result;
}
