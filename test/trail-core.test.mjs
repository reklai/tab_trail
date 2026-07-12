import test from "node:test";
import assert from "node:assert/strict";
import { loadTsModule } from "./helpers/loadTsModule.mjs";

let corePromise = null;

function loadTrailCoreModule() {
  if (!corePromise) {
    corePromise = loadTsModule("src/lib/core/trail/trailCore.ts");
  }
  return corePromise;
}

const KEY_TRIGGER = {
  modifier: "alt",
  withShift: false,
  kind: "key",
  keyCode: "KeyH",
  mouseButton: 1,
};

const MOUSE_TRIGGER = { ...KEY_TRIGGER, modifier: "ctrl", kind: "mouse", mouseButton: 1 };

function keyEvent(overrides = {}) {
  return {
    type: "keydown",
    code: "KeyH",
    button: undefined,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isTrusted: true,
    ...overrides,
  };
}

function mouseEvent(overrides = {}) {
  return {
    type: "mousedown",
    code: undefined,
    button: 1,
    altKey: false,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    isTrusted: true,
    ...overrides,
  };
}

function navEvent(url, overrides = {}) {
  return {
    kind: "committed",
    url,
    timestamp: 1000,
    transitionType: "link",
    qualifiers: [],
    pendingJumpIndex: null,
    pendingJumpKind: null,
    ...overrides,
  };
}

function walk(core, urls) {
  let state = core.EMPTY_TRAIL_STATE;
  let timestamp = 0;
  for (const url of urls) {
    timestamp += 1000;
    state = core.applyNavigationEvent(state, navEvent(url, { timestamp })).state;
  }
  return state;
}

function urls(state) {
  return state.entries.map((entry) => entry.url);
}

// --- toggle trigger helpers ---

test("toToggleTriggerEvent maps keyboard and mouse DOM-like events", async () => {
  const core = await loadTrailCoreModule();
  assert.deepEqual(
    core.toToggleTriggerEvent({
      type: "keydown",
      code: "KeyH",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isTrusted: true,
    }),
    {
      type: "keydown",
      code: "KeyH",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isTrusted: true,
    },
  );
  assert.deepEqual(
    core.toToggleTriggerEvent({
      type: "mousedown",
      button: 2,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      isTrusted: true,
    }),
    {
      type: "mousedown",
      button: 2,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      isTrusted: true,
    },
  );
});

test("isMouseChordFollowUp only ties contextmenu to the right button", async () => {
  const core = await loadTrailCoreModule();
  assert.equal(core.isMouseChordFollowUp({ type: "click", button: 1 }, 1), true);
  assert.equal(core.isMouseChordFollowUp({ type: "click", button: 2 }, 1), false);
  assert.equal(core.isMouseChordFollowUp({ type: "contextmenu", button: 0 }, 2), true);
  assert.equal(core.isMouseChordFollowUp({ type: "contextmenu", button: 0 }, 1), false);
  assert.equal(core.MOUSE_CHORD_SWALLOW_WINDOW_MS, 600);
});

// --- matchesToggleTrigger truth table ---

test("keyboard trigger matches the exact configured chord", async () => {
  const core = await loadTrailCoreModule();
  assert.equal(core.matchesToggleTrigger(keyEvent(), KEY_TRIGGER), true);
});

test("keyboard trigger rejects auto-repeat and synthetic events", async () => {
  const core = await loadTrailCoreModule();
  assert.equal(core.matchesToggleTrigger(keyEvent({ repeat: true }), KEY_TRIGGER), false);
  assert.equal(core.matchesToggleTrigger(keyEvent({ isTrusted: false }), KEY_TRIGGER), false);
});

test("keyboard trigger rejects the wrong key, missing modifier, or extra modifier", async () => {
  const core = await loadTrailCoreModule();
  assert.equal(core.matchesToggleTrigger(keyEvent({ code: "KeyJ" }), KEY_TRIGGER), false);
  assert.equal(core.matchesToggleTrigger(keyEvent({ altKey: false }), KEY_TRIGGER), false);
  // AltGr shows up as Ctrl+Alt — the extra modifier must reject the chord.
  assert.equal(core.matchesToggleTrigger(keyEvent({ ctrlKey: true }), KEY_TRIGGER), false);
  assert.equal(core.matchesToggleTrigger(keyEvent({ metaKey: true }), KEY_TRIGGER), false);
});

