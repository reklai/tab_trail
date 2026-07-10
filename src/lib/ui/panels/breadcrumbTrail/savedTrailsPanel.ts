// Saved trails library public API. Implementation lives in focused modules
// (session, dialogs, mutations, tree preview, library); this file re-exports
// the stable surface used by breadcrumbTrail and tests.

import {
  closeOverlaySurface,
  hasOverlaySurface,
} from "./overlaySurfaces";
import { openLibraryPanel } from "./savedTrailsLibrary";
import { setHost, type SavedTrailsHost } from "./savedTrailsSession";

export {
  LIBRARY_EMPTY_COPY,
  type SavedTrailsHost,
  type SavedTrailsNoticeOptions,
} from "./savedTrailsSession";
export { openSaveTrailDialog } from "./savedTrailsDialogs";

export function bindSavedTrailsHost(next: SavedTrailsHost): void {
  setHost(next);
}

export function unbindSavedTrailsHost(): void {
  setHost(null);
  closeAllSavedTrailSurfaces();
}

export function closeAllSavedTrailSurfaces(): void {
  closeOverlaySurface("menu");
  closeOverlaySurface("treePreview");
  closeOverlaySurface("nameDialog");
  closeOverlaySurface("library");
}

export function isSavedTrailsLibraryOpen(): boolean {
  return hasOverlaySurface("library");
}

export function toggleSavedTrailsLibrary(): void {
  if (hasOverlaySurface("library")) {
    closeOverlaySurface("library");
    return;
  }
  openLibraryPanel();
}
