// Saved-trail UI gateway. The panel depends on this interface rather than on
// browser.storage/runtime, which keeps the same UI usable behind another
// transport (for example an isolated overlay frame).

import browser from "webextension-polyfill";
import { TABTRAIL_STORAGE_KEYS } from "../../common/contracts/tabtrail";
import { normalizeSavedTrails } from "../../core/trail/trailCore";
import type {
  DeleteSavedTrailResult,
  ReplaceSavedTrailResult,
  SaveNamedTrailResult,
  SavedTrailMutationResult,
} from "../storage/savedTrailsStore";
import {
  deleteNamedTrail,
  loadNamedTrails,
  openSavedTrail,
  renameNamedTrail,
  replaceNamedTrail,
  restoreNamedTrail,
  saveNamedTrail,
  setNamedTrailPinned,
} from "./tabtrailApi";

export interface SavedTrailsClient {
  load(): Promise<SavedTrail[]>;
  subscribe(onChanged: (trails: SavedTrail[]) => void): () => void;
  open(path: TrailEntry[], mode: SavedTrailOpenMode): Promise<TabTrailActionResult>;
  save(path: TrailEntry[], name: string): Promise<SaveNamedTrailResult>;
  rename(id: string, name: string): Promise<SavedTrailMutationResult>;
  replace(
    id: string,
    path: TrailEntry[],
    expectedPath?: TrailEntry[],
  ): Promise<ReplaceSavedTrailResult>;
  setPinned(id: string, pinned: boolean): Promise<SavedTrailMutationResult>;
  delete(id: string): Promise<DeleteSavedTrailResult>;
  restore(trail: SavedTrail): Promise<SavedTrailMutationResult>;
}

function subscribeToSavedTrails(
  onChanged: (trails: SavedTrail[]) => void,
): () => void {
  const storageChanged = (
    changes: Record<string, browser.Storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local") return;
    const savedChange = changes[TABTRAIL_STORAGE_KEYS.savedTrails];
    if (!savedChange) return;
    onChanged(normalizeSavedTrails(savedChange.newValue));
  };
  browser.storage.onChanged.addListener(storageChanged);
  return () => browser.storage.onChanged.removeListener(storageChanged);
}

/**
 * Browser-backed default used by the host content-script / overlay RPC path.
 * Durable reads go through the background so they wait on the startup
 * migration gate (same authority as mutations). Subscribe still listens to
 * storage.onChanged for push updates after the library is durable.
 */
export const browserSavedTrailsClient: SavedTrailsClient = {
  load: loadNamedTrails,
  subscribe: subscribeToSavedTrails,
  open: openSavedTrail,
  save: saveNamedTrail,
  rename: renameNamedTrail,
  replace: replaceNamedTrail,
  setPinned: setNamedTrailPinned,
  delete: deleteNamedTrail,
  restore: restoreNamedTrail,
};
