import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

async function loadPanelModule() {
  const tempDir = mkdtempSync(join(tmpdir(), "saved-trails-panel-dom-"));
  const outfile = join(tempDir, "savedTrailsPanel.mjs");
  await build({
    entryPoints: ["src/lib/ui/panels/breadcrumbTrail/savedTrailsPanel.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    logLevel: "silent",
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
    Node: dom.window.Node,
    ShadowRoot: dom.window.ShadowRoot,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
  });
  return dom;
}

function entry(url, title) {
  return {
    url,
    title,
    favIconUrl: "",
    timestamp: 1000,
    transition: "link",
    redirected: false,
    historyBacked: true,
  };
}

function savedTrail(id, name, url, options = {}) {
  return {
    id,
    name,
    pinned: options.pinned ?? false,
    createdAt: options.createdAt ?? 1000,
    updatedAt: options.updatedAt ?? 1000,
    entries: options.entries ?? [entry(url, options.title ?? name)],
  };
}

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function testSavedTrailsClient() {
  globalThis.__savedTrailStorageListeners ??= new Set();
  const send = (message) => globalThis.__savedTrailSend(message);
  return {
    async load() {
      const result = await globalThis.__savedTrailGet("tabtrailSavedTrails");
      return result.tabtrailSavedTrails ?? [];
    },
    subscribe(onChanged) {
      const listener = (changes, areaName) => {
        if (areaName !== "local" || !changes.tabtrailSavedTrails) return;
        onChanged(changes.tabtrailSavedTrails.newValue ?? []);
      };
      globalThis.__savedTrailStorageListeners.add(listener);
      return () => globalThis.__savedTrailStorageListeners.delete(listener);
    },
    open: (path, mode) => send({ type: "SAVED_TRAIL_OPEN", path, mode }),
    save: (path, name) => send({ type: "SAVED_TRAIL_SAVE", path, name }),
    rename: (id, name) => send({ type: "SAVED_TRAIL_RENAME", id, name }),
    replace: (id, path, expectedPath) =>
      send({ type: "SAVED_TRAIL_REPLACE", id, path, expectedPath }),
    setPinned: (id, pinned) => send({ type: "SAVED_TRAIL_SET_PINNED", id, pinned }),
    delete: (id) => send({ type: "SAVED_TRAIL_DELETE", id }),
    restore: (trail) => send({ type: "SAVED_TRAIL_RESTORE", trail }),
  };
}

test("saved library exposes async states, management controls, sync, and Undo", async () => {
  const dom = installDom();
  const { mod, cleanup } = await loadPanelModule();
  let liveState = { entries: [entry("https://live.test/", "Live")], cursor: 0 };
  let trails = [
    savedTrail("a", "Alpha", "https://alpha.test/", { updatedAt: 2000 }),
    savedTrail("b", "Beta", "https://beta.test/finish", {
      entries: [
        entry("https://beta.test/docs", "API Documentation"),
        {
          ...entry("https://beta.test/finish", "Beta finish"),
          historyBacked: false,
        },
      ],
    }),
  ];
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  globalThis.__savedTrailGet = async (key) => {
    await loadGate;
    return { [key]: trails };
  };
  const sent = [];
  let failNextRename = false;
  globalThis.__savedTrailSend = async (message) => {
    sent.push(message);
    if (message.type === "SAVED_TRAIL_RENAME") {
      if (failNextRename) {
        failNextRename = false;
        return { ok: false, reason: "Rename failed" };
      }
      const original = trails.find((trail) => trail.id === message.id);
      const renamed = { ...original, name: message.name, updatedAt: original.updatedAt + 1 };
      trails = trails.map((trail) => trail.id === message.id ? renamed : trail);
      return { ok: true, trail: renamed, trails };
    }
    if (message.type === "SAVED_TRAIL_REPLACE") {
      const original = trails.find((trail) => trail.id === message.id);
      if (
        message.expectedPath &&
        JSON.stringify(message.expectedPath) !== JSON.stringify(original.entries)
      ) {
        return { ok: false, reason: "Trail changed before replacement" };
      }
      const previousTrail = structuredClone(original);
      const replaced = {
        ...original,
        entries: structuredClone(message.path),
        updatedAt: original.updatedAt + 1,
      };
      trails = trails.map((trail) => trail.id === message.id ? replaced : trail);
      return { ok: true, trail: replaced, previousTrail, trails };
    }
    if (message.type === "SAVED_TRAIL_DELETE") {
      const deleted = trails.find((trail) => trail.id === message.id);
      trails = trails.filter((trail) => trail.id !== message.id);
      return { ok: true, trail: deleted, trails };
    }
    if (message.type === "SAVED_TRAIL_RESTORE") {
      trails = [message.trail, ...trails];
      return { ok: true, trail: message.trail, trails };
    }
    if (message.type === "SAVED_TRAIL_SET_PINNED") {
      trails = trails.map((trail) => trail.id === message.id
        ? { ...trail, pinned: message.pinned }
        : trail);
      return { ok: true, trail: trails.find((trail) => trail.id === message.id), trails };
    }
    return { ok: false, reason: "Unexpected test message" };
  };
  globalThis.__savedTrailSet = async () => {};

  const shell = document.createElement("div");
  const shadow = shell.attachShadow({ mode: "open" });
  const layer = document.createElement("div");
  const bar = document.createElement("div");
  const opener = document.createElement("button");
  opener.textContent = "Library";
  shadow.append(layer, bar, opener);
  document.body.appendChild(shell);
  opener.focus();
  const notices = [];
  mod.bindSavedTrailsHost({
    layer,
    bar,
    client: testSavedTrailsClient(),
    getState: () => liveState,
    showNotice: (message, options = {}) => notices.push({ message, options }),
    hideTrail() {},
    closeLiveSurfaces() {},
    flushLiveTrailUpdates() {},
    restoreLiveFocus() {},
    setLiveInteractionBlocked() {},
  });

  mod.toggleSavedTrailsLibrary();
  const loadingPanel = shadow.querySelector(".wf-library-panel");
  assert.ok(loadingPanel, "the shell appears before storage resolves");
  assert.equal(loadingPanel.hasAttribute("data-tabtrail-hit-surface"), true);
  assert.equal(layer.hasAttribute("data-tabtrail-hit-surface"), false);
  assert.equal(loadingPanel.getAttribute("aria-busy"), "true");
  assert.match(loadingPanel.textContent, /Loading saved trails/);
  mod.toggleSavedTrailsLibrary();
  assert.equal(loadingPanel.isConnected, false, "Escape/toggle-close is safe during loading");
  opener.focus();
  mod.toggleSavedTrailsLibrary();
  const panel = shadow.querySelector(".wf-library-panel");

  releaseLoad();
  await flushAsync();
  assert.equal(panel.getAttribute("aria-busy"), "false");
  assert.equal(panel.querySelectorAll(".wf-library-row").length, 2);
  assert.equal(panel.querySelector(".wf-library-count").textContent, "2/50");

  const search = panel.querySelector(".wf-library-search");
  assert.equal(search.placeholder, "Search trails…");
  assert.equal(search.getAttribute("aria-label"), "Fuzzy-search saved trails");
  assert.equal(panel.querySelector(".wf-library-sort"), null);
  search.value = "dcmnt";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(panel.querySelectorAll(".wf-library-row").length, 1);
  assert.match(panel.textContent, /Beta/);
  assert.match(panel.querySelector(".wf-library-row-meta").textContent, /API Documentation/);
  assert.equal(
    [...panel.querySelectorAll(".wf-library-row-meta .wf-library-search-match")]
      .map((match) => match.textContent)
      .join(""),
    "Dcmnt",
  );
  assert.match(panel.querySelector(".wf-library-count").textContent, /1 match/);

  search.value = "bt";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(
    [...panel.querySelectorAll(".wf-library-row-name .wf-library-search-match")]
      .map((match) => match.textContent)
      .join(""),
    "Bt",
  );
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(panel.querySelectorAll(".wf-library-search-match").length, 0);

  panel.querySelector(".wf-library-pin").click();
  await flushAsync();
  assert.equal(sent.at(-1).type, "SAVED_TRAIL_SET_PINNED");

  const row = (id) => [...panel.querySelectorAll(".wf-library-row")]
    .find((candidate) => candidate.dataset.trailId === id);
  const alphaMain = row("a").querySelector(".wf-library-row-main");
  const alphaMore = row("a").querySelector(".wf-row-more");
  const betaMore = row("b").querySelector(".wf-row-more");
  assert.equal(alphaMain.tagName, "DIV", "saved-trail text is not a left-click action");
  alphaMain.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(shadow.querySelector(".wf-menu"), null);

  row("a").dispatchEvent(new dom.window.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
  }));
  assert.ok(shadow.querySelector(".wf-menu"), "right-click still opens the saved-trail menu");
  alphaMore.click();
  assert.equal(
    shadow.querySelector(".wf-menu"),
    null,
    "⋯ closes the same menu after it was opened by right-click",
  );

  alphaMore.click();
  assert.ok(shadow.querySelector(".wf-menu"));
  assert.equal(alphaMore.getAttribute("aria-expanded"), "true");
  alphaMore.click();
  assert.equal(shadow.querySelector(".wf-menu"), null, "the same ⋯ toggles its menu closed");
  assert.equal(alphaMore.getAttribute("aria-expanded"), "false");

  alphaMore.click();
  betaMore.click();
  assert.equal(shadow.querySelectorAll(".wf-menu").length, 1);
  assert.equal(shadow.querySelector(".wf-menu-detail-title").textContent, "Beta");
  assert.equal(alphaMore.getAttribute("aria-expanded"), "false");
  assert.equal(betaMore.getAttribute("aria-expanded"), "true");
  betaMore.click();
  assert.equal(shadow.querySelector(".wf-menu"), null);

  const invokeMenuAction = (id, label) => {
    const more = row(id).querySelector(".wf-row-more");
    more.focus();
    more.click();
    const action = [...shadow.querySelectorAll(".wf-menu-item")]
      .find((item) => item.textContent === label);
    assert.ok(action, `${label} is available for ${id}`);
    action.click();
    return more;
  };

  invokeMenuAction("b", "Preview");
  const savedTreePreview = shadow.querySelector(".wf-trail-tree-preview");
  assert.equal(savedTreePreview?.hasAttribute("data-tabtrail-hit-surface"), true);
  assert.match(
    savedTreePreview.querySelector(".wf-trail-tree-preview-meta").textContent,
    /Contains direct-navigation steps/,
  );
  assert.doesNotMatch(savedTreePreview.textContent, /Inherited path/i);
  assert.equal(
    savedTreePreview.querySelector(".wf-branch-connector").title,
    "Direct-navigation boundary",
  );
  savedTreePreview.querySelector(".wf-trail-tree-preview-close").click();

  const renameMore = row("a").querySelector(".wf-row-more");
  renameMore.focus();
  renameMore.click();
  const managementLabels = [...shadow.querySelectorAll(".wf-menu-item")]
    .map((item) => item.textContent);
  assert.ok(
    managementLabels.indexOf("Update from current path") < managementLabels.indexOf("Rename"),
    "Update from current path precedes Rename",
  );
  assert.equal(
    managementLabels.some((label) => label.startsWith("Duplicate")),
    false,
    "saved trails cannot be duplicated from the menu",
  );
  [...shadow.querySelectorAll(".wf-menu-item")]
    .find((button) => button.textContent === "Rename")
    .click();
  const renameInput = shadow.querySelector(".wf-dialog-input");
  assert.equal(
    shadow.querySelector(".wf-dialog")?.hasAttribute("data-tabtrail-hit-surface"),
    true,
  );
  assert.equal(shadow.activeElement, renameInput);
  failNextRename = true;
  renameInput.value = "Rejected rename";
  [...shadow.querySelectorAll(".wf-dialog-btn")]
    .find((button) => button.textContent === "Rename")
    .click();
  await flushAsync();
  assert.equal(shadow.querySelector(".wf-dialog-input"), renameInput);
  assert.equal(renameInput.disabled, false);
  assert.equal(shadow.activeElement, renameInput);
  assert.match(shadow.querySelector(".wf-dialog-error").textContent, /Rename failed/);

  renameInput.value = "Alpha renamed";
  [...shadow.querySelectorAll(".wf-dialog-btn")]
    .find((button) => button.textContent === "Rename")
    .click();
  await flushAsync();
  assert.deepEqual(sent.at(-1), {
    type: "SAVED_TRAIL_RENAME",
    id: "a",
    name: "Alpha renamed",
  });
  assert.match(row("a").textContent, /Alpha renamed/);
  assert.equal(shadow.activeElement, row("a").querySelector(".wf-row-more"));

  const capturedPath = [
    entry("https://live.test/", "Live"),
    entry("https://live.test/captured", "Captured endpoint"),
  ];
  liveState = { entries: capturedPath, cursor: 1 };
  const expectedPath = structuredClone(trails.find((trail) => trail.id === "a").entries);
  invokeMenuAction("a", "Update from current path");
  const replaceButton = [...shadow.querySelectorAll(".wf-dialog-btn")]
    .find((button) => button.textContent === "Replace path");
  assert.ok(replaceButton);
  assert.equal(shadow.activeElement, replaceButton);
  assert.match(shadow.querySelector(".wf-dialog-summary").textContent, /Captured endpoint/);
  liveState = {
    entries: [entry("https://changed-after-dialog.test/", "Changed later")],
    cursor: 0,
  };
  replaceButton.click();
  await flushAsync();
  const replacements = sent.filter((message) => message.type === "SAVED_TRAIL_REPLACE");
  assert.equal(replacements.length, 1);
  assert.deepEqual(replacements[0].path, capturedPath);
  assert.deepEqual(replacements[0].expectedPath, expectedPath);
  const updateNotice = notices.at(-1);
  assert.match(updateNotice.message, /Updated/);
  assert.equal(updateNotice.options.actionLabel, "Undo");
  assert.equal(typeof updateNotice.options.action, "function");

  await updateNotice.options.action();
  await flushAsync();
  const replacementsAfterUndo = sent.filter((message) => message.type === "SAVED_TRAIL_REPLACE");
  assert.equal(replacementsAfterUndo.length, 2);
  assert.deepEqual(replacementsAfterUndo[1].path, expectedPath);
  assert.deepEqual(replacementsAfterUndo[1].expectedPath, capturedPath);
  assert.match(notices.at(-1).message, /Restored the previous path/);

  invokeMenuAction("a", "Remove trail");
  await flushAsync();
  assert.deepEqual(sent.at(-1), { type: "SAVED_TRAIL_DELETE", id: "a" });
  const alphaDeleteUndo = notices.at(-1);
  assert.match(alphaDeleteUndo.message, /Removed.*Alpha renamed/);
  assert.equal(alphaDeleteUndo.options.undo, true);
  assert.equal(alphaDeleteUndo.options.durationMs, 8000);
  assert.equal(typeof alphaDeleteUndo.options.action, "function");

  invokeMenuAction("b", "Remove trail");
  await flushAsync();
  assert.deepEqual(sent.at(-1), { type: "SAVED_TRAIL_DELETE", id: "b" });
  const betaDeleteUndo = notices.at(-1);
  assert.match(betaDeleteUndo.message, /Removed.*Beta/);
  assert.equal(betaDeleteUndo.options.undo, true);
  assert.equal(betaDeleteUndo.options.durationMs, 8000);
  assert.equal(typeof betaDeleteUndo.options.action, "function");

  await alphaDeleteUndo.options.action();
  await flushAsync();
  await betaDeleteUndo.options.action();
  await flushAsync();
  const restoredIds = sent
    .filter((message) => message.type === "SAVED_TRAIL_RESTORE")
    .slice(-2)
    .map((message) => message.trail.id);
  assert.deepEqual(restoredIds, ["a", "b"]);
  assert.match(notices.at(-1).message, /Restored/);

  row("a").querySelector(".wf-row-more").focus();
  row("a").querySelector(".wf-row-more").click();
  assert.ok(shadow.querySelector(".wf-menu"));
  const external = savedTrail("external", "External", "https://external.test/");
  trails = [external];
  for (const listener of globalThis.__savedTrailStorageListeners) {
    listener({ tabtrailSavedTrails: { newValue: trails } }, "local");
  }
  await flushAsync();
  assert.equal(panel.querySelectorAll(".wf-library-row").length, 1);
  assert.match(panel.textContent, /External/);
  assert.equal(shadow.querySelector(".wf-menu"), null, "storage refresh closes stale menus");
  assert.equal(shadow.activeElement, row("external").querySelector(".wf-row-more"));

  mod.toggleSavedTrailsLibrary();
  await flushAsync();
  assert.equal(shadow.querySelector(".wf-library-panel"), null);
  assert.equal(shadow.activeElement, opener);
  mod.toggleSavedTrailsLibrary();
  await flushAsync();
  assert.equal(shadow.querySelector(".wf-library-sort"), null);
  mod.toggleSavedTrailsLibrary();
  mod.unbindSavedTrailsHost();
  cleanup();
  dom.window.close();
});

