// Library row mutations: pin, delete/restore, and open saved trails.

import { closeOverlaySurface } from "./overlaySurfaces";
import {
  UNDO_DURATION_MS,
  acceptAuthoritativeTrails,
  activeShadowElement,
  host,
  libraryFocusIdentity,
  librarySession,
  pendingTrailIds,
  renderLibrary,
  restoreFocus,
  restoreLibraryFocus,
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
  if (pendingTrailIds.has(trailId)) return null;
  pendingTrailIds.add(trailId);
  closeOverlaySurface("menu");
  const operationFocus = libraryFocusIdentity(activeShadowElement(session.host));
  const mutationGeneration = session.loadRequest;
  renderLibrary(session);
  try {
    const result = await task();
    if (!result.ok) {
      if (host === session.host) {
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
    if (host === session.host) {
      session.host.showNotice("Could not save changes", { tone: "error", durationMs: 5000 });
    }
    return null;
  } finally {
    pendingTrailIds.delete(trailId);
    if (host === session.host && librarySession === session) {
      renderLibrary(session);
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
  if (host === session.host && result?.ok) {
    session.host.showNotice(trail.pinned ? `Unpinned “${trail.name}”` : `Pinned “${trail.name}”`);
  }
}

export async function removeTrail(session: LibrarySession, trail: SavedTrail): Promise<void> {
  const result = await runTrailMutation(session, trail.id, () => session.host.client.delete(trail.id));
  if (host !== session.host || !result?.ok || !("trail" in result)) return;
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
    if (host !== boundHost) return;
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
    if (host !== boundHost) return;
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
  if (!host) return;
  const boundHost = host;
  try {
    const result = await boundHost.client.open(trail.entries, mode);
    if (host !== boundHost) return;
    if (!result.ok) {
      boundHost.showNotice(result.reason || "Could not open trail", { tone: "error" });
      return;
    }
    if (mode === "current") boundHost.hideTrail();
    else boundHost.showNotice("Opened in new tab");
  } catch (_) {
    if (host === boundHost) {
      boundHost.showNotice("Could not open trail", { tone: "error" });
    }
  }
}
