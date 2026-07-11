import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const entry = {
  url: "https://example.test/page",
  title: "Example page",
  favIconUrl: "",
  timestamp: 1,
  transition: "link",
  redirected: false,
  historyBacked: true,
};

async function loadPreviewModule() {
  const tempDir = mkdtempSync(join(tmpdir(), "live-trail-preview-"));
  const outfile = join(tempDir, "liveTrailPreview.mjs");
  await build({
    entryPoints: ["src/lib/ui/panels/breadcrumbTrail/liveTrailPreview.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile,
    logLevel: "silent",
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return {
    mod,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "chrome-extension://test/overlayFrame.html",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.MouseEvent = window.MouseEvent;
  return {
    window,
    cleanup: () => {
      dom.window.close();
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.HTMLElement;
      delete globalThis.Node;
      delete globalThis.MouseEvent;
    },
  };
}

test("preview shows loading then blocked fallback without an iframe when probe denies", async (t) => {
  const dom = installDom();
  t.after(dom.cleanup);
  const { mod, cleanup } = await loadPreviewModule();
  t.after(cleanup);

  const layer = document.createElement("div");
  document.body.appendChild(layer);
  const bar = document.createElement("div");
  document.body.appendChild(bar);

  const preview = mod.createLiveTrailPreview(() => layer, () => bar, {
    probeFramability: async () => ({
      framable: "no",
      reason: "This site blocks embedding, so a live preview isn’t available.",
    }),
  });
  preview.open(
    null,
    entry,
    { onOpenInNewTab() {}, onJump() {}, onCopyUrl() {} },
    null,
  );

  const pane = layer.querySelector(".wf-preview-pane");
  assert.ok(pane);
  assert.equal(pane.dataset.previewState, "loading");
  assert.ok(pane.querySelector(".wf-preview-pane-loading"));

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(pane.dataset.previewState, "blocked");
  assert.equal(pane.querySelector("iframe"), null);
  const detail = pane.querySelector(".wf-preview-pane-fallback-detail");
  assert.match(detail?.textContent ?? "", /blocks embedding/i);
  const labels = [...pane.querySelectorAll(".wf-preview-pane-fallback-action")]
    .map((button) => button.textContent);
  assert.deepEqual(labels, ["Open in this tab", "Open in new tab", "Copy URL"]);
  preview.close();
});

test("preview mounts a hidden iframe while loading when probe is unknown", async (t) => {
  const dom = installDom();
  t.after(dom.cleanup);
  const { mod, cleanup } = await loadPreviewModule();
  t.after(cleanup);

  const layer = document.createElement("div");
  document.body.appendChild(layer);
  const bar = document.createElement("div");
  document.body.appendChild(bar);

  const preview = mod.createLiveTrailPreview(() => layer, () => bar, {
    probeFramability: async () => ({ framable: "unknown" }),
  });
  preview.open(
    null,
    entry,
    { onOpenInNewTab() {}, onJump() {} },
    null,
  );

  await Promise.resolve();
  await Promise.resolve();

  const pane = layer.querySelector(".wf-preview-pane");
  const frame = pane?.querySelector("iframe");
  assert.ok(frame);
  assert.equal(frame.hidden, true);
  assert.equal(frame.src, entry.url);
  assert.equal(frame.getAttribute("sandbox"), "allow-forms allow-popups allow-scripts");
  assert.equal(pane.dataset.previewState, "loading");
  assert.ok(pane.querySelector(".wf-preview-pane-loading"));
  preview.close();
});

test("about:blank load does not mark preview ready", async (t) => {
  const dom = installDom();
  t.after(dom.cleanup);
  const { mod, cleanup } = await loadPreviewModule();
  t.after(cleanup);

  const layer = document.createElement("div");
  document.body.appendChild(layer);
  const bar = document.createElement("div");
  document.body.appendChild(bar);

  const preview = mod.createLiveTrailPreview(() => layer, () => bar, {
    probeFramability: async () => ({ framable: "yes" }),
  });
  preview.open(
    null,
    entry,
    { onOpenInNewTab() {}, onJump() {} },
    null,
  );

  await Promise.resolve();
  await Promise.resolve();

  const pane = layer.querySelector(".wf-preview-pane");
  const frame = pane?.querySelector("iframe");
  assert.ok(frame);
  // Simulate an intermediate blank load (readable same-origin about:blank).
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    get: () => ({ location: { href: "about:blank" } }),
  });
  frame.dispatchEvent(new dom.window.Event("load"));
  assert.equal(pane.dataset.previewState, "loading");
  assert.equal(frame.hidden, true);

  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    get: () => {
      throw new dom.window.DOMException("Blocked a frame with origin", "SecurityError");
    },
  });
  frame.dispatchEvent(new dom.window.Event("load"));
  assert.equal(pane.dataset.previewState, "ready");
  assert.equal(frame.hidden, false);
  preview.close();
});

test("setBodyState ready path does not wipe a mounted iframe", async (t) => {
  const dom = installDom();
  t.after(dom.cleanup);
  const { mod, cleanup } = await loadPreviewModule();
  t.after(cleanup);

  const layer = document.createElement("div");
  document.body.appendChild(layer);
  const bar = document.createElement("div");
  document.body.appendChild(bar);

  const preview = mod.createLiveTrailPreview(() => layer, () => bar, {
    probeFramability: async () => ({ framable: "yes" }),
  });
  preview.open(
    null,
    entry,
    { onOpenInNewTab() {}, onJump() {} },
    null,
  );

  await Promise.resolve();
  await Promise.resolve();

  const pane = layer.querySelector(".wf-preview-pane");
  const frame = pane?.querySelector("iframe");
  assert.ok(frame);
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    get: () => {
      throw new dom.window.DOMException("cross-origin", "SecurityError");
    },
  });
  frame.dispatchEvent(new dom.window.Event("load"));
  assert.equal(pane.dataset.previewState, "ready");
  assert.equal(pane.querySelector("iframe"), frame);
  preview.close();
});

test("fallback open-in-this-tab invokes onJump", async (t) => {
  const dom = installDom();
  t.after(dom.cleanup);
  const { mod, cleanup } = await loadPreviewModule();
  t.after(cleanup);

  const layer = document.createElement("div");
  document.body.appendChild(layer);
  const bar = document.createElement("div");
  document.body.appendChild(bar);

  let jumped = 0;
  let opened = 0;
  const preview = mod.createLiveTrailPreview(() => layer, () => bar, {
    probeFramability: async () => ({ framable: "no", reason: "blocked" }),
  });
  preview.open(
    null,
    entry,
    {
      onOpenInNewTab() {
        opened += 1;
      },
      onJump() {
        jumped += 1;
      },
    },
    null,
  );

  await Promise.resolve();
  await Promise.resolve();

  const jumpBtn = [...layer.querySelectorAll("button")]
    .find((button) => button.textContent === "Open in this tab");
  assert.ok(jumpBtn);
  jumpBtn.click();
  assert.equal(jumped, 1);
  assert.equal(opened, 0);
  preview.close();
});
