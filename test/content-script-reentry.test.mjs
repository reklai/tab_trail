import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("double initChordCapture replaces cleanup and retires the previous bootstrap", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://example.test/",
    pretendToBeVisual: true,
  });
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "chord-reentry-"));
  const outfile = join(tempDir, "chordCapture.mjs");
  await build({
    entryPoints: ["src/lib/appInit/chordCapture.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "chord-reentry-stubs",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^webextension-polyfill$/ }, () => ({
          path: "webextension-polyfill",
          namespace: "chord-stub",
        }));
        buildApi.onResolve({ filter: /adapters\/runtime\/tabtrailApi$/ }, () => ({
          path: "tabtrail-api",
          namespace: "chord-stub",
        }));
        buildApi.onLoad({
          filter: /^webextension-polyfill$/,
          namespace: "chord-stub",
        }, () => ({
          loader: "js",
          contents: `
            export default {
              storage: {
                onChanged: {
                  addListener() {},
                  removeListener() {},
                },
                local: { get: async () => ({}) },
              },
            };
          `,
        }));
        buildApi.onLoad({
          filter: /^tabtrail-api$/,
          namespace: "chord-stub",
        }, () => ({
          loader: "js",
          contents: `
            export async function toggleTrailOverlay() { return { ok: true }; }
          `,
        }));
      },
    }],
  });

  try {
    const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    mod.initChordCapture();
    const firstCleanup = dom.window.__tabtrailChordCleanup;
    assert.equal(typeof firstCleanup, "function");

    mod.initChordCapture();
    const secondCleanup = dom.window.__tabtrailChordCleanup;
    assert.equal(typeof secondCleanup, "function");
    assert.notEqual(
      secondCleanup,
      firstCleanup,
      "re-init replaces the cleanup hook after retiring the previous bootstrap",
    );
    secondCleanup();
    assert.equal(dom.window.__tabtrailChordCleanup, undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    dom.window.close();
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test("double initTopFrameOverlay does not stack runtime message listeners", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://example.test/",
    pretendToBeVisual: true,
  });
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    HTMLElement: Object.getOwnPropertyDescriptor(globalThis, "HTMLElement"),
    CSS: Object.getOwnPropertyDescriptor(globalThis, "CSS"),
    MessageChannel: Object.getOwnPropertyDescriptor(globalThis, "MessageChannel"),
  };

  const tempDir = mkdtempSync(join(tmpdir(), "top-reentry-"));
  const outfile = join(tempDir, "topFrameOverlay.mjs");
  const messageListeners = new Set();
  await build({
    entryPoints: ["src/lib/appInit/topFrameOverlay.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "top-reentry-stubs",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^webextension-polyfill$/ }, () => ({
          path: "webextension-polyfill",
          namespace: "top-stub",
        }));
        buildApi.onResolve({ filter: /ui\/overlayFrame\/overlayFrameController$/ }, () => ({
          path: "overlay-controller",
          namespace: "top-stub",
        }));
        buildApi.onLoad({
          filter: /^webextension-polyfill$/,
          namespace: "top-stub",
        }, () => ({
          loader: "js",
          contents: `
            export default {
              storage: {
                onChanged: {
                  addListener() {},
                  removeListener() {},
                },
                local: { get: async () => ({}), set: async () => {} },
              },
              runtime: {
                onMessage: {
                  addListener(fn) { globalThis.__topMessageListeners.add(fn); },
                  removeListener(fn) { globalThis.__topMessageListeners.delete(fn); },
                },
                getURL(path) { return "https://extension.test/" + path; },
              },
            };
          `,
        }));
        buildApi.onLoad({
          filter: /^overlay-controller$/,
          namespace: "top-stub",
        }, () => ({
          loader: "js",
          contents: `
            export function createOverlayFrameController() {
              return {
                isOpen() { return false; },
                open: async () => true,
                close() {},
                dispose() {},
                updateTrail() {},
                updateSettings() {},
                authorizeClaim() { return { ok: true }; },
                getDiagnostics() {
                  return {
                    lastFaultReason: null,
                    surfaceResyncCount: 0,
                    lastOpenKind: null,
                    lastHostOpenLatencyMs: null,
                  };
                },
              };
            }
          `,
        }));
      },
    }],
  });

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    CSS: { supports: () => true },
    MessageChannel: class {
      constructor() {
        this.port1 = { postMessage() {}, start() {}, close() {}, addEventListener() {} };
        this.port2 = { postMessage() {}, start() {}, close() {}, addEventListener() {} };
      }
    },
  });
  globalThis.__topMessageListeners = messageListeners;

  try {
    const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    mod.initTopFrameOverlay();
    assert.equal(messageListeners.size, 1);
    const firstCleanup = dom.window.__tabtrailTopCleanup;
    mod.initTopFrameOverlay();
    assert.equal(messageListeners.size, 1, "re-init must not stack message listeners");
    assert.notEqual(dom.window.__tabtrailTopCleanup, firstCleanup);
    dom.window.__tabtrailTopCleanup();
    assert.equal(messageListeners.size, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    dom.window.close();
    delete globalThis.__topMessageListeners;
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
