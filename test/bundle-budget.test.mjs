import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  BUNDLE_BUDGETS,
  verifyBundleSizes,
} from "../esBuildConfig/verifyBundles.mjs";

function withBundleFixture(sizes, run) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "tabtrail-bundle-budget-"));
  try {
    for (const [path, size] of Object.entries(sizes)) {
      const outputPath = resolve(fixtureDir, path);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, Buffer.alloc(size));
    }
    run(fixtureDir);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

test("bundle budgets cover every latency-sensitive production bundle", () => {
  assert.deepEqual(
    BUNDLE_BUDGETS.map(({ path, maxBytes }) => [path, maxBytes]),
    [
      ["overlayFrame/overlayFrame.js", 140 * 1024],
      ["contentScriptTop.js", 45 * 1024],
      ["contentScriptChord.js", 20 * 1024],
      ["contentScript.js", 50 * 1024],
      ["background.js", 45 * 1024],
    ],
  );
});

test("bundle verifier accepts files at their exact budgets", () => {
  const sizes = Object.fromEntries(
    BUNDLE_BUDGETS.map(({ path, maxBytes }) => [path, maxBytes]),
  );
  withBundleFixture(sizes, (distDir) => {
    const result = verifyBundleSizes({ distDir });
    assert.equal(result.errors.length, 0);
    assert.equal(result.results.length, BUNDLE_BUDGETS.length);
  });
});

test("bundle verifier reports oversized and missing output", () => {
  const [oversized, missing, ...withinBudget] = BUNDLE_BUDGETS;
  const sizes = Object.fromEntries([
    [oversized.path, oversized.maxBytes + 1],
    ...withinBudget.map(({ path, maxBytes }) => [path, maxBytes]),
  ]);

  withBundleFixture(sizes, (distDir) => {
    const result = verifyBundleSizes({ distDir });
    assert.deepEqual(result.errors, [
      `${oversized.path} is ${oversized.maxBytes + 1} bytes (140.0 KB); ` +
        `budget is ${oversized.maxBytes} bytes (140.0 KB).`,
      `Missing bundle: ${missing.path}`,
    ]);
  });
});