test("keyboard trigger enforces the Shift requirement in both directions", async () => {
  const core = await loadTrailCoreModule();
  const shiftTrigger = { ...KEY_TRIGGER, withShift: true };
  assert.equal(core.matchesToggleTrigger(keyEvent(), shiftTrigger), false);
  assert.equal(core.matchesToggleTrigger(keyEvent({ shiftKey: true }), shiftTrigger), true);
  assert.equal(core.matchesToggleTrigger(keyEvent({ shiftKey: true }), KEY_TRIGGER), false);
});

test("super modifier maps to metaKey", async () => {
  const core = await loadTrailCoreModule();
  const superTrigger = { ...KEY_TRIGGER, modifier: "super" };
  assert.equal(
    core.matchesToggleTrigger(keyEvent({ altKey: false, metaKey: true }), superTrigger),
    true,
  );
  assert.equal(core.matchesToggleTrigger(keyEvent(), superTrigger), false);
});

test("mouse trigger matches modifier + button on mousedown only", async () => {
  const core = await loadTrailCoreModule();
  assert.equal(core.matchesToggleTrigger(mouseEvent(), MOUSE_TRIGGER), true);
  assert.equal(core.matchesToggleTrigger(mouseEvent({ button: 2 }), MOUSE_TRIGGER), false);
  assert.equal(core.matchesToggleTrigger(mouseEvent({ ctrlKey: false }), MOUSE_TRIGGER), false);
  assert.equal(core.matchesToggleTrigger(mouseEvent({ isTrusted: false }), MOUSE_TRIGGER), false);
  // A keydown never satisfies a mouse trigger, and vice versa.
  assert.equal(core.matchesToggleTrigger(keyEvent({ ctrlKey: true, altKey: false }), MOUSE_TRIGGER), false);
  assert.equal(core.matchesToggleTrigger(mouseEvent({ altKey: true, ctrlKey: false }), KEY_TRIGGER), false);
});

test("mouse trigger supports configured left, middle, and right clicks", async () => {
  const core = await loadTrailCoreModule();
  for (const button of [0, 1, 2]) {
    const trigger = { ...MOUSE_TRIGGER, mouseButton: button };
    assert.equal(core.matchesToggleTrigger(mouseEvent({ button }), trigger), true);
    assert.equal(core.matchesToggleTrigger(mouseEvent({ button: 3 }), trigger), false);
  }
});

// --- applyNavigationEvent rules ---

test("first navigation seeds the trail", async () => {
  const core = await loadTrailCoreModule();
  const { state, changed } = core.applyNavigationEvent(
    core.EMPTY_TRAIL_STATE,
    navEvent("https://a.test/"),
  );
  assert.equal(changed, true);
  assert.deepEqual(urls(state), ["https://a.test/"]);
  assert.equal(state.cursor, 0);
  assert.equal(state.entries[0].historyBacked, true);
});

test("plain link navigations append and advance the cursor", async () => {
  const core = await loadTrailCoreModule();
  const state = walk(core, ["https://a.test/", "https://b.test/", "https://c.test/"]);
  assert.deepEqual(urls(state), ["https://a.test/", "https://b.test/", "https://c.test/"]);
  assert.equal(state.cursor, 2);
});

test("reload refreshes in place without appending", async () => {
  const core = await loadTrailCoreModule();
  let state = walk(core, ["https://a.test/", "https://b.test/"]);
  state = core.applyNavigationEvent(
    state,
    navEvent("https://b.test/", { transitionType: "reload", timestamp: 9000 }),
  ).state;
  assert.deepEqual(urls(state), ["https://a.test/", "https://b.test/"]);
  assert.equal(state.entries[1].timestamp, 9000);
  assert.equal(state.cursor, 1);
});

