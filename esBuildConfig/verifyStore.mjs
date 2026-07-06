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

if (manifestV2.description !== manifestV3.description) {
  errors.push("Manifest descriptions must match between MV2 and MV3.");
}
if (manifestV2.name.length > FIREFOX_NAME_LIMIT) {
  errors.push(`Firefox manifest name must be <=${FIREFOX_NAME_LIMIT} chars (found ${manifestV2.name.length}).`);
}
if (manifestV3.name.length > CHROME_NAME_LIMIT) {
  errors.push(`Chrome manifest name must be <=${CHROME_NAME_LIMIT} chars (found ${manifestV3.name.length}).`);
}
if (manifestV3.description.length > CHROME_SUMMARY_LIMIT) {
  errors.push(`Chrome manifest description must be <=${CHROME_SUMMARY_LIMIT} chars (found ${manifestV3.description.length}).`);
}

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

const chromeSummaryMatch = store.match(/## Chrome Summary[^\n]*\s+([\s\S]*?)\n## /);
if (!chromeSummaryMatch) {
  errors.push("STORE.md must include the Chrome summary section.");
} else {
  const summaryLine = chromeSummaryMatch[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!summaryLine) {
    errors.push("STORE.md Chrome summary cannot be empty.");
  } else if (summaryLine.length > CHROME_SUMMARY_LIMIT) {
    errors.push(`STORE.md Chrome summary must be <=${CHROME_SUMMARY_LIMIT} chars (found ${summaryLine.length}).`);
  } else if (summaryLine !== manifestV3.description) {
    errors.push("STORE.md Chrome summary must match the manifest description.");
  }
}

const firefoxSummaryMatch = store.match(/## Firefox Summary[^\n]*\s+([\s\S]*?)\n## /);
if (!firefoxSummaryMatch) {
  errors.push("STORE.md must include the Firefox summary section.");
} else {
  const summaryLine = firefoxSummaryMatch[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!summaryLine) {
    errors.push("STORE.md Firefox summary cannot be empty.");
  } else if (summaryLine.length > FIREFOX_SUMMARY_LIMIT) {
    errors.push(`STORE.md Firefox summary must be <=${FIREFOX_SUMMARY_LIMIT} chars (found ${summaryLine.length}).`);
  }
}

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
