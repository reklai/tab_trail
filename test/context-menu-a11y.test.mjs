import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(process.cwd(), "src/lib/ui/panels/breadcrumbTrail/contextMenu.ts"),
  "utf8",
);

test("context menus expose semantic buttons and optional item states", () => {
  assert.match(source, /disabled\?: boolean/);
  assert.match(source, /danger\?: boolean/);
  assert.match(source, /setAttribute\("role", "menu"\)/);
  assert.match(source, /createElement\("button"\)/);
  assert.match(source, /row\.type = "button"/);
  assert.match(source, /setAttribute\("role", "menuitem"\)/);
  assert.match(source, /row\.disabled = item\.disabled === true/);
  assert.match(source, /wf-menu-item-danger/);
});

test("context menus support roving keyboard focus and focus-safe dismissal", () => {
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape"]) {
    assert.match(source, new RegExp(`event\\.key === "${key}"|\\[.*"${key}"`));
  }
  assert.match(source, /itemButtons\.filter\(\(item\) => !item\.disabled\)/);
  assert.match(source, /row\.tabIndex = -1/);
  assert.match(source, /candidate\.tabIndex = candidate === item \? 0 : -1/);
  assert.match(source, /if \(firstItem\) focusItem\(firstItem\)/);
  assert.match(source, /event\.key === "Tab"[\s\S]*closeMenu\(false\)/);
  assert.match(source, /closeMenu\(event\.detail === 0\)/);
  assert.match(source, /closeMenu\(false\)/);
  assert.match(source, /options\.trigger\?\.isConnected/);
  assert.match(source, /focusOnOpen\?: boolean/);
  assert.match(source, /if \(options\.focusOnOpen !== false\)/);
  assert.match(source, /close: \(\) => closeMenu\(menuHasFocus\(\)\)/);
});
