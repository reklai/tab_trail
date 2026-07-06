import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function readText(pathFromRoot) {
  return readFileSync(resolve(ROOT, pathFromRoot), "utf8");
}

test("CONTRIBUTING references the release, store, and privacy docs", () => {
  const contributing = readText("CONTRIBUTING.md");
  for (const doc of ["RELEASE.md", "STORE.md", "PRIVACY.md"]) {
    assert.ok(contributing.includes(doc), `CONTRIBUTING.md must reference ${doc}`);
  }
});

test("README documents the trigger, the tracking API, and the session-only model", () => {
  const readme = readText("README.md");
  assert.match(readme, /Alt \+ H/);
  assert.match(readme, /webNavigation/);
  assert.match(readme, /session/i);
  assert.match(readme, /toolbar\s+popup/i);
  assert.match(readme, /Works on Firefox, Chrome, and Zen Browser/);
});

test("PRIVACY documents the stored keys and the no-collection stance", () => {
  const privacy = readText("PRIVACY.md");
  assert.match(privacy, /tabtrailSettings/);
  assert.match(privacy, /tabtrailTrail:/);
  assert.match(privacy, /storageSchemaVersion/);
  assert.match(privacy, /does not collect, transmit, or share/);
});

test("docs carry no leftover branding from earlier concepts", () => {
  for (const doc of ["README.md", "STORE.md", "PRIVACY.md", "CONTRIBUTING.md", "RELEASE.md"]) {
    const text = readText(doc);
    assert.doesNotMatch(text, /TabWheel/, `${doc} should not mention TabWheel`);
    assert.doesNotMatch(text, /Scratchpad/i, `${doc} should not mention the scratchpad concept`);
    assert.doesNotMatch(text, /Wayfind/, `${doc} should not expose the old public brand`);
  }
});
