import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function readText(pathFromRoot) {
  return readFileSync(resolve(root, pathFromRoot), "utf8");
}

function readJson(pathFromRoot) {
  return JSON.parse(readText(pathFromRoot));
}

const errors = [];

const manifestV2 = readJson("esBuildConfig/manifest_v2.json");
const manifestV3 = readJson("esBuildConfig/manifest_v3.json");

const store = readText("STORE.md");
const privacy = readText("PRIVACY.md");

const CHROME_NAME_LIMIT = 75;
const FIREFOX_NAME_LIMIT = 50;
const CHROME_SUMMARY_LIMIT = 132;
const FIREFOX_SUMMARY_LIMIT = 250;

function checkMaxLength(label, value, limit) {
  if (value.length > limit) {
    errors.push(`${label} must be <=${limit} chars (found ${value.length}).`);
  }
}

// Validate one store's STORE.md summary section: it must exist, be non-empty,
// fit the store's character limit, and (Chrome only) match the manifest.
function checkStoreSummary({ storeLabel, heading, limit, mustEqual }) {
  const match = store.match(heading);
  if (!match) {
    errors.push(`STORE.md must include the ${storeLabel} summary section.`);
    return;
  }
  const summaryLine = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!summaryLine) {
    errors.push(`STORE.md ${storeLabel} summary cannot be empty.`);
  } else if (summaryLine.length > limit) {
    errors.push(`STORE.md ${storeLabel} summary must be <=${limit} chars (found ${summaryLine.length}).`);
  } else if (mustEqual !== undefined && summaryLine !== mustEqual) {
    errors.push(`STORE.md ${storeLabel} summary must match the manifest description.`);
  }
}

if (manifestV2.description !== manifestV3.description) {
  errors.push("Manifest descriptions must match between MV2 and MV3.");
}
checkMaxLength("Firefox manifest name", manifestV2.name, FIREFOX_NAME_LIMIT);
checkMaxLength("Chrome manifest name", manifestV3.name, CHROME_NAME_LIMIT);
checkMaxLength("Chrome manifest description", manifestV3.description, CHROME_SUMMARY_LIMIT);

const extensionNamesMatch = store.match(/## Extension Names\s+([\s\S]*?)\n## /);
if (!extensionNamesMatch) {
  errors.push("STORE.md must include an '## Extension Names' section.");
} else {
  const extensionNames = extensionNamesMatch[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!extensionNames.some((line) => line.includes(`Firefox / Zen: ${manifestV2.name}`))) {
    errors.push(`STORE.md Firefox / Zen name must match MV2 manifest (${manifestV2.name}).`);
  }
  if (!extensionNames.some((line) => line.includes(`Chrome: ${manifestV3.name}`))) {
    errors.push(`STORE.md Chrome name must match MV3 manifest (${manifestV3.name}).`);
  }
}

checkStoreSummary({
  storeLabel: "Chrome",
  heading: /## Chrome Summary[^\n]*\s+([\s\S]*?)\n## /,
  limit: CHROME_SUMMARY_LIMIT,
  mustEqual: manifestV3.description,
});
checkStoreSummary({
  storeLabel: "Firefox",
  heading: /## Firefox Summary[^\n]*\s+([\s\S]*?)\n## /,
  limit: FIREFOX_SUMMARY_LIMIT,
});

const requiredPermissionDocs = ["webNavigation", "tabs", "storage", "scripting", "<all_urls>"];
for (const permission of requiredPermissionDocs) {
  if (!store.includes(permission)) {
    errors.push(`STORE.md must document permission: ${permission}`);
  }
  if (!privacy.includes(permission)) {
    errors.push(`PRIVACY.md must document permission: ${permission}`);
  }
}

if (!store.includes("No data leaves your browser")) {
  errors.push("STORE.md must state local-only data handling.");
}
if (!store.includes("Works on Firefox, Chrome, and Zen Browser")) {
  errors.push("STORE.md must mention Firefox/Chrome/Zen support.");
}
if (!privacy.includes("does not collect, transmit, or share")) {
  errors.push("PRIVACY.md summary must explicitly state no data collection/transmission.");
}

if (errors.length > 0) {
  console.error("[verify:store] FAILED");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("[verify:store] OK");
console.log(`- Firefox/Zen name: ${manifestV2.name}`);
console.log(`- Chrome name: ${manifestV3.name}`);
console.log(`- Description length: ${manifestV2.description.length}`);
console.log(`- Checked permissions docs: ${requiredPermissionDocs.length}`);