test("revisiting the same URL in a row refreshes instead of duplicating", async () => {
  const core = await loadTrailCoreModule();
  let state = walk(core, ["https://a.test/", "https://b.test/"]);
  state = core.applyNavigationEvent(
    state,
    navEvent("https://b.test/", { timestamp: 9000 }),
  ).state;
  assert.deepEqual(urls(state), ["https://a.test/", "https://b.test/"]);
  assert.equal(state.entries[1].timestamp, 9000);
});

test("forward_back moves the cursor to the matching entry", async () => {
  const core = await loadTrailCoreModule();
  let state = walk(core, ["https://a.test/", "https://b.test/", "https://c.test/"]);
  state = core.applyNavigationEvent(
    state,
    navEvent("https://b.test/", { qualifiers: ["forward_back"] }),
  ).state;
  assert.equal(state.cursor, 1);
  assert.equal(state.entries.length, 3);
  // Going forward again also just moves the cursor.
  state = core.applyNavigationEvent(
    state,
    navEvent("https://c.test/", { qualifiers: ["forward_back"] }),
  ).state;
  assert.equal(state.cursor, 2);
  assert.equal(state.entries.length, 3);
});

test("forward_back with no matching entry falls back to appending", async () => {
  const core = await loadTrailCoreModule();
  let state = walk(core, ["https://a.test/", "https://b.test/"]);
  state = core.applyNavigationEvent(
    state,
    navEvent("https://z.test/", { qualifiers: ["forward_back"] }),
  ).state;
  assert.deepEqual(urls(state), ["https://a.test/", "https://b.test/", "https://z.test/"]);
  assert.equal(state.cursor, 2);
});

test("navigating from mid-trail truncates the forward stack", async () => {
  const core = await loadTrailCoreModule();
  let state = walk(core, ["https://a.test/", "https://b.test/", "https://c.test/", "https://d.test/"]);
  state = core.applyNavigationEvent(
    state,
    navEvent("https://b.test/", { qualifiers: ["forward_back"] }),
  ).state;
  assert.equal(state.cursor, 1);
  state = core.applyNavigationEvent(state, navEvent("https://e.test/")).state;
  assert.deepEqual(urls(state), ["https://a.test/", "https://b.test/", "https://e.test/"]);
  assert.equal(state.cursor, 2);
});

test("pendingJump landing moves the cursor without appending", async () => {
  const core = await loadTrailCoreModule();
  let state = walk(core, ["https://a.test/", "https://b.test/", "https://c.test/"]);
  const { state: next, changed } = core.applyNavigationEvent(
    state,
    navEvent("https://a.test/", { pendingJumpIndex: 0, qualifiers: ["forward_back"] }),
  );
  assert.equal(changed, true);
  assert.equal(next.cursor, 0);
  assert.deepEqual(urls(next), urls(state));
});

test("direct pendingJump establishes a branch and drops descendants", async () => {
  const core = await loadTrailCoreModule();
  const state = walk(core, ["https://a.test/", "https://b.test/", "https://c.test/"]);
  const { state: branch } = core.applyNavigationEvent(
    state,
    navEvent("https://b.test/", {
      pendingJumpIndex: 1,
      pendingJumpKind: "navigate",
      timestamp: 9000,
    }),
  );
  assert.deepEqual(urls(branch), ["https://a.test/", "https://b.test/"]);
  assert.equal(branch.cursor, 1);
  assert.equal(branch.entries[1].timestamp, 9000);
  assert.equal(branch.entries[1].historyBacked, false);
  assert.deepEqual(
    core.resolveJumpPlan(branch, 0),
    { kind: "navigate", url: "https://a.test/" },
  );
});

test("direct jump landing cannot reuse stale native history on the shortened branch", async () => {
  const core = await loadTrailCoreModule();
  let state = walk(core, ["https://a.test/", "https://b.test/"]);
  state = core.applyNavigationEvent(
    state,
    navEvent("https://c.test/", { qualifiers: ["server_redirect"] }),
  ).state;
  state = core.applyNavigationEvent(state, navEvent("https://d.test/")).state;

  // The redirected edge forces the click on B to use tabs.update rather than
  // history.go. Native history now has abandoned C/D entries that this branch
  // deliberately drops.
  assert.deepEqual(
    core.resolveJumpPlan(state, 1),
    { kind: "navigate", url: "https://b.test/" },
  );
  state = core.applyNavigationEvent(
    state,
    navEvent("https://b.test/", {
      pendingJumpIndex: 1,
      pendingJumpKind: "navigate",
      timestamp: 9000,
    }),
  ).state;

  assert.deepEqual(urls(state), ["https://a.test/", "https://b.test/"]);
  assert.equal(state.entries[1].historyBacked, false);
  assert.deepEqual(
    core.resolveJumpPlan(state, 0),
    { kind: "navigate", url: "https://a.test/" },
  );
});

