import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { loadTsModule } from "./helpers/loadTsModule.mjs";

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
];

function installDom() {
  const dom = new JSDOM("<!doctype html><body><button id=outside>Outside</button></body>", {
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    WheelEvent: dom.window.WheelEvent,
  });
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const target = document.createElement("button");
  shadow.append(target);
  document.body.append(host);
  return { dom, host, shadow, target };
}

function setScrollGeometry(element, {
  clientHeight = 100,
  clientWidth = 100,
  scrollHeight = 300,
  scrollWidth = 100,
  scrollTop = 0,
  scrollLeft = 0,
} = {}) {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    clientWidth: { configurable: true, value: clientWidth },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollWidth: { configurable: true, value: scrollWidth },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
    scrollLeft: { configurable: true, writable: true, value: scrollLeft },
  });
}

function wheel(target, options = {}) {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

test("overlay targets receive contained events without exposing them to page bubble listeners", async () => {
  const { dom, shadow, target } = installDom();
  const { installOverlayInteractionShield } = await loadTsModule(
    "src/lib/ui/panels/breadcrumbTrail/interactionShield.ts",
  );
  const cleanup = installOverlayInteractionShield(shadow);
  let targetEvents = 0;
  let hostilePageEvents = 0;

  for (const eventType of CONTAINED_EVENT_TYPES) {
    target.addEventListener(eventType, () => { targetEvents += 1; });
    document.addEventListener(eventType, () => { hostilePageEvents += 1; });
    target.dispatchEvent(new Event(eventType, {
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
  }

  assert.equal(targetEvents, CONTAINED_EVENT_TYPES.length);
  assert.equal(hostilePageEvents, 0);

  cleanup();
  target.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
  assert.equal(hostilePageEvents, 1, "cleanup removes the containment listeners");
  dom.window.close();
});

test("events dispatched outside the overlay remain untouched", async () => {
  const { dom, shadow } = installDom();
  const { installOverlayInteractionShield } = await loadTsModule(
    "src/lib/ui/panels/breadcrumbTrail/interactionShield.ts",
  );
  installOverlayInteractionShield(shadow);
  const outside = document.querySelector("#outside");
  let pageClicks = 0;
  document.addEventListener("click", () => { pageClicks += 1; });

  const outsideClick = new Event("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  outside.dispatchEvent(outsideClick);

  assert.equal(pageClicks, 1);
  assert.equal(outsideClick.defaultPrevented, false);
  dom.window.close();
});

test("wheel keeps native scrolling inside an available path scroll region", async () => {
  const { dom, shadow } = installDom();
  const { installOverlayInteractionShield } = await loadTsModule(
    "src/lib/ui/panels/breadcrumbTrail/interactionShield.ts",
  );
  installOverlayInteractionShield(shadow);
  shadow.replaceChildren();
  const region = document.createElement("div");
  region.dataset.tabtrailScrollRegion = "";
  const child = document.createElement("span");
  region.append(child);
  shadow.append(region);
  setScrollGeometry(region, { scrollTop: 50 });
  let targetWheels = 0;
  let hostilePageWheels = 0;
  child.addEventListener("wheel", () => { targetWheels += 1; });
  document.addEventListener("wheel", () => { hostilePageWheels += 1; });

  const event = wheel(child, { deltaY: 30 });

  assert.equal(targetWheels, 1);
  assert.equal(hostilePageWheels, 0);
  assert.equal(event.defaultPrevented, false, "the browser may scroll the region natively");
  dom.window.close();
});

test("wheel is canceled at a path scroll region boundary", async () => {
  const { dom, shadow } = installDom();
  const { installOverlayInteractionShield } = await loadTsModule(
    "src/lib/ui/panels/breadcrumbTrail/interactionShield.ts",
  );
  installOverlayInteractionShield(shadow);
  shadow.replaceChildren();
  const region = document.createElement("div");
  region.dataset.tabtrailScrollRegion = "";
  shadow.append(region);
  setScrollGeometry(region, { scrollTop: 200 });

  const event = wheel(region, { deltaY: 20 });

  assert.equal(event.defaultPrevented, true);
  assert.equal(region.scrollTop, 200);
  dom.window.close();
});

test("a page capture cancellation cannot disable overlay list scrolling", async () => {
  const { dom, shadow } = installDom();
  const { installOverlayInteractionShield } = await loadTsModule(
    "src/lib/ui/panels/breadcrumbTrail/interactionShield.ts",
  );
  document.addEventListener("wheel", (event) => event.preventDefault(), {
    capture: true,
    passive: false,
  });
  installOverlayInteractionShield(shadow);
  shadow.replaceChildren();
  const region = document.createElement("div");
  region.dataset.tabtrailScrollRegion = "";
  shadow.append(region);
  setScrollGeometry(region);

  const event = wheel(region, { deltaY: 25 });

  assert.equal(event.defaultPrevented, true);
  assert.equal(region.scrollTop, 25, "the shield salvages canceled native scrolling");
  dom.window.close();
});

test("wheel over a marked surface manually scrolls its fallback region", async () => {
  const { dom, shadow } = installDom();
  const { installOverlayInteractionShield } = await loadTsModule(
    "src/lib/ui/panels/breadcrumbTrail/interactionShield.ts",
  );
  installOverlayInteractionShield(shadow);
  shadow.replaceChildren();
  const surface = document.createElement("section");
  surface.dataset.tabtrailWheelSurface = "";
  const nonScrollingHeader = document.createElement("header");
  const region = document.createElement("div");
  region.dataset.tabtrailScrollRegion = "";
  surface.append(nonScrollingHeader, region);
  shadow.append(surface);
  setScrollGeometry(region);

  const event = wheel(nonScrollingHeader, {
    deltaY: 2,
    deltaMode: WheelEvent.DOM_DELTA_LINE,
  });

  assert.equal(event.defaultPrevented, true);
  assert.equal(region.scrollTop, 32, "line deltas are normalized before manual scrolling");
  dom.window.close();
});

test("page wheel events are unaffected by the overlay shield", async () => {
  const { dom, shadow } = installDom();
  const { installOverlayInteractionShield } = await loadTsModule(
    "src/lib/ui/panels/breadcrumbTrail/interactionShield.ts",
  );
  installOverlayInteractionShield(shadow);
  const outside = document.querySelector("#outside");
  let pageWheels = 0;
  document.addEventListener("wheel", () => { pageWheels += 1; });

  const event = wheel(outside, { deltaY: 25 });

  assert.equal(pageWheels, 1);
  assert.equal(event.defaultPrevented, false);
  dom.window.close();
});
