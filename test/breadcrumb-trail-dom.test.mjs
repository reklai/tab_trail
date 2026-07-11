import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

async function loadBreadcrumbModule() {
  const tempDir = mkdtempSync(join(tmpdir(), "breadcrumb-trail-dom-"));
  const outfile = join(tempDir, "breadcrumbTrail.mjs");
  await build({
    entryPoints: ["src/lib/ui/panels/breadcrumbTrail/breadcrumbTrail.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    logLevel: "silent",
    loader: { ".css": "text" },
    plugins: [{
      name: "breadcrumb-dom-stubs",
      setup(buildApi) {
        buildApi.onResolve({ filter: /common\/utils\/panelHost$/ }, () => ({
          path: "panel-host",
          namespace: "breadcrumb-stub",
        }));
        buildApi.onResolve({ filter: /^\.\/savedTrailsPanel$/ }, () => ({
          path: "saved-trails-panel",
          namespace: "breadcrumb-stub",
        }));
        buildApi.onResolve({ filter: /adapters\/runtime\/savedTrailsClient$/ }, () => ({
          path: "saved-trails-client",
          namespace: "breadcrumb-stub",
        }));
        buildApi.onLoad({ filter: /^panel-host$/, namespace: "breadcrumb-stub" }, () => ({
          loader: "js",
          contents: `
            export function createPanelHost() {
              const host = document.createElement("div");
              const shadow = host.attachShadow({ mode: "open" });
              document.body.appendChild(host);
              globalThis.__breadcrumbHost = host;
              return { host, shadow };
            }
            export function getBaseStyles() { return ""; }
            export function registerPanelCleanup(cleanup) {
              globalThis.__breadcrumbCleanup = cleanup;
            }
            export function dismissPanel() {
              globalThis.__breadcrumbCleanup?.();
              globalThis.__breadcrumbHost?.remove();
            }
          `,
        }));
        buildApi.onLoad({ filter: /^saved-trails-panel$/, namespace: "breadcrumb-stub" }, () => ({
          loader: "js",
          contents: `
            export function bindSavedTrailsHost(options) {
              globalThis.__boundSavedTrailsHost = options;
            }
            export function unbindSavedTrailsHost() {}
            export function openSaveTrailDialog() {}
            export function toggleSavedTrailsLibrary() {}
          `,
        }));
        buildApi.onLoad({ filter: /^saved-trails-client$/, namespace: "breadcrumb-stub" }, () => ({
          loader: "js",
          contents: "export const browserSavedTrailsClient = {};",
        }));
      },
    }],
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return { mod, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
}

async function loadIntegratedBreadcrumbModule() {
  const tempDir = mkdtempSync(join(tmpdir(), "breadcrumb-trail-integrated-dom-"));
  const outfile = join(tempDir, "breadcrumbTrail.mjs");
  await build({
    entryPoints: ["src/lib/ui/panels/breadcrumbTrail/breadcrumbTrail.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    logLevel: "silent",
    loader: { ".css": "text" },
    plugins: [{
      name: "breadcrumb-integrated-dom-stubs",
      setup(buildApi) {
        buildApi.onResolve({ filter: /common\/utils\/panelHost$/ }, () => ({
          path: "panel-host",
          namespace: "breadcrumb-integrated-stub",
        }));
        buildApi.onResolve({ filter: /^webextension-polyfill$/ }, () => ({
          path: "webextension-polyfill",
          namespace: "breadcrumb-integrated-stub",
        }));
        buildApi.onLoad({ filter: /^panel-host$/, namespace: "breadcrumb-integrated-stub" }, () => ({
          loader: "js",
          contents: `
            export function createPanelHost() {
              const host = document.createElement("div");
              const shadow = host.attachShadow({ mode: "open" });
              document.body.appendChild(host);
              globalThis.__breadcrumbHost = host;
              return { host, shadow };
            }
            export function getBaseStyles() { return ""; }
            export function registerPanelCleanup(cleanup) {
              globalThis.__breadcrumbCleanup = cleanup;
            }
            export function dismissPanel() {
              globalThis.__breadcrumbCleanup?.();
              globalThis.__breadcrumbHost?.remove();
            }
          `,
        }));
        buildApi.onLoad({ filter: /^webextension-polyfill$/, namespace: "breadcrumb-integrated-stub" }, () => ({
          loader: "js",
          contents: `
            if (!globalThis.__breadcrumbStorageListeners) {
              globalThis.__breadcrumbStorageListeners = new Set();
            }
            export default {
              storage: {
                local: {
                  async get(key) {
                    return { [key]: globalThis.__breadcrumbSavedTrails || [] };
                  },
                  async set() {},
                },
                onChanged: {
                  addListener(listener) { globalThis.__breadcrumbStorageListeners.add(listener); },
                  removeListener(listener) { globalThis.__breadcrumbStorageListeners.delete(listener); },
                },
              },
              runtime: {
                async sendMessage() { return { ok: false, reason: "unused" }; },
              },
            };
          `,
        }));
      },
    }],
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return { mod, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
}

function installDom() {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    ShadowRoot: dom.window.ShadowRoot,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
  });
  return dom;
}

function entry(url, title, timestamp) {
  return {
    url,
    title,
    favIconUrl: "",
    timestamp,
    transition: "link",
    redirected: false,
    historyBacked: true,
  };
}

function options(overrides = {}) {
  return {
    settings: {
      maxVisibleSegments: 8,
      overlayPosition: null,
    },
    callbacks: {
      onJump() {},
      onOpenInNewTab() {},
      onOpenInNewWindow() {},
      onOpenOptions() {},
      onClose() {},
      onPositionChange() {},
      ...overrides,
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushTasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("live trail makes the current crumb non-actionable and exposes an accessible preview dialog", async () => {
  const dom = installDom();
  const { mod, cleanup } = await loadBreadcrumbModule();
  let jumps = 0;
  mod.showBreadcrumbTrail({
    entries: [
      entry("https://root.test/start", "Root page", 1000),
      entry("https://current.test/docs", "Current page", 2000),
    ],
    cursor: 1,
  }, options({ onJump() { jumps += 1; } }));

  const shadow = globalThis.__breadcrumbHost.shadowRoot;
  assert.equal(shadow.querySelector(".wf-bar").hasAttribute("data-tabtrail-hit-surface"), true);
  assert.equal(shadow.querySelector(".wf-layer").hasAttribute("data-tabtrail-hit-surface"), false);
  const rows = [...shadow.querySelectorAll(".wf-branch-row")];
  const priorMain = rows[0].querySelector(".wf-branch-row-main");
  const currentMain = rows[1].querySelector(".wf-branch-row-main");

  assert.equal(priorMain.tagName, "BUTTON");
  assert.equal(currentMain.tagName, "DIV");
  assert.equal(currentMain.getAttribute("role"), "group");
  assert.equal(currentMain.getAttribute("aria-current"), "page");
  assert.equal(currentMain.tabIndex, -1);
  currentMain.click();
  assert.equal(jumps, 0, "the current crumb must not trigger navigation");

  const pageInput = document.createElement("input");
  document.body.appendChild(pageInput);
  pageInput.focus();
  rows[0].dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
  }));
  assert.equal(
    shadow.querySelector(".wf-menu")?.hasAttribute("data-tabtrail-hit-surface"),
    true,
  );
  assert.equal(document.activeElement, pageInput, "right-click must preserve page focus");
  pageInput.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
  assert.equal(shadow.querySelector(".wf-menu"), null);
  assert.equal(document.activeElement, pageInput);

  priorMain.focus();
  rows[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  assert.equal(shadow.activeElement?.classList.contains("wf-menu-item"), true);
  shadow.activeElement.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(shadow.querySelector(".wf-menu"), null);

  const previewOpener = rows[0].querySelector(".wf-row-more");
  previewOpener.click();
  const previewAction = [...shadow.querySelectorAll(".wf-menu-item")]
    .find((item) => item.textContent === "Preview");
  assert.ok(previewAction);
  previewAction.click();

  const preview = shadow.querySelector(".wf-preview-pane");
  assert.ok(preview);
  assert.equal(preview.hasAttribute("data-tabtrail-hit-surface"), true);
  assert.equal(preview.getAttribute("role"), "dialog");
  assert.equal(preview.getAttribute("aria-modal"), "false");
  const title = shadow.getElementById(preview.getAttribute("aria-labelledby"));
  const description = shadow.getElementById(preview.getAttribute("aria-describedby"));
  assert.equal(title?.textContent, "Root page");
  assert.equal(description?.textContent, "root.test/start");
  assert.equal(preview.querySelector("iframe").title, "Preview: Root page");
  assert.equal(
    preview.querySelector(".wf-preview-pane-action").getAttribute("aria-label"),
    "Open previewed page in a new tab",
  );
  const close = preview.querySelector(".wf-preview-pane-close");
  assert.equal(close.getAttribute("aria-label"), "Close page preview");
  assert.equal(shadow.activeElement, close);

  close.click();
  await flushMicrotasks();
  assert.equal(shadow.querySelector(".wf-preview-pane"), null);
  assert.equal(shadow.activeElement, previewOpener);

  previewOpener.click();
  [...shadow.querySelectorAll(".wf-menu-item")]
    .find((item) => item.textContent === "Preview")
    .click();
  const secondClose = shadow.querySelector(".wf-preview-pane-close");
  secondClose.click();
  const settingsButton = shadow.querySelector("[data-live-control=settings]");
  settingsButton.focus();
  await flushMicrotasks();
  assert.equal(
    shadow.activeElement,
    settingsButton,
    "preview cleanup must not steal focus from a newer target",
  );

  previewOpener.click();
  [...shadow.querySelectorAll(".wf-menu-item")]
    .find((item) => item.textContent === "Preview")
    .click();
  shadow.querySelector(".wf-preview-pane-close").click();
  pageInput.focus();
  await flushMicrotasks();
  assert.equal(
    document.activeElement,
    pageInput,
    "preview cleanup must not steal focus from a page control",
  );

  const focusedRow = shadow.querySelector(".wf-branch-row .wf-branch-row-main");
  focusedRow.focus();
  mod.updateBreadcrumbTrail({
    entries: [
      entry("https://root.test/start", "Root page updated", 1000),
      entry("https://current.test/docs", "Current page", 2000),
    ],
    cursor: 1,
  });
  await flushMicrotasks();
  const patchedRow = shadow.querySelector(".wf-branch-row .wf-branch-row-main");
  // Title-only updates patch in place so open menus/previews and focus stay put.
  assert.equal(patchedRow, focusedRow);
  assert.equal(shadow.activeElement, patchedRow, "live updates preserve logical row focus");
  assert.equal(
    shadow.querySelector(".wf-branch-entry-title")?.textContent,
    "Root page updated",
  );

  globalThis.__breadcrumbCleanup();
  cleanup();
  dom.window.close();
});

test("metadata patches refresh retained live menus, actions, and previews", async () => {
  const dom = installDom();
  const { mod, cleanup } = await loadBreadcrumbModule();
  const now = Date.now();
  const current = entry("https://current.test/", "Current", now - 30_000);
  mod.showBreadcrumbTrail({
    entries: [entry("https://root.test/start", "Original title", now - 60_000), current],
    cursor: 1,
  }, options());

  const shadow = globalThis.__breadcrumbHost.shadowRoot;
  const more = shadow.querySelector(".wf-branch-row .wf-row-more");
  more.click();
  const menu = shadow.querySelector(".wf-menu");
  const originalMeta = menu.querySelector(".wf-menu-detail-time").textContent;

  mod.updateBreadcrumbTrail({
    entries: [entry("https://root.test/start", "Patched title", now - 7_200_000), current],
    cursor: 1,
  });

  assert.equal(shadow.querySelector(".wf-menu"), menu, "the open menu stays in place");
  assert.equal(menu.querySelector(".wf-menu-detail-title").textContent, "Patched title");
  assert.notEqual(menu.querySelector(".wf-menu-detail-time").textContent, originalMeta);

  [...menu.querySelectorAll(".wf-menu-item")]
    .find((item) => item.textContent === "Preview")
    .click();
  const preview = shadow.querySelector(".wf-preview-pane");
  assert.equal(preview.querySelector(".wf-preview-pane-title").textContent, "Patched title");
  assert.equal(preview.querySelector("iframe").title, "Preview: Patched title");

  mod.updateBreadcrumbTrail({
    entries: [entry("https://root.test/start", "Newest title", now - 14_400_000), current],
    cursor: 1,
  });

  assert.equal(shadow.querySelector(".wf-preview-pane"), preview, "the preview stays open");
  assert.equal(preview.querySelector(".wf-preview-pane-title").textContent, "Newest title");
  assert.equal(preview.querySelector("iframe").title, "Preview: Newest title");

  globalThis.__breadcrumbCleanup();
  cleanup();
  dom.window.close();
});

test("a structural rebuild restores focus to the preview's logical opener", async () => {
  const dom = installDom();
  const { mod, cleanup } = await loadBreadcrumbModule();
  const root = entry("https://root.test/start", "Root", 1000);
  const second = entry("https://second.test/", "Second", 2000);
  mod.showBreadcrumbTrail({ entries: [root, second], cursor: 1 }, options());

  const shadow = globalThis.__breadcrumbHost.shadowRoot;
  const oldOpener = shadow.querySelector(".wf-branch-row .wf-row-more");
  oldOpener.click();
  [...shadow.querySelectorAll(".wf-menu-item")]
    .find((item) => item.textContent === "Preview")
    .click();
  assert.equal(shadow.activeElement, shadow.querySelector(".wf-preview-pane-close"));

  mod.updateBreadcrumbTrail({
    entries: [root, second, entry("https://third.test/", "Third", 3000)],
    cursor: 2,
  });
  await flushMicrotasks();

  const rebuiltOpener = shadow.querySelector(".wf-branch-row .wf-row-more");
  assert.notEqual(rebuiltOpener, oldOpener);
  assert.equal(shadow.querySelector(".wf-preview-pane"), null);
  assert.equal(shadow.activeElement, rebuiltOpener);

  globalThis.__breadcrumbCleanup();
  cleanup();
  dom.window.close();
});

test("non-native history edges use neutral direct-navigation presentation", async () => {
  const dom = installDom();
  const { mod, cleanup } = await loadBreadcrumbModule();
  const directLanding = {
    ...entry("https://landing.test/", "Direct landing", 2000),
    historyBacked: false,
  };
  mod.showBreadcrumbTrail({
    entries: [
      entry("https://redirect.test/", "Redirect source", 1000),
      directLanding,
    ],
    cursor: 1,
  }, options());

  const shadow = globalThis.__breadcrumbHost.shadowRoot;
  const boundaryRow = shadow.querySelectorAll(".wf-branch-row")[1];
  const boundaryMain = boundaryRow.querySelector(".wf-branch-row-main");
  const connector = shadow.querySelector(".wf-branch-connector");

  assert.match(boundaryRow.title, /Direct-navigation boundary/);
  assert.match(boundaryMain.getAttribute("aria-label"), /Direct-navigation boundary/);
  assert.equal(connector.title, "Direct-navigation boundary");
  assert.doesNotMatch(boundaryRow.title, /inherit|another tab/i);
  assert.doesNotMatch(boundaryMain.getAttribute("aria-label"), /inherit|another tab/i);

  globalThis.__breadcrumbCleanup();
  cleanup();
  dom.window.close();
});

test("multiple Undo notices remain recoverable while status notices replace independently", async () => {
  const dom = installDom();
  const { mod, cleanup } = await loadBreadcrumbModule();
  mod.showBreadcrumbTrail({
    entries: [entry("https://current.test/", "Current", 1000)],
    cursor: 0,
  }, options());

  const shadow = globalThis.__breadcrumbHost.shadowRoot;
  const { showNotice } = globalThis.__boundSavedTrailsHost;
  const longDuration = 60_000;
  const restored = [];
  showNotice("Removed Alpha", {
    undo: true,
    actionLabel: "Undo",
    action: async () => { restored.push("Alpha"); },
    durationMs: longDuration,
  });
  showNotice("Pinned Beta", { durationMs: longDuration });

  assert.equal(shadow.querySelectorAll(".wf-notice").length, 2);
  assert.equal(
    [...shadow.querySelectorAll(".wf-notice")].every((notice) =>
      notice.hasAttribute("data-tabtrail-hit-surface")
    ),
    true,
  );
  assert.equal(shadow.querySelector(".wf-notice-undo")?.textContent, "Removed AlphaUndo");
  assert.equal(shadow.querySelector(".wf-notice-status")?.textContent, "Pinned Beta");

  showNotice("Renamed Beta", { durationMs: longDuration });
  assert.equal(shadow.querySelectorAll(".wf-notice-status").length, 1);
  assert.equal(shadow.querySelector(".wf-notice-status")?.textContent, "Renamed Beta");
  assert.equal(shadow.querySelector(".wf-notice-undo")?.textContent, "Removed AlphaUndo");

  showNotice("Removed Beta", {
    undo: true,
    actionLabel: "Undo",
    action: async () => { restored.push("Beta"); },
    durationMs: longDuration,
  });
  const undoNotices = [...shadow.querySelectorAll(".wf-notice-undo")];
  assert.equal(undoNotices.length, 2);
  assert.deepEqual(
    undoNotices.map((notice) => notice.textContent),
    ["Removed AlphaUndo", "Removed BetaUndo"],
  );
  assert.equal(shadow.querySelector(".wf-notice-status")?.textContent, "Renamed Beta");

  const alphaUndo = undoNotices[0].querySelector(".wf-notice-action");
  alphaUndo.focus();
  alphaUndo.click();
  await flushMicrotasks();
  assert.deepEqual(restored, ["Alpha"]);
  assert.equal(shadow.querySelectorAll(".wf-notice-undo").length, 1);
  const betaUndo = shadow.querySelector(".wf-notice-undo .wf-notice-action");
  assert.equal(shadow.activeElement, betaUndo, "focus advances to the remaining recovery action");

  betaUndo.click();
  await flushMicrotasks();
  assert.deepEqual(restored, ["Alpha", "Beta"]);
  assert.equal(shadow.querySelector(".wf-notice-undo"), null);
  assert.equal(shadow.querySelector(".wf-notice-status")?.textContent, "Renamed Beta");
  assert.equal(
    shadow.activeElement,
    shadow.querySelector("[data-live-control=library]"),
    "removing the final focused recovery notice returns focus to the trail",
  );

  globalThis.__breadcrumbCleanup();
  cleanup();
  dom.window.close();
});

test("a disappearing more control falls back to the stable library button", async () => {
  const dom = installDom();
  const { mod, cleanup } = await loadBreadcrumbModule();
  const entries = Array.from({ length: 10 }, (_, index) =>
    entry(`https://trail.test/${index}`, `Page ${index}`, 1000 + index));
  mod.showBreadcrumbTrail({ entries, cursor: 9 }, options());

  const shadow = globalThis.__breadcrumbHost.shadowRoot;
  const expand = shadow.querySelector("[data-live-control=expand]");
  assert.ok(expand);
  expand.focus();
  mod.updateBreadcrumbTrail({ entries: entries.slice(0, 2), cursor: 1 });
  await flushMicrotasks();

  assert.equal(shadow.querySelector("[data-live-control=expand]"), null);
  assert.equal(shadow.activeElement, shadow.querySelector("[data-live-control=library]"));
  globalThis.__breadcrumbCleanup();
  cleanup();
  dom.window.close();
});

test("dismissing mid-drag cannot move or persist a later overlay session", async () => {
  const dom = installDom();
  const { mod, cleanup } = await loadBreadcrumbModule();
  const persistedPositions = [];
  const state = {
    entries: [entry("https://current.test/", "Current", 1000)],
    cursor: 0,
  };
  mod.showBreadcrumbTrail(state, options());
  const firstShadow = globalThis.__breadcrumbHost.shadowRoot;
  firstShadow.querySelector(".wf-grip").dispatchEvent(new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    clientX: 100,
    clientY: 40,
  }));
  globalThis.__breadcrumbCleanup();

  mod.showBreadcrumbTrail(state, options({
    onPositionChange(position) { persistedPositions.push(position); },
  }));
  const nextBar = globalThis.__breadcrumbHost.shadowRoot.querySelector(".wf-bar");
  assert.equal(nextBar.style.left, "50%");
  assert.equal(nextBar.style.top, "8%");

  window.dispatchEvent(new MouseEvent("pointermove", {
    bubbles: true,
    clientX: 500,
    clientY: 300,
  }));
  window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));

  assert.equal(nextBar.style.left, "50%");
  assert.equal(nextBar.style.top, "8%");
  assert.deepEqual(persistedPositions, []);
  globalThis.__breadcrumbCleanup();
  cleanup();
  dom.window.close();
});

test("blocking saved surfaces disable stale rows and flush the newest state on close", async () => {
  const dom = installDom();
  const pageInput = document.createElement("input");
  pageInput.value = "page sentinel";
  document.body.appendChild(pageInput);
  pageInput.focus();
  let pageKeydowns = 0;
  let pageInputs = 0;
  let pageWheels = 0;
  let videoFullscreen = false;
  document.addEventListener("keydown", (event) => {
    pageKeydowns += 1;
    if (event.key.toLocaleLowerCase() === "f") videoFullscreen = true;
    if (event.key.length === 1) pageInput.value += event.key;
  });
  document.addEventListener("input", () => { pageInputs += 1; });
  document.addEventListener("wheel", () => { pageWheels += 1; });
  globalThis.__breadcrumbSavedTrails = [];
  const { mod, cleanup } = await loadIntegratedBreadcrumbModule();
  const jumps = [];
  const initial = [
    entry("https://trail.test/a", "Page A", 1000),
    entry("https://trail.test/b", "Page B", 2000),
  ];
  mod.showBreadcrumbTrail({ entries: initial, cursor: 1 }, options({
    onJump(index) { jumps.push(index); },
  }));
  const shadow = globalThis.__breadcrumbHost.shadowRoot;
  const bar = shadow.querySelector(".wf-bar");

  mod.updateBreadcrumbTrailSettings(options().settings);
  const libraryButton = shadow.querySelector("[data-live-control=library]");
  libraryButton.focus();
  libraryButton.click();
  await flushTasks();
  assert.equal(shadow.querySelector(".wf-library-sort"), null);
  const search = shadow.querySelector(".wf-library-search");
  assert.equal(shadow.activeElement, search);
  search.dispatchEvent(new KeyboardEvent("keydown", {
    key: "f",
    bubbles: true,
    composed: true,
  }));
  search.value = "f";
  search.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  const overlayWheel = new window.WheelEvent("wheel", {
    deltaY: 120,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  shadow.querySelector(".wf-library-list").dispatchEvent(overlayWheel);
  assert.equal(pageKeydowns, 0);
  assert.equal(pageInputs, 0);
  assert.equal(pageWheels, 0);
  assert.equal(videoFullscreen, false, "page video hotkeys cannot observe search typing");
  assert.equal(pageInput.value, "page sentinel");
  assert.equal(overlayWheel.defaultPrevented, true, "wheel cannot chain into the page");
  assert.equal(bar.inert, true);
  assert.equal(bar.classList.contains("wf-bar-blocked"), true);
  assert.match(bar.textContent, /Page A/);

  const shifted = [
    entry("https://trail.test/x", "Page X", 500),
    ...initial,
  ];
  mod.updateBreadcrumbTrail({ entries: shifted, cursor: 2 });
  assert.match(bar.textContent, /Page A/);
  assert.doesNotMatch(bar.textContent, /Page X/);

  shadow.querySelector(".wf-library-close").click();
  await flushTasks();
  assert.equal(bar.inert, false);
  assert.equal(bar.classList.contains("wf-bar-blocked"), false);
  assert.match(bar.textContent, /Page X/);
  shadow.querySelector(".wf-branch-row .wf-branch-row-main").click();
  assert.deepEqual(jumps, [0]);

  pageInput.dispatchEvent(new KeyboardEvent("keydown", {
    key: "y",
    bubbles: true,
    composed: true,
  }));
  pageInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  pageInput.dispatchEvent(new window.WheelEvent("wheel", {
    deltaY: 120,
    bubbles: true,
    cancelable: true,
    composed: true,
  }));
  assert.equal(pageKeydowns, 1);
  assert.equal(pageInputs, 1);
  assert.equal(pageWheels, 1);
  assert.equal(pageInput.value, "page sentinely");

  globalThis.__breadcrumbCleanup();
  cleanup();
  dom.window.close();
});

test("saved-trail mutation ownership survives overlay hibernation", async () => {
  const dom = installDom();
  const { mod, cleanup } = await loadIntegratedBreadcrumbModule();
  const saved = {
    id: "saved-one",
    name: "Saved one",
    pinned: false,
    createdAt: 1000,
    updatedAt: 1000,
    entries: [entry("https://saved.test/", "Saved page", 1000)],
  };
  let resolveFirstMutation;
  const firstMutation = new Promise((resolve) => {
    resolveFirstMutation = resolve;
  });
  let pinCalls = 0;
  const client = {
    async load() { return [saved]; },
    subscribe() { return () => {}; },
    async setPinned() {
      pinCalls += 1;
      if (pinCalls === 1) return firstMutation;
      return { ok: true, trails: [{ ...saved, pinned: true }] };
    },
  };
  const liveState = {
    entries: [entry("https://current.test/", "Current", 2000)],
    cursor: 0,
  };
  const trailOptions = { ...options(), savedTrailsClient: client };

  mod.showBreadcrumbTrail(liveState, trailOptions);
  let shadow = globalThis.__breadcrumbHost.shadowRoot;
  shadow.querySelector("[data-live-control=library]").click();
  await flushTasks();
  shadow.querySelector(".wf-library-pin").click();
  await flushMicrotasks();
  assert.equal(pinCalls, 1);
  assert.equal(shadow.querySelector(".wf-library-pin").disabled, true);

  globalThis.__breadcrumbCleanup();
  mod.showBreadcrumbTrail(liveState, trailOptions);
  shadow = globalThis.__breadcrumbHost.shadowRoot;
  shadow.querySelector("[data-live-control=library]").click();
  await flushTasks();

  const pendingPin = shadow.querySelector(".wf-library-pin");
  assert.equal(pendingPin.disabled, true, "the reopened overlay retains the in-flight owner");
  pendingPin.click();
  assert.equal(pinCalls, 1, "a second mutation cannot overlap the first");

  resolveFirstMutation({ ok: true, trails: [{ ...saved, pinned: true }] });
  await flushTasks();
  const releasedPin = shadow.querySelector(".wf-library-pin");
  assert.equal(releasedPin.disabled, false, "settling the owner refreshes the reopened library");
  releasedPin.click();
  await flushTasks();
  assert.equal(pinCalls, 2);

  globalThis.__breadcrumbCleanup();
  cleanup();
  dom.window.close();
});
