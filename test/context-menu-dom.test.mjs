import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { loadTsModule } from "./helpers/loadTsModule.mjs";

function installDom() {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
  });
  return dom;
}

test("context menu moves focus with arrows and restores its trigger on Escape", async () => {
  const dom = installDom();
  const menuModule = await loadTsModule("src/lib/ui/panels/breadcrumbTrail/contextMenu.ts");
  const trigger = document.createElement("button");
  const anchor = document.createElement("div");
  const layer = document.createElement("div");
  document.body.append(trigger, anchor, layer);
  trigger.focus();

  let closed = 0;
  const handle = menuModule.showContextMenu({
    layer,
    anchor,
    trigger,
    detail: { title: "Saved path" },
    items: [
      { label: "First", action() {} },
      { label: "Unavailable", disabled: true, action() {} },
      { label: "Last", danger: true, action() {} },
    ],
    onClose() { closed += 1; },
  });

  const items = [...handle.element.querySelectorAll("button")];
  assert.equal(handle.element.hasAttribute("data-tabtrail-hit-surface"), true);
  assert.equal(document.activeElement, items[0]);
  assert.equal(handle.element.getAttribute("role"), "menu");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");

  items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(document.activeElement, items[2], "disabled items are skipped");
  items[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  assert.equal(document.activeElement, items[0]);
  items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  assert.equal(closed, 1);
  assert.equal(handle.element.isConnected, false);
  assert.equal(document.activeElement, trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  dom.window.close();
});

test("outside-pointer dismissal does not reclaim focus", async () => {
  const dom = installDom();
  const menuModule = await loadTsModule("src/lib/ui/panels/breadcrumbTrail/contextMenu.ts");
  const trigger = document.createElement("button");
  const outside = document.createElement("button");
  const anchor = document.createElement("div");
  const layer = document.createElement("div");
  document.body.append(trigger, outside, anchor, layer);
  const handle = menuModule.showContextMenu({
    layer,
    anchor,
    trigger,
    detail: { title: "Menu" },
    items: [{ label: "Action", action() {} }],
    onClose() {},
  });

  outside.focus();
  outside.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
  assert.equal(handle.element.isConnected, false);
  assert.equal(document.activeElement, outside);
  dom.window.close();
});

test("pointer-open menus preserve page focus and do not restore an unfocused trigger", async () => {
  const dom = installDom();
  const menuModule = await loadTsModule("src/lib/ui/panels/breadcrumbTrail/contextMenu.ts");
  const pageInput = document.createElement("input");
  const trigger = document.createElement("button");
  const anchor = document.createElement("div");
  const layer = document.createElement("div");
  document.body.append(pageInput, trigger, anchor, layer);
  pageInput.focus();

  const handle = menuModule.showContextMenu({
    layer,
    anchor,
    trigger,
    focusOnOpen: false,
    detail: { title: "Pointer menu" },
    items: [{ label: "Action", action() {} }],
    onClose() {},
  });

  assert.equal(document.activeElement, pageInput);
  handle.close();
  assert.equal(handle.element.isConnected, false);
  assert.equal(document.activeElement, pageInput);
  dom.window.close();
});

test("context menu uses one roving tab stop and Tab dismisses without reclaiming focus", async () => {
  const dom = installDom();
  const menuModule = await loadTsModule("src/lib/ui/panels/breadcrumbTrail/contextMenu.ts");
  const trigger = document.createElement("button");
  const anchor = document.createElement("div");
  const layer = document.createElement("div");
  document.body.append(trigger, anchor, layer);
  trigger.focus();

  let closed = 0;
  const handle = menuModule.showContextMenu({
    layer,
    anchor,
    trigger,
    detail: { title: "Saved path" },
    items: [
      { label: "First", action() {} },
      { label: "Second", action() {} },
      { label: "Disabled", disabled: true, action() {} },
    ],
    onClose() { closed += 1; },
  });

  const items = [...handle.element.querySelectorAll("button")];
  assert.deepEqual(items.map((item) => item.tabIndex), [0, -1, -1]);

  items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.deepEqual(items.map((item) => item.tabIndex), [-1, 0, -1]);
  assert.equal(document.activeElement, items[1]);

  const tabEvent = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  items[1].dispatchEvent(tabEvent);

  assert.equal(tabEvent.defaultPrevented, false, "native Tab traversal remains available");
  assert.equal(closed, 1);
  assert.equal(handle.element.isConnected, false);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.notEqual(document.activeElement, trigger, "Tab dismissal must not pull focus backward");
  dom.window.close();
});

test("context menu stays in a short viewport and reveals roving-focus actions", async () => {
  const dom = installDom();
  const menuModule = await loadTsModule("src/lib/ui/panels/breadcrumbTrail/contextMenu.ts");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 300 });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 240 });

  const scrolledItems = [];
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList.contains("wf-menu")) {
      return { x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 600, width: 320, height: 600 };
    }
    return originalRect.call(this);
  };
  HTMLElement.prototype.scrollIntoView = function scrollIntoView(options) {
    scrolledItems.push({ element: this, options });
  };

  try {
    const trigger = document.createElement("button");
    const anchor = document.createElement("div");
    const layer = document.createElement("div");
    anchor.getBoundingClientRect = () => ({
      x: 120, y: 180, left: 120, top: 180, right: 160, bottom: 210, width: 40, height: 30,
    });
    document.body.append(trigger, anchor, layer);

    const handle = menuModule.showContextMenu({
      layer,
      anchor,
      trigger,
      detail: { title: "A saved trail", subtitle: "https://example.com/a/very/long/path" },
      items: [
        { label: "First", action() {} },
        { label: "Last", action() {} },
      ],
      onClose() {},
    });

    const items = [...handle.element.querySelectorAll("button")];
    assert.equal(handle.element.style.top, "8px", "a menu taller than the viewport is top-clamped");
    assert.equal(handle.element.style.left, "8px", "an over-wide menu is side-clamped");
    assert.equal(handle.element.hasAttribute("data-tabtrail-scroll-region"), true);
    assert.deepEqual(scrolledItems[0], {
      element: items[0],
      options: { block: "nearest", inline: "nearest" },
    });

    items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    assert.equal(document.activeElement, items[1]);
    assert.deepEqual(scrolledItems.at(-1), {
      element: items[1],
      options: { block: "nearest", inline: "nearest" },
    });

    handle.close();
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (originalScrollIntoView) {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    } else {
      delete HTMLElement.prototype.scrollIntoView;
    }
    dom.window.close();
  }
});