test("pendingJump with a mismatched URL falls through to normal rules", async () => {
  const core = await loadTrailCoreModule();
  let state = walk(core, ["https://a.test/", "https://b.test/"]);
  state = core.applyNavigationEvent(
    state,
    navEvent("https://z.test/", { pendingJumpIndex: 0 }),
  ).state;
  assert.deepEqual(urls(state), ["https://a.test/", "https://b.test/", "https://z.test/"]);
});

test("historyState and refFragment events append with spa/fragment transitions", async () => {
  const core = await loadTrailCoreModule();
  let state = walk(core, ["https://app.test/"]);
  state = core.applyNavigationEvent(
    state,
    navEvent("https://app.test/inbox", { kind: "historyState", transitionType: undefined }),
  ).state;
  state = core.applyNavigationEvent(
    state,
    navEvent("https://app.test/inbox#detail", { kind: "refFragment", transitionType: undefined }),
  ).state;
  assert.equal(state.entries[1].transition, "spa");
  assert.equal(state.entries[2].transition, "fragment");
  assert.equal(state.cursor, 2);
});

test("replaceState churn on the same URL refreshes in place", async () => {
  const core = await loadTrailCoreModule();
  let state = walk(core, ["https://app.test/watch"]);
  for (let i = 0; i < 5; i += 1) {
    state = core.applyNavigationEvent(
      state,
      navEvent("https://app.test/watch", { kind: "historyState", timestamp: 2000 + i }),
    ).state;
  }
  assert.equal(state.entries.length, 1);
});

test("trail caps at TRAIL_MAX_ENTRIES by dropping the oldest", async () => {
  const core = await loadTrailCoreModule();
  const many = Array.from({ length: core.TRAIL_MAX_ENTRIES + 10 }, (_, i) => `https://p.test/${i}`);
  const state = walk(core, many);
  assert.equal(state.entries.length, core.TRAIL_MAX_ENTRIES);
  assert.equal(state.entries[0].url, "https://p.test/10");
  assert.equal(state.cursor, core.TRAIL_MAX_ENTRIES - 1);
});

// --- resolveJumpPlan ---

test("jump plan uses history.go over a clean span", async () => {
  const core = await loadTrailCoreModule();
  const state = walk(core, ["https://a.test/", "https://b.test/", "https://c.test/"]);
  assert.deepEqual(core.resolveJumpPlan(state, 0), { kind: "historyGo", delta: -2 });
  // Forward jump after moving the cursor back.
  const back = core.applyNavigationEvent(
    state,
    navEvent("https://a.test/", { qualifiers: ["forward_back"] }),
  ).state;
  assert.deepEqual(core.resolveJumpPlan(back, 2), { kind: "historyGo", delta: 2 });
});

test("jump plan falls back to navigate across a redirected entry", async () => {
  const core = await loadTrailCoreModule();
  let state = walk(core, ["https://a.test/", "https://b.test/"]);
  state = core.applyNavigationEvent(
    state,
    navEvent("https://c.test/", { qualifiers: ["client_redirect"] }),
  ).state;
  assert.deepEqual(core.resolveJumpPlan(state, 0), { kind: "navigate", url: "https://a.test/" });
});

