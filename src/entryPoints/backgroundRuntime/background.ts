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

registerRuntimeMessageRouter([
  createTrailMessageHandler(trail),
]);

async function bootstrapBackground(): Promise<void> {
  const migration = await migrateStorageIfNeeded();
  if (migration.changed) {
    console.log(
      `[Wayfind] Storage migration applied (${migration.fromVersion} -> ${migration.toVersion}).`,
    );
  }

  void trail.ensureLoaded();
}

void bootstrapBackground().catch((error) => {
  console.error("[Wayfind] Background bootstrap failed:", error);
});
