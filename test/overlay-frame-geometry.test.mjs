import test from "node:test";
import assert from "node:assert/strict";
import { loadTsModule } from "./helpers/loadTsModule.mjs";

let geometryPromise;

function loadGeometry() {
  geometryPromise ??= loadTsModule("src/lib/ui/overlayFrame/surfaceGeometry.ts", {
    replace: [[
      `import {
  OVERLAY_FRAME_MAX_SURFACES,
  type OverlaySurfaceRect,
} from "../../common/contracts/overlayFrame";`,
      "const OVERLAY_FRAME_MAX_SURFACES = 32;",
    ]],
  });
  return geometryPromise;
}

test("surface updates are flush, clamped to the viewport, and fully outside rects are dropped", async () => {
  const geometry = await loadGeometry();
  const result = geometry.validateSurfaceUpdate(
    {
      sequence: 1,
      viewportWidth: 100,
      viewportHeight: 50,
      rects: [
        { x: -2, y: 5, width: 20, height: 10 },
        { x: 95, y: 45, width: 20, height: 20 },
        { x: 150, y: 10, width: 5, height: 5 },
      ],
    },
    { width: 100, height: 50 },
    null,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.rects, [
    { x: 0, y: 5, width: 18, height: 10 },
    { x: 95, y: 45, width: 5, height: 5 },
  ]);
  assert.equal(
    result.value.clipPath,
    'path("M 5 5 H 13 Q 18 5 18 10 V 10 Q 18 15 13 15 H 5 Q 0 15 0 10 V 10 Q 0 5 5 5 Z M 97.5 45 H 97.5 Q 100 45 100 47.5 V 47.5 Q 100 50 97.5 50 H 97.5 Q 95 50 95 47.5 V 47.5 Q 95 45 97.5 45 Z")',
  );
});

test("clip paths keep disjoint surfaces in separate closed subpaths", async () => {
  const geometry = await loadGeometry();
  const clipPath = geometry.buildOverlaySurfaceClipPath([
    { x: 1, y: 2, width: 10, height: 20 },
    { x: 50, y: 60, width: 5, height: 6 },
  ]);

  assert.equal(
    clipPath,
    'path("M 6 2 H 6 Q 11 2 11 7 V 17 Q 11 22 6 22 H 6 Q 1 22 1 17 V 7 Q 1 2 6 2 Z M 52.5 60 H 52.5 Q 55 60 55 62.5 V 63.5 Q 55 66 52.5 66 H 52.5 Q 50 66 50 63.5 V 62.5 Q 50 60 52.5 60 Z")',
  );
  assert.equal((clipPath.match(/\bM\b/g) || []).length, 2);
  assert.equal(geometry.buildOverlaySurfaceClipPath([]), geometry.OVERLAY_EMPTY_CLIP_PATH);
});

test("nextSurfacePublish publishes current only for pure moves and stable open/close", async () => {
  const geometry = await loadGeometry();
  const previous = [{ x: 0, y: 0, width: 10, height: 10 }];
  const moved = [{ x: 20, y: 20, width: 10, height: 10 }];
  const move = geometry.nextSurfacePublish(previous, moved);
  assert.deepEqual(move.publish, moved);
  assert.equal(move.needsContraction, false);
  assert.equal(geometry.isStableSurfaceSetTransition(previous, moved), true);

  const same = geometry.nextSurfacePublish(moved, moved);
  assert.deepEqual(same.publish, moved);
  assert.equal(same.needsContraction, false);

  const withMenu = [
    { x: 20, y: 20, width: 10, height: 10 },
    { x: 40, y: 30, width: 80, height: 120 },
  ];
  const opened = geometry.nextSurfacePublish(moved, withMenu);
  assert.deepEqual(opened.publish, withMenu);
  assert.equal(opened.needsContraction, false);

  const closed = geometry.nextSurfacePublish(withMenu, moved);
  assert.deepEqual(closed.publish, moved);
  assert.equal(closed.needsContraction, false);

  const firstPaint = geometry.nextSurfacePublish([], moved);
  assert.deepEqual(firstPaint.publish, moved);
  assert.equal(firstPaint.needsContraction, false);
});

test("nextSurfacePublish treats same-count surface replacements as close/open", async () => {
  const geometry = await loadGeometry();
  const barBefore = { x: 20, y: 20, width: 100, height: 24 };
  const barAfter = { x: 24, y: 20, width: 100, height: 24 };
  const menu = { x: 40, y: 50, width: 160, height: 220 };
  const dialog = { x: 60, y: 80, width: 320, height: 180 };
  const previous = [barBefore, menu];
  const current = [barAfter, dialog];

  assert.equal(geometry.surfacesSizeMatched(previous, current), false);
  assert.equal(geometry.isStableSurfaceSetTransition(previous, current), true);
  assert.deepEqual(geometry.nextSurfacePublish(previous, current), {
    publish: current,
    needsContraction: false,
  });
  assert.deepEqual(geometry.nextSurfacePublish(current, previous), {
    publish: previous,
    needsContraction: false,
  });
});