test("inherited lineage navigates safely and post-fork history remains native", async () => {
  const core = await loadTrailCoreModule();
  const source = walk(core, ["https://a.test/", "https://b.test/", "https://c.test/"]);
  const inherited = core.createInheritedTrailState(source.entries);

  assert.notEqual(inherited.entries, source.entries);
  assert.deepEqual(urls(inherited), urls(source));
  assert.deepEqual(
    inherited.entries.map((entry) => entry.historyBacked),
    [true, false, false],
  );
  assert.equal(inherited.cursor, 2);
  assert.deepEqual(
    core.resolveJumpPlan(inherited, 1),
    { kind: "navigate", url: "https://b.test/" },
  );

  const extended = core.applyNavigationEvent(inherited, navEvent("https://x.test/")).state;
  assert.equal(extended.entries[3].historyBacked, true);
  assert.deepEqual(core.resolveJumpPlan(extended, 2), { kind: "historyGo", delta: -1 });
  assert.deepEqual(
    core.resolveJumpPlan(extended, 1),
    { kind: "navigate", url: "https://b.test/" },
  );
});

test("jump plan is null for the current segment and invalid indices", async () => {
  const core = await loadTrailCoreModule();
  const state = walk(core, ["https://a.test/", "https://b.test/"]);
  assert.equal(core.resolveJumpPlan(state, 1), null);
  assert.equal(core.resolveJumpPlan(state, -1), null);
  assert.equal(core.resolveJumpPlan(state, 99), null);
});

// --- presentation + normalization helpers ---

test("truncateTrailTitle keeps short titles and ellipsizes long ones", async () => {
  const core = await loadTrailCoreModule();
  assert.equal(core.truncateTrailTitle("Short title"), "Short title");
  const long = core.truncateTrailTitle("A very long article title that keeps going and going", 20);
  assert.ok(long.endsWith("…"));
  assert.ok(long.length <= 20);
});

