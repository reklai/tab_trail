# Wayfind — Store Listing

## Extension Names
- Firefox / Zen: Wayfind
- Chrome: Wayfind

Chrome Web Store listing title: **Wayfind - Where Did This Tab Come From**

## Summary (short, <=132 chars)
Press Alt+H to see where this tab came from. Retrace your browsing path and click to jump back instantly.

## Description
Wayfind automatically tracks every page you visit within a tab, building a
clickable branch trail. Press Alt + H to see exactly where this tab came
from and jump back to any point.

- Automatic tracking — every link click is recorded. Works on single-page apps
  (pushState) and hash routers too.
- Toggleable overlay — Alt + H to show, Alt + H (or Esc) to hide. Zero screen
  space when idle.
- Click to retrace — any branch row navigates the tab back to that
  page, preserving scroll position where the browser allows it.
- Drag to reposition — move the bar by its handle; it remembers its spot.
- Right-click a row — open an in-page preview pane, open in a new tab, open in a new window, or copy the URL.
- Fully configurable shortcut — Alt, Ctrl, or Super plus a letter/top-row digit
  key or left, middle, or right click, with optional Shift.
- Session-only by design — trails live in session storage and clear when the
  browser closes. Titles and URLs only: no page content, no screenshots.

No data leaves your browser. Works on Firefox, Chrome, and Zen Browser.

We use the `webNavigation` API to record page titles and URLs only — no content
is read, nothing is transmitted, and there are no analytics. On browser pages
(`about:`, `chrome://`) where extension content scripts cannot run, the
shortcut is unavailable; the toolbar popup still lets you adjust the shortcut and
open settings.

## Permissions
- `webNavigation` — observe when the tab commits a navigation (including SPA
  pushState and hash changes) to build the trail. Titles and URLs only.
- `tabs` — read tab titles/favicons for trail entries and navigate the tab when
  you click a branch row.
- `storage` — save your settings locally and mirror trails in session storage
  (cleared when the browser closes).
- `scripting` — (Chrome) re-inject the content script into open tabs after
  install/update so the shortcut works without reloading pages.
- `<all_urls>` — run the content script that captures configurable shortcuts and
  renders the branch overlay on every page.

## Compatibility
Works on Firefox, Chrome, and Zen Browser.
