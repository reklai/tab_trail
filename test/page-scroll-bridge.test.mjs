import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadBridge() {
  const tempDir = mkdtempSync(join(tmpdir(), "page-scroll-bridge-"));
  const outfile = join(tempDir, "pageScrollBridge.mjs");
  await build({
    entryPoints: ["src/lib/appInit/pageScrollBridge.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "stub-api",
      setup(buildApi) {
        buildApi.onResolve({ filter: /tabtrailApi$/ }, () => ({
          path: "tabtrail-api-stub",
          namespace: "stub",
        }));
        buildApi.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          loader: "js",
          contents: `
            export async function reportTrailScroll(url, viewport, options) {
              globalThis.__scrollReports = globalThis.__scrollReports || [];
              globalThis.__scrollReports.push({ url, viewport, options, kind: "normal" });
            }
            export async function reportTrailScrollWithRetry(url, viewport) {
              globalThis.__scrollReports = globalThis.__scrollReports || [];
              globalThis.__scrollReports.push({ url, viewport, kind: "retry" });
            }
          `,
        }));
      },
    }],
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return { mod, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
}

function installDom(html = "<!doctype html><html><body style='height:5000px'></body></html>") {
  const dom = new JSDOM(html, {
    url: "https://example.test/article",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // Minimal scroll API for document root.
  Object.defineProperty(window, "scrollX", { value: 0, writable: true, configurable: true });
  Object.defineProperty(window, "scrollY", { value: 0, writable: true, configurable: true });
  window.scrollTo = (xOrOpts, y) => {
    if (typeof xOrOpts === "object" && xOrOpts) {
      window.scrollX = xOrOpts.left ?? 0;
      window.scrollY = xOrOpts.top ?? 0;
    } else {
      window.scrollX = xOrOpts || 0;
      window.scrollY = y || 0;
    }
    const se = window.document.scrollingElement || window.document.documentElement;
    if (se) {
      se.scrollLeft = window.scrollX;
      se.scrollTop = window.scrollY;
    }
  };
  const se = window.document.documentElement;
  Object.defineProperty(se, "scrollHeight", { value: 5000, configurable: true });
  Object.defineProperty(se, "clientHeight", { value: 800, configurable: true });
  Object.defineProperty(se, "scrollWidth", { value: 800, configurable: true });
  Object.defineProperty(se, "clientWidth", { value: 800, configurable: true });
  se.scrollTop = 0;
  se.scrollLeft = 0;

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.CSSStyleDeclaration = window.CSSStyleDeclaration;
  globalThis.PageTransitionEvent = window.Event;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.__scrollReports = [];
  return { window, dom };
}

function teardownDom(dom) {
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.HTMLElement;
  delete globalThis.Element;
  delete globalThis.Node;
  delete globalThis.CSSStyleDeclaration;
  delete globalThis.PageTransitionEvent;
  delete globalThis.ResizeObserver;
  delete globalThis.requestAnimationFrame;
  delete globalThis.__scrollReports;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("pageScrollBridge samples after scroll debounce and flushes on pagehide", async (t) => {
  const { mod, cleanup } = await loadBridge();
  t.after(cleanup);
  const { window, dom } = installDom();
  const bridge = mod.installPageScrollBridge();
  t.after(() => {
    bridge.dispose();
    teardownDom(dom);
  });

  window.scrollTo(0, 400);
  window.dispatchEvent(new window.Event("scroll"));
  await sleep(250);
  assert.ok(globalThis.__scrollReports.length >= 1);
  assert.equal(globalThis.__scrollReports.at(-1).viewport.y, 400);

  window.scrollTo(0, 900);
  window.dispatchEvent(new window.Event("pagehide"));
  await sleep(20);
  const retry = globalThis.__scrollReports.filter((r) => r.kind === "retry");
  assert.ok(retry.length >= 1);
  assert.equal(retry.at(-1).viewport.y, 900);
});

test("restore gate suppresses samples until generation clears", async (t) => {
  const { mod, cleanup } = await loadBridge();
  t.after(cleanup);
  const { window, dom } = installDom();
  const bridge = mod.installPageScrollBridge();

  const before = globalThis.__scrollReports.length;
  const response = await bridge.handleRestoreScroll({
    url: "https://example.test/article",
    viewport: { x: 0, y: 1200, root: "document", scrollHeight: 5000 },
    mode: "force",
    generation: 1,
  });
  assert.equal(response.ok, true);
  assert.equal(bridge.isRestoreGateActive(), true);

  window.scrollTo(0, 50);
  window.dispatchEvent(new window.Event("scroll"));
  await sleep(250);
  // No new samples while restore gate is live (multi-attempt may still run).
  const midRestoreReports = globalThis.__scrollReports.length - before;
  // Accept is immediate; any reports would be sample pollution — expect none from scroll.
  assert.equal(midRestoreReports, 0);

  bridge.dispose();
  await sleep(50);
  teardownDom(dom);
});

test("force restore rejects url mismatch without arming generation", async (t) => {
  const { mod, cleanup } = await loadBridge();
  t.after(cleanup);
  const { dom } = installDom();
  const bridge = mod.installPageScrollBridge();
  t.after(() => {
    bridge.dispose();
    teardownDom(dom);
  });

  const response = await bridge.handleRestoreScroll({
    url: "https://other.test/page",
    viewport: { x: 0, y: 100, root: "document" },
    mode: "corrective",
    generation: 3,
  });
  assert.equal(response.ok, false);
  assert.equal(response.reason, "url-mismatch");
  assert.equal(bridge.isRestoreGateActive(), false);
});

test("stale generation is rejected without cancelling a newer restore", async (t) => {
  const { mod, cleanup } = await loadBridge();
  t.after(cleanup);
  const { window, dom } = installDom();
  const bridge = mod.installPageScrollBridge();

  const newer = await bridge.handleRestoreScroll({
    url: "https://example.test/article",
    viewport: { x: 0, y: 800, root: "document", scrollHeight: 5000 },
    mode: "force",
    generation: 5,
  });
  assert.equal(newer.ok, true);
  assert.equal(bridge.isRestoreGateActive(), true);

  const stale = await bridge.handleRestoreScroll({
    url: "https://example.test/article",
    viewport: { x: 0, y: 10, root: "document" },
    mode: "force",
    generation: 2,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale-generation");
  assert.equal(bridge.isRestoreGateActive(), true);
  // Live restore still targets generation 5's URL gate.
  assert.equal(window.location.href, "https://example.test/article");

  // Dispose before teardown so async multi-attempt cleanup cannot race DOM death.
  bridge.dispose();
  await sleep(50);
  teardownDom(dom);
});

test("pageScrollBridge source binds nested element scroll listeners", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const source = readFileSync(
    resolve(process.cwd(), "src/lib/appInit/pageScrollBridge.ts"),
    "utf8",
  );
  assert.match(source, /findPrimaryNestedScroller/);
  assert.match(source, /bindNestedRoot/);
  assert.match(source, /addEventListener\("scroll", onNestedScroll/);
  assert.match(source, /root === "element"/);
  assert.match(source, /isAllowedRootSelector/);
  assert.match(source, /collectNestedCandidates/);
  // Soft-nav must not use unload flush:true path.
  assert.match(source, /flushSampleSoft/);
  assert.match(source, /flushSampleUnload/);
  assert.doesNotMatch(
    source,
    /pushState[\s\S]{0,200}flushSampleUnload|replaceState[\s\S]{0,200}flushSampleUnload/,
  );
  // Chord stays free of scroll logic.
  const chord = readFileSync(
    resolve(process.cwd(), "src/lib/appInit/chordCapture.ts"),
    "utf8",
  );
  assert.doesNotMatch(chord, /TRAIL_SCROLL|pageScrollBridge|scrollY/);
});