test("formatTrailTimestamp buckets relative times", async () => {
  const core = await loadTrailCoreModule();
  const now = 10_000_000;
  assert.equal(core.formatTrailTimestamp(now - 10_000, now), "just now");
  assert.equal(core.formatTrailTimestamp(now - 5 * 60_000, now), "5m ago");
  assert.equal(core.formatTrailTimestamp(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(core.formatTrailTimestamp(now - 48 * 3_600_000, now), "2d ago");
});

test("normalizeTrailState heals malformed persisted values", async () => {
  const core = await loadTrailCoreModule();
  assert.deepEqual(core.normalizeTrailState(null), { entries: [], cursor: -1 });
  assert.deepEqual(core.normalizeTrailState({ entries: "nope" }), { entries: [], cursor: -1 });
  const healed = core.normalizeTrailState({
    entries: [
      { url: "https://a.test/", title: 42, timestamp: "x", transition: "warp" },
      { notAnEntry: true },
      { url: "https://b.test/" },
    ],
    cursor: 99,
  });
  assert.equal(healed.entries.length, 2);
  assert.equal(healed.entries[0].title, "");
  assert.equal(healed.entries[0].transition, "other");
  assert.equal(healed.entries[0].historyBacked, true);
  assert.equal(healed.cursor, 1);

  const inherited = core.normalizeTrailState({
    entries: [
      sampleEntry("https://a.test/"),
      { ...sampleEntry("https://b.test/"), historyBacked: false },
    ],
    cursor: 1,
  });
  assert.deepEqual(inherited.entries.map((entry) => entry.historyBacked), [true, false]);
});

test("normalizeTrailState round-trips valid viewport and strips invalid", async () => {
  const core = await loadTrailCoreModule();
  const withViewport = core.normalizeTrailState({
    entries: [
      {
        ...sampleEntry("https://a.test/"),
        viewport: {
          x: 12,
          y: 840,
          scrollHeight: 5000,
          root: "document",
          capturedAt: 99,
        },
      },
      {
        ...sampleEntry("https://b.test/"),
        viewport: { x: "nope", y: 10 },
      },
      {
        ...sampleEntry("https://c.test/"),
        viewport: { x: -5, y: 1e9, root: "warp", rootSelector: "x".repeat(300) },
      },
    ],
    cursor: 0,
  });
  assert.deepEqual(withViewport.entries[0].viewport, {
    x: 12,
    y: 840,
    scrollHeight: 5000,
    root: "document",
    capturedAt: 99,
  });
  assert.equal(withViewport.entries[1].viewport, undefined);
  assert.equal(withViewport.entries[2].viewport.x, 0);
  assert.equal(withViewport.entries[2].viewport.y, 1e7);
  assert.equal(withViewport.entries[2].viewport.root, undefined);
  assert.equal(withViewport.entries[2].viewport.rootSelector, undefined);

  // Round-trip through normalize again preserves the healed viewport.
  const again = core.normalizeTrailState(withViewport);
  assert.deepEqual(again.entries[0].viewport, withViewport.entries[0].viewport);
});

test("refreshEntry preserves viewport via object spread; makeEntry omits it", async () => {
  const core = await loadTrailCoreModule();
  let state = core.applyNavigationEvent(
    core.EMPTY_TRAIL_STATE,
    navEvent("https://a.test/"),
  ).state;
  assert.equal(state.entries[0].viewport, undefined);

  // Patch viewport as the domain would after a scroll report.
  state = {
    entries: [{
      ...state.entries[0],
      viewport: { x: 0, y: 400, root: "document" },
    }],
    cursor: 0,
  };

  // Same-URL refresh (reload / replaceState churn) must keep viewport.
  const refreshed = core.applyNavigationEvent(
    state,
    navEvent("https://a.test/", { transitionType: "reload" }),
  ).state;
  assert.deepEqual(refreshed.entries[0].viewport, { x: 0, y: 400, root: "document" });

  // New navigation starts clean without viewport.
  const next = core.applyNavigationEvent(
    refreshed,
    navEvent("https://b.test/"),
  ).state;
  assert.equal(next.entries[1].viewport, undefined);
  assert.deepEqual(next.entries[0].viewport, { x: 0, y: 400, root: "document" });
});

test("savedTrailPathsEqual ignores viewport; savedTrailEntriesEqual includes it", async () => {
  const core = await loadTrailCoreModule();
  const path = [sampleEntry("https://a.test/", "A"), sampleEntry("https://b.test/", "B")];
  const scrolled = path.map((entry, index) => ({
    ...entry,
    viewport: { x: 0, y: 100 * (index + 1), root: "document" },
  }));
  assert.equal(core.savedTrailPathsEqual(path, scrolled), true);
  assert.equal(core.savedTrailEntriesEqual(path, scrolled), false);
  assert.equal(core.savedTrailEntriesEqual(scrolled, scrolled), true);
  assert.equal(
    core.viewportEquals(
      { x: 0, y: 10, capturedAt: 1 },
      { x: 0, y: 10, capturedAt: 99 },
    ),
    true,
  );
});

test("isAllowedRootSelector allowlists sampler grammar and rejects arbitrary CSS", async () => {
  const core = await loadTrailCoreModule();
  assert.equal(core.isAllowedRootSelector("#main"), true);
  assert.equal(core.isAllowedRootSelector("#foo-bar"), true);
  assert.equal(core.isAllowedRootSelector("div > section:nth-of-type(2)"), true);
  assert.equal(core.isAllowedRootSelector("div:nth-of-type(1)"), true);
  // Custom elements (hyphenated tags) are part of the sampler grammar.
  assert.equal(core.isAllowedRootSelector("app-shell"), true);
  assert.equal(core.isAllowedRootSelector("app-shell:nth-of-type(1) > main"), true);
  assert.equal(core.isAllowedRootSelector("div.foo"), false);
  assert.equal(core.isAllowedRootSelector("div[data-x]"), false);
  assert.equal(core.isAllowedRootSelector(""), false);
  // CSS.escape-style ids must not pass (sampler emits unescaped #id only).
  assert.equal(core.isAllowedRootSelector("#foo\\:bar"), false);
  // Element root with invalid selector is discarded entirely — never demote to
  // document while keeping nested x/y (wrong coordinate space).
  assert.equal(
    core.normalizeViewport({
      x: 0,
      y: 10,
      root: "element",
      rootSelector: "div.evil > *",
    }),
    null,
  );
  assert.equal(
    core.normalizeViewport({
      x: 5,
      y: 99,
      root: "element",
    }),
    null,
  );
  // Valid nested selector is preserved.
  assert.deepEqual(
    core.normalizeViewport({
      x: 0,
      y: 40,
      root: "element",
      rootSelector: "app-shell:nth-of-type(1)",
    }),
    { x: 0, y: 40, root: "element", rootSelector: "app-shell:nth-of-type(1)" },
  );
  assert.equal(
    core.normalizeViewport({ x: 0, y: 1, capturedAt: 1e20 })?.capturedAt,
    undefined,
  );
});

// --- named trail snapshots ---

function sampleEntry(url, title = "") {
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

test("slicePathToIndex returns root through selected node", async () => {
  const core = await loadTrailCoreModule();
  const state = walk(core, ["https://a.test/", "https://b.test/", "https://c.test/"]);
  const path = core.slicePathToIndex(state, 1);
  assert.deepEqual(path.map((entry) => entry.url), ["https://a.test/", "https://b.test/"]);
  assert.equal(core.slicePathToIndex(state, -1), null);
  assert.equal(core.slicePathToIndex(state, 9), null);
  assert.equal(core.slicePathToIndex(core.EMPTY_TRAIL_STATE, 0), null);
});

test("saved trail names are unique case-insensitively after trim", async () => {
  const core = await loadTrailCoreModule();
  const trails = [
    core.createSavedTrail("My Path", [sampleEntry("https://a.test/", "A")]),
  ];
  assert.equal(core.isSavedTrailNameTaken(trails, "my path"), true);
  assert.equal(core.isSavedTrailNameTaken(trails, "  MY PATH  "), true);
  assert.equal(core.isSavedTrailNameTaken(trails, "Other"), false);
  assert.equal(core.isSavedTrailNameTaken(trails, "My Path", trails[0].id), false);
  assert.equal(core.normalizeSavedTrailName("  multi   space  "), "multi space");
});

test("normalizeSavedTrails drops invalid rows, enforces unique names and IDs, and caps", async () => {
  const core = await loadTrailCoreModule();
  const many = [];
  for (let i = 0; i < core.MAX_SAVED_TRAILS + 5; i += 1) {
    many.push({
      id: `id-${i}`,
      name: `Trail ${i}`,
      createdAt: i,
      updatedAt: i,
      entries: [sampleEntry(`https://x.test/${i}`)],
    });
  }
  many.push({ id: "bad", name: "", entries: [sampleEntry("https://bad.test/")] });
  many.push({
    id: "dup",
    name: "Trail 0",
    createdAt: 999,
    updatedAt: 999,
    entries: [sampleEntry("https://dup.test/")],
  });
  many.unshift({
    id: "same-id",
    name: "ID winner",
    entries: [sampleEntry("https://winner.test/")],
  });
  many.unshift({
    id: "same-id",
    name: "Other ID winner",
    entries: [sampleEntry("https://other-winner.test/")],
  });
  const normalized = core.normalizeSavedTrails(many);
  assert.equal(normalized.length, core.MAX_SAVED_TRAILS);
  assert.equal(normalized.filter((trail) => trail.name === "Trail 0").length, 1);
  assert.equal(normalized.filter((trail) => trail.id === "same-id").length, 1);
  assert.ok(normalized.every((trail) => trail.entries.length >= 1));
  assert.ok(normalized.every((trail) => trail.pinned === false));
});

test("normalizeSavedTrails preserves legacy trails with duplicate navigation paths", async () => {
  const core = await loadTrailCoreModule();
  const path = [sampleEntry("https://a.test/?view=full#details")];
  const first = core.createSavedTrail("First", path, 100);
  const second = { ...core.createSavedTrail("Second", path, 200), id: "second" };
  const normalized = core.normalizeSavedTrails([first, second]);
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized.map((trail) => trail.name), ["Second", "First"]);
});

test("saved trail path identity ignores cosmetic metadata but preserves navigation structure", async () => {
  const core = await loadTrailCoreModule();
  const path = [
    sampleEntry("https://a.test/?mode=full#start", "Original A"),
    sampleEntry("https://b.test/end", "Original B"),
  ];
  const cosmeticVariant = path.map((entry, index) => ({
    ...entry,
    title: `Changed ${index}`,
    favIconUrl: `https://icons.test/${index}.png`,
    timestamp: entry.timestamp + index + 10,
    redirected: !entry.redirected,
  }));

  assert.equal(core.savedTrailPathsEqual(path, cosmeticVariant), true);
  assert.equal(core.savedTrailEntriesEqual(path, cosmeticVariant), false);
  assert.equal(core.savedTrailPathsEqual(path, path.slice(0, 1)), false);
  assert.equal(core.savedTrailPathsEqual(path, [...path].reverse()), false);
  assert.equal(
    core.savedTrailPathsEqual(path, [
      { ...path[0], url: "https://a.test/?mode=compact#start" },
      path[1],
    ]),
    false,
  );
  assert.equal(
    core.savedTrailPathsEqual(path, [
      { ...path[0], url: "https://a.test/?mode=full#other" },
      path[1],
    ]),
    false,
  );
  assert.equal(
    core.savedTrailPathsEqual(path, [path[0], { ...path[1], transition: "typed" }]),
    false,
  );
  assert.equal(
    core.savedTrailPathsEqual(path, [path[0], { ...path[1], historyBacked: false }]),
    false,
  );
});

test("saved trails normalize pin state", async () => {
  const core = await loadTrailCoreModule();
  const source = core.createSavedTrail(
    "A".repeat(core.SAVED_TRAIL_NAME_MAX_LENGTH),
    [sampleEntry("https://a.test/")],
    123,
  );
  assert.equal(source.pinned, false);
  assert.equal(source.createdAt, 123);

  const pinned = core.normalizeSavedTrail({ ...source, pinned: true });
  assert.equal(pinned.pinned, true);
  assert.equal(core.normalizeSavedTrail({ ...source, pinned: "yes" }).pinned, false);
});

test("suggestSavedTrailName prefers title then host", async () => {
  const core = await loadTrailCoreModule();
  assert.equal(
    core.suggestSavedTrailName(sampleEntry("https://example.com/x", "Example Title")),
    "Example Title",
  );
  assert.equal(core.suggestSavedTrailName(sampleEntry("https://example.com/x")), "example.com");
});

test("savedTrailEndpoint returns the last entry", async () => {
  const core = await loadTrailCoreModule();
  const trail = core.createSavedTrail("T", [
    sampleEntry("https://a.test/"),
    sampleEntry("https://b.test/", "B"),
  ]);
  assert.equal(core.savedTrailEndpoint(trail)?.url, "https://b.test/");
});

test("shouldApplyInheritedSeed fill refuses longer same-lineage and multi-hop races", async () => {
  const core = await loadTrailCoreModule();
  const seeded = core.createInheritedTrailState([
    sampleEntry("https://a.test/"),
    sampleEntry("https://b.test/"),
  ]);
  const empty = core.EMPTY_TRAIL_STATE;
  assert.equal(core.shouldApplyInheritedSeed(empty, seeded, "fill"), true);

  const coldEndpoint = {
    entries: [sampleEntry("https://b.test/")],
    cursor: 0,
  };
  assert.equal(core.shouldApplyInheritedSeed(coldEndpoint, seeded, "fill"), true);

  const sameLineageExtended = {
    entries: [
      ...seeded.entries,
      sampleEntry("https://c.test/"),
    ],
    cursor: 2,
  };
  assert.equal(
    core.shouldApplyInheritedSeed(sameLineageExtended, seeded, "fill"),
    false,
  );

  const multiHopCold = {
    entries: [
      sampleEntry("https://b.test/"),
      sampleEntry("https://c.test/"),
      sampleEntry("https://d.test/"),
    ],
    cursor: 2,
  };
  assert.equal(core.shouldApplyInheritedSeed(multiHopCold, seeded, "fill"), false);

  // replace always installs the open-current path over an unrelated live trail.
  assert.equal(
    core.shouldApplyInheritedSeed(multiHopCold, seeded, "replace"),
    true,
  );
  assert.equal(core.shouldApplyInheritedSeed(empty, seeded, "replace"), true);
  assert.equal(
    core.shouldApplyInheritedSeed(seeded, core.EMPTY_TRAIL_STATE, "fill"),
    false,
  );
});
