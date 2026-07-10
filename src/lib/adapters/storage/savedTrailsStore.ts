// Durable named-trail library: storage I/O + save/delete orchestration.
// Pure normalizers and uniqueness live in trailCore. Mutations are invoked by
// the background runtime, making this module's queue the single write path
// across every tab and extension surface.

import browser from "webextension-polyfill";
import { TABTRAIL_STORAGE_KEYS } from "../../common/contracts/tabtrail";
import {
  createSavedTrail,
  isSavedTrailNameTaken,
  MAX_SAVED_TRAILS,
  normalizeSavedTrail,
  normalizeSavedTrailEntries,
  normalizeSavedTrailName,
  normalizeSavedTrails,
  savedTrailEntriesEqual,
  savedTrailPathsEqual,
  slicePathToIndex,
} from "../../core/trail/trailCore";

export type SavedTrailMutationFailure = { ok: false; reason: string };

export type SaveNamedTrailResult =
  | { ok: true; trail: SavedTrail; trails: SavedTrail[] }
  | SavedTrailMutationFailure;

export type SavedTrailMutationResult =
  | { ok: true; trail: SavedTrail; trails: SavedTrail[] }
  | SavedTrailMutationFailure;

export type ReplaceSavedTrailResult =
  | {
      ok: true;
      trail: SavedTrail;
      previousTrail: SavedTrail;
      trails: SavedTrail[];
    }
  | SavedTrailMutationFailure;

export type DeleteSavedTrailResult =
  | { ok: true; trail: SavedTrail; trails: SavedTrail[] }
  | SavedTrailMutationFailure;

let mutationTail: Promise<void> = Promise.resolve();

function runMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(mutation);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

export async function loadSavedTrails(): Promise<SavedTrail[]> {
  const data = await browser.storage.local.get(TABTRAIL_STORAGE_KEYS.savedTrails);
  return normalizeSavedTrails(data[TABTRAIL_STORAGE_KEYS.savedTrails]);
}

async function writeSavedTrails(trails: SavedTrail[]): Promise<SavedTrail[]> {
  const normalized = normalizeSavedTrails(trails);
  await browser.storage.local.set({
    [TABTRAIL_STORAGE_KEYS.savedTrails]: normalized,
  });
  return normalized;
}

function cloneSavedTrail(trail: SavedTrail): SavedTrail {
  return {
    ...trail,
    entries: trail.entries.map((entry) => ({ ...entry })),
  };
}

function savedTrailsEqual(left: SavedTrail, right: SavedTrail): boolean {
  return left.id === right.id &&
    left.name === right.name &&
    left.pinned === right.pinned &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    savedTrailEntriesEqual(left.entries, right.entries);
}

function nextUpdatedAt(trail: SavedTrail): number {
  return Math.max(Date.now(), trail.updatedAt + 1);
}

function findTrail(trails: readonly SavedTrail[], id: string): SavedTrail | undefined {
  return trails.find((trail) => trail.id === id);
}

function findTrailWithPath(
  trails: readonly SavedTrail[],
  path: readonly TrailEntry[],
  excludeId?: string,
): SavedTrail | undefined {
  return trails.find(
    (trail) => trail.id !== excludeId && savedTrailPathsEqual(trail.entries, path),
  );
}

function trailPathConflict(trail: SavedTrail): SavedTrailMutationFailure {
  return { ok: false, reason: `This trail path is already saved as “${trail.name}”` };
}

function trailNotFound(): SavedTrailMutationFailure {
  return { ok: false, reason: "That saved trail no longer exists" };
}

export async function saveTrailFromPath(
  state: TrailState,
  index: number,
  name: string,
): Promise<SaveNamedTrailResult> {
  const path = slicePathToIndex(state, index);
  if (!path || path.length === 0) {
    return { ok: false, reason: "Nothing to save on this row" };
  }
  return saveCapturedTrail(path, name);
}

export async function saveCapturedTrail(
  path: TrailEntry[],
  name: string,
): Promise<SaveNamedTrailResult> {
  const capturedPath = normalizeSavedTrailEntries(path);
  if (capturedPath.length === 0) {
    return { ok: false, reason: "Nothing to save on this row" };
  }
  const cleanedName = normalizeSavedTrailName(name);
  if (cleanedName === "") {
    return { ok: false, reason: "Enter a name for this trail" };
  }
  return runMutation(async () => {
    const existing = await loadSavedTrails();
    const matchingPath = findTrailWithPath(existing, capturedPath);
    if (matchingPath) return trailPathConflict(matchingPath);
    if (existing.length >= MAX_SAVED_TRAILS) {
      return { ok: false, reason: "Remove a trail before saving another" };
    }
    if (isSavedTrailNameTaken(existing, cleanedName)) {
      return { ok: false, reason: `A trail named “${cleanedName}” already exists` };
    }
    const trail = createSavedTrail(cleanedName, capturedPath);
    const trails = await writeSavedTrails([trail, ...existing]);
    return { ok: true, trail: findTrail(trails, trail.id) || trail, trails };
  });
}

