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
    assert.equal(
      document.getElementById("tabtrail-isolated-overlay-host"),
      null,
      "the close still removes the overlay immediately",
    );

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
