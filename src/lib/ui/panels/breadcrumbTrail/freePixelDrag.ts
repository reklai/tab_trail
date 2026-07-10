// Free-pixel pointer drag for overlay panes (preview, library). Main trail bar
// uses percent-of-viewport drag separately because its position is persisted.

export interface PixelPoint {
  left: number;
  top: number;
}

export function clampInViewport(
  left: number,
  top: number,
  width: number,
  height: number,
  margin = 12,
): PixelPoint {
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  return {
    left: Math.min(Math.max(margin, left), maxLeft),
    top: Math.min(Math.max(margin, top), maxTop),
  };
}

export interface FreePixelDragOptions {
  draggingClass?: string;
  onMove?: (position: PixelPoint) => void;
  /** Called when the drag ends (after listeners are removed). */
  onEnd?: () => void;
}

/**
 * Start dragging `element` from a pointerdown. Returns a stop function that
 * removes listeners and the dragging class (safe to call multiple times).
 */
export function startFreePixelDrag(
  element: HTMLElement,
  event: PointerEvent,
  options: FreePixelDragOptions = {},
): () => void {
  event.preventDefault();
  event.stopPropagation();

  const rect = element.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  const draggingClass = options.draggingClass;
  const pointerId = event.pointerId;

  try {
    element.setPointerCapture(pointerId);
  } catch (_) {
    // Synthetic events and older engines can lack an active pointer capture.
  }

  if (draggingClass) element.classList.add(draggingClass);
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;

  const apply = (left: number, top: number): void => {
    const position = clampInViewport(left, top, rect.width, rect.height);
    element.style.left = `${position.left}px`;
    element.style.top = `${position.top}px`;
    options.onMove?.(position);
  };

  apply(rect.left, rect.top);

  const move = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== pointerId) return;
    apply(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
  };

  let stopped = false;
  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    try {
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    } catch (_) {
      // The element or pointer may already have been released during teardown.
    }
    if (draggingClass) element.classList.remove(draggingClass);
    options.onEnd?.();
  };
  const end = (endEvent: PointerEvent): void => {
    if (endEvent.pointerId === pointerId) finish();
  };
  const stop = (): void => finish();

  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  return stop;
}
