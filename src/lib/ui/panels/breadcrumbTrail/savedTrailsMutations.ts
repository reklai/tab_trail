// Library row mutations: pin, delete/restore, and open saved trails.

import { closeOverlaySurface } from "./overlaySurfaces";
import {
  UNDO_DURATION_MS,
  acceptAuthoritativeTrails,
  activeShadowElement,
  libraryFocusIdentity,
  restoreFocus,
  restoreLibraryFocus,
  savedTrailsUi,
  type LibrarySession,
  type SavedTrailsHost,
} from "./savedTrailsSession";

export async function runTrailMutation<T extends {
  ok: boolean;
  reason?: string;
  trails?: SavedTrail[];
}>(
  session: LibrarySession,
  trailId: string,
  task: () => Promise<T>,
): Promise<T | null> {
  const mutationOwner = savedTrailsUi.beginTrailMutation(trailId);
  if (!mutationOwner) return null;
  closeOverlaySurface("menu");
  const operationFocus = libraryFocusIdentity(activeShadowElement(session.host));
  const mutationGeneration = session.loadRequest;
  savedTrailsUi.renderLibrary(session);
  try {
    const result = await task();
    if (!result.ok) {
      if (savedTrailsUi.host === session.host) {
        session.host.showNotice(result.reason || "Could not save changes", {
          tone: "error",
          durationMs: 5000,
        });
      }
      return result;
    }
    if (result.trails) {
      acceptAuthoritativeTrails(result.trails, session, mutationGeneration);
    }
    return result;
  } catch (_) {
    if (savedTrailsUi.host === session.host) {
      session.host.showNotice("Could not save changes", { tone: "error", durationMs: 5000 });
    }
    return null;
  } finally {
    const released = savedTrailsUi.finishTrailMutation(trailId, mutationOwner);
    const currentSession = savedTrailsUi.librarySession;
    if (released && currentSession) savedTrailsUi.renderLibrary(currentSession);
    if (savedTrailsUi.host === session.host && currentSession === session) {
      restoreLibraryFocus(operationFocus);
    }
  }
}

export async function togglePinned(session: LibrarySession, trail: SavedTrail): Promise<void> {
  const result = await runTrailMutation(
    session,
    trail.id,
    () => session.host.client.setPinned(trail.id, !trail.pinned),
  );
  if (savedTrailsUi.host === session.host && result?.ok) {
    session.host.showNotice(trail.pinned ? `Unpinned “${trail.name}”` : `Pinned “${trail.name}”`);
  }
}

export async function removeTrail(session: LibrarySession, trail: SavedTrail): Promise<void> {
  const result = await runTrailMutation(session, trail.id, () => session.host.client.delete(trail.id));
  if (savedTrailsUi.host !== session.host || !result?.ok || !("trail" in result)) return;
  const deleted = result.trail;
  offerDeleteUndo(session.host, deleted, session);
  restoreFocus(
    session.list.querySelector<HTMLElement>(".wf-library-row .wf-row-more") ?? session.search,
  );
}

export function offerDeleteUndo(
  boundHost: SavedTrailsHost,
  deleted: SavedTrail,
  originSession: LibrarySession,
): void {
  boundHost.showNotice(`Removed “${deleted.name}”`, {
    actionLabel: "Undo",
    durationMs: UNDO_DURATION_MS,
    undo: true,
    action: () => restoreDeletedTrail(boundHost, deleted, originSession),
  });
}

export async function restoreDeletedTrail(
  boundHost: SavedTrailsHost,
  deleted: SavedTrail,
  originSession: LibrarySession,
): Promise<void> {
  const mutationGeneration = originSession.loadRequest;
  try {
    const restored = await boundHost.client.restore(deleted);
    if (savedTrailsUi.host !== boundHost) return;
    if (!restored.ok) {
      boundHost.showNotice(restored.reason, {
        tone: "error",
        actionLabel: "Retry",
        durationMs: UNDO_DURATION_MS,
        undo: true,
        action: () => restoreDeletedTrail(boundHost, deleted, originSession),
      });
      return;
    }
    acceptAuthoritativeTrails(restored.trails, originSession, mutationGeneration);
    boundHost.showNotice(`Restored “${restored.trail.name}”`);
  } catch (_) {
    if (savedTrailsUi.host !== boundHost) return;
    boundHost.showNotice("Could not restore trail", {
      tone: "error",
      actionLabel: "Retry",
      durationMs: UNDO_DURATION_MS,
      undo: true,
      action: () => restoreDeletedTrail(boundHost, deleted, originSession),
    });
  }
}

export async function navigateSavedTrail(trail: SavedTrail, mode: SavedTrailOpenMode): Promise<void> {
  if (!savedTrailsUi.host) return;
  const boundHost = savedTrailsUi.host;
  try {
    const result = await boundHost.client.open(trail.entries, mode);
    if (savedTrailsUi.host !== boundHost) return;
    if (!result.ok) {
      boundHost.showNotice(result.reason || "Could not open trail", { tone: "error" });
      return;
    }
    if (mode === "current") boundHost.hideTrail();
    else boundHost.showNotice("Opened in new tab");
  } catch (_) {
    if (savedTrailsUi.host === boundHost) {
      boundHost.showNotice("Could not open trail", { tone: "error" });
    }
  }
}
