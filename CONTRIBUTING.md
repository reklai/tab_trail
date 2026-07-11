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

The overlay is a two-document system (page host iframe + extension-origin
panel). See `OVERLAY_UI.md` for architecture, design tokens, hit-surface
clipping, and a phase-ordered reconstruction checklist if that stack needs
rebuilding. See `STABILITY.md` for stability/reliability/performance targets,
failure classes, and the incremental hardening plan.

The custom architecture linter (`npm run lint`) enforces the layer boundaries,
naming conventions, and overlay contracts. Keep `core` pure and do not let `ui`
import `backgroundRuntime`.

### Overlay performance process

- **Default `npm run ci`** covers lint, unit/dom tests, typecheck, verifiers,
  dual builds, and **bundle budgets**. It does **not** run Selenium browser
  smoke (`test:browser:firefox` / `test:browser:chrome`).
- On PRs that touch the overlay host, frame, content scripts, trail domain
  delivery, or geometry: run browser smoke locally (or optional CI job) and
  treat cold host-open >250 ms / warm host-open or warm toggle >50 ms as
  regressions when that harness is used.
- Keep **chord** and **top** content-script bundles small (`verify:bundles`
  budgets). Do not pull trail UI or heavy deps into chord capture.
- Observability is host DOM attributes while live plus
  `controller.getDiagnostics()` after teardown — not chatty console logs.

## Before opening a PR

Run the full check suite:

```bash
npm run ci
```

This runs lint, tests, typecheck, the compatibility/upgrade/store verifiers, and
both browser builds.

## Related docs

- `OVERLAY_UI.md` - how the isolated overlay UI is structured and how to
  reconstruct it if needed.
- `STABILITY.md` - stability, reliability, and performance approach for the
  overlay (invariants, budgets, PR plan).
- `RELEASE.md` - how versioned release artifacts are built and packaged.
- `STORE.md` - the store listing copy (names, summary, permissions).
- `PRIVACY.md` - the privacy policy; update it whenever stored data or
  permissions change.