test("saved library keeps load errors inline and retries in the same panel", async () => {
  const dom = installDom();
  const { mod, cleanup } = await loadPanelModule();
  let shouldFail = true;
  let retryGate = null;
  const trails = [savedTrail("retry", "Retry success", "https://retry.test/")];
  globalThis.__savedTrailGet = async (key) => {
    if (shouldFail) throw new Error("temporary storage failure");
    if (retryGate) await retryGate;
    return { [key]: trails };
  };
  globalThis.__savedTrailSend = async () => ({ ok: false, reason: "unused" });
  const shell = document.createElement("div");
  const shadow = shell.attachShadow({ mode: "open" });
  const layer = document.createElement("div");
  const bar = document.createElement("div");
  shadow.append(layer, bar);
  document.body.appendChild(shell);
  mod.bindSavedTrailsHost({
    layer,
    bar,
    client: testSavedTrailsClient(),
    getState: () => ({ entries: [], cursor: -1 }),
    showNotice() {},
    hideTrail() {},
    closeLiveSurfaces() {},
    flushLiveTrailUpdates() {},
    restoreLiveFocus() {},
    setLiveInteractionBlocked() {},
  });

  mod.toggleSavedTrailsLibrary();
  await flushAsync();
  const panel = shadow.querySelector(".wf-library-panel");
  assert.match(panel.textContent, /Couldn’t load saved trails/);
  const retry = panel.querySelector(".wf-library-state-action");
  shouldFail = false;
  let releaseRetry;
  retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  retry.focus();
  retry.click();
  await flushAsync();
  assert.match(panel.textContent, /Loading saved trails/);
  assert.equal(shadow.activeElement, panel.querySelector(".wf-library-search"));
  releaseRetry();
  retryGate = null;
  await flushAsync();
  assert.match(panel.textContent, /Retry success/);
  assert.equal(shadow.activeElement, panel.querySelector(".wf-library-search"));

  mod.unbindSavedTrailsHost();
  cleanup();
  dom.window.close();
});

