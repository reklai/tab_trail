// Pure helpers for durable named-trail snapshots. No browser APIs. Live
// navigation reducer stays in trailCore.ts; this module owns library naming,
// normalization, creation, and navigation-path identity helpers.

import { normalizeTrailState } from "./trailCore";

// Hard cap for durable named snapshots in storage.local.
export const MAX_SAVED_TRAILS = 50;
export const SAVED_TRAIL_NAME_MAX_LENGTH = 80;

export function normalizeSavedTrailName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, SAVED_TRAIL_NAME_MAX_LENGTH);
}

export function savedTrailNameKey(name: string): string {
  return normalizeSavedTrailName(name).toLowerCase();
}

export function isSavedTrailNameTaken(
  trails: readonly SavedTrail[],
  name: string,
  excludeId?: string,
): boolean {
  const key = savedTrailNameKey(name);
  if (key === "") return false;
  return trails.some(
    (trail) => trail.id !== excludeId && savedTrailNameKey(trail.name) === key,
  );
}

export function suggestSavedTrailName(entry: TrailEntry | undefined): string {
  if (!entry) return "Saved trail";
  const title = entry.title.trim();
  if (title !== "") return normalizeSavedTrailName(title) || "Saved trail";
  try {
    const host = new URL(entry.url).hostname;
    return normalizeSavedTrailName(host) || "Saved trail";
  } catch (_) {
    return "Saved trail";
  }
}

export function savedTrailEndpoint(trail: SavedTrail): TrailEntry | null {
  if (trail.entries.length === 0) return null;
  return trail.entries[trail.entries.length - 1];
}

export function normalizeSavedTrailEntries(value: unknown): TrailEntry[] {
  return normalizeTrailState({
    entries: value,
    cursor: Array.isArray(value) ? value.length - 1 : -1,
  }).entries;
}

export function savedTrailEntriesEqual(
  left: readonly TrailEntry[],
  right: readonly TrailEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return entry.url === other.url &&
      entry.title === other.title &&
      entry.favIconUrl === other.favIconUrl &&
      entry.timestamp === other.timestamp &&
      entry.transition === other.transition &&
      entry.redirected === other.redirected &&
      entry.historyBacked === other.historyBacked;
  });
}

// Navigation identity deliberately excludes presentation and observation
// metadata. A saved path is the ordered sequence of exact locations and the
// navigation/history edges that connect them.
export function savedTrailPathsEqual(
  left: readonly TrailEntry[],
  right: readonly TrailEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return entry.url === other.url &&
      entry.transition === other.transition &&
      entry.historyBacked === other.historyBacked;
  });
}

export function normalizeSavedTrail(value: unknown): SavedTrail | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<SavedTrail>;
  const name = normalizeSavedTrailName(raw.name);
  if (name === "") return null;
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
  if (!id) return null;
  const entries = normalizeSavedTrailEntries(raw.entries);
  if (entries.length === 0) return null;
  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
  return { id, name, pinned: raw.pinned === true, createdAt, updatedAt, entries };
}

// Drop invalid rows, enforce uniqueness (first wins), cap count, newest-first sort.
export function normalizeSavedTrails(value: unknown): SavedTrail[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const trails: SavedTrail[] = [];
  for (const item of value) {
    const trail = normalizeSavedTrail(item);
    if (!trail) continue;
    const key = savedTrailNameKey(trail.name);
    if (seenIds.has(trail.id) || seenNames.has(key)) continue;
    seenIds.add(trail.id);
    seenNames.add(key);
    trails.push(trail);
    if (trails.length >= MAX_SAVED_TRAILS) break;
  }
  return trails.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

export function createSavedTrailId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `trail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createSavedTrail(name: string, entries: TrailEntry[], now = Date.now()): SavedTrail {
  return {
    id: createSavedTrailId(),
    name: normalizeSavedTrailName(name),
    pinned: false,
    createdAt: now,
    updatedAt: now,
    entries: normalizeSavedTrailEntries(entries),
  };
}
