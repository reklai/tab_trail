import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function readSource(pathFromRoot) {
  return readFileSync(resolve(ROOT, pathFromRoot), "utf8");
}

test("background composes the domain, handler, router, and migration at top level", () => {
  const source = readSource("src/entryPoints/backgroundRuntime/background.ts");
  assert.match(source, /createTrailDomain\(\)/);
  assert.match(source, /registerLifecycleListeners\(\)/);
  assert.match(source, /registerRuntimeMessageRouter\(\[/);
  assert.match(source, /createTrailMessageHandler\(/);
  assert.match(source, /migrateStorageIfNeeded\(\)/);
  assert.match(source, /ensureLoaded\(\)/);
  // Listener registration must precede the async bootstrap for MV3 workers.
  assert.ok(
    source.indexOf("registerRuntimeMessageRouter") < source.indexOf("async function bootstrapBackground"),
    "router registration must happen before the async bootstrap",
  );
});

test("message handler routes every trail message and falls back to UNHANDLED", () => {
  const source = readSource("src/lib/backgroundRuntime/handlers/trailMessageHandler.ts");
  for (const messageType of [
    "TRAIL_CONTENT_READY",
    "TRAIL_GET",
    "TRAIL_TOGGLE_OVERLAY",
    "TRAIL_JUMP",
    "TRAIL_OPEN_IN_NEW_TAB",
    "TRAIL_OPEN_IN_NEW_WINDOW",
    "TRAIL_OVERLAY_STATE",
    "WAYFIND_OPEN_OPTIONS",
    "WAYFIND_REFRESH_EXTENSION",
  ]) {
    assert.match(source, new RegExp(`case "${messageType}"`), `handler must route ${messageType}`);
  }
  assert.match(source, /domain\.refreshExtension\(\)/);
  assert.match(source, /default:\s*\n?\s*return UNHANDLED/);
});

test("router rethrows on the trail query so its retrying caller is not misled", () => {
  const source = readSource("src/lib/backgroundRuntime/handlers/runtimeRouter.ts");
  assert.match(source, /TRAIL_GET/);
  assert.match(source, /throw error/);
});

test("domain registers all three webNavigation intakes and serializes per tab", () => {
  const source = readSource("src/lib/backgroundRuntime/domains/trailDomain.ts");
  assert.match(source, /webNavigation\.onCommitted\.addListener/);
  assert.match(source, /webNavigation\.onHistoryStateUpdated\.addListener/);
  assert.match(source, /webNavigation\.onReferenceFragmentUpdated\.addListener/);
  assert.match(source, /frameId !== 0/);
  assert.match(source, /createKeyedTaskQueue\(\)/);
  // Session-storage mirror with the storage.local wipe fallback.
  assert.match(source, /session\?: SessionStorageArea/);
  assert.match(source, /TRAIL_MIRROR_KEY_PREFIX/);
  assert.match(source, /runtime\.onStartup\.addListener/);
  assert.match(source, /tabs\.onRemoved\.addListener/);
  assert.match(source, /refreshExtension\(\)/);
  assert.match(source, /activateExistingContentScripts\(\)/);
  assert.match(source, /openEntryInNewWindow/);
  assert.match(source, /windows\.create\(\{\s*url:\s*entry\.url\s*\}\)/);
  assert.doesNotMatch(source, /previewEntry|type:\s*"popup"|width:\s*420|height:\s*560/);
});

test("content script captures both trigger event kinds in capture phase and is re-injection safe", () => {
  const source = readSource("src/lib/appInit/appInit.ts");
  assert.match(source, /addEventListener\("keydown", keydownHandler, true\)/);
  assert.match(source, /addEventListener\("mousedown", mousedownHandler, true\)/);
  assert.match(source, /addEventListener\("contextmenu", mouseFollowUpHandler, true\)/);
  assert.match(source, /matchesToggleTrigger/);
  assert.match(source, /window\.__wayfindCleanup/);
  assert.match(source, /announceTrailContentReady/);
  assert.match(source, /openWayfindOptions/);
  assert.match(source, /onOpenOptions:\s*\(\)\s*=>/);
  assert.match(source, /HISTORY_GO/);
});

test("trigger contract accepts left, middle, and right mouse buttons only", () => {
  const source = readSource("src/lib/common/contracts/wayfind.ts");
  assert.match(source, /TRIGGER_MOUSE_BUTTONS[^\n=]*=\s*\[0,\s*1,\s*2\]/);
  assert.match(source, /button === 0[\s\S]*Left Click/);
  assert.match(source, /button === 1[\s\S]*Middle Click/);
  assert.match(source, /button === 2[\s\S]*Right Click/);
  assert.doesNotMatch(source, /Mouse 4|Mouse 5/);
});

test("toolbar popup exposes shortcut and overlay settings without trail rendering", () => {
  const html = readSource("src/entryPoints/toolbarPopup/toolbarPopup.html");
  const source = readSource("src/entryPoints/toolbarPopup/toolbarPopup.ts");
  const css = readSource("src/entryPoints/toolbarPopup/toolbarPopup.css");
  const contract = readSource("src/lib/common/contracts/wayfind.ts");
  assert.match(html, /class="tabwheel-popup"/);
  assert.match(html, /id="triggerModifier"/);
  assert.match(html, /id="triggerWithShift"/);
  assert.match(html, /id="triggerCaptureBtn"/);
  assert.match(html, /id="maxVisibleSegments"/);
  assert.match(html, /id="maxVisibleSegments"[^>]*min="5"[^>]*max="12"/);
  assert.match(html, /id="resetShortcutBtn"/);
  assert.match(html, /id="resetPositionBtn"/);
  assert.match(html, /id="resetShortcutBtn" class="overlay-action"/);
  assert.match(html, /id="resetPositionBtn" class="overlay-action"/);
  assert.match(html, /id="refreshWayfindBtn"/);
  assert.match(html, /id="settingsBtn"/);
  assert.match(html, /id="fallbackPanel"/);
  assert.match(html, /Browser-Restricted Page/);
  assert.match(html, /The browser does not allow extension scripts on restricted pages/);
  assert.match(html, /Wayfind cannot listen for keyboard or mouse shortcuts or show the in-page trail here/);
  assert.match(html, /change shortcut and overlay settings/);
  assert.match(html, /reset the shortcut/);
  assert.match(html, /Wayfind Shortcut/);
  assert.match(html, /Overlay/);
  assert.match(html, /Hold key/);
  assert.match(html, /Key or click/);
  assert.match(html, /Visible rows/);
  assert.match(html, /Overlay position/);
  assert.doesNotMatch(html, />Wayfind Trigger<|>Trigger</);
  assert.doesNotMatch(html, /showTransitionArrows|Path color hints|Reset Defaults|resetDefaultsBtn/);
  assert.match(source, /DEFAULT_WAYFIND_TRIGGER/);
  assert.match(source, /MIN_VISIBLE_SEGMENTS/);
  assert.match(source, /MAX_VISIBLE_SEGMENTS/);
  assert.match(source, /Keyboard shortcut active/);
  assert.match(source, /function detectPageShortcutAvailability/);
  assert.match(source, /refreshWayfindExtension/);
  assert.match(source, /function refreshWayfind/);
  assert.match(source, /WAYFIND_PING/);
  assert.match(source, /fallbackPanel\.hidden = pageShortcutsReady/);
  assert.match(source, /shortcutStatus\.hidden = !pageShortcutsReady/);
  assert.match(source, /Page Shortcut Not Ready/);
  assert.match(source, /maxVisibleSegments:\s*Number\(maxVisibleInput\.value\)/);
  assert.match(source, /overlayPosition:\s*null/);
  assert.match(source, /trigger:\s*\{\s*...DEFAULT_WAYFIND_TRIGGER\s*\}/);
  assert.doesNotMatch(source, /DEFAULT_WAYFIND_SETTINGS|arrowsInput|resetDefaults|resetDefaultsBtn|showTransitionArrows:\s*arrowsInput\.checked/);
  assert.match(css, /\.fallback-panel/);
  assert.match(css, /\.number-control/);
  assert.match(css, /\.section-actions/);
  assert.doesNotMatch(css, /\.section-actions button/);
  assert.match(css, /\.titlebar-button/);
  assert.match(css, /\.overlay-action\s*\{[\s\S]*background:\s*#252525[\s\S]*color:\s*#e0e0e0/);
  assert.match(contract, /overlayPosition:\s*null/);
  assert.doesNotMatch(html, /trailList|trail-item|trail-card/);
  assert.doesNotMatch(source, /TRAIL_GET|getTrailWithRetry|jumpToTrailEntry|formatTrailTimestamp/);
});

test("options page presents shortcut wording and reset controls", () => {
  const html = readSource("src/entryPoints/optionsPage/optionsPage.html");
  const source = readSource("src/entryPoints/optionsPage/optionsPage.ts");
  assert.match(html, /id="shortcutLabel"/);
  assert.match(html, /Press Alt \+ H to show your trail/);
  assert.doesNotMatch(html, /shortcutStatus|Keyboard shortcut active on normal web pages/);
  assert.match(html, /<h2>Shortcut<\/h2>/);
  assert.match(html, /Hold key/);
  assert.match(html, /Require Shift/);
  assert.match(html, /Key or click/);
  assert.match(html, /id="maxVisibleSegments"[^>]*min="5"[^>]*max="12"/);
  assert.match(html, /id="resetShortcutBtn"/);
  assert.match(html, /id="refreshBtn"/);
  assert.doesNotMatch(html, /Path color hints|showTransitionArrows/);
  assert.doesNotMatch(html, /options-actions|resetBtn|saveHint|Reset to defaults|Changes save automatically/);
  assert.doesNotMatch(html, /Toggle trigger|Current trigger|Transition connectors/);
  assert.match(source, /shortcutLabel\.textContent = `Press \$\{combo\} to show your trail`/);
  assert.match(source, /resetShortcutBtn/);
  assert.match(source, /refreshWayfindExtension/);
  assert.match(source, /function refreshWayfind/);
  assert.match(source, /trigger:\s*\{\s*...DEFAULT_WAYFIND_TRIGGER\s*\}/);
  assert.doesNotMatch(source, /shortcutStatus|resetBtn|showTransitionArrows|Keyboard shortcut active on normal web pages/);
});

test("branch overlay context menu order and callbacks match the trail actions", () => {
  const source = readSource("src/lib/ui/panels/breadcrumbTrail/breadcrumbTrail.ts");
  assert.match(source, /onOpenOptions\(\):\s*void/);
  assert.match(source, /onOpenInNewWindow\(index:\s*number\):\s*void/);
  assert.match(source, /const HOVER_DETAIL_DELAY_MS\s*=\s*350/);
  assert.match(source, /branchList\.className\s*=\s*"wf-branch-list"/);
  assert.match(
    source,
    /bar\.appendChild\(buildBranchHeader\(callbacks\)\)[\s\S]*bar\.appendChild\(branchList\)/,
  );
  assert.match(
    source,
    /header\.appendChild\(buildSettingsButton\(callbacks\)\)[\s\S]*header\.appendChild\(title\)[\s\S]*header\.appendChild\(buildGrip\(\)\)[\s\S]*header\.appendChild\(buildCloseButton\(\)\)/,
  );
  assert.match(source, /settings\.className\s*=\s*"wf-settings"/);
  assert.match(source, /settings\.textContent\s*=\s*"⚙"/);
  assert.match(source, /settings\.addEventListener\("click",\s*\(\)\s*=>\s*callbacks\.onOpenOptions\(\)\)/);
  assert.match(source, /grip\.addEventListener\("pointerdown",\s*startDrag\)/);
  assert.match(source, /className\s*=\s*"wf-branch-row"/);
  assert.match(source, /className\s*=\s*"wf-branch-connector"/);
  assert.match(source, /const budget\s*=\s*Math\.min\(Math\.max\(1,\s*maxVisible\),\s*total\)/);
  assert.match(source, /addIndex\(total - 1\)/);
  assert.match(source, /selected\.size < budget/);
  assert.match(source, /function buildCollapsePill/);
  assert.match(source, /pill\.textContent\s*=\s*"Show less"/);
  assert.match(source, /session\.expanded\s*=\s*false/);
  assert.match(source, /className\s*=\s*"wf-branch-entry-title"/);
  assert.match(source, /className\s*=\s*"wf-branch-entry-url"/);
  assert.match(source, /function entryUrlSubtitle/);
  assert.match(source, /function scheduleTooltip/);
  assert.match(source, /rowNeedsTooltip\(anchor\)/);
  assert.match(source, /function openEntryPreview/);
  assert.match(source, /function positionPreviewPane/);
  assert.match(source, /session\.bar\.getBoundingClientRect\(\)/);
  assert.match(source, /className\s*=\s*"wf-preview-pane"/);
  assert.match(source, /className\s*=\s*"wf-preview-pane-kicker"/);
  assert.match(source, /className\s*=\s*"wf-preview-pane-drag"/);
  assert.match(source, /drag\.addEventListener\("pointerdown",\s*startPreviewPaneDrag\)/);
  assert.match(source, /actions\.appendChild\(drag\)[\s\S]*actions\.appendChild\(open\)[\s\S]*actions\.appendChild\(close\)/);
  assert.match(source, /kicker\.textContent\s*=\s*"Preview"/);
  assert.match(source, /classList\.add\("wf-branch-row-previewed"\)/);
  assert.match(source, /classList\.remove\("wf-branch-row-previewed"\)/);
  assert.match(source, /function startPreviewPaneDrag/);
  assert.match(source, /function clampPreviewPanePosition/);
  assert.match(source, /let previewManualPosition/);
  assert.match(source, /document\.createElement\("iframe"\)/);
  assert.match(source, /frame\.src\s*=\s*entry\.url/);
  assert.match(source, /callbacks\.onOpenInNewTab\(index\)/);
  assert.match(source, /classList\.add\("wf-preview-pane-bottom"\)/);
  assert.match(
    source,
    /label:\s*"Preview"[\s\S]*label:\s*"Open in new tab"[\s\S]*label:\s*"Open in new window"[\s\S]*label:\s*"Copy URL"/,
  );
  assert.doesNotMatch(source, /positionPopover\(preview/);
  assert.doesNotMatch(source, /onPreview\(|--wf-depth|MAX_BRANCH_DEPTH/);
  assert.doesNotMatch(source, /wf-branch-label/);
  assert.doesNotMatch(source, /Copy as Markdown/);
});

test("trigger matcher rejects auto-repeat and untrusted events", () => {
  const source = readSource("src/lib/core/trail/trailCore.ts");
  assert.match(source, /event\.repeat/);
  assert.match(source, /event\.isTrusted/);
  assert.match(source, /applyNavigationEvent/);
  assert.match(source, /resolveJumpPlan/);
});

test("runtime message contract declares all message literals", () => {
  const source = readSource("src/lib/common/contracts/runtimeMessages.ts");
  for (const messageType of [
    "WAYFIND_PING",
    "TRAIL_SHOW",
    "TRAIL_UPDATED",
    "HISTORY_GO",
    "TRAIL_CONTENT_READY",
    "TRAIL_GET",
    "TRAIL_TOGGLE_OVERLAY",
    "TRAIL_JUMP",
    "TRAIL_OPEN_IN_NEW_TAB",
    "TRAIL_OPEN_IN_NEW_WINDOW",
    "TRAIL_OVERLAY_STATE",
    "WAYFIND_OPEN_OPTIONS",
    "WAYFIND_REFRESH_EXTENSION",
  ]) {
    assert.match(source, new RegExp(messageType), `contract must declare ${messageType}`);
  }
});