test("saved library width stays inside a viewport narrower than its preferred minimum", async () => {
  const dom = installDom();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 250 });
  const { mod, cleanup } = await loadPanelModule();
  globalThis.__savedTrailGet = async (key) => ({ [key]: [] });
  globalThis.__savedTrailSend = async () => ({ ok: false, reason: "unused" });

  const shell = document.createElement("div");
  const shadow = shell.attachShadow({ mode: "open" });
  const layer = document.createElement("div");
  const bar = document.createElement("div");
  bar.getBoundingClientRect = () => ({
    x: 12,
    y: 12,
    left: 12,
    top: 12,
    right: 402,
    bottom: 52,
    width: 390,
    height: 40,
    toJSON() {},
  });
  shadow.append(layer, bar);
  document.body.appendChild(shell);
  mod.bindSavedTrailsHost({
    layer,
    bar,
    client: testSavedTrailsClient(),
    getState: () => ({ entries: [], cursor: -1 }),
    showNotice() {},
    hideTrail() {},
    closeLiveSurfaces() {},
    flushLiveTrailUpdates() {},
    restoreLiveFocus() {},
    setLiveInteractionBlocked() {},
  });

  mod.toggleSavedTrailsLibrary();
  const panel = shadow.querySelector(".wf-library-panel");
  assert.equal(panel.style.width, "226px");
  assert.equal(panel.style.left, "12px");
  assert.ok(parseFloat(panel.style.width) + 24 <= window.innerWidth);

  mod.unbindSavedTrailsHost();
  cleanup();
  dom.window.close();
});

