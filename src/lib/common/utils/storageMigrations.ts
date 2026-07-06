// Pure, import-free storage schema migration. Reads the version key, applies a
// chained sequence of `if (fromVersion < N) { ... }` steps that mutate a
// snapshot, and stamps the current version. Each step reports whether it
// changed anything so the runtime can skip writes when nothing moved.
//
// v1 stamps the version onto a fresh or legacy profile; v2 renames the
// Wayfind->TabTrail storage keys. Future migrations chain below as new
// `if (fromVersion < N)` blocks.

export const STORAGE_SCHEMA_VERSION_KEY = "storageSchemaVersion";
export const STORAGE_SCHEMA_VERSION = 2;

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

// v1->v2: the extension was renamed from "Wayfind" to "TabTrail". Carry the
// saved settings over to the new key and drop any stale wayfind* keys (the
// local-storage fallback copies of per-tab session trails). The old literals
// are hardcoded on purpose — a migration must reference the values a legacy
// build actually wrote, never the renamed constants.
function renameWayfindKeys(storage: StorageSnapshot): boolean {
  let changed = false;
  if ("wayfindSettings" in storage) {
    storage["tabtrailSettings"] = storage["wayfindSettings"];
    delete storage["wayfindSettings"];
    changed = true;
  }
  for (const key of Object.keys(storage)) {
    if (key.startsWith("wayfindTrail:")) {
      delete storage[key];
      changed = true;
    }
  }
  return changed;
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

  if (fromVersion < 2) {
    changed = renameWayfindKeys(migratedStorage) || changed;
  }

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
