// Pure, import-free storage schema migration. Reads the version key, applies a
// chained sequence of `if (fromVersion < N) { ... }` steps that mutate a
// snapshot, and stamps the current version. Each step reports whether it
// changed anything so the runtime can skip writes when nothing moved.
//
// The schema starts at v1; the only step so far is stamping the version onto a
// fresh or legacy profile. Future migrations chain below as new `if` blocks.

export const STORAGE_SCHEMA_VERSION_KEY = "storageSchemaVersion";
export const STORAGE_SCHEMA_VERSION = 1;

type StorageSnapshot = Record<string, unknown>;

export interface StorageMigrationResult {
  fromVersion: number;
  toVersion: number;
  changed: boolean;
  migratedStorage: StorageSnapshot;
}

function readSchemaVersion(storage: StorageSnapshot): number {
  const numeric = Number(storage[STORAGE_SCHEMA_VERSION_KEY]);
  if (!Number.isFinite(numeric)) return 0;
  const rounded = Math.floor(numeric);
  return rounded > 0 ? rounded : 0;
}

export function isStorageSchemaVersionCurrent(rawVersion: unknown): boolean {
  return Number(rawVersion) === STORAGE_SCHEMA_VERSION;
}

export function createCurrentVersionMigrationResult(): StorageMigrationResult {
  return {
    fromVersion: STORAGE_SCHEMA_VERSION,
    toVersion: STORAGE_SCHEMA_VERSION,
    changed: false,
    migratedStorage: {},
  };
}

export function migrateStorageSnapshot(input: StorageSnapshot): StorageMigrationResult {
  const migratedStorage: StorageSnapshot = { ...input };
  const fromVersion = readSchemaVersion(input);

  // A profile written by a newer build — never downgrade its data.
  if (fromVersion > STORAGE_SCHEMA_VERSION) {
    return {
      fromVersion,
      toVersion: fromVersion,
      changed: false,
      migratedStorage,
    };
  }

  let changed = false;

  // Future schema steps go here, e.g.:
  //   if (fromVersion < 2) { changed = migrateSomething(migratedStorage) || changed; }

  if (migratedStorage[STORAGE_SCHEMA_VERSION_KEY] !== STORAGE_SCHEMA_VERSION) {
    migratedStorage[STORAGE_SCHEMA_VERSION_KEY] = STORAGE_SCHEMA_VERSION;
    changed = true;
  }

  return {
    fromVersion,
    toVersion: STORAGE_SCHEMA_VERSION,
    changed,
    migratedStorage,
  };
}