export async function renameSavedTrail(
  id: string,
  name: string,
): Promise<SavedTrailMutationResult> {
  const cleanedName = normalizeSavedTrailName(name);
  if (cleanedName === "") {
    return { ok: false, reason: "Enter a name for this trail" };
  }
  return runMutation(async () => {
    const existing = await loadSavedTrails();
    const current = findTrail(existing, id);
    if (!current) return trailNotFound();
    if (isSavedTrailNameTaken(existing, cleanedName, id)) {
      return { ok: false, reason: `A trail named “${cleanedName}” already exists` };
    }
    if (current.name === cleanedName) {
      return { ok: true, trail: current, trails: existing };
    }
    const renamed: SavedTrail = {
      ...current,
      name: cleanedName,
      updatedAt: nextUpdatedAt(current),
    };
    const trails = await writeSavedTrails(
      existing.map((trail) => trail.id === id ? renamed : trail),
    );
    return { ok: true, trail: findTrail(trails, id) || renamed, trails };
  });
}

export async function replaceSavedTrail(
  id: string,
  path: TrailEntry[],
  expectedPath?: TrailEntry[],
): Promise<ReplaceSavedTrailResult> {
  const replacementPath = normalizeSavedTrailEntries(path);
  if (replacementPath.length === 0) {
    return { ok: false, reason: "Choose a non-empty trail path to update" };
  }
  const normalizedExpectedPath = expectedPath === undefined
    ? undefined
    : normalizeSavedTrailEntries(expectedPath);
  return runMutation(async () => {
    const existing = await loadSavedTrails();
    const current = findTrail(existing, id);
    if (!current) return trailNotFound();
    if (
      normalizedExpectedPath !== undefined &&
      !savedTrailEntriesEqual(current.entries, normalizedExpectedPath)
    ) {
      return { ok: false, reason: "This trail changed before the update could be applied" };
    }
    const previousTrail = cloneSavedTrail(current);
    if (!savedTrailPathsEqual(current.entries, replacementPath)) {
      const matchingPath = findTrailWithPath(existing, replacementPath, id);
      if (matchingPath) return trailPathConflict(matchingPath);
    }
    if (savedTrailEntriesEqual(current.entries, replacementPath)) {
      return { ok: true, trail: current, previousTrail, trails: existing };
    }
    const replaced: SavedTrail = {
      ...current,
      updatedAt: nextUpdatedAt(current),
      entries: replacementPath.map((entry) => ({ ...entry })),
    };
    const trails = await writeSavedTrails(
      existing.map((trail) => trail.id === id ? replaced : trail),
    );
    return {
      ok: true,
      trail: findTrail(trails, id) || replaced,
      previousTrail,
      trails,
    };
  });
}

export async function setSavedTrailPinned(
  id: string,
  pinned: boolean,
): Promise<SavedTrailMutationResult> {
  return runMutation(async () => {
    const existing = await loadSavedTrails();
    const current = findTrail(existing, id);
    if (!current) return trailNotFound();
    if (current.pinned === pinned) {
      return { ok: true, trail: current, trails: existing };
    }
    const changed: SavedTrail = { ...current, pinned };
    const trails = await writeSavedTrails(
      existing.map((trail) => trail.id === id ? changed : trail),
    );
    return { ok: true, trail: findTrail(trails, id) || changed, trails };
  });
}

export async function deleteSavedTrail(id: string): Promise<DeleteSavedTrailResult> {
  return runMutation(async () => {
    const existing = await loadSavedTrails();
    const deleted = findTrail(existing, id);
    if (!deleted) return trailNotFound();
    const trails = await writeSavedTrails(existing.filter((trail) => trail.id !== id));
    return { ok: true, trail: cloneSavedTrail(deleted), trails };
  });
}

export async function restoreSavedTrail(
  snapshot: SavedTrail,
): Promise<SavedTrailMutationResult> {
  const restored = normalizeSavedTrail(snapshot);
  if (!restored) {
    return { ok: false, reason: "This saved trail can no longer be restored" };
  }
  return runMutation(async () => {
    const existing = await loadSavedTrails();
    const matchingId = findTrail(existing, restored.id);
    if (matchingId) {
      if (savedTrailsEqual(matchingId, restored)) {
        return { ok: true, trail: matchingId, trails: existing };
      }
      return { ok: false, reason: "A different saved trail now uses this ID" };
    }
    const matchingPath = findTrailWithPath(existing, restored.entries);
    if (matchingPath) return trailPathConflict(matchingPath);
    if (existing.length >= MAX_SAVED_TRAILS) {
      return { ok: false, reason: "Remove a trail before restoring this one" };
    }
    if (isSavedTrailNameTaken(existing, restored.name)) {
      return { ok: false, reason: `A trail named “${restored.name}” already exists` };
    }
    const trails = await writeSavedTrails([restored, ...existing]);
    return { ok: true, trail: findTrail(trails, restored.id) || restored, trails };
  });
}