test("surfacesSizeMatched finds a complete pairing independent of iteration order", async () => {
  const geometry = await loadGeometry();
  const source = [
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 20, y: 0, width: 12, height: 10 },
  ];
  const target = [
    { x: 40, y: 0, width: 11, height: 10 },
    { x: 60, y: 0, width: 8, height: 10 },
  ];

  assert.equal(geometry.surfacesSizeMatched(source, target), true);
  assert.equal(geometry.surfacesSizeMatched([...source].reverse(), target), true);
  assert.equal(geometry.surfacesSizeMatched(source, [...target].reverse()), true);
  assert.deepEqual(geometry.nextSurfacePublish(source, target), {
    publish: target,
    needsContraction: false,
  });

  const expanded = [
    ...target,
    { x: 80, y: 0, width: 30, height: 10 },
  ];
  assert.deepEqual(geometry.nextSurfacePublish(source, expanded), {
    publish: expanded,
    needsContraction: false,
  });
  assert.deepEqual(geometry.nextSurfacePublish(expanded, source), {
    publish: source,
    needsContraction: false,
  });

  const competing = [
    { x: 40, y: 0, width: 11, height: 10 },
    { x: 60, y: 0, width: 30, height: 10 },
  ];
  assert.equal(geometry.surfacesSizeMatched(source, competing), false);
});

test("nextSurfacePublish unions previous and current when sizes change substantially", async () => {
  const geometry = await loadGeometry();
  const previous = [{ x: 0, y: 0, width: 10, height: 10 }];
  const resized = [{ x: 0, y: 0, width: 10, height: 40 }];
  const transition = geometry.nextSurfacePublish(previous, resized);
  assert.deepEqual(transition.publish, [
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 10, height: 40 },
  ]);
  assert.equal(transition.needsContraction, true);
  assert.equal(geometry.isStableSurfaceSetTransition(previous, resized), false);

  // Within size tolerance still counts as a stable move, not a resize union.
  const near = [{ x: 5, y: 5, width: 10, height: 11.5 }];
  const tolerant = geometry.nextSurfacePublish(previous, near);
  assert.deepEqual(tolerant.publish, near);
  assert.equal(tolerant.needsContraction, false);

  const deduped = geometry.uniqueSurfaceRects([
    { x: 1, y: 1, width: 2, height: 2 },
    { x: 1, y: 1, width: 2, height: 2 },
  ]);
  assert.deepEqual(deduped, [{ x: 1, y: 1, width: 2, height: 2 }]);
  assert.equal(
    geometry.surfaceRectsEqual(resized, [{ x: 0, y: 0, width: 10, height: 40 }]),
    true,
  );
});

test("stale and malformed surface updates fail closed", async () => {
  const geometry = await loadGeometry();
  const viewport = { width: 100, height: 100 };

  assert.equal(geometry.isNewerSurfaceSequence(4, 3), true);
  assert.equal(geometry.isNewerSurfaceSequence(3, 3), false);
  assert.equal(geometry.isNewerSurfaceSequence(2, 3), false);
  assert.equal(geometry.isNewerSurfaceSequence(0, null), true);

  assert.deepEqual(
    geometry.validateSurfaceUpdate(
      { sequence: 3, viewportWidth: 100, viewportHeight: 100, rects: [] },
      viewport,
      3,
    ),
    { ok: false, reason: "stale-sequence" },
  );
  assert.deepEqual(
    geometry.validateSurfaceUpdate(
      {
        sequence: 4,
        viewportWidth: 100,
        viewportHeight: 100,
        rects: [{ x: 0, y: 0, width: Number.NaN, height: 1 }],
      },
      viewport,
      3,
    ),
    { ok: false, reason: "invalid-surface" },
  );
  assert.deepEqual(
    geometry.validateSurfaceUpdate(
      { sequence: 4, viewportWidth: 100, viewportHeight: 100, rects: [] },
      { width: 0, height: 100 },
      3,
    ),
    { ok: false, reason: "invalid-viewport" },
  );
  assert.deepEqual(
    geometry.validateSurfaceUpdate(
      { sequence: 4, viewportWidth: 101, viewportHeight: 100, rects: [] },
      viewport,
      3,
    ),
    { ok: false, reason: "stale-viewport" },
  );
});

test("a surface report is capped at 32 entries", async () => {
  const geometry = await loadGeometry();
  const surface = { x: 1, y: 1, width: 1, height: 1 };
  const accepted = geometry.validateSurfaceUpdate(
    {
      sequence: 1,
      viewportWidth: 100,
      viewportHeight: 100,
      rects: Array.from({ length: 32 }, () => ({ ...surface })),
    },
    { width: 100, height: 100 },
    null,
    { paddingPx: 0 },
  );
  const rejected = geometry.validateSurfaceUpdate(
    {
      sequence: 2,
      viewportWidth: 100,
      viewportHeight: 100,
      rects: Array.from({ length: 33 }, () => ({ ...surface })),
    },
    { width: 100, height: 100 },
    1,
    { paddingPx: 0 },
  );

  assert.equal(accepted.ok, true);
  assert.deepEqual(rejected, { ok: false, reason: "too-many-surfaces" });
});
