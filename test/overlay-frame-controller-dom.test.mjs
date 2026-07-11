import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PROTOCOL_VERSION = 2;

async function loadOverlayFrameController() {
  const tempDir = mkdtempSync(join(tmpdir(), "overlay-frame-controller-dom-"));
  const outfile = join(tempDir, "overlayFrameController.mjs");
  await build({
    entryPoints: ["src/lib/ui/overlayFrame/overlayFrameController.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "overlay-frame-controller-stubs",
      setup(buildApi) {
        const stub = (filter, path) => {
          buildApi.onResolve({ filter }, () => ({
            path,
            namespace: "overlay-frame-controller-stub",
          }));
        };
        stub(/^webextension-polyfill$/, "webextension-polyfill");
        stub(/adapters\/runtime\/savedTrailsClient$/, "saved-trails-client");
        stub(/adapters\/runtime\/tabtrailApi$/, "tabtrail-api");

        buildApi.onLoad({
          filter: /^webextension-polyfill$/,
          namespace: "overlay-frame-controller-stub",
        }, () => ({
          loader: "js",
          contents: `
            export default {
              runtime: {
                getURL(path) { return \`https://extension.test/\${path}\`; },
              },
            };
          `,
        }));
        buildApi.onLoad({
          filter: /^saved-trails-client$/,
          namespace: "overlay-frame-controller-stub",
        }, () => ({
          loader: "js",
          contents: `
            const ok = async () => ({ ok: true });
            export const browserSavedTrailsClient = {
              load: async () => [],
              open: ok,
              save: ok,
              rename: ok,
              replace: ok,
              setPinned: ok,
              delete: ok,
              restore: ok,
              subscribe: () => () => {},
            };
          `,
        }));
        buildApi.onLoad({
          filter: /^tabtrail-api$/,
          namespace: "overlay-frame-controller-stub",
        }, () => ({
          loader: "js",
          contents: `
            const ok = async () => ({ ok: true });
            export const jumpToTrailEntry = ok;
            export const openTabTrailOptions = ok;
            export const openTrailEntryInNewTab = ok;
            export const openTrailEntryInNewWindow = ok;
            export const reportTrailOverlayState = ok;
          `,
        }));
      },
    }],
  });
  const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return {
    module,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

class FakePort {
  listeners = new Map();
  peer = null;

  postMessage(data) {
    for (const listener of this.peer?.listeners.get("message") ?? []) listener({ data });
  }

  start() {}
  close() {}

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
}

class FakeMessageChannel {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

function mouse(window, target, type, options) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

async function withOverlayControllerDom(html, run) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
    pretendToBeVisual: true,
    url: "https://example.test/",
  });
  const globalNames = [
    "window",
    "document",
    "HTMLElement",
    "MouseEvent",
    "MessageChannel",
    "requestAnimationFrame",
    "CSS",
  ];
  const previousGlobals = new Map(globalNames.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]));
  const nativeAttachShadow = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function attachOpenShadow(init) {
    return nativeAttachShadow.call(this, { ...init, mode: "open" });
  };
  let connectMessage;
  let framePort;
  const frameWindow = {
    postMessage(message, _targetOrigin, ports) {
      connectMessage = message;
      [framePort] = ports;
    },
  };
  Object.defineProperty(dom.window.HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get: () => frameWindow,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    MessageChannel: FakeMessageChannel,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    CSS: { supports: () => true },
  });

  let cleanupModule = () => {};
  try {
    const loaded = await loadOverlayFrameController();
    cleanupModule = loaded.cleanup;
    const controller = loaded.module.createOverlayFrameController({
      onPositionChange() {},
    });
    await run({
      dom,
      controller,
      connection: () => ({ message: connectMessage, port: framePort }),
    });
  } finally {
    dom.window.close();
    cleanupModule();
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test("the host frame stays tabbable and shields mouse-close follow-ups after teardown", async () => {
  const dom = new JSDOM("<!doctype html><body><button>Page action</button></body>", {
    pretendToBeVisual: true,
    url: "https://example.test/",
  });
  const globalNames = [
    "window",
    "document",
    "HTMLElement",
    "MouseEvent",
    "MessageChannel",
    "requestAnimationFrame",
  ];
  const previousGlobals = new Map(globalNames.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]));
  const nativeAttachShadow = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function attachOpenShadow(init) {
    return nativeAttachShadow.call(this, { ...init, mode: "open" });
  };
  let connectMessage;
  let framePort;
  const frameWindow = {
    postMessage(message, _targetOrigin, ports) {
      connectMessage = message;
      [framePort] = ports;
    },
  };
  Object.defineProperty(dom.window.HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get: () => frameWindow,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    MessageChannel: FakeMessageChannel,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  });

  let cleanupModule = () => {};
  try {
    const loaded = await loadOverlayFrameController();
    cleanupModule = loaded.cleanup;
    const controller = loaded.module.createOverlayFrameController({
      onPositionChange() {},
    });
    const settings = {
      trigger: {
        modifier: "alt",
        withShift: false,
        kind: "mouse",
        keyCode: "KeyH",
        mouseButton: 2,
      },
      overlayPosition: null,
      maxVisibleSegments: 8,
    };
    const opened = controller.open({ entries: [], cursor: -1 }, settings);
    const host = document.getElementById("tabtrail-isolated-overlay-host");
    const frame = host.shadowRoot.querySelector("iframe");
    assert.equal(frame.tabIndex, 0, "Tab can enter the isolated overlay browsing context");
    assert.match(host.style.getPropertyValue("outline"), /^0(?:px)?$/);
    assert.equal(host.style.getPropertyValue("box-shadow"), "none");
    assert.match(frame.style.getPropertyValue("outline"), /^0(?:px)?$/);
    assert.equal(frame.style.getPropertyValue("box-shadow"), "none");
    assert.equal(frame.style.getPropertyValue("display"), "block");
    assert.equal(
      frame.style.getPropertyValue("background"),
      "transparent",
      "stale and merged clip regions must not expose an opaque iframe canvas",
    );

    frame.dispatchEvent(new dom.window.Event("load"));
    assert.equal(controller.authorizeClaim(connectMessage.nonce).ok, true);
    framePort.postMessage({ type: "FRAME_READY", version: PROTOCOL_VERSION });
    framePort.postMessage({
      type: "FRAME_RPC_REQUEST",
      version: PROTOCOL_VERSION,
      request: {
        requestId: 1,
        method: "LIVE_CLOSE",
        params: { mouseButton: 2 },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(await opened, false);
    const warmHost = document.getElementById("tabtrail-isolated-overlay-host");
    assert.ok(warmHost, "user close keeps a warm frame host for the next open");
    assert.equal(controller.isOpen(), false, "hibernated frame is not considered open");
    const warmFrame = warmHost.shadowRoot.querySelector("iframe");
    assert.match(warmFrame.style.getPropertyValue("visibility"), /hidden/i);

    const button = document.querySelector("button");
    let pageContextMenus = 0;
    let pageAuxClicks = 0;
    let pageClicks = 0;
    button.addEventListener("contextmenu", () => { pageContextMenus += 1; });
    button.addEventListener("auxclick", () => { pageAuxClicks += 1; });
    button.addEventListener("click", () => { pageClicks += 1; });

    const contextMenu = mouse(dom.window, button, "contextmenu", { button: 2 });
    const auxClick = mouse(dom.window, button, "auxclick", { button: 2 });
    const unrelatedClick = mouse(dom.window, button, "click", { button: 0 });
    assert.equal(contextMenu.defaultPrevented, true);
    assert.equal(auxClick.defaultPrevented, true);
    assert.equal(pageContextMenus, 0, "the closing right chord cannot open the page menu");
    assert.equal(pageAuxClicks, 0, "the closing right chord cannot activate page content");
    assert.equal(unrelatedClick.defaultPrevented, false);
    assert.equal(pageClicks, 1, "the shield leaves unrelated mouse buttons alone");
  } finally {
    dom.window.close();
    cleanupModule();
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test("closing restores page focus captured before the frame is hidden or removed", async (t) => {
  const settings = {
    trigger: {
      modifier: "alt",
      withShift: false,
      kind: "keyboard",
      keyCode: "KeyH",
      mouseButton: 2,
    },
    overlayPosition: null,
    maxVisibleSegments: 8,
  };
  for (const closeCase of [
    { name: "warm hibernation", request: { mode: "hibernate" }, blurOnHide: true },
    {
      name: "hard teardown",
      request: { mode: "destroy", reason: "Overlay frame failed" },
      blurOnHide: false,
    },
  ]) {
    await t.test(closeCase.name, async () => {
      await withOverlayControllerDom("<button>Page action</button>", async ({ dom, controller }) => {
        const button = document.querySelector("button");
        button.focus();
        const opened = controller.open({ entries: [], cursor: -1 }, settings);
        const host = document.getElementById("tabtrail-isolated-overlay-host");
        const frame = host.shadowRoot.querySelector("iframe");
        if (closeCase.blurOnHide) {
          const setProperty = frame.style.setProperty.bind(frame.style);
          frame.style.setProperty = (property, value, priority) => {
            setProperty(property, value, priority);
            if (property === "visibility" && value === "hidden") frame.blur();
          };
        }

        frame.focus();
        assert.equal(host.shadowRoot.activeElement, frame);
        controller.close(closeCase.request);
        assert.equal(await opened, false);
        await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
        assert.equal(document.activeElement, button);
      });
    });
  }
});

test("a loading frame reopened after hibernation queues a fresh show", async () => {
  await withOverlayControllerDom("<button>Page action</button>", async ({ dom, controller, connection }) => {
    const settings = {
      trigger: {
        modifier: "alt",
        withShift: false,
        kind: "keyboard",
        keyCode: "KeyH",
        mouseButton: 2,
      },
      overlayPosition: null,
      maxVisibleSegments: 8,
    };
    const initialState = { entries: [], cursor: -1 };
    const resumedState = {
      entries: [{ id: "new", url: "https://example.test/new", title: "New" }],
      cursor: 0,
    };
    const initialOpened = controller.open(initialState, settings);
    const host = document.getElementById("tabtrail-isolated-overlay-host");
    const frame = host.shadowRoot.querySelector("iframe");
    frame.dispatchEvent(new dom.window.Event("load"));
    const { message: connectMessage, port: framePort } = connection();
    assert.equal(controller.authorizeClaim(connectMessage.nonce).ok, true);
    const hostMessages = [];
    framePort.addEventListener("message", (event) => hostMessages.push(event.data));
    framePort.start();

    controller.close();
    assert.equal(await initialOpened, false);
    const resumedOpened = controller.open(resumedState, settings);
    assert.notEqual(resumedOpened, initialOpened);
    assert.equal(controller.isOpen(), true);
    let resumedSettled = false;
    void resumedOpened.then(() => { resumedSettled = true; });
    await Promise.resolve();
    assert.equal(resumedSettled, false, "the resumed open waits for live surfaces");

    framePort.postMessage({ type: "FRAME_READY", version: PROTOCOL_VERSION });
    assert.deepEqual(
      hostMessages.map((message) => message.type),
      ["HOST_HIBERNATE", "HOST_INIT", "HOST_SHOW"],
    );
    assert.deepEqual(hostMessages[1].state, resumedState);
    assert.deepEqual(hostMessages[2].state, resumedState);
    framePort.postMessage({
      type: "FRAME_SURFACES_UPDATED",
      version: PROTOCOL_VERSION,
      sequence: 0,
      viewportWidth: dom.window.innerWidth,
      viewportHeight: dom.window.innerHeight,
      rects: [{ x: 10, y: 10, width: 120, height: 40 }],
    });
    assert.equal(await resumedOpened, true);
    controller.close({ mode: "destroy", reason: "test complete" });
  });
});

test("open diagnostics settle once per cold or warm attempt and reset stale latency", async () => {
  await withOverlayControllerDom("<button>Page action</button>", async ({ dom, controller, connection }) => {
    const settings = {
      trigger: {
        modifier: "alt",
        withShift: false,
        kind: "keyboard",
        keyCode: "KeyH",
        mouseButton: 2,
      },
      overlayPosition: null,
      maxVisibleSegments: 8,
    };
    const state = { entries: [], cursor: -1 };
    const requestedAtEpochMs = performance.timeOrigin + performance.now() - 25;
    const coldOpened = controller.open(state, settings, requestedAtEpochMs);
    const host = document.getElementById("tabtrail-isolated-overlay-host");
    const frame = host.shadowRoot.querySelector("iframe");

    assert.equal(host.getAttribute("data-tabtrail-open-sequence"), "1");
    assert.equal(host.getAttribute("data-tabtrail-open-kind"), "cold");
    assert.equal(host.hasAttribute("data-tabtrail-host-open-latency-ms"), false);
    assert.equal(host.hasAttribute("data-tabtrail-toggle-latency-ms"), false);

    frame.dispatchEvent(new dom.window.Event("load"));
    const { message: connectMessage, port: framePort } = connection();
    assert.equal(controller.authorizeClaim(connectMessage.nonce).ok, true);
    framePort.postMessage({ type: "FRAME_READY", version: PROTOCOL_VERSION });
    framePort.postMessage({
      type: "FRAME_SURFACES_UPDATED",
      version: PROTOCOL_VERSION,
      sequence: 0,
      viewportWidth: dom.window.innerWidth,
      viewportHeight: dom.window.innerHeight,
      rects: [],
    });
    assert.equal(host.hasAttribute("data-tabtrail-host-open-latency-ms"), false);
    framePort.postMessage({
      type: "FRAME_SURFACES_UPDATED",
      version: PROTOCOL_VERSION,
      sequence: 1,
      viewportWidth: dom.window.innerWidth,
      viewportHeight: dom.window.innerHeight,
      rects: [{ x: 10, y: 10, width: 120, height: 40 }],
    });
    assert.equal(await coldOpened, true);
    assert.equal(host.hasAttribute("data-tabtrail-host-open-latency-ms"), true);
    assert.equal(host.hasAttribute("data-tabtrail-toggle-latency-ms"), true);
    assert.ok(Number(host.getAttribute("data-tabtrail-host-open-latency-ms")) >= 0);
    assert.ok(Number(host.getAttribute("data-tabtrail-toggle-latency-ms")) >= 25);
    const coldHostLatency = host.getAttribute("data-tabtrail-host-open-latency-ms");
    const coldToggleLatency = host.getAttribute("data-tabtrail-toggle-latency-ms");

    framePort.postMessage({
      type: "FRAME_SURFACES_UPDATED",
      version: PROTOCOL_VERSION,
      sequence: 2,
      viewportWidth: dom.window.innerWidth,
      viewportHeight: dom.window.innerHeight,
      rects: [{ x: 20, y: 20, width: 120, height: 40 }],
    });
    assert.equal(host.getAttribute("data-tabtrail-host-open-latency-ms"), coldHostLatency);
    assert.equal(host.getAttribute("data-tabtrail-toggle-latency-ms"), coldToggleLatency);

    controller.close();
    const warmOpened = controller.open(state, settings, Number.POSITIVE_INFINITY);
    assert.equal(host.getAttribute("data-tabtrail-open-sequence"), "2");
    assert.equal(host.getAttribute("data-tabtrail-open-kind"), "warm");
    assert.equal(host.hasAttribute("data-tabtrail-host-open-latency-ms"), false);
    assert.equal(host.hasAttribute("data-tabtrail-toggle-latency-ms"), false);

    framePort.postMessage({
      type: "FRAME_SURFACES_UPDATED",
      version: PROTOCOL_VERSION,
      sequence: 0,
      viewportWidth: dom.window.innerWidth,
      viewportHeight: dom.window.innerHeight,
      rects: [{ x: 10, y: 10, width: 120, height: 40 }],
    });
    assert.equal(await warmOpened, true);
    assert.equal(host.hasAttribute("data-tabtrail-host-open-latency-ms"), true);
    assert.ok(Number(host.getAttribute("data-tabtrail-host-open-latency-ms")) >= 0);
    assert.equal(host.hasAttribute("data-tabtrail-toggle-latency-ms"), false);
    controller.close({ mode: "destroy", reason: "test complete" });
  });
});
