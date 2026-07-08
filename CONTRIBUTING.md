# Contributing to Current Tab History - In-Page Trail

Thanks for helping out. This is a vanilla TypeScript WebExtension - no UI
frameworks - built with esbuild and checked with Node's built-in test runner.

## Setup

```bash
npm install
npm run build:firefox   # or build:chrome
```

- **Firefox / Zen:** open `about:debugging` -> This Firefox -> Load Temporary
  Add-on -> pick `dist/manifest.json` after `npm run build:firefox`.
- **Chrome:** open `chrome://extensions`, enable Developer mode -> Load unpacked
  -> select `dist/` after `npm run build:chrome`.

Use `npm run watch:firefox` / `watch:chrome` to rebuild on change, then reload
the extension.

## Project layout

- `src/entryPoints/` - the four bundled entry points (background, content
  script, toolbar popup, options page).
- `src/lib/core/` - pure, browser-free logic (the trail reducer, jump planner,
  and shortcut matcher). Unit-tested directly.
- `src/lib/backgroundRuntime/` - the trail domain (`webNavigation` intake,
  session-storage mirror, jump orchestration) and the message router.
- `src/lib/common/` - contracts (message + settings shapes) and shared utilities.
- `src/lib/ui/` - the trail overlay and shared settings controls.
- `esBuildConfig/` - build, manifests, and the lint/verify tooling.

The custom architecture linter (`npm run lint`) enforces the layer boundaries,
naming conventions, and overlay contracts. Keep `core` pure and do not let `ui`
import `backgroundRuntime`.

## Before opening a PR

Run the full check suite:

```bash
npm run ci
```

This runs lint, tests, typecheck, the compatibility/upgrade/store verifiers, and
both browser builds.

## Related docs

- `RELEASE.md` - how versioned release artifacts are built and packaged.
- `STORE.md` - the store listing copy (names, summary, permissions).
- `PRIVACY.md` - the privacy policy; update it whenever stored data or
  permissions change.
