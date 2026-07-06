# TabTrail - Store Listing

## Extension Names
- Firefox / Zen: TabTrail - Current Tab History
- Chrome: TabTrail - Current Tab History
- In-app name: TabTrail

Chrome Web Store listing title: **TabTrail - Current Tab History**

## Chrome Summary (short, <=132 chars)
Press Alt+H to show this tab's page trail and jump back to any visited step without pressing Back over and over.

## Firefox Summary (<=250 chars)
Press Alt+H to show this tab's page trail, preview visited pages, and jump back to the right step without pressing Back over and over.

## Description
TabTrail shows a clean page trail for the current tab, so you can see where you
came from and jump back to the right step without repeatedly pressing Back.

Use it when you are deep in docs, search results, product pages, dashboards,
GitHub issues, or research links and need to recover your place quickly.

- View the page trail for the current tab.
- Open the trail with a keyboard or mouse shortcut.
- Preview visited pages from the trail.
- Jump back to any trail entry.
- Open entries in a new tab or window.
- Copy any trail URL.
- Keep trails session-only; they clear when the browser closes.

TabTrail is focused on in-tab navigation history. It is not a full tab manager,
session restore tool, bookmark manager, or closed-tab recovery extension.

No data leaves your browser. Works on Firefox, Chrome, and Zen Browser.

We use the `webNavigation` API to record page titles and URLs only: no content
is read, nothing is transmitted, and there are no analytics. On browser pages
(`about:`, `chrome://`) where extension content scripts cannot run, the shortcut
and in-page trail are unavailable; the toolbar popup still lets you adjust the
shortcut and open settings.

## Permissions
- `webNavigation` - observe when the tab commits a navigation (including SPA
  pushState and hash changes) to build the trail. Titles and URLs only.
- `tabs` - read tab titles/favicons for trail entries and navigate the tab when
  you click a trail row.
- `storage` - save your settings locally and mirror trails in session storage
  (cleared when the browser closes).
- `scripting` - (Chrome) re-inject the content script into open tabs after
  install/update so the shortcut works without reloading pages.
- `<all_urls>` - run the content script that captures configurable shortcuts and
  renders the trail overlay on every page.

## Compatibility
Works on Firefox, Chrome, and Zen Browser.
