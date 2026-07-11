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
        stub(/ui\/panels\/breadcrumbTrail\/savedTrailsSession$/, "saved-trails-session");

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
            export const MOUSE_CHORD_SWALLOW_WINDOW_MS = 600;
            export function toToggleTriggerEvent(event) {
              if (event.type === "keydown") {
                return {
                  type: "keydown",
                  code: event.code,
                  altKey: event.altKey,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  shiftKey: event.shiftKey,
                  repeat: event.repeat,
                  isTrusted: event.isTrusted,
                };
              }
              return {
                type: "mousedown",
                button: event.button,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                isTrusted: event.isTrusted,
              };
            }
            export function isMouseChordFollowUp(event, swallowedButton) {
              if (event.type === "contextmenu") return swallowedButton === 2;
              return event.button === swallowedButton;
            }
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
            let open = false;
            export function hideBreadcrumbTrail() {
              open = false;
              document.getElementById("ht-panel-host")?.remove();
            }
            export function isBreadcrumbTrailOpen() { return open; }
            export function showBreadcrumbTrail() {
              open = true;
              const host = document.createElement("div");
              host.id = "ht-panel-host";
              const shadow = host.attachShadow({ mode: "open" });
              const surface = document.createElement("div");
              surface.dataset.tabtrailHitSurface = "";
              surface.getClientRects = () => [{ x: 10, y: 12, width: 120, height: 40 }];
              surface.getBoundingClientRect = () => ({
                x: 10,
                y: 12,
                width: 120,
                height: 40,
                left: 10,
                top: 12,
                right: 130,
                bottom: 52,
                toJSON() {},
              });
              shadow.appendChild(surface);
              document.body.appendChild(host);
            }
            export function updateBreadcrumbTrail() {}
            export function updateBreadcrumbTrailSettings() {}
          `,
        }));
        buildApi.onLoad({
          filter: /^saved-trails-session$/,
          namespace: "overlay-frame-trigger-stub",
        }, () => ({
          loader: "js",
          contents: `
            export class SavedTrailsUiController {}
            export function createSavedTrailsController() {
              return new SavedTrailsUiController();
            }
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
  const state = { entries: [], cursor: -1 };
  port.emitMessage({
    type: "HOST_INIT",
    version: PROTOCOL_VERSION,
    settings,
  });
  assert.equal(
    port.posted.filter((message) => message.type === "FRAME_SURFACES_UPDATED").length,
    0,
    "HOST_INIT seeds protocol settings only and does not mount geometry",
  );
  port.emitMessage({
    type: "HOST_SHOW",
    version: PROTOCOL_VERSION,
    state,
    settings,
  });
  const initialSurfaceUpdates = port.posted.filter((message) => (
    message.type === "FRAME_SURFACES_UPDATED"
  ));
  assert.equal(
    initialSurfaceUpdates.length,
    1,
    "HOST_SHOW posts its first surface geometry synchronously",
  );
  assert.deepEqual(initialSurfaceUpdates[0].rects, [
    { x: 10, y: 12, width: 120, height: 40 },
  ], "the synchronous geometry is immediately usable by the host");
  await new Promise((resolve) => requestAnimationFrame(resolve));
  assert.equal(
    port.posted.filter((message) => message.type === "FRAME_SURFACES_UPDATED").length,
    1,
    "an initial layout with no previous surfaces does not queue a duplicate contraction",
  );

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

  port.emitMessage({ type: "HOST_HIBERNATE", version: PROTOCOL_VERSION });
  const updatesBeforeWarmShow = port.posted.filter((message) => (
    message.type === "FRAME_SURFACES_UPDATED"
  )).length;
  port.emitMessage({
    type: "HOST_SHOW",
    version: PROTOCOL_VERSION,
    state,
    settings,
  });
  assert.equal(
    port.posted.filter((message) => message.type === "FRAME_SURFACES_UPDATED").length,
    updatesBeforeWarmShow + 1,
    "HOST_SHOW posts restored surface geometry synchronously",
  );
  assert.deepEqual(
    port.posted.filter((message) => message.type === "FRAME_SURFACES_UPDATED").at(-1).rects,
    [{ x: 10, y: 12, width: 120, height: 40 }],
    "warm geometry is usable without waiting for animation-frame work",
  );
  await new Promise((resolve) => requestAnimationFrame(resolve));
  assert.equal(
    port.posted.filter((message) => message.type === "FRAME_SURFACES_UPDATED").length,
    updatesBeforeWarmShow + 1,
    "warm remount does not queue a duplicate contraction",
  );

  dom.window.close();
  cleanupModule();
});
