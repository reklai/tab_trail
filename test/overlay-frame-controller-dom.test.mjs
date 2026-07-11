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
    // HOST_INIT seeds settings only; trail state rides exclusively on HOST_SHOW.
    assert.equal(hostMessages[1].state, undefined);
    assert.deepEqual(hostMessages[1].settings, settings);
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

const DEFAULT_SETTINGS = {
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

async function settleVisible(controller, connection, dom, state = { entries: [], cursor: -1 }) {
  const opened = controller.open(state, DEFAULT_SETTINGS);
  const host = document.getElementById("tabtrail-isolated-overlay-host");
  const frame = host.shadowRoot.querySelector("iframe");
  frame.dispatchEvent(new dom.window.Event("load"));
  const { message: connectMessage, port: framePort } = connection();
  assert.equal(controller.authorizeClaim(connectMessage.nonce).ok, true);
  const hostMessages = [];
  framePort.addEventListener("message", (event) => hostMessages.push(event.data));
  framePort.start();
  framePort.postMessage({ type: "FRAME_READY", version: PROTOCOL_VERSION });
  framePort.postMessage({
    type: "FRAME_SURFACES_UPDATED",
    version: PROTOCOL_VERSION,
    sequence: 0,
    viewportWidth: dom.window.innerWidth,
    viewportHeight: dom.window.innerHeight,
    rects: [{ x: 10, y: 10, width: 120, height: 40 }],
  });
  assert.equal(await opened, true);
  return { host, frame, framePort, hostMessages };
}

test("updateTrail while hibernated is delivered on warm HOST_SHOW", async () => {
  await withOverlayControllerDom("<button>Page</button>", async ({ dom, controller, connection }) => {
    const { framePort, hostMessages } = await settleVisible(controller, connection, dom);
    controller.close({ mode: "hibernate" });
    assert.equal(controller.isOpen(), false);

    const updated = {
      entries: [{ id: "a", url: "https://example.test/a", title: "A" }],
      cursor: 0,
    };
    controller.updateTrail(updated);
    hostMessages.length = 0;

    const warmOpened = controller.open(updated, DEFAULT_SETTINGS);
    assert.equal(controller.isOpen(), true);
    const show = hostMessages.find((message) => message.type === "HOST_SHOW");
    assert.ok(show, "warm reopen posts HOST_SHOW");
    assert.deepEqual(show.state, updated);

    framePort.postMessage({
      type: "FRAME_SURFACES_UPDATED",
      version: PROTOCOL_VERSION,
      sequence: 0,
      viewportWidth: dom.window.innerWidth,
      viewportHeight: dom.window.innerHeight,
      rects: [{ x: 10, y: 10, width: 120, height: 40 }],
    });
    assert.equal(await warmOpened, true);
    controller.close({ mode: "destroy", reason: "test complete" });
  });
});

test("destroy during pending open settles false and removes the host", async () => {
  await withOverlayControllerDom("<button>Page</button>", async ({ controller }) => {
    const opened = controller.open({ entries: [], cursor: -1 }, DEFAULT_SETTINGS);
    assert.ok(document.getElementById("tabtrail-isolated-overlay-host"));
    controller.close({ mode: "destroy", reason: "Page became unavailable" });
    assert.equal(await opened, false);
    assert.equal(document.getElementById("tabtrail-isolated-overlay-host"), null);
    assert.equal(controller.getDiagnostics().lastFaultReason, "Page became unavailable");
  });
});

test("host open while visible-unsettled returns the same promise", async () => {
  await withOverlayControllerDom("<button>Page</button>", async ({ controller }) => {
    const first = controller.open({ entries: [], cursor: -1 }, DEFAULT_SETTINGS);
    assert.equal(controller.isOpen(), true);
    const second = controller.open(
      { entries: [{ id: "x", url: "https://example.test/", title: "X" }], cursor: 0 },
      DEFAULT_SETTINGS,
    );
    assert.equal(second, first, "idempotent open while visible returns the same promise");
    controller.close({ mode: "destroy", reason: "test complete" });
    assert.equal(await first, false);
  });
});

test("TRAIL_SHOW-style mid-handshake toggle hibernates rather than double-opening", async () => {
  await withOverlayControllerDom("<button>Page</button>", async ({ dom, controller, connection }) => {
    const opened = controller.open({ entries: [], cursor: -1 }, DEFAULT_SETTINGS);
    const host = document.getElementById("tabtrail-isolated-overlay-host");
    const frame = host.shadowRoot.querySelector("iframe");
    frame.dispatchEvent(new dom.window.Event("load"));
    const { message: connectMessage, port: framePort } = connection();
    assert.equal(controller.authorizeClaim(connectMessage.nonce).ok, true);
    framePort.start();
    // Visible before surfaces settle — content TRAIL_SHOW uses isOpen() → hibernate.
    assert.equal(controller.isOpen(), true);
    controller.close({ mode: "hibernate" });
    assert.equal(controller.isOpen(), false);
    assert.equal(await opened, false);
    assert.ok(document.getElementById("tabtrail-isolated-overlay-host"), "hibernate keeps the host");
    controller.close({ mode: "destroy", reason: "test complete" });
  });
});

test("LIVE_CLOSE during surface handshake hibernates and settles false", async () => {
  await withOverlayControllerDom("<button>Page</button>", async ({ dom, controller, connection }) => {
    const opened = controller.open({ entries: [], cursor: -1 }, DEFAULT_SETTINGS);
    const host = document.getElementById("tabtrail-isolated-overlay-host");
    const frame = host.shadowRoot.querySelector("iframe");
    frame.dispatchEvent(new dom.window.Event("load"));
    const { message: connectMessage, port: framePort } = connection();
    assert.equal(controller.authorizeClaim(connectMessage.nonce).ok, true);
    framePort.start();
    framePort.postMessage({ type: "FRAME_READY", version: PROTOCOL_VERSION });
    assert.equal(controller.isOpen(), true);

    framePort.postMessage({
      type: "FRAME_RPC_REQUEST",
      version: PROTOCOL_VERSION,
      request: { requestId: 1, method: "LIVE_CLOSE", params: {} },
    });
    // executeRpc + response post + queueMicrotask(hibernate) need a few turns.
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    assert.equal(controller.isOpen(), false);
    assert.equal(await opened, false);
    assert.ok(document.getElementById("tabtrail-isolated-overlay-host"));
    controller.close({ mode: "destroy", reason: "test complete" });
  });
});

test("hibernated mid-load reopen reuses the host with cold open kind", async () => {
  await withOverlayControllerDom("<button>Page</button>", async ({ dom, controller, connection }) => {
    const initialOpened = controller.open({ entries: [], cursor: -1 }, DEFAULT_SETTINGS);
    const host = document.getElementById("tabtrail-isolated-overlay-host");
    const frame = host.shadowRoot.querySelector("iframe");
    frame.dispatchEvent(new dom.window.Event("load"));
    const { message: connectMessage, port: framePort } = connection();
    assert.equal(controller.authorizeClaim(connectMessage.nonce).ok, true);
    framePort.start();

    controller.close({ mode: "hibernate" });
    assert.equal(await initialOpened, false);

    const resumed = {
      entries: [{ id: "r", url: "https://example.test/r", title: "R" }],
      cursor: 0,
    };
    const resumedOpened = controller.open(resumed, DEFAULT_SETTINGS);
    assert.equal(
      document.getElementById("tabtrail-isolated-overlay-host"),
      host,
      "mid-load reopen reuses the loading host",
    );
    assert.equal(host.getAttribute("data-tabtrail-open-kind"), "cold");
    assert.equal(controller.getDiagnostics().lastOpenKind, "cold");

    framePort.postMessage({ type: "FRAME_READY", version: PROTOCOL_VERSION });
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

test("getDiagnostics records resync count and survives host removal", async () => {
  await withOverlayControllerDom("<button>Page</button>", async ({ dom, controller, connection }) => {
    const { framePort } = await settleVisible(controller, connection, dom);
    const before = controller.getDiagnostics().surfaceResyncCount;
    // Viewport mismatch triggers soft resync.
    framePort.postMessage({
      type: "FRAME_SURFACES_UPDATED",
      version: PROTOCOL_VERSION,
      sequence: 1,
      viewportWidth: 1,
      viewportHeight: 1,
      rects: [{ x: 0, y: 0, width: 10, height: 10 }],
    });
    assert.equal(controller.getDiagnostics().surfaceResyncCount, before + 1);

    controller.close({ mode: "hibernate" });
    assert.equal(
      controller.getDiagnostics().surfaceResyncCount,
      before + 1,
      "hibernate keeps the last visible-session resync total",
    );

    controller.close({ mode: "destroy", reason: "Browser does not support isolated overlay hit testing" });
    assert.equal(document.getElementById("tabtrail-isolated-overlay-host"), null);
    const diagnostics = controller.getDiagnostics();
    assert.equal(
      diagnostics.lastFaultReason,
      "Browser does not support isolated overlay hit testing",
    );
    assert.equal(diagnostics.lastOpenKind, "cold");
  });
});
