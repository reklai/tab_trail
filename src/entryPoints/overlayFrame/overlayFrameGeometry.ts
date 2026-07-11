// Frame-side hit-surface geometry: collect, coalesce, publish, observe.

import {
  OVERLAY_FRAME_MAX_SURFACES,
  OVERLAY_FRAME_PROTOCOL_VERSION,
  type OverlayFrameToHostMessage,
  type OverlaySurfaceRect,
} from "../../lib/common/contracts/overlayFrame";
import {
  nextSurfacePublish,
  uniqueSurfaceRects,
} from "../../lib/ui/overlayFrame/surfaceGeometry";

const HIT_SURFACE_SELECTOR = "[data-tabtrail-hit-surface]";

export interface OverlayFrameGeometry {
  schedule(force?: boolean): void;
  sendImmediately(force?: boolean): void;
  installObservers(): void;
  reset(): void;
  sendEmpty(): void;
  dispose(): void;
}

export function createOverlayFrameGeometry(deps: {
  postToHost: (message: OverlayFrameToHostMessage) => void;
  isActive: () => boolean;
  panelShadow: () => ShadowRoot | null;
}): OverlayFrameGeometry {
  let nextSurfaceSequence = 0;
  let geometryFrame = 0;
  let geometryForcePending = false;
  let previousSurfaceRects: OverlaySurfaceRect[] = [];
  let previousLayoutKey = "";
  let sendContractionNextFrame = false;
  let geometryObserversCleanup: (() => void) | null = null;

  function collectSurfaceRects(): OverlaySurfaceRect[] {
    const shadow = deps.panelShadow();
    if (!shadow) return [];
    const rects: OverlaySurfaceRect[] = [];
    let noticesRect: OverlaySurfaceRect | null = null;
    for (const element of shadow.querySelectorAll<HTMLElement>(HIT_SURFACE_SELECTOR)) {
      if (element.getClientRects().length === 0) continue;
      const rect = element.getBoundingClientRect();
      if (
        !Number.isFinite(rect.x) ||
        !Number.isFinite(rect.y) ||
        !Number.isFinite(rect.width) ||
        !Number.isFinite(rect.height) ||
        rect.width <= 0 ||
        rect.height <= 0
      ) continue;
      const surface = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      // Undo notices can coexist independently (up to the saved-trail limit).
      // They render as one compact stack, so report that stack as one hit region
      // instead of allowing ordinary rapid deletes to exceed the protocol cap.
      if (element.classList.contains("wf-notice")) {
        if (!noticesRect) {
          noticesRect = surface;
        } else {
          const left = Math.min(noticesRect.x, surface.x);
          const top = Math.min(noticesRect.y, surface.y);
          const right = Math.max(noticesRect.x + noticesRect.width, surface.x + surface.width);
          const bottom = Math.max(noticesRect.y + noticesRect.height, surface.y + surface.height);
          noticesRect = { x: left, y: top, width: right - left, height: bottom - top };
        }
        continue;
      }
      rects.push(surface);
    }
    if (noticesRect) rects.push(noticesRect);
    return rects;
  }

  function surfaceLayoutKey(rects: readonly OverlaySurfaceRect[]): string {
    return `${window.innerWidth}x${window.innerHeight}:` + rects.map((rect) => (
      `${rect.x.toFixed(2)},${rect.y.toFixed(2)},${rect.width.toFixed(2)},${rect.height.toFixed(2)}`
    )).join(";");
  }

  function sendSurfaceRects(rects: OverlaySurfaceRect[]): void {
    if (rects.length > OVERLAY_FRAME_MAX_SURFACES) {
      deps.postToHost({
        type: "FRAME_ERROR",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
        reason: "Overlay produced too many interaction surfaces",
      });
      return;
    }
    deps.postToHost({
      type: "FRAME_SURFACES_UPDATED",
      version: OVERLAY_FRAME_PROTOCOL_VERSION,
      sequence: nextSurfaceSequence++,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      rects,
    });
  }

  function sendMeasuredSurfaceGeometry(force: boolean): void {
    const currentRects = collectSurfaceRects();
    const layoutKey = surfaceLayoutKey(currentRects);
    if (layoutKey !== previousLayoutKey) {
      const { publish, needsContraction } = nextSurfacePublish(
        previousSurfaceRects,
        currentRects,
      );
      sendSurfaceRects(publish);
      previousSurfaceRects = currentRects;
      previousLayoutKey = layoutKey;
      sendContractionNextFrame = needsContraction;
    } else if (force || sendContractionNextFrame) {
      sendSurfaceRects(uniqueSurfaceRects(currentRects));
      sendContractionNextFrame = false;
    }
  }

  // Coalesce geometry work onto one animation frame. Invalidation (DOM mutation,
  // resize, host request, or a one-frame contraction handoff) drives updates.
  function schedule(force = false): void {
    if (force) geometryForcePending = true;
    if (!deps.isActive()) return;
    if (geometryFrame) return;
    geometryFrame = requestAnimationFrame(() => {
      geometryFrame = 0;
      if (!deps.isActive()) return;
      const forceNow = geometryForcePending;
      geometryForcePending = false;
      sendMeasuredSurfaceGeometry(forceNow);
      if (sendContractionNextFrame) schedule(true);
    });
  }

  function sendImmediately(force = false): void {
    if (force) geometryForcePending = false;
    sendMeasuredSurfaceGeometry(force);
    if (sendContractionNextFrame) schedule(true);
  }

  function installObservers(): void {
    geometryObserversCleanup?.();
    const cleanups: Array<() => void> = [];
    const onInvalidate = (): void => schedule();
    window.addEventListener("resize", onInvalidate);
    window.visualViewport?.addEventListener("resize", onInvalidate);
    cleanups.push(() => {
      window.removeEventListener("resize", onInvalidate);
      window.visualViewport?.removeEventListener("resize", onInvalidate);
    });

    const host = document.getElementById("ht-panel-host");
    const shadow = host?.shadowRoot;
    // Hit-surface box changes drive geometry. Prefer ResizeObserver on surfaces;
    // keep a narrow MutationObserver for structure/class/style that can alter boxes
    // without a resize (hidden, class layout flips). Skip characterData noise.
    if (host && typeof ResizeObserver === "function") {
      const resizeObserver = new ResizeObserver(() => schedule());
      resizeObserver.observe(host);
      const observeHitSurfaces = (): void => {
        if (!shadow) return;
        for (const element of shadow.querySelectorAll(HIT_SURFACE_SELECTOR)) {
          resizeObserver.observe(element);
        }
        const layer = shadow.querySelector(".wf-layer");
        if (layer instanceof Element) resizeObserver.observe(layer);
      };
      observeHitSurfaces();
      cleanups.push(() => resizeObserver.disconnect());
      if (shadow && typeof MutationObserver === "function") {
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === "childList") {
              observeHitSurfaces();
              break;
            }
          }
          schedule();
        });
        observer.observe(shadow, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["style", "class", "hidden"],
        });
        cleanups.push(() => observer.disconnect());
      }
    } else if (shadow && typeof MutationObserver === "function") {
      const observer = new MutationObserver(() => schedule());
      observer.observe(shadow, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["style", "class", "hidden"],
      });
      cleanups.push(() => observer.disconnect());
    }
    geometryObserversCleanup = () => {
      for (const cleanup of cleanups) cleanup();
      geometryObserversCleanup = null;
    };
  }

  function reset(): void {
    geometryObserversCleanup?.();
    cancelAnimationFrame(geometryFrame);
    geometryFrame = 0;
    geometryForcePending = false;
    previousSurfaceRects = [];
    previousLayoutKey = "";
    sendContractionNextFrame = false;
  }

  function sendEmpty(): void {
    sendSurfaceRects([]);
  }

  function dispose(): void {
    reset();
  }

  return {
    schedule,
    sendImmediately,
    installObservers,
    reset,
    sendEmpty,
    dispose,
  };
}
