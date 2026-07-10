// Background entrypoint. Wires up the trail domain, its message handler, and
// the runtime router. Register every listener at the top level — MV3 service
// workers only fire events at listeners registered during the first run, so
// nothing below can wait behind an await.

import { createTrailDomain } from "../../lib/backgroundRuntime/domains/trailDomain";
import { createTrailMessageHandler } from "../../lib/backgroundRuntime/handlers/trailMessageHandler";
import { registerRuntimeMessageRouter } from "../../lib/backgroundRuntime/handlers/runtimeRouter";
import { migrateStorageIfNeeded } from "../../lib/common/utils/storageMigrationsRuntime";

const trail = createTrailDomain();
trail.registerLifecycleListeners();
const storageMigration = migrateStorageIfNeeded();
// Keep listeners synchronous at module load, but do not let a saved-trail
// read-modify-write race a startup migration. A failed migration releases the
// gate; the router/store will still surface any subsequent storage failure.
const storageReady = storageMigration.then(() => undefined, () => undefined);

registerRuntimeMessageRouter([
  createTrailMessageHandler(trail, storageReady),
]);

async function bootstrapBackground(): Promise<void> {
  const migration = await storageMigration;
  if (migration.changed) {
    console.log(
      `[TabTrail] Storage migration applied (${migration.fromVersion} -> ${migration.toVersion}).`,
    );
  }

  void trail.ensureLoaded();
}

void bootstrapBackground().catch((error) => {
  console.error("[TabTrail] Background bootstrap failed:", error);
});
