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
  for (const doc of ["RELEASE.md", "STORE.md", "PRIVACY.md", "OVERLAY_UI.md", "STABILITY.md"]) {
    assert.ok(contributing.includes(doc), `CONTRIBUTING.md must reference ${doc}`);
  }
});

test("README documents the trigger, tracking, and saved-trail persistence model", () => {
  const readme = readText("README.md");
  assert.match(readme, /Alt \+ H/);
  assert.match(readme, /webNavigation/);
  assert.match(readme, /Live trails are session-only/);
  assert.match(readme, /named saved trails.*persist/is);
  assert.match(readme, /complete navigation trees must be unique/i);
  assert.match(readme, /shorter\s+or longer versions of a path can still be saved separately/i);
  assert.doesNotMatch(readme, /\bduplicate\b/i);
  assert.match(readme, /toolbar\s+popup/i);
  assert.match(readme, /Works on Firefox, Chrome, and Zen Browser/);
  assert.match(readme, /restores the last-known viewport|last-known scroll/i);
});

test("store and options copy describe saved-trail persistence and uniqueness", () => {
  const store = readText("STORE.md");
  const options = readText("src/entryPoints/optionsPage/optionsPage.html");
  assert.match(store, /complete navigation trees must be unique/i);
  assert.doesNotMatch(store, /\bduplicate\b/i);
  assert.match(
    options,
    /Live trails are session-only and clear when the browser closes\. Named saved trails persist locally; neither is sent over the network\./,
  );
  assert.match(
    options,
    /Saved trail names and complete navigation trees must be unique\. Shorter or longer versions of a path can still be saved separately\./,
  );
});

test("PRIVACY documents the stored keys and the no-collection stance", () => {
  const privacy = readText("PRIVACY.md");
  assert.match(privacy, /tabtrailSettings/);
  assert.match(privacy, /tabtrailSavedTrails/);
  assert.match(privacy, /tabtrailTrail:/);
  assert.match(privacy, /storageSchemaVersion/);
  assert.match(privacy, /does not collect, transmit, or share/);
  assert.match(privacy, /viewport pixel offsets \(scroll position\)/);
  assert.match(privacy, /never page content/i);
});

test("docs carry no leftover branding from earlier concepts", () => {
  for (const doc of [
    "README.md",
    "STORE.md",
    "PRIVACY.md",
    "CONTRIBUTING.md",
    "RELEASE.md",
    "OVERLAY_UI.md",
    "STABILITY.md",
  ]) {
    const text = readText(doc);
    assert.doesNotMatch(text, /TabWheel/, `${doc} should not mention TabWheel`);
    assert.doesNotMatch(text, /Scratchpad/i, `${doc} should not mention the scratchpad concept`);
    assert.doesNotMatch(text, /Wayfind/, `${doc} should not expose the old public brand`);
  }
});
