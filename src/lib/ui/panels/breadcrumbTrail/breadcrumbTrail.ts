// Compact vertical branch overlay showing the tab's navigation trail. Built
// on the shared Shadow DOM panel host so it stays isolated from page styles,
// but deliberately NON-modal. Saved-trails library/name/tree UI lives in
// savedTrailsPanel.ts; live bar render/patch/menu lives in liveTrailBar.ts.

import styles from "./breadcrumbTrail.css";
import savedTrailStyles from "./savedTrailsPanel.css";
import {
  browserSavedTrailsClient,
  type SavedTrailsClient,
} from "../../../adapters/runtime/savedTrailsClient";
import {
  createPanelHost,
  dismissPanel,
  getBaseStyles,
  registerPanelCleanup,
} from "../../../common/utils/panelHost";
import { installOverlayInteractionShield } from "./interactionShield";
import {
  clearLiveNotices,
  showLiveNotice,
  type LiveNoticeHost,
} from "./liveTrailNotices";
import {
  createLiveTrailBar,
  type LiveTrailBarCallbacks,
  type LiveTrailBarController,
  type LiveTrailBarSession,
} from "./liveTrailBar";
import {
  createLiveTrailPreview,
  type LiveTrailPreviewController,
} from "./liveTrailPreview";
import {
  closeAllOverlaySurfaces,
  closeOverlaySurface,
  closeTopOverlaySurface,
  isOverlaySurfaceBlockingLiveRender,
} from "./overlaySurfaces";
import {
  bindSavedTrailsHost,
  unbindSavedTrailsHost,
} from "./savedTrailsPanel";
import type { SavedTrailsNoticeOptions } from "./savedTrailsPanel";

export type BreadcrumbTrailCallbacks = LiveTrailBarCallbacks;

export interface BreadcrumbTrailOptions {
  settings: TabTrailSettings;
  callbacks: BreadcrumbTrailCallbacks;
  /** Persistence/navigation gateway; injectable for isolated rendering hosts. */
  savedTrailsClient?: SavedTrailsClient;
  /**
   * Document-lifetime saved-trails controller. When omitted, a controller is
   * created for this show (tests). The overlay frame passes one instance so
   * pending mutations survive hibernate remounts.
   */
  savedTrailsController?: import("./savedTrailsSession").SavedTrailsUiController;
}

const DEFAULT_POSITION: TabTrailOverlayPosition = { xPercent: 50, yPercent: 8 };

interface OverlaySession extends LiveNoticeHost, LiveTrailBarSession {
  position: TabTrailOverlayPosition;
  preview: LiveTrailPreviewController;
}

let session: OverlaySession | null = null;
let mainDragStop: (() => void) | null = null;
let liveBar: LiveTrailBarController | null = null;

function getLiveBar(): LiveTrailBarController {
  if (!liveBar) {
    liveBar = createLiveTrailBar({
      getSession: () => session,
      setLiveInteractionBlocked,
      hideTrail: hideBreadcrumbTrail,
      startDrag,
    });
  }
  return liveBar;
}

export function isBreadcrumbTrailOpen(): boolean {
  return session !== null;
}

export function hideBreadcrumbTrail(): void {
  if (!session) return;
  dismissPanel();
}

export function updateBreadcrumbTrail(state: TrailState): void {
  if (!session) return;
  const previous = session.state;
  session.state = state;
  if (isOverlaySurfaceBlockingLiveRender()) {
    session.liveRenderPending = true;
    setLiveInteractionBlocked(true);
    return;
  }
  const bar = getLiveBar();
  if (bar.canPatchLiveTrail(previous, state, session)) {
    bar.patchLiveTrail(previous, state);
    return;
  }
  bar.renderBar();
}

export function updateBreadcrumbTrailSettings(settings: TabTrailSettings): void {
  if (!session) return;
  const visibleRowsChanged =
    session.options.settings.maxVisibleSegments !== settings.maxVisibleSegments;
  session.options.settings = settings;
  if (!visibleRowsChanged) return;
  if (isOverlaySurfaceBlockingLiveRender()) {
    session.liveRenderPending = true;
    setLiveInteractionBlocked(true);
    return;
  }
  getLiveBar().renderBar();
}

