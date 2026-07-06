import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transform } from "esbuild";

const ROOT = process.cwd();

let corePromise = null;

function loadTrailCoreModule() {
  if (!corePromise) {
    corePromise = (async () => {
      const source = readFileSync(resolve(ROOT, "src/lib/core/trail/trailCore.ts"), "utf8");
      const transformed = await transform(source, {
        loader: "ts",
        format: "esm",
        target: "es2022",
      });
      const encoded = Buffer.from(transformed.code, "utf8").toString("base64");
      return import(`data:text/javascript;base64,${encoded}`);
    })();
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
  assert.equal(healed.cursor, 1);
});
