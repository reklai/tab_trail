import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transform } from "esbuild";

const ROOT = process.cwd();

let contractPromise = null;

function loadWayfindContractModule() {
  if (!contractPromise) {
    contractPromise = (async () => {
      const source = readFileSync(resolve(ROOT, "src/lib/common/contracts/wayfind.ts"), "utf8")
        .replace(
          'import browser from "webextension-polyfill";',
          "const browser = { storage: { local: { get: async () => ({}), set: async () => {} } } };",
        );
      const transformed = await transform(source, {
        loader: "ts",
        format: "esm",
        target: "es2022",
      });
      const encoded = Buffer.from(transformed.code, "utf8").toString("base64");
      return import(`data:text/javascript;base64,${encoded}`);
    })();
  }
  return contractPromise;
}

test("trigger keys are limited to letters and top-row digits", async () => {
  const contract = await loadWayfindContractModule();
  for (const code of ["KeyA", "KeyZ", "Digit0", "Digit9"]) {
    assert.equal(contract.isValidTriggerKeyCode(code), true, `${code} should be valid`);
  }
  for (const code of ["Numpad1", "ArrowLeft", "Escape", "F1", "Space", "KeyAA"]) {
    assert.equal(contract.isValidTriggerKeyCode(code), false, `${code} should be invalid`);
  }
});

test("trigger mouse buttons are limited to left, middle, and right click", async () => {
  const contract = await loadWayfindContractModule();
  for (const button of [0, 1, 2]) {
    assert.equal(contract.isValidTriggerMouseButton(button), true, `${button} should be valid`);
  }
  for (const button of [-1, 3, 4, 5]) {
    assert.equal(contract.isValidTriggerMouseButton(button), false, `${button} should be invalid`);
  }
});

test("trigger normalizer drops arbitrary keys and side buttons", async () => {
  const contract = await loadWayfindContractModule();
  const normalized = contract.normalizeWayfindTrigger({
    modifier: "alt",
    withShift: true,
    kind: "mouse",
    keyCode: "Numpad1",
    mouseButton: 4,
  });

  assert.equal(normalized.kind, "mouse");
  assert.equal(normalized.keyCode, contract.DEFAULT_WAYFIND_TRIGGER.keyCode);
  assert.equal(normalized.mouseButton, contract.DEFAULT_WAYFIND_TRIGGER.mouseButton);
});

test("path color hints are always enabled by normalized settings", async () => {
  const contract = await loadWayfindContractModule();
  const normalized = contract.normalizeWayfindSettings({
    trigger: contract.DEFAULT_WAYFIND_TRIGGER,
    showTransitionArrows: false,
    overlayPosition: null,
    maxVisibleSegments: 8,
  });

  assert.equal(normalized.showTransitionArrows, true);
});

test("visible row settings clamp to the supported overlay range", async () => {
  const contract = await loadWayfindContractModule();
  assert.equal(contract.MIN_VISIBLE_SEGMENTS, 5);
  assert.equal(contract.MAX_VISIBLE_SEGMENTS, 12);

  const belowRange = contract.normalizeWayfindSettings({ maxVisibleSegments: 1 });
  const aboveRange = contract.normalizeWayfindSettings({ maxVisibleSegments: 50 });
  const invalid = contract.normalizeWayfindSettings({ maxVisibleSegments: "many" });

  assert.equal(belowRange.maxVisibleSegments, 5);
  assert.equal(aboveRange.maxVisibleSegments, 12);
  assert.equal(invalid.maxVisibleSegments, contract.DEFAULT_WAYFIND_SETTINGS.maxVisibleSegments);
});
