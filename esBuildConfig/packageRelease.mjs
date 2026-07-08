import { readFileSync, rmSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");
const releaseDir = resolve(root, "release");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = packageJson.version;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function zipDirectory(sourceDir, archivePath) {
  run("zip", ["-r", "-q", archivePath, "."], { cwd: sourceDir });
}

// Directories left out of the source archive (kept in sync with .gitignore).
const SOURCE_ZIP_EXCLUDED_DIRS = [".agents", ".claude", ".codex", "dist", "release", "node_modules"];

function zipSource(archivePath) {
  run("zip", [
    "-r",
    "-q",
    archivePath,
    ".",
    "-x",
    ".git/*",
    ...SOURCE_ZIP_EXCLUDED_DIRS.flatMap((dir) => [dir, `${dir}/`, `${dir}/*`]),
  ]);
}

function main() {
  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });

  run("npm", ["run", "build:firefox"]);
  zipDirectory(dist, resolve(releaseDir, `tabtrail-firefox-v${version}.xpi`));

  run("npm", ["run", "build:chrome"]);
  zipDirectory(dist, resolve(releaseDir, `tabtrail-chrome-v${version}.zip`));

  zipSource(resolve(releaseDir, `tabtrail-source-v${version}.zip`));

  console.log("[release] Done");
  console.log(`- release/tabtrail-firefox-v${version}.xpi`);
  console.log(`- release/tabtrail-chrome-v${version}.zip`);
  console.log(`- release/tabtrail-source-v${version}.zip`);
}

try {
  main();
} catch (error) {
  console.error("[release] FAILED");
  console.error(error);
  process.exit(1);
}