test("empty library saves the path captured when its naming dialog opens", async () => {
  const dom = installDom();
  const { mod, cleanup } = await loadPanelModule();
  let trails = [];
  const capturedPath = [
    entry("https://root.test/", "Root"),
    entry("https://root.test/endpoint", "Endpoint"),
  ];
  let liveState = { entries: capturedPath, cursor: 1 };
  globalThis.__savedTrailGet = async (key) => ({ [key]: trails });
  const sent = [];
  globalThis.__savedTrailSend = async (message) => {
    sent.push(message);
    if (message.type !== "SAVED_TRAIL_SAVE") {
      return { ok: false, reason: "Unexpected test message" };
    }
    const created = {
      id: "saved-current",
      name: message.name,
      pinned: false,
      createdAt: 5000,
      updatedAt: 5000,
      entries: structuredClone(message.path),
    };
    trails = [created];
    return { ok: true, trail: created, trails };
  };
  globalThis.__savedTrailSet = async () => {};

  const shell = document.createElement("div");
  const shadow = shell.attachShadow({ mode: "open" });
  const layer = document.createElement("div");
  const bar = document.createElement("div");
  const opener = document.createElement("button");
  opener.textContent = "Library";
  shadow.append(layer, bar, opener);
  document.body.appendChild(shell);
  opener.focus();
  mod.bindSavedTrailsHost({
    layer,
    bar,
    client: testSavedTrailsClient(),
    getState: () => liveState,
    showNotice() {},
    hideTrail() {},
    closeLiveSurfaces() {},
    flushLiveTrailUpdates() {},
    restoreLiveFocus() {},
    setLiveInteractionBlocked() {},
  });

  mod.toggleSavedTrailsLibrary();
  await flushAsync();
  const saveCurrent = shadow.querySelector(".wf-library-state-action");
  assert.equal(saveCurrent.textContent, "Save current trail");
  saveCurrent.click();
  const input = shadow.querySelector(".wf-dialog-input");
  assert.ok(input);
  assert.equal(shadow.activeElement, input);
  assert.match(shadow.querySelector(".wf-dialog-summary").textContent, /Endpoint/);
  assert.equal(shadow.querySelector(".wf-library-panel"), null);

  liveState = {
    entries: [entry("https://later.test/", "Later")],
    cursor: 0,
  };
  input.value = "Captured trail";
  [...shadow.querySelectorAll(".wf-dialog-btn")]
    .find((button) => button.textContent === "Save")
    .click();
  await flushAsync();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].name, "Captured trail");
  assert.deepEqual(sent[0].path, capturedPath);
  assert.equal(shadow.querySelector(".wf-dialog"), null);
  assert.equal(shadow.activeElement, opener);

  mod.unbindSavedTrailsHost();
  cleanup();
  dom.window.close();
});
