import test from "node:test";
import assert from "node:assert/strict";
import { loadTsModule } from "./helpers/loadTsModule.mjs";

let contractPromise = null;

function loadTabTrailContractModule() {
  if (!contractPromise) {
    contractPromise = loadTsModule("src/lib/common/contracts/tabtrail.ts", {
      replace: [[
        'import browser from "webextension-polyfill";',
        "const browser = { storage: { local: { get: async () => ({}), set: async () => {} } } };",
      ]],
    });
  }
  return contractPromise;
}

test("trigger keys are limited to letters and top-row digits", async () => {
  const contract = await loadTabTrailContractModule();
  for (const code of ["KeyA", "KeyZ", "Digit0", "Digit9"]) {
    assert.equal(contract.isValidTriggerKeyCode(code), true, `${code} should be valid`);
  }
  for (const code of ["Numpad1", "ArrowLeft", "Escape", "F1", "Space", "KeyAA"]) {
    assert.equal(contract.isValidTriggerKeyCode(code), false, `${code} should be invalid`);
  }
});

test("trigger mouse buttons are limited to left, middle, and right click", async () => {
  const contract = await loadTabTrailContractModule();
  for (const button of [0, 1, 2]) {
    assert.equal(contract.isValidTriggerMouseButton(button), true, `${button} should be valid`);
  }
  for (const button of [-1, 3, 4, 5]) {
    assert.equal(contract.isValidTriggerMouseButton(button), false, `${button} should be invalid`);
  }
});

test("trigger normalizer drops arbitrary keys and side buttons", async () => {
  const contract = await loadTabTrailContractModule();
  const normalized = contract.normalizeTabTrailTrigger({
    modifier: "alt",
    withShift: true,
    kind: "mouse",
    keyCode: "Numpad1",
    mouseButton: 4,
  });

  assert.equal(normalized.kind, "mouse");
  assert.equal(normalized.keyCode, contract.DEFAULT_TABTRAIL_TRIGGER.keyCode);
  assert.equal(normalized.mouseButton, contract.DEFAULT_TABTRAIL_TRIGGER.mouseButton);
});

test("visible row settings clamp to the supported overlay range", async () => {
  const contract = await loadTabTrailContractModule();
  assert.equal(contract.MIN_VISIBLE_SEGMENTS, 5);
  assert.equal(contract.MAX_VISIBLE_SEGMENTS, 12);

  const belowRange = contract.normalizeTabTrailSettings({ maxVisibleSegments: 1 });
  const aboveRange = contract.normalizeTabTrailSettings({ maxVisibleSegments: 50 });
  const invalid = contract.normalizeTabTrailSettings({ maxVisibleSegments: "many" });

  assert.equal(belowRange.maxVisibleSegments, 5);
  assert.equal(aboveRange.maxVisibleSegments, 12);
  assert.equal(invalid.maxVisibleSegments, contract.DEFAULT_TABTRAIL_SETTINGS.maxVisibleSegments);
});
