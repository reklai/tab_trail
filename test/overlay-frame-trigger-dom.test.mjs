import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PROTOCOL_VERSION = 2;

async function loadOverlayFrameEntry() {
  const tempDir = mkdtempSync(join(tmpdir(), "overlay-frame-trigger-dom-"));
  const outfile = join(tempDir, "overlayFrame.mjs");
  await build({
    entryPoints: ["src/entryPoints/overlayFrame/overlayFrame.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "overlay-frame-trigger-stubs",
      setup(buildApi) {
        const stub = (filter, path) => {
          buildApi.onResolve({ filter }, () => ({
            path,
            namespace: "overlay-frame-trigger-stub",
          }));
        };
        stub(/adapters\/runtime\/tabtrailApi$/, "tabtrail-api");
        stub(/core\/trail\/trailCore$/, "trail-core");
        stub(/ui\/panels\/breadcrumbTrail\/breadcrumbTrail$/, "breadcrumb-trail");
        stub(/ui\/panels\/breadcrumbTrail\/overlaySurfaces$/, "overlay-surfaces");

        buildApi.onLoad({
          filter: /^tabtrail-api$/,
          namespace: "overlay-frame-trigger-stub",
        }, () => ({
          loader: "js",
          contents: "export async function claimOverlayFrame() { return { ok: true }; }",
        }));
        buildApi.onLoad({
          filter: /^trail-core$/,
          namespace: "overlay-frame-trigger-stub",
        }, () => ({
          loader: "js",
          contents: `
            export function matchesToggleTrigger(event, trigger) {
              if (trigger.kind !== "mouse" || event.type !== "mousedown") return false;
              if (event.button !== trigger.mouseButton || event.shiftKey !== trigger.withShift) {
                return false;
              }
              return event.altKey === (trigger.modifier === "alt") &&
                event.ctrlKey === (trigger.modifier === "ctrl") &&
                event.metaKey === (trigger.modifier === "super");
            }
          `,
        }));
        buildApi.onLoad({
          filter: /^breadcrumb-trail$/,
          namespace: "overlay-frame-trigger-stub",
        }, () => ({
          loader: "js",
          contents: `
            export function hideBreadcrumbTrail() {}
            export function isBreadcrumbTrailOpen() { return false; }
            export function showBreadcrumbTrail() {}
            export function updateBreadcrumbTrail() {}
            export function updateBreadcrumbTrailSettings() {}
          `,
        }));
        buildApi.onLoad({
          filter: /^overlay-surfaces$/,
          namespace: "overlay-frame-trigger-stub",
        }, () => ({
          loader: "js",
          contents: "export function closeOverlaySurface() {}",
        }));
      },
    }],
  });
  await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return () => rmSync(tempDir, { recursive: true, force: true });
}

function createPort() {
  const listeners = new Map();
  const posted = [];
  return {
    posted,
    postMessage(message) {
      posted.push(message);
    },
    start() {},
    close() {},
    addEventListener(type, listener) {
      const typeListeners = listeners.get(type) ?? new Set();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emitMessage(data) {
      for (const listener of listeners.get("message") ?? []) listener({ data });
    },
  };
}

function mouse(target, type, options) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

test("the isolated frame closes on a mouse chord and swallows only its follow-ups", async () => {
  const dom = new JSDOM("<!doctype html><body><button>Overlay action</button></body>", {
    pretendToBeVisual: true,
    url: "moz-extension://tabtrail/overlayFrame/overlayFrame.html",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const cleanupModule = await loadOverlayFrameEntry();
  const port = createPort();
  window.dispatchEvent(new window.MessageEvent("message", {
    source: window,
    data: {
      type: "TABTRAIL_OVERLAY_CONNECT",
      version: PROTOCOL_VERSION,
      nonce: "0123456789abcdef0123456789abcdef",
    },
    ports: [port],
  }));
  await Promise.resolve();
  await Promise.resolve();

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
  port.emitMessage({
    type: "HOST_INIT",
    version: PROTOCOL_VERSION,
    state: { entries: [], cursor: -1 },
    settings,
  });

  const button = document.querySelector("button");
  let targetMouseDowns = 0;
  let targetContextMenus = 0;
  let targetAuxClicks = 0;
  button.addEventListener("mousedown", () => { targetMouseDowns += 1; });
  button.addEventListener("contextmenu", () => { targetContextMenus += 1; });
  button.addEventListener("auxclick", () => { targetAuxClicks += 1; });

  const wrongChord = mouse(button, "mousedown", { button: 2, ctrlKey: true });
  assert.equal(wrongChord.defaultPrevented, false);
  assert.equal(targetMouseDowns, 1, "a non-matching chord still reaches the overlay control");

  const matchedRightDown = mouse(button, "mousedown", { button: 2, altKey: true });
  assert.equal(matchedRightDown.defaultPrevented, true);
  assert.equal(targetMouseDowns, 1, "the trigger mousedown cannot activate an overlay control");
  assert.equal(
    port.posted.filter((message) => (
      message.type === "FRAME_RPC_REQUEST" && message.request.method === "LIVE_CLOSE"
    )).length,
    1,
  );
  assert.deepEqual(
    port.posted.find((message) => (
      message.type === "FRAME_RPC_REQUEST" && message.request.method === "LIVE_CLOSE"
    )).request.params,
    { mouseButton: 2 },
    "the host receives enough gesture identity to continue shielding after teardown",
  );

  const rightContextMenu = mouse(button, "contextmenu", { button: 2 });
  assert.equal(rightContextMenu.defaultPrevented, true);
  assert.equal(targetContextMenus, 0, "a right-button trigger cannot open a context menu");

  port.emitMessage({
    type: "HOST_SETTINGS_UPDATED",
    version: PROTOCOL_VERSION,
    settings: { ...settings, trigger: { ...settings.trigger, mouseButton: 1 } },
  });
  mouse(button, "mousedown", { button: 1, altKey: true });
  const middleAuxClick = mouse(button, "auxclick", { button: 1 });
  assert.equal(middleAuxClick.defaultPrevented, true);
  assert.equal(targetAuxClicks, 0, "the matching middle-button follow-up is swallowed");

  const unrelatedContextMenu = mouse(button, "contextmenu", { button: 2 });
  assert.equal(unrelatedContextMenu.defaultPrevented, false);
  assert.equal(
    targetContextMenus,
    1,
    "a middle-button trigger does not eat an unrelated right-click context menu",
  );

  dom.window.close();
  cleanupModule();
});
