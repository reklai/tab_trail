import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function readText(pathFromRoot) {
  return readFileSync(resolve(ROOT, pathFromRoot), "utf8");
}

test("branch overlay includes mobile tightening and scroll containment", () => {
  const css = readText("src/lib/ui/panels/breadcrumbTrail/breadcrumbTrail.css");
  assert.match(css, /@media \(max-width:/);
  assert.match(css, /border-radius:\s*8px/);
  assert.match(css, /\.wf-branch-list\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /\.wf-bar\s*\{[\s\S]*overflow:\s*visible/);
  assert.match(css, /\.wf-branch-header\s*\{[\s\S]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto auto/);
  assert.match(css, /\.wf-settings\s*\{[\s\S]*width:\s*22px/);
  assert.match(css, /\.wf-grip\s*\{[\s\S]*rgba\(254,188,46/);
  assert.match(css, /\.wf-close\s*\{[\s\S]*rgba\(255,95,87/);
  assert.match(css, /\.wf-branch-row\s*\{[\s\S]*color:\s*#d6d6d6/);
  assert.match(css, /\.wf-branch-row\s*\{[\s\S]*grid-template-columns:\s*14px minmax\(0,\s*1fr\) auto/);
  assert.match(css, /\.wf-branch-row\s*\{[\s\S]*margin:\s*2px 0/);
  assert.match(css, /\.wf-row-more\s*\{[\s\S]*width:\s*28px[\s\S]*height:\s*28px/);
  assert.match(css, /\.wf-branch-row-current\s*\{[\s\S]*rgba\(10,132,255/);
  assert.match(css, /\.wf-branch-row-current \.wf-branch-node\s*\{[\s\S]*#30d158/);
  assert.match(css, /\.wf-branch-row-previewed\s*\{[\s\S]*#ffb340/);
  assert.match(css, /\.wf-branch-entry-title\s*\{[\s\S]*-webkit-line-clamp:\s*2/);
  assert.match(css, /\.wf-branch-entry-url\s*\{[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.wf-branch-connector::before\s*\{/);
  assert.match(css, /\.wf-branch-connector::after\s*\{/);
  assert.match(css, /\.wf-branch-connector\s*\{[\s\S]*margin:\s*3px 0 3px 6px/);
  assert.match(css, /\.wf-more\s*\{[\s\S]*margin-left:\s*12px/);
  assert.match(css, /\.wf-more-collapse\s*\{[\s\S]*margin-top:\s*4px/);
  assert.match(css, /\.wf-preview-pane\s*\{[\s\S]*position:\s*fixed[\s\S]*width:\s*min\(88vw,\s*640px\)/);
  assert.match(css, /\.wf-preview-pane-bottom\s*\{/);
  assert.match(css, /\.wf-preview-pane-frame\s*\{[\s\S]*height:\s*100%/);
  assert.match(css, /\.wf-preview-pane-drag\s*\{[\s\S]*rgba\(254,188,46/);
  assert.match(css, /\.wf-preview-pane-dragging\s*\{/);
  assert.match(css, /@media \(max-width:\s*520px\)[\s\S]*\.wf-preview-pane\s*\{[\s\S]*width:\s*calc\(100vw - 24px\)/);
  assert.match(css, /\.wf-menu\s*\{[\s\S]*z-index:\s*14/);
  assert.doesNotMatch(css, /\.wf-menu-section-label/);
  assert.match(css, /\.wf-menu-detail\s*\{[\s\S]*background:\s*var\(--ht-color-surface-dim\)/);
  assert.match(css, /\.wf-menu-detail\s*\{[\s\S]*border:\s*1px solid var\(--ht-color-border-soft\)/);
  assert.match(css, /\.wf-menu-detail-url\s*\{[\s\S]*word-break:\s*break-all/);
  assert.doesNotMatch(css, /--wf-depth/);
  assert.doesNotMatch(css, /\.wf-tooltip/);
});

test("popup layout is fixed-height, scroll-safe, and never uses 100vh", () => {
  const popupCss = readText("src/entryPoints/toolbarPopup/toolbarPopup.css");
  assert.match(popupCss, /height:\s*600px/);
  assert.match(popupCss, /\.tabwheel-popup\s*\{[\s\S]*width:\s*520px[\s\S]*height:\s*600px/);
  assert.match(popupCss, /\.popup-scroll\s*\{[\s\S]*flex:\s*1 1 auto/);
  assert.doesNotMatch(popupCss, /100vh/);
  assert.match(popupCss, /\.control-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(popupCss, /\.control-row small\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(popupCss, /\.control-row strong\s*\{[\s\S]*font-size:\s*13px/);
  assert.match(popupCss, /\.section-actions\s*\{[\s\S]*justify-content:\s*flex-end/);
  assert.match(popupCss, /\.action-row\s*\{[\s\S]*justify-content:\s*flex-end/);
  assert.doesNotMatch(popupCss, /#resetDefaultsBtn/);
});

test("options layout uses full-width setting rows", () => {
  const optionsCss = readText("src/entryPoints/optionsPage/optionsPage.css");
  assert.match(optionsCss, /--bg:\s*#1e1e1e/);
  assert.match(optionsCss, /--surface:\s*#252525/);
  assert.match(optionsCss, /--titlebar:\s*#3a3a3c/);
  assert.match(optionsCss, /--accent:\s*#0a84ff/);
  assert.match(optionsCss, /font-family:\s*'SF Mono', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace/);
  assert.match(optionsCss, /\.options-header\s*\{[\s\S]*background:\s*var\(--titlebar\)/);
  assert.match(optionsCss, /\.options-body\s*\{[\s\S]*background:\s*var\(--surface\)/);
  assert.match(optionsCss, /\.shortcut-panel\s*\{[\s\S]*margin-bottom:\s*16px/);
  assert.match(optionsCss, /\.shortcut-panel\s*\{[\s\S]*background:\s*var\(--card\)/);
  assert.match(optionsCss, /\.shortcut-panel\s*\{[\s\S]*border:\s*1px solid var\(--card-border\)/);
  assert.doesNotMatch(optionsCss, /\.shortcut-panel\s*\{[\s\S]*border-left:\s*3px solid var\(--accent\)/);
  assert.match(optionsCss, /\.shortcut-panel strong\s*\{[\s\S]*font-size:\s*13px/);
  assert.match(optionsCss, /\.card\s*\{[\s\S]*border-radius:\s*8px/);
  assert.match(optionsCss, /\.card\s*\{[\s\S]*margin-bottom:\s*16px/);
  assert.match(optionsCss, /\.setting-label strong\s*\{[\s\S]*font-size:\s*13px/);
  assert.match(optionsCss, /\.setting-label small\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(optionsCss, /\.card-actions\s*\{[\s\S]*justify-content:\s*flex-end/);
  assert.match(optionsCss, /\.btn\s*\{[\s\S]*background:\s*rgba\(255, 255, 255, 0\.06\)/);
  assert.match(optionsCss, /\.btn:hover\s*\{\s*background:\s*rgba\(255, 255, 255, 0\.1\)/);
  assert.doesNotMatch(optionsCss, /\.options-actions|\.save-hint|--accent-hover|--accent-soft/);
  assert.match(optionsCss, /\.setting-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(optionsCss, /\.setting-wide\s*\{\s*grid-column:\s*auto/);
  assert.doesNotMatch(optionsCss, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(optionsCss, /@media \(max-width:\s*620px\)/);
});