export function showBreadcrumbTrail(state: TrailState, options: BreadcrumbTrailOptions): void {
  const { host, shadow } = createPanelHost();
  const removeInteractionShield = installOverlayInteractionShield(shadow);
  host.style.pointerEvents = "none";

  const style = document.createElement("style");
  style.textContent = getBaseStyles() + styles + savedTrailStyles;
  shadow.appendChild(style);

  const layer = document.createElement("div");
  layer.className = "wf-layer";
  shadow.appendChild(layer);

  const bar = document.createElement("div");
  bar.className = "wf-bar";
  bar.dataset.tabtrailHitSurface = "";
  bar.dataset.tabtrailWheelSurface = "";
  bar.setAttribute("role", "navigation");
  bar.setAttribute("aria-label", "Navigation trail");
  layer.appendChild(bar);

  const noticeStack = document.createElement("div");
  noticeStack.className = "wf-notice-stack";
  noticeStack.dataset.tabtrailWheelSurface = "";
  noticeStack.dataset.tabtrailScrollRegion = "";
  layer.appendChild(noticeStack);

  const preview = createLiveTrailPreview(
    () => session?.layer ?? null,
    () => session?.bar ?? null,
  );

  session = {
    shadow,
    bar,
    layer,
    options,
    state,
    expanded: false,
    position: options.settings.overlayPosition ?? DEFAULT_POSITION,
    noticeStack,
    statusNoticeCleanup: null,
    undoNoticeCleanups: new Set(),
    liveRenderPending: false,
    preview,
  };

  bindSavedTrailsHost(
    {
      layer,
      bar,
      client: options.savedTrailsClient ?? browserSavedTrailsClient,
      getState: () => session?.state ?? { entries: [], cursor: -1 },
      showNotice,
      hideTrail: hideBreadcrumbTrail,
      closeLiveSurfaces: () => {
        closeOverlaySurface("menu");
        preview.close();
      },
      flushLiveTrailUpdates: () => {
        queueMicrotask(() => {
          if (!session?.liveRenderPending || isOverlaySurfaceBlockingLiveRender()) return;
          getLiveBar().renderBar();
        });
      },
      restoreLiveFocus: (opener) => getLiveBar().restoreLiveFocus(opener),
      setLiveInteractionBlocked,
    },
    options.savedTrailsController,
  );

  applyPosition();
  getLiveBar().renderBar();

  const onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !session) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (closeTopOverlaySurface()) return;
    if (session.preview.isOpen()) {
      session.preview.close(true);
      return;
    }
    hideBreadcrumbTrail();
  };
  document.addEventListener("keydown", onDocumentKeydown, true);

  registerPanelCleanup(() => {
    document.removeEventListener("keydown", onDocumentKeydown, true);
    mainDragStop?.();
    mainDragStop = null;
    removeInteractionShield();
    clearLiveNotices(session);
    closeAllOverlaySurfaces();
    session?.preview.close();
    unbindSavedTrailsHost();
    getLiveBar().clearMenuState();
    const closing = session;
    session = null;
    closing?.options.callbacks.onClose();
  });
}

function showNotice(message: string, options: SavedTrailsNoticeOptions = {}): void {
  if (!session) return;
  const noticeHost = session;
  showLiveNotice(noticeHost, () => session === noticeHost, message, options);
}

function applyPosition(): void {
  if (!session) return;
  const { xPercent, yPercent } = session.position;
  session.bar.style.left = `${xPercent}%`;
  session.bar.style.top = `${yPercent}%`;
  session.preview.reposition();
}

function setLiveInteractionBlocked(blocked: boolean): void {
  if (!session) return;
  session.bar.inert = blocked;
  session.bar.classList.toggle("wf-bar-blocked", blocked);
  if (blocked) session.bar.setAttribute("aria-disabled", "true");
  else session.bar.removeAttribute("aria-disabled");
}

// --- Main bar drag (percent position, persisted) ---

function startDrag(event: PointerEvent): void {
  if (!session) return;
  mainDragStop?.();
  mainDragStop = null;
  event.preventDefault();
  const dragSession = session;
  const { bar } = dragSession;
  const captureTarget = event.currentTarget instanceof HTMLElement ? event.currentTarget : bar;
  const pointerId = event.pointerId;
  try {
    captureTarget.setPointerCapture(pointerId);
  } catch (_) {
    // Synthetic events and older engines can lack an active pointer capture.
  }
  const barRect = bar.getBoundingClientRect();
  const grabOffsetX = event.clientX - (barRect.left + barRect.width / 2);
  const grabOffsetY = event.clientY - barRect.top;
  bar.classList.add("wf-dragging");

  const onMove = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== pointerId) return;
    if (session !== dragSession) return;
    const x = ((moveEvent.clientX - grabOffsetX) / window.innerWidth) * 100;
    const y = ((moveEvent.clientY - grabOffsetY) / window.innerHeight) * 100;
    dragSession.position = {
      xPercent: Math.min(Math.max(x, 0), 100),
      yPercent: Math.min(Math.max(y, 0), 96),
    };
    applyPosition();
  };

  let stopped = false;
  const finish = (persist: boolean): void => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onPointerEnd, true);
    window.removeEventListener("pointercancel", onPointerEnd, true);
    try {
      if (captureTarget.hasPointerCapture(pointerId)) {
        captureTarget.releasePointerCapture(pointerId);
      }
    } catch (_) {
      // Pointer capture may already be released if the overlay was removed.
    }
    bar.classList.remove("wf-dragging");
    if (mainDragStop === cancel) mainDragStop = null;
    if (persist && session === dragSession) {
      dragSession.options.callbacks.onPositionChange(dragSession.position);
    }
  };
  const onPointerEnd = (endEvent: PointerEvent): void => {
    if (endEvent.pointerId === pointerId) finish(true);
  };
  const cancel = (): void => finish(false);
  mainDragStop = cancel;

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onPointerEnd, true);
  window.addEventListener("pointercancel", onPointerEnd, true);
}
