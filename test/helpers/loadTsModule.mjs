// Shared test helper: transpile a TypeScript source file with esbuild and
// import it as an ES module. Used by the pure-logic tests instead of each one
// re-implementing the same transform -> base64 -> dynamic-import dance.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transform } from "esbuild";

const ROOT = process.cwd();

// `replace` is an optional list of [find, replaceWith] string substitutions
// applied to the source before transpiling — e.g. stubbing the
// webextension-polyfill import so a contract module loads without a browser.
export async function loadTsModule(pathFromRoot, { replace = [] } = {}) {
  let source = readFileSync(resolve(ROOT, pathFromRoot), "utf8");
  for (const [find, replaceWith] of replace) {
    source = source.replace(find, replaceWith);
  }
  const transformed = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  const encoded = Buffer.from(transformed.code, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}
