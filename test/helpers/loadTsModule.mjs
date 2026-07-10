// Shared test helper: transpile a TypeScript source file with esbuild and
// import it as an ES module. Used by the pure-logic tests instead of each one
// re-implementing the same transform -> base64 -> dynamic-import dance.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, transform } from "esbuild";

const ROOT = process.cwd();

// `replace` is an optional list of [find, replaceWith] string substitutions
// applied to the source before transpiling — e.g. stubbing the
// webextension-polyfill import so a contract module loads without a browser.
// When the entry has relative local imports (or re-exports), we bundle so the
// data-URL import path is self-contained.
export async function loadTsModule(pathFromRoot, { replace = [] } = {}) {
  const absoluteEntry = resolve(ROOT, pathFromRoot);
  let source = readFileSync(absoluteEntry, "utf8");
  for (const [find, replaceWith] of replace) {
    source = source.replace(find, replaceWith);
  }

  const needsBundle =
    replace.length === 0 &&
    /(?:from|export\s+\{[^}]*\}\s+from)\s+["']\.\.?\/[^"']+["']/.test(source);

  if (!needsBundle) {
    const transformed = await transform(source, {
      loader: "ts",
      format: "esm",
      target: "es2022",
    });
    const encoded = Buffer.from(transformed.code, "utf8").toString("base64");
    return import(`data:text/javascript;base64,${encoded}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "load-ts-module-"));
  const outfile = join(tempDir, "module.mjs");
  try {
    await build({
      entryPoints: [absoluteEntry],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      outfile,
      logLevel: "silent",
      write: true,
    });
    return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    // Defer cleanup so the dynamic import can finish reading the file.
    setTimeout(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {
        // Best-effort cleanup of the temp bundle.
      }
    }, 0);
  }
}
