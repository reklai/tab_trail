import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function readJson(pathFromRoot) {
  return JSON.parse(readFileSync(resolve(root, pathFromRoot), "utf8"));
}

test("verifyCompat script succeeds", () => {
  const result = spawnSync(process.execPath, [resolve(root, "esBuildConfig/verifyCompat.mjs")], {
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `verifyCompat failed:\nstdout:\n${result.stdout || "(empty)"}\nstderr:\n${result.stderr || "(empty)"}`,
  );
});

test("manifests do not declare keyboard commands (toggle is captured in-page)", () => {
  const v2 = readJson("esBuildConfig/manifest_v2.json");
  const v3 = readJson("esBuildConfig/manifest_v3.json");
  assert.equal(v2.commands, undefined);
  assert.equal(v3.commands, undefined);
});

test("manifests use shared store names and titles", () => {
  const v2 = readJson("esBuildConfig/manifest_v2.json");
  const v3 = readJson("esBuildConfig/manifest_v3.json");
  assert.equal(v2.name, "Wayfind");
  assert.equal(v2.browser_action.default_title, "Wayfind");
  assert.equal(v3.name, "Wayfind");
  assert.equal(v3.action.default_title, "Wayfind");
});

test("manifests and package share the same version", () => {
  const v2 = readJson("esBuildConfig/manifest_v2.json");
  const v3 = readJson("esBuildConfig/manifest_v3.json");
  const packageJson = readJson("package.json");

  assert.equal(packageJson.version, "1.0.0");
  assert.equal(v2.version, packageJson.version);
  assert.equal(v3.version, packageJson.version);
});

test("firefox manifest can observe navigations and run the overlay everywhere", () => {
  const v2 = readJson("esBuildConfig/manifest_v2.json");
  assert.ok(v2.permissions.includes("webNavigation"));
  assert.ok(v2.permissions.includes("tabs"));
  assert.ok(v2.permissions.includes("<all_urls>"));
});

test("chrome manifest can observe navigations and re-inject content scripts", () => {
  const v3 = readJson("esBuildConfig/manifest_v3.json");
  assert.ok(v3.permissions.includes("webNavigation"));
  assert.ok(v3.permissions.includes("scripting"));
  assert.ok(v3.host_permissions.includes("<all_urls>"));
});

test("manifests omit the retired single-slot permissions", () => {
  const v2 = readJson("esBuildConfig/manifest_v2.json");
  const v3 = readJson("esBuildConfig/manifest_v3.json");
  for (const manifest of [v2, v3]) {
    assert.equal(manifest.permissions.includes("tabHide"), false);
    assert.equal(manifest.permissions.includes("sessions"), false);
    assert.equal(manifest.permissions.includes("tabGroups"), false);
  }
});

test("content scripts run early enough to claim the keybind in all frames", () => {
  const v2 = readJson("esBuildConfig/manifest_v2.json");
  const v3 = readJson("esBuildConfig/manifest_v3.json");

  for (const manifest of [v2, v3]) {
    assert.equal(manifest.content_scripts[0].run_at, "document_start");
    assert.equal(manifest.content_scripts[0].all_frames, true);
    assert.equal(manifest.content_scripts[0].match_about_blank, true);
  }
});

test("manifests do not expose native side panel/sidebar surfaces", () => {
  const v2 = readJson("esBuildConfig/manifest_v2.json");
  const v3 = readJson("esBuildConfig/manifest_v3.json");

  assert.equal(v2.sidebar_action, undefined);
  assert.equal(v3.side_panel, undefined);
  assert.equal(v3.permissions.includes("sidePanel"), false);
});

test("firefox manifest contains AMO gecko metadata", () => {
  const v2 = readJson("esBuildConfig/manifest_v2.json");
  const gecko = v2.browser_specific_settings?.gecko;
  assert.equal(typeof gecko?.id, "string");
  assert.ok(gecko.id.length > 0);

  const required = gecko?.data_collection_permissions?.required;
  assert.ok(Array.isArray(required), "Expected gecko.data_collection_permissions.required to be an array.");
  assert.ok(required.includes("none"), 'Expected gecko.data_collection_permissions.required to include "none".');
});
