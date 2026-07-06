import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = process.cwd();
const SRC_DIR = resolve(ROOT, "src");

// storageMigrations.ts intentionally retains the legacy "wayfind*" key literals
// so the v1->v2 migration can read data written by pre-rename builds.
const ALLOWED_LEGACY_FILES = new Set(["storageMigrations.ts"]);

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

test("source no longer references the old Wayfind name", () => {
  const offenders = [];
  for (const file of collectFiles(SRC_DIR)) {
    if (ALLOWED_LEGACY_FILES.has(file.split("/").pop())) continue;
    if (/wayfind/i.test(readFileSync(file, "utf8"))) {
      offenders.push(file.slice(ROOT.length + 1));
    }
  }
  assert.deepEqual(offenders, [], `Files still contain the old "wayfind" name: ${offenders.join(", ")}`);
});
