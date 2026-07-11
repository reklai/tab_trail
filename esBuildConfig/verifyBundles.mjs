import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");
const KB = 1024;

export const BUNDLE_BUDGETS = Object.freeze([
  { path: "overlayFrame/overlayFrame.js", maxBytes: 140 * KB },
  { path: "contentScriptTop.js", maxBytes: 45 * KB },
  { path: "contentScriptChord.js", maxBytes: 20 * KB },
  { path: "contentScript.js", maxBytes: 50 * KB },
  { path: "background.js", maxBytes: 45 * KB },
]);

function formatKB(bytes) {
  return `${(bytes / KB).toFixed(1)} KB`;
}

export function verifyBundleSizes({ distDir = dist, budgets = BUNDLE_BUDGETS } = {}) {
  const results = [];
  const errors = [];

  for (const budget of budgets) {
    const bundlePath = resolve(distDir, budget.path);
    let size;
    try {
      size = statSync(bundlePath).size;
    } catch (error) {
      if (error?.code === "ENOENT") {
        errors.push(`Missing bundle: ${budget.path}`);
        continue;
      }
      throw error;
    }

    results.push({ ...budget, size });
    if (size > budget.maxBytes) {
      errors.push(
        `${budget.path} is ${size} bytes (${formatKB(size)}); ` +
          `budget is ${budget.maxBytes} bytes (${formatKB(budget.maxBytes)}).`,
      );
    }
  }

  return { results, errors };
}

function readTarget(argv) {
  const targetIndex = argv.indexOf("--target");
  const target = targetIndex === -1 ? undefined : argv[targetIndex + 1];
  if (targetIndex !== -1 && target === undefined) {
    throw new Error('Missing value after "--target".');
  }
  if (target !== undefined && !["firefox", "chrome"].includes(target)) {
    throw new Error(`Unknown target "${target}". Use "firefox" or "chrome".`);
  }
  return target;
}

function main() {
  const target = readTarget(process.argv.slice(2));
  const { results, errors } = verifyBundleSizes();

  if (errors.length > 0) {
    console.error(`[verify:bundles] FAILED${target ? ` (${target})` : ""}`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[verify:bundles] OK${target ? ` (${target})` : ""}`);
  for (const result of results) {
    console.log(
      `- ${result.path}: ${formatKB(result.size)} / ${formatKB(result.maxBytes)}`,
    );
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error("[verify:bundles] FAILED");
    console.error(`- ${error.message}`);
    process.exitCode = 1;
  }
}
