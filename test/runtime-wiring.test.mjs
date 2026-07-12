import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadTsModule } from "./helpers/loadTsModule.mjs";

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
    "TRAIL_TOGGLE_OVERLAY",
    "TRAIL_JUMP",
    "TRAIL_OPEN_IN_NEW_TAB",
    "TRAIL_OPEN_IN_NEW_WINDOW",
    "TRAIL_SCROLL_REPORT",
    "SAVED_TRAIL_LOAD",
    "SAVED_TRAIL_SAVE",
    "SAVED_TRAIL_RENAME",
    "SAVED_TRAIL_REPLACE",
    "SAVED_TRAIL_SET_PINNED",
    "SAVED_TRAIL_DELETE",
    "SAVED_TRAIL_RESTORE",
    "SAVED_TRAIL_OPEN",
    "TRAIL_OVERLAY_STATE",
    "TABTRAIL_OPEN_OPTIONS",
    "TABTRAIL_REFRESH_EXTENSION",
  ]) {
    assert.match(source, new RegExp(`case "${messageType}"`), `handler must route ${messageType}`);
  }
  assert.match(source, /loadSavedTrails\(\)/);
  assert.match(source, /isDurableSavedTrailStorageAccess/);
  assert.match(source, /domain\.applyScrollReport\(/);
  assert.match(source, /domain\.openSavedTrail\(message\.path,/);
  assert.match(source, /saveCapturedTrail\(/);
  assert.match(source, /renameSavedTrail\(/);
  assert.match(source, /replaceSavedTrail\(/);
  assert.match(source, /setSavedTrailPinned\(/);
  assert.match(source, /deleteSavedTrail\(/);
  assert.match(source, /restoreSavedTrail\(/);
  assert.match(source, /domain\.refreshExtension\(\)/);
  assert.match(source, /default:\s*\n?\s*return UNHANDLED/);
  assert.doesNotMatch(source, /SAVED_TRAIL_DUPLICATE|duplicateSavedTrail/);
});

test("domain registers all three webNavigation intakes and serializes per tab", () => {
  const source = readSource("src/lib/backgroundRuntime/domains/trailDomain.ts");
  const activation = readSource("src/lib/backgroundRuntime/domains/contentScriptActivation.ts");
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
  assert.match(source, /contentScriptActivation/);
  assert.match(activation, /"injected-all-frames"/);
  assert.match(activation, /"injected-top-frame"/);
  assert.match(activation, /function shouldRetryContentScriptInjection|shouldRetryContentScriptInjection/);
  assert.match(activation, /outcome === "failed" \|\| outcome === "injected-top-frame"/);
  assert.match(activation, /COMBINED_CONTENT_SCRIPT_FALLBACK|contentScript\.js/);
  assert.match(source, /openEntryInNewWindow/);
  assert.match(source, /openSavedTrail/);
  assert.match(source, /createInheritedTrailState\(path\)/);
  assert.match(source, /scheduleSeedInheritedTrail\(created\.id, state, "fill"\)/);
  assert.match(source, /scheduleSeedInheritedTrail\(seededTabId, inherited, "fill"\)/);
  assert.match(source, /scheduleSeedInheritedTrail\(targetTabId, inherited, "replace"\)/);
  assert.match(source, /void seedInheritedTrail\(tabId, state, policy\)\.catch\(\(\) => \{\}\)/);
  assert.match(source, /shouldApplyInheritedSeed\(existing, seeded, policy\)/);
  assert.match(source, /liveUrl !== endpointUrl/);
  assert.match(source, /pendingJumpByTabId\.set\(targetTabId, \{ index, kind: "navigate" \}\)/);
  assert.match(source, /pendingRestoreByTabId/);
  assert.match(source, /TRAIL_RESTORE_SCROLL/);
  assert.match(source, /applyScrollReport/);
  assert.match(source, /armPendingFromEntry\(created\.id/);
  assert.match(source, /proactiveDispatch:\s*true/);
  assert.match(source, /dispatchPendingRestore/);
  assert.match(
    source,
    /windows\.create\(\{\s*url:\s*endpoint\.url,\s*incognito:\s*sourceIncognito,\s*\}\)/,
  );
  assert.match(source, /created\.incognito === sourceIncognito/);
  assert.doesNotMatch(source, /previewEntry|type:\s*"popup"|width:\s*420|height:\s*560/);
});

test("content script captures both trigger event kinds in capture phase and is re-injection safe", () => {
  const chord = readSource("src/lib/appInit/chordCapture.ts");
  const top = readSource("src/lib/appInit/topFrameOverlay.ts");
  const legacy = readSource("src/lib/appInit/legacyBootstrap.ts");
  assert.match(chord, /addEventListener\("keydown", keydownHandler, true\)/);
  assert.match(chord, /addEventListener\("mousedown", mousedownHandler, true\)/);
  assert.match(chord, /installMouseChordGuard\(window\)/);
  assert.match(chord, /mouseChordGuard\.arm\(event\.button\)/);
  assert.match(chord, /mouseChordGuard\.dispose\(\)/);
  assert.match(chord, /toToggleTriggerEvent/);
  assert.match(chord, /matchesToggleTrigger/);
  assert.match(chord, /performance\.timeOrigin \+ performance\.now\(\)/);
  assert.match(chord, /toggleTrailOverlay\(requestedAtEpochMs\)/);
  assert.match(chord, /window\.__tabtrailChordCleanup/);
  assert.ok(
    chord.indexOf("retireLegacyCombinedBootstrap()")
      < chord.indexOf('retireBootstrapCleanup("__tabtrailChordCleanup")'),
    "chord bootstrap must retire the legacy combined listener before replacing its split listener",
  );
  assert.match(top, /createOverlayFrameController/);
  assert.match(top, /OVERLAY_FRAME_CHALLENGE/);
  assert.match(top, /overlayController\?\.open\([\s\S]*typed\.requestedAtEpochMs/);
  assert.match(top, /overlayController\?\.updateTrail\(typed\.state\)/);
  assert.match(top, /HISTORY_GO/);
  assert.match(top, /TRAIL_RESTORE_SCROLL/);
  assert.match(top, /installPageScrollBridge/);
  assert.match(top, /const destroyOpenOverlay\s*=\s*\(\):\s*void\s*=>/);
  assert.match(top, /mode:\s*"destroy"/);
  assert.match(top, /mode:\s*"hibernate"/);
  assert.match(top, /overlayController\?\.dispose\(\)/);
  assert.match(top, /document\.visibilityState !== "hidden"/);
  assert.match(top, /document\.addEventListener\("visibilitychange", visibilityChangeHandler\)/);
  assert.match(top, /document\.removeEventListener\("visibilitychange", visibilityChangeHandler\)/);
  assert.match(top, /overlayController\?\.updateSettings\(settings\)/);
  assert.ok(
    top.indexOf("retireLegacyCombinedBootstrap()")
      < top.indexOf('retireBootstrapCleanup("__tabtrailTopCleanup")'),
    "top-frame bootstrap must retire the legacy combined listener before replacing its split listener",
  );
  assert.match(legacy, /const cleanup = bootstrapWindow\[cleanupKey\]/);
  assert.match(legacy, /cleanup\(\)/);
  assert.match(legacy, /finally\s*\{\s*delete bootstrapWindow\[cleanupKey\]/);
  assert.match(
    top,
    /onPositionChange:\s*async \(position\)\s*=>\s*\{\s*settings = \{ \.\.\.settings, overlayPosition: position \};[\s\S]*await saveTabTrailSettings\(settings\)/,
  );
  assert.doesNotMatch(chord, /addEventListener\("blur"/);
  assert.doesNotMatch(top, /addEventListener\("blur"/);
});

test("split bootstrap retirement survives invalidated cleanup hooks", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    const { retireBootstrapCleanup } = await loadTsModule(
      "src/lib/appInit/legacyBootstrap.ts",
    );
    for (const cleanupKey of [
      "__tabtrailCleanup",
      "__tabtrailChordCleanup",
      "__tabtrailTopCleanup",
    ]) {
      let calls = 0;
      window[cleanupKey] = () => {
        calls += 1;
        throw new Error("Extension context invalidated");
      };

      assert.doesNotThrow(() => retireBootstrapCleanup(cleanupKey));
      assert.equal(calls, 1);
      assert.equal(cleanupKey in window, false, `${cleanupKey} must be cleared after failure`);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("isolated overlay host authenticates, clips, and owns focused input outside the page event path", () => {
  const top = readSource("src/lib/appInit/topFrameOverlay.ts");
  const host = readSource("src/lib/ui/overlayFrame/overlayFrameController.ts");
  const hostSession = readSource("src/lib/ui/overlayFrame/overlayFrameSession.ts");
  const hostRpc = readSource("src/lib/ui/overlayFrame/overlayFrameRpc.ts");
  const frame = readSource("src/entryPoints/overlayFrame/overlayFrame.ts");
  const frameCss = readSource("src/entryPoints/overlayFrame/overlayFrame.css");
  assert.match(hostSession, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(host, /new MessageChannel\(\)/);
  assert.match(host, /TABTRAIL_OVERLAY_CONNECT/);
  assert.match(host, /validateSurfaceUpdate/);
  assert.match(host, /clip-path/);
  assert.match(hostSession, /pointer-events", "none"/);
  assert.match(host, /pointer-events", "auto"/);
  assert.match(host, /focusOwned/);
  // Open is reported as soon as the host session exists so TRAIL_UPDATED is not
  // dropped during the iframe handshake; settleOpened still waits for surfaces.
  assert.match(host, /reportOpenState\(current, true\)/);
  assert.match(host, /const hibernate\s*=/);
  assert.match(host, /const resumeWarm\s*=/);
  assert.match(host, /const armVisibleSession\s*=/);
  assert.match(host, /OverlayCloseRequest|mode: "hibernate"|mode: "destroy"/);
  assert.doesNotMatch(host, /isHardCloseReason|showWhenReady/);
  assert.match(host, /HOST_HIBERNATE/);
  assert.match(host, /HOST_SHOW/);
  assert.match(host, /if \(!current\.settled\)[\s\S]*settleOpened\(current, true\)/);
  assert.doesNotMatch(host, /SAVED_SUBSCRIBE|SAVED_UNSUBSCRIBE/);
  // Soft protocol path: stale RPCs are ignored; geometry failures resync.
  assert.match(host, /Ignore stale\/duplicate request ids|stale\/duplicate request ids/);
  assert.match(host, /requestSurfaceResync/);
  assert.match(hostSession, /HEARTBEAT_MISS_LIMIT/);
  assert.match(hostRpc, /createOverlayRpcExecutor|LIVE_JUMP|SAVED_LOAD/);
  assert.doesNotMatch(host, /SAVED_DUPLICATE|browserSavedTrailsClient\.duplicate/);
  assert.doesNotMatch(hostRpc, /SAVED_DUPLICATE|browserSavedTrailsClient\.duplicate/);
  assert.match(
    host,
    /const invalidateGeometry[\s\S]*hideFrameSurface[\s\S]*HOST_REQUEST_SURFACES/,
  );
  // HOST_INIT seeds settings only — trail state rides on HOST_SHOW.
  assert.match(
    host,
    /type: "HOST_INIT",\s*version: OVERLAY_FRAME_PROTOCOL_VERSION,\s*settings: current\.settings,/,
  );
  assert.doesNotMatch(
    host,
    /type: "HOST_INIT",\s*version: OVERLAY_FRAME_PROTOCOL_VERSION,\s*settings: current\.settings,\s*state:/,
  );
  // Re-arm must drop prior page listeners before reinstalling.
  assert.match(host, /current\.cleanupPageListeners\(\);\s*current\.cleanupPageListeners = installPageListeners/);
  assert.match(frame, /claimOverlayFrame\(connection\.message\.nonce\)/);
  assert.match(frame, /FRAME_FOCUS_OWNERSHIP/);
  const frameGeometry = readSource("src/entryPoints/overlayFrame/overlayFrameGeometry.ts");
  const frameClient = readSource("src/entryPoints/overlayFrame/overlayFrameHostClient.ts");
  assert.match(frame, /createOverlayFrameGeometry|geometry\.schedule/);
  assert.match(frameGeometry, /installObservers|scheduleSurfaceGeometry|function schedule/);
  assert.match(frame, /HOST_HIBERNATE|hibernateUi/);
  assert.match(frame, /seedHostState/);
  assert.match(frame, /HOST_SHOW|mountTrailUi/);
  // HOST_INIT must not mount trail DOM; paint is HOST_SHOW-only.
  assert.match(frame, /function seedHostState\(/);
  assert.match(
    frame,
    /case "HOST_INIT":\s*try \{\s*seedHostState\(message\.settings\);/,
  );
  assert.match(
    frame,
    /case "HOST_SHOW":[\s\S]*mountTrailUi\(message\.state, message\.settings\)/,
  );
  assert.match(host, /getDiagnostics/);
  assert.match(host, /surfaceResyncCount/);
  assert.match(top, /mode:\s*"hibernate"/);
  assert.match(top, /mode:\s*"destroy"/);
  assert.doesNotMatch(top, /close\(\s*["']hibernate["']\s*\)|close\(\s*["']destroy["']/);
  assert.match(
    frame,
    /case "HOST_REQUEST_SURFACES":[\s\S]*geometry\.sendImmediately\(true\)/,
  );
  assert.match(frameGeometry, /needsContraction|sendContractionNextFrame/);
  assert.match(frameGeometry, /nextSurfacePublish/);
  assert.match(frameClient, /createOverlayFrameHostClient|requestHost/);
  assert.match(frameCss, /overscroll-behavior:\s*none/);
  assert.match(frameGeometry, /data-tabtrail-hit-surface/);
  assert.doesNotMatch(frame, /SAVED_DUPLICATE|\bduplicate:\s*async/);
  assert.doesNotMatch(frameClient, /SAVED_DUPLICATE|\bduplicate:\s*async/);
  assert.doesNotMatch(top, /showBreadcrumbTrail|hideBreadcrumbTrail/);
  assert.match(frame, /createSavedTrailsController|savedTrailsController/);
});

test("trigger contract accepts left, middle, and right mouse buttons only", () => {
  const source = readSource("src/lib/common/contracts/tabtrail.ts");
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
  const contract = readSource("src/lib/common/contracts/tabtrail.ts");
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
  assert.match(html, /id="fallbackPanel"/);
  assert.match(
    html,
    /<div class="action-row">[\s\S]*id="refreshTabTrailBtn"[\s\S]*id="settingsBtn"[\s\S]*<\/div>/,
  );
  assert.match(html, /Browser-Restricted Page/);
  assert.match(html, /The browser does not allow extension scripts on restricted pages/);
  assert.match(html, /__EXTENSION_NAME__ cannot listen for keyboard or mouse shortcuts or show the in-page trail here/);
  assert.match(html, /change shortcut and overlay settings/);
  assert.match(html, /reset the shortcut/);
  assert.match(html, /__EXTENSION_NAME__ Shortcut/);
  assert.match(html, /__EXTENSION_NAME__ Overlay/);
  assert.match(html, /Hold key/);
  assert.match(html, /Key or click/);
  assert.match(html, /Visible rows/);
  assert.match(html, /Overlay position/);
  assert.doesNotMatch(html, /Trigger</);
  assert.doesNotMatch(html, /showTransitionArrows|Path color hints|Reset Defaults|resetDefaultsBtn/);
  assert.match(source, /DEFAULT_TABTRAIL_TRIGGER/);
  assert.match(source, /MIN_VISIBLE_SEGMENTS/);
  assert.match(source, /MAX_VISIBLE_SEGMENTS/);
  assert.match(source, /Keyboard shortcut active/);
  assert.match(source, /function detectPageShortcutAvailability/);
  assert.match(source, /refreshTabTrailExtension/);
  assert.match(source, /function refreshTabTrail/);
  assert.match(source, /TABTRAIL_PING/);
  assert.match(source, /fallbackPanel\.hidden = pageShortcutsReady/);
  assert.match(source, /shortcutStatus\.hidden = !pageShortcutsReady/);
  assert.match(source, /Page Shortcut Not Ready/);
  assert.match(source, /maxVisibleSegments:\s*Number\(maxVisibleInput\.value\)/);
  assert.match(source, /overlayPosition:\s*null/);
  assert.match(source, /trigger:\s*\{\s*...DEFAULT_TABTRAIL_TRIGGER\s*\}/);
  assert.doesNotMatch(source, /DEFAULT_TABTRAIL_SETTINGS|arrowsInput|resetDefaults|resetDefaultsBtn|showTransitionArrows:\s*arrowsInput\.checked/);
  assert.match(css, /\.fallback-panel/);
  assert.match(css, /\.number-control/);
  assert.match(css, /\.section-actions/);
  assert.doesNotMatch(css, /\.section-actions button/);
  assert.match(css, /\.action-row button\s*\{[\s\S]*width:\s*100%/);
  assert.doesNotMatch(css, /\.titlebar-button/);
  assert.match(css, /\.overlay-action\s*\{[\s\S]*background:\s*#252525[\s\S]*color:\s*#e0e0e0/);
  assert.match(contract, /overlayPosition:\s*null/);
  assert.doesNotMatch(html, /trailList|trail-item|trail-card/);
  assert.doesNotMatch(source, /TRAIL_GET|getTrailWithRetry|jumpToTrailEntry|formatTrailTimestamp/);
});

test("options page presents shortcut wording and reset controls", () => {
  const html = readSource("src/entryPoints/optionsPage/optionsPage.html");
  const source = readSource("src/entryPoints/optionsPage/optionsPage.ts");
  assert.match(html, /id="shortcutLabel"/);
  assert.match(html, /Press Alt \+ H to show __EXTENSION_NAME__/);
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
  assert.match(source, /shortcutLabel\.textContent = `Press \$\{combo\} to show \$\{EXTENSION_TITLE\}`/);
  assert.match(source, /resetShortcutBtn/);
  assert.match(source, /refreshTabTrailExtension/);
  assert.match(source, /function refreshTabTrail/);
  assert.match(source, /trigger:\s*\{\s*...DEFAULT_TABTRAIL_TRIGGER\s*\}/);
  assert.doesNotMatch(source, /shortcutStatus|resetBtn|showTransitionArrows|Keyboard shortcut active on normal web pages/);
});

test("live branch overlay hosts the bar and delegates saved trails", () => {
  const source = readSource("src/lib/ui/panels/breadcrumbTrail/breadcrumbTrail.ts");
  const liveBar = readSource("src/lib/ui/panels/breadcrumbTrail/liveTrailBar.ts");
  const preview = readSource("src/lib/ui/panels/breadcrumbTrail/liveTrailPreview.ts");
  const notices = readSource("src/lib/ui/panels/breadcrumbTrail/liveTrailNotices.ts");
  assert.match(liveBar, /onOpenOptions\(\):\s*void/);
  assert.match(liveBar, /onOpenInNewWindow\(index:\s*number\):\s*void/);
  assert.match(liveBar, /branchList\.className\s*=\s*"wf-branch-list"/);
  assert.match(liveBar, /buildLibraryButton|wf-library/);
  assert.match(liveBar, /toggleSavedTrailsLibrary/);
  assert.match(liveBar, /openSaveTrailDialog/);
  assert.match(source, /bindSavedTrailsHost/);
  assert.match(source, /installOverlayInteractionShield\(shadow\)/);
  assert.match(source, /removeInteractionShield\(\)/);
  assert.match(source, /closeTopOverlaySurface/);
  assert.match(source, /createLiveTrailPreview/);
  assert.match(source, /createLiveTrailBar|canPatchLiveTrail/);
  assert.match(liveBar, /canPatchLiveTrail/);
  assert.match(liveBar, /showContextMenu/);
  assert.match(preview, /document\.createElement\("iframe"\)/);
  assert.match(preview, /startFreePixelDrag/);
  assert.match(preview, /allow-forms allow-popups allow-scripts/);
  assert.doesNotMatch(preview, /allow-same-origin/);
  assert.match(notices, /showLiveNotice/);
  assert.match(
    liveBar,
    /label:\s*"Preview"[\s\S]*label:\s*"Open in new tab"[\s\S]*label:\s*"Open in new window"[\s\S]*label:\s*"Copy URL"[\s\S]*label:\s*"Save trail up to this point in path"/,
  );
  assert.doesNotMatch(source, /function openLibraryPanel/);
  assert.doesNotMatch(source, /Copy as Markdown/);
});

test("saved trails panel owns library, name dialog, and path-tree preview", () => {
  // Implementation is split across focused modules; the façade re-exports the public API.
  const source = [
    "savedTrailsPanel.ts",
    "savedTrailsSession.ts",
    "savedTrailsDialogs.ts",
    "savedTrailsMutations.ts",
    "savedTrailsTreePreview.ts",
    "savedTrailsLibrary.ts",
  ]
    .map((name) => readSource(`src/lib/ui/panels/breadcrumbTrail/${name}`))
    .join("\n");
  const facade = readSource("src/lib/ui/panels/breadcrumbTrail/savedTrailsPanel.ts");
  const client = readSource("src/lib/adapters/runtime/savedTrailsClient.ts");
  assert.match(facade, /export function bindSavedTrailsHost/);
  assert.match(facade, /export function toggleSavedTrailsLibrary/);
  assert.match(facade, /export \{ openSaveTrailDialog \}/);
  assert.match(source, /client\.save\(path,/);
  assert.match(source, /client\.delete\(trail\.id\)/);
  assert.doesNotMatch(source, /webextension-polyfill|browser\.storage|browser\.runtime/);
  assert.match(client, /export interface SavedTrailsClient/);
  assert.match(client, /browserSavedTrailsClient/);
  assert.match(client, /load:\s*loadNamedTrails/);
  assert.match(client, /subscribe:\s*subscribeToSavedTrails/);
  assert.doesNotMatch(client, /load:\s*loadSavedTrails/);
  assert.doesNotMatch(client, /duplicateNamedTrail|\bduplicate\s*\(/);
  assert.match(source, /librarySession !== session \|\|/);
  assert.match(source, /session\.loadRequest !== request/);
  assert.match(source, /flushLiveTrailUpdates/);
  assert.match(source, /openSavedTrailTreePreview/);
  assert.match(source, /wf-trail-tree-preview/);
  assert.match(source, /wf-library-panel/);
  assert.match(source, /Save trail up to this point in path/);
  assert.match(source, /label:\s*"Preview"/);
  assert.match(source, /label:\s*"Remove trail"/);
  assert.doesNotMatch(source, /label:\s*"Copy URL"/);
  assert.match(source, /startFreePixelDrag/);
  assert.match(source, /client\.open\(trail\.entries, mode\)/);
  assert.match(source, /client\.subscribe\(savedTrailsChanged\)/);
  assert.match(source, /Search trails…/);
  assert.doesNotMatch(source, /wf-library-sort|SavedTrailsSortMode|getSortMode|setSortMode/);
  assert.match(source, /offerDeleteUndo/);
  assert.match(source, /createManagedDialogShell/);
  assert.match(source, /openMutationDialog/);
  assert.match(source, /SAVED_TRAIL_NAME_MAX_LENGTH/);
  assert.match(source, /input\.maxLength = options\.input\.maxLength/);
  assert.doesNotMatch(source, /window\.confirm/);
});

test("overlay drags retain pointer ownership inside the interaction boundary", () => {
  const breadcrumb = readSource("src/lib/ui/panels/breadcrumbTrail/breadcrumbTrail.ts");
  const freePixelDrag = readSource("src/lib/ui/panels/breadcrumbTrail/freePixelDrag.ts");
  for (const source of [breadcrumb, freePixelDrag]) {
    assert.match(source, /setPointerCapture\(pointerId\)/);
    assert.match(source, /releasePointerCapture\(pointerId\)/);
    assert.match(source, /moveEvent\.pointerId !== pointerId/);
    assert.match(source, /endEvent\.pointerId === pointerId/);
  }
});

test("panel host stays non-modal and never reclaims focus from the page", () => {
  const source = readSource("src/lib/common/utils/panelHost.ts");
  assert.doesNotMatch(
    source,
    /lastFocusedInPanel|focusPreferredPanelTarget|pointerInteractionInPanel|host\.tabIndex/,
  );
  assert.doesNotMatch(source, /addEventListener\("focus|addEventListener\("visibilitychange/);
  assert.doesNotMatch(source, /webextension-polyfill|browser\.runtime\.getURL/);
  assert.match(source, /PANEL_EXTENSION_ORIGIN/);
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
    "TABTRAIL_PING",
    "TRAIL_SHOW",
    "TRAIL_UPDATED",
    "HISTORY_GO",
    "TRAIL_RESTORE_SCROLL",
    "TRAIL_TOGGLE_OVERLAY",
    "TRAIL_JUMP",
    "TRAIL_OPEN_IN_NEW_TAB",
    "TRAIL_OPEN_IN_NEW_WINDOW",
    "TRAIL_SCROLL_REPORT",
    "SAVED_TRAIL_LOAD",
    "SAVED_TRAIL_SAVE",
    "SAVED_TRAIL_RENAME",
    "SAVED_TRAIL_REPLACE",
    "SAVED_TRAIL_SET_PINNED",
    "SAVED_TRAIL_DELETE",
    "SAVED_TRAIL_RESTORE",
    "SAVED_TRAIL_OPEN",
    "TRAIL_OVERLAY_STATE",
    "TABTRAIL_OPEN_OPTIONS",
    "TABTRAIL_REFRESH_EXTENSION",
  ]) {
    assert.match(source, new RegExp(messageType), `contract must declare ${messageType}`);
  }
  assert.match(source, /mode: TrailScrollRestoreMode/);
});

test("saved trail open sends a path so new tabs can inherit lineage", () => {
  const contract = readSource("src/lib/common/contracts/runtimeMessages.ts");
  const api = readSource("src/lib/adapters/runtime/tabtrailApi.ts");
  assert.match(contract, /type: "SAVED_TRAIL_OPEN"; path: TrailEntry\[\]/);
  assert.match(api, /type: "SAVED_TRAIL_OPEN",\s*path,/);
  assert.doesNotMatch(api, /type: "SAVED_TRAIL_OPEN",\s*url,/);
});

test("saved trail load goes through background so migration can finish first", () => {
  const contract = readSource("src/lib/common/contracts/runtimeMessages.ts");
  const api = readSource("src/lib/adapters/runtime/tabtrailApi.ts");
  const client = readSource("src/lib/adapters/runtime/savedTrailsClient.ts");
  assert.match(contract, /type: "SAVED_TRAIL_LOAD"/);
  assert.match(api, /type: "SAVED_TRAIL_LOAD"/);
  assert.match(api, /export async function loadNamedTrails/);
  assert.match(client, /load:\s*loadNamedTrails/);
  assert.doesNotMatch(client, /import \{[^}]*loadSavedTrails[^}]*\} from "\.\.\/storage\/savedTrailsStore"/);
  assert.doesNotMatch(client, /load:\s*loadSavedTrails/);
});

test("saved trail management messages have typed wrappers and authoritative results", () => {
  const contract = readSource("src/lib/common/contracts/runtimeMessages.ts");
  const api = readSource("src/lib/adapters/runtime/tabtrailApi.ts");
  const store = readSource("src/lib/adapters/storage/savedTrailsStore.ts");

  assert.match(contract, /type: "SAVED_TRAIL_REPLACE";[\s\S]*expectedPath\?: TrailEntry\[\]/);
  assert.match(contract, /type: "SAVED_TRAIL_RESTORE"; trail: SavedTrail/);
  for (const wrapper of [
    "renameNamedTrail",
    "replaceNamedTrail",
    "setNamedTrailPinned",
    "deleteNamedTrail",
    "restoreNamedTrail",
  ]) {
    assert.match(api, new RegExp(`function ${wrapper}\\(`));
  }
  assert.doesNotMatch(contract, /SAVED_TRAIL_DUPLICATE/);
  assert.doesNotMatch(api, /duplicateNamedTrail|SAVED_TRAIL_DUPLICATE/);
  assert.match(store, /previousTrail: SavedTrail/);
  assert.match(store, /DeleteSavedTrailResult/);
});
