const CONTAINED_EVENT_TYPES = [
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "change",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "focusin",
  "focusout",
  "copy",
  "cut",
  "paste",
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointercancel",
  "pointerover",
  "pointerout",
  "pointerenter",
  "pointerleave",
  "mousedown",
  "mouseup",
  "mousemove",
  "mouseover",
  "mouseout",
  "mouseenter",
  "mouseleave",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "drag",
  "dragstart",
  "dragend",
  "dragenter",
  "dragleave",
  "dragover",
  "drop",
] as const;

const SCROLL_REGION_SELECTOR = "[data-tabtrail-scroll-region]";
const WHEEL_SURFACE_SELECTOR = "[data-tabtrail-wheel-surface]";
const LINE_DELTA_PIXELS = 16;

function isElement(target: EventTarget): target is Element {
  return typeof (target as Element).matches === "function";
}

function eventPathElements(event: Event): Element[] {
  return event.composedPath().filter(isElement);
}

function canScrollAxis(
  position: number,
  viewportSize: number,
  contentSize: number,
  delta: number,
): boolean {
  if (delta < 0) return position > 0;
  if (delta > 0) return position + viewportSize < contentSize;
  return false;
}

function canScrollInWheelDirection(region: HTMLElement, event: WheelEvent): boolean {
  return canScrollAxis(
    region.scrollTop,
    region.clientHeight,
    region.scrollHeight,
    event.deltaY,
  ) || canScrollAxis(
    region.scrollLeft,
    region.clientWidth,
    region.scrollWidth,
    event.deltaX,
  );
}

function deltaMultiplier(event: WheelEvent, region: HTMLElement, axis: "x" | "y"): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return LINE_DELTA_PIXELS;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    const viewportSize = axis === "y" ? region.clientHeight : region.clientWidth;
    return viewportSize || 1;
  }
  return 1;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function manuallyScrollRegion(region: HTMLElement, event: WheelEvent): void {
  const deltaX = event.deltaX * deltaMultiplier(event, region, "x");
  const deltaY = event.deltaY * deltaMultiplier(event, region, "y");
  const maxScrollLeft = Math.max(0, region.scrollWidth - region.clientWidth);
  const maxScrollTop = Math.max(0, region.scrollHeight - region.clientHeight);

  region.scrollLeft = clamp(region.scrollLeft + deltaX, 0, maxScrollLeft);
  region.scrollTop = clamp(region.scrollTop + deltaY, 0, maxScrollTop);
}

/**
 * Keeps events handled by the extension overlay from bubbling into page-level
 * interaction handlers, and prevents wheel input from chaining to the page.
 *
 * Since the overlay shares the page document, capture-phase listeners already
 * installed on window/document run before this ShadowRoot bubble listener. That
 * remains an unavoidable same-document limitation.
 */
export function installOverlayInteractionShield(shadow: ShadowRoot): () => void {
  const containEvent = (event: Event): void => {
    event.stopPropagation();
  };

  const containWheel = (event: Event): void => {
    const wheelEvent = event as WheelEvent;
    wheelEvent.stopPropagation();

    const pathElements = eventPathElements(wheelEvent);
    const pathRegion = pathElements.find((element) => (
      element.matches(SCROLL_REGION_SELECTOR)
    ));
    if (pathRegion instanceof HTMLElement) {
      if (canScrollInWheelDirection(pathRegion, wheelEvent)) {
        // A page capture listener may have canceled native scrolling before
        // the event reached this boundary. Preserve overlay scrolling for
        // that recoverable case by applying the delta ourselves.
        if (wheelEvent.defaultPrevented) manuallyScrollRegion(pathRegion, wheelEvent);
      } else {
        wheelEvent.preventDefault();
      }
      return;
    }

    const wheelSurface = pathElements.find((element) => (
      element.matches(WHEEL_SURFACE_SELECTOR)
    ));
    const fallbackRegion = wheelSurface?.querySelector<HTMLElement>(
      SCROLL_REGION_SELECTOR,
    );
    if (fallbackRegion) manuallyScrollRegion(fallbackRegion, wheelEvent);
    wheelEvent.preventDefault();
  };

  for (const eventType of CONTAINED_EVENT_TYPES) {
    shadow.addEventListener(eventType, containEvent);
  }
  shadow.addEventListener("wheel", containWheel, { passive: false });

  return () => {
    for (const eventType of CONTAINED_EVENT_TYPES) {
      shadow.removeEventListener(eventType, containEvent);
    }
    shadow.removeEventListener("wheel", containWheel);
  };
}
