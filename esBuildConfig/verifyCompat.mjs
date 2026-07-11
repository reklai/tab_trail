import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function loadJson(file) {
  return JSON.parse(readFileSync(resolve(__dirname, file), "utf8"));
}

function fileExists(pathFromRoot) {
  return existsSync(resolve(root, pathFromRoot));
}

function pngDimensions(pathFromRoot) {
  const buffer = readFileSync(resolve(root, pathFromRoot));
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function hasAll(actual, required) {
  return required.every((item) => actual.includes(item));
}

function hasNone(actual, forbidden) {
  return forbidden.every((item) => !actual.includes(item));
}

function countSuggestedCommands(commands) {
  return Object.values(commands || {}).filter((command) => command?.suggested_key).length;
}

const manifestV2 = loadJson("manifest_v2.json");
const manifestV3 = loadJson("manifest_v3.json");

const errors = [];
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const OVERLAY_FRAME_RESOURCE = "overlayFrame/overlayFrame.html";

if (!SEMVER_RE.test(String(manifestV2.version || "")) || !SEMVER_RE.test(String(manifestV3.version || ""))) {
  errors.push("Both manifests must use a semver version string (x.y.z).");
}

for (const [name, manifest] of [
  ["MV2", manifestV2],
  ["MV3", manifestV3],
]) {
  if (!manifest.name || typeof manifest.name !== "string") {
    errors.push(`${name} must declare a non-empty "name".`);
  }
  if (!manifest.description || typeof manifest.description !== "string") {
    errors.push(`${name} must declare a non-empty "description".`);
  }
}

const requiredV2Permissions = ["webNavigation", "tabs", "storage", "<all_urls>"];
if (!hasAll(manifestV2.permissions || [], requiredV2Permissions)) {
  errors.push("MV2 is missing required permissions for runtime features.");
}
// Chrome-only permissions must not appear in the Firefox manifest, and the
// old single-slot permissions must not creep back into either manifest.
if (!hasNone(manifestV2.permissions || [], ["tabGroups", "scripting", "tabHide", "sessions"])) {
  errors.push("MV2 must not declare Chrome-only (scripting, tabGroups) or retired (tabHide, sessions) permissions.");
}
if (manifestV2.incognito !== "spanning") {
  errors.push('MV2 must use "spanning" incognito mode; Firefox does not support split mode.');
}

const geckoSettings = manifestV2.browser_specific_settings?.gecko;
if (!geckoSettings?.id || typeof geckoSettings.id !== "string") {
  errors.push("MV2 must declare browser_specific_settings.gecko.id for AMO signing.");
}

const requiredDataCollection = geckoSettings?.data_collection_permissions?.required;
if (!Array.isArray(requiredDataCollection) || requiredDataCollection.length === 0) {
  errors.push("MV2 must declare gecko.data_collection_permissions.required for AMO submissions.");
} else if (!requiredDataCollection.includes("none")) {
  errors.push("MV2 data_collection_permissions.required must include \"none\" for no external data collection.");
}

const requiredV3Permissions = ["webNavigation", "tabs", "storage", "scripting"];
if (!hasAll(manifestV3.permissions || [], requiredV3Permissions)) {
  errors.push("MV3 is missing required permissions for runtime features.");
}
// Firefox-only permissions must not appear in the Chrome manifest (Chrome
// rejects unknown permissions), and the retired tab-group park path must not
// creep back in.
if (!hasNone(manifestV3.permissions || [], ["tabHide", "sessions", "tabGroups"])) {
  errors.push("MV3 must not declare Firefox-only (tabHide, sessions) or retired (tabGroups) permissions.");
}
if (manifestV3.incognito !== "split") {
  errors.push('MV3 must use "split" incognito mode so Chrome can load the extension overlay frame in incognito tabs.');
}

if (!hasAll(manifestV3.host_permissions || [], ["<all_urls>"])) {
  errors.push("MV3 host_permissions must include <all_urls> for content script coverage.");
}

const v2WebResources = manifestV2.web_accessible_resources;
if (
  !Array.isArray(v2WebResources) ||
  v2WebResources.length !== 1 ||
  v2WebResources[0] !== OVERLAY_FRAME_RESOURCE
) {
  errors.push(`MV2 must expose only ${OVERLAY_FRAME_RESOURCE} as a web-accessible resource.`);
}

const v3WebResources = manifestV3.web_accessible_resources;
const v3OverlayResource = Array.isArray(v3WebResources) && v3WebResources.length === 1
  ? v3WebResources[0]
  : null;
if (
  !v3OverlayResource ||
  !Array.isArray(v3OverlayResource.resources) ||
  v3OverlayResource.resources.length !== 1 ||
  v3OverlayResource.resources[0] !== OVERLAY_FRAME_RESOURCE ||
  !Array.isArray(v3OverlayResource.matches) ||
  v3OverlayResource.matches.length !== 1 ||
  v3OverlayResource.matches[0] !== "<all_urls>" ||
  v3OverlayResource.use_dynamic_url !== false
) {
  errors.push(
    `MV3 must expose only ${OVERLAY_FRAME_RESOURCE} to <all_urls> through a stable extension URL.`,
  );
}

const suggestedCount = countSuggestedCommands(manifestV3.commands);
if (suggestedCount !== 0) {
  errors.push(`MV3 must not declare keyboard shortcuts; the toggle is captured in-page (found ${suggestedCount}).`);
}

if (manifestV2.commands || manifestV3.commands) {
  errors.push("TabTrail manifests must not declare commands; the toggle is captured in the content script.");
}

if (manifestV2.options_ui?.page !== "optionsPage/optionsPage.html") {
  errors.push('MV2 options_ui.page must be "optionsPage/optionsPage.html".');
}
if (manifestV3.options_ui?.page !== "optionsPage/optionsPage.html") {
  errors.push('MV3 options_ui.page must be "optionsPage/optionsPage.html".');
}

const v2Popup = manifestV2.browser_action?.default_popup;
const v3Popup = manifestV3.action?.default_popup;
if (v2Popup !== "toolbarPopup/toolbarPopup.html" || v3Popup !== "toolbarPopup/toolbarPopup.html") {
  errors.push('Both manifests must use "toolbarPopup/toolbarPopup.html" as default popup.');
}

for (const [name, manifest] of [
  ["MV2", manifestV2],
  ["MV3", manifestV3],
]) {
  const scripts = manifest.content_scripts ?? [];
  const chord = scripts.find((entry) =>
    Array.isArray(entry.js) && entry.js.includes("contentScriptChord.js"));
  const top = scripts.find((entry) =>
    Array.isArray(entry.js) && entry.js.includes("contentScriptTop.js"));
  if (!chord) {
    errors.push(`${name} must register contentScriptChord.js for toggle capture.`);
  } else {
    if (chord.run_at !== "document_start") {
      errors.push(`${name} chord content script must run at document_start.`);
    }
    if (chord.all_frames !== true) {
      errors.push(`${name} chord content script must run in all frames.`);
    }
    if (chord.match_about_blank !== true) {
      errors.push(`${name} chord content script must match about:blank child frames.`);
    }
  }
  if (!top) {
    errors.push(`${name} must register contentScriptTop.js for the top-frame overlay host.`);
  } else {
    if (top.run_at !== "document_start") {
      errors.push(`${name} top content script must run at document_start.`);
    }
    if (top.all_frames !== false && top.all_frames !== undefined) {
      // Explicit false preferred; undefined also means top-only in Chromium.
      if (top.all_frames === true) {
        errors.push(`${name} top content script must not inject into subframes.`);
      }
    }
  }
}

// Single source of truth for every shipped PNG. `iconSize` marks the
// toolbar/store icons that must also appear in each manifest's `icons` map;
// `dimensions` is the required pixel size. This one table drives the manifest
// icon check, the existence check, and the dimension check below.
const pngAssets = [
  { path: "src/icons/icon-32.png", iconSize: 32, dimensions: [32, 32] },
  { path: "src/icons/icon-48.png", iconSize: 48, dimensions: [48, 48] },
  { path: "src/icons/icon-64.png", iconSize: 64, dimensions: [64, 64] },
  { path: "src/icons/icon-96.png", iconSize: 96, dimensions: [96, 96] },
  { path: "src/icons/icon-128.png", iconSize: 128, dimensions: [128, 128] },
  { path: "src/icons/icon-1024.png", dimensions: [1024, 1024] },
  { path: "src/icons/promo-440x280.png", dimensions: [440, 280] },
  { path: "src/icons/marquee-1400x560.png", dimensions: [1400, 560] },
];

const requiredIconSizes = pngAssets
  .filter((asset) => asset.iconSize !== undefined)
  .map((asset) => String(asset.iconSize));

for (const [name, manifest] of [
  ["MV2", manifestV2],
  ["MV3", manifestV3],
]) {
  const icons = manifest.icons || {};
  for (const size of requiredIconSizes) {
    if (!icons[size]) {
      errors.push(`${name} icons must include size ${size}.`);
    }
  }
}

const requiredSourceFiles = [
  "src/entryPoints/contentScript/contentScriptChord.ts",
  "src/entryPoints/contentScript/contentScriptTop.ts",
  "src/entryPoints/contentScript/contentScript.ts",
  "src/entryPoints/backgroundRuntime/background.ts",
  "src/entryPoints/overlayFrame/overlayFrame.ts",
  "src/entryPoints/overlayFrame/overlayFrame.html",
  "src/entryPoints/overlayFrame/overlayFrame.css",
  "src/entryPoints/optionsPage/optionsPage.html",
  "src/entryPoints/optionsPage/optionsPage.css",
  "src/entryPoints/toolbarPopup/toolbarPopup.html",
  "src/entryPoints/toolbarPopup/toolbarPopup.css",
  "src/lib/ui/panels/breadcrumbTrail/breadcrumbTrail.ts",
  "src/lib/ui/panels/breadcrumbTrail/breadcrumbTrail.css",
  "src/lib/ui/panels/breadcrumbTrail/savedTrailsPanel.css",
  ...pngAssets.map((asset) => asset.path),
];
for (const requiredFile of requiredSourceFiles) {
  if (!fileExists(requiredFile)) {
    errors.push(`Missing required source asset: ${requiredFile}`);
  }
}

for (const { path: pngPath, dimensions: [expectedWidth, expectedHeight] } of pngAssets) {
  if (!fileExists(pngPath)) continue;
  const dimensions = pngDimensions(pngPath);
  if (!dimensions || dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
    errors.push(`${pngPath} must be a ${expectedWidth}x${expectedHeight} PNG.`);
  }
}

if (errors.length > 0) {
  console.error("[verify:compat] FAILED");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("[verify:compat] OK");
console.log(`- MV2 permissions: ${(manifestV2.permissions || []).length}`);
console.log(`- MV3 permissions: ${(manifestV3.permissions || []).length}`);
console.log(`- MV3 suggested shortcuts: ${suggestedCount}`);
