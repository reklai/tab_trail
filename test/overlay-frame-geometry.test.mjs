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

test("surface updates are padded, clamped to the viewport, and fully outside rects are dropped", async () => {
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
    { x: 0, y: 1, width: 22, height: 18 },
    { x: 91, y: 41, width: 9, height: 9 },
  ]);
  assert.equal(
    result.value.clipPath,
    'path("M 0 1 H 22 V 19 H 0 Z M 91 41 H 100 V 50 H 91 Z")',
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
    'path("M 1 2 H 11 V 22 H 1 Z M 50 60 H 55 V 66 H 50 Z")',
  );
  assert.equal((clipPath.match(/\bM\b/g) || []).length, 2);
  assert.equal(geometry.buildOverlaySurfaceClipPath([]), geometry.OVERLAY_EMPTY_CLIP_PATH);
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
