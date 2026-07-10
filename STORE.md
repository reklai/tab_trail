# Current Tab History - In-Page Trail - Store Listing

## Extension Names
- Firefox / Zen: Current Tab History - In-Page Trail
- Chrome: Current Tab History - In-Page Trail
- In-app name: Current Tab History - In-Page Trail

Chrome Web Store listing title: **Current Tab History - In-Page Trail**

## Chrome Summary (short, <=132 chars)
Stop losing your place in a tab. See your current tab history, preview earlier pages, and jump back without repeated Back clicks.

## Firefox Summary (<=250 chars)
Stop losing your place in a tab. See your current tab history, preview earlier pages, and jump back without repeated Back clicks.

## Description
In-Page Trail shows a clean in-page trail for the current tab, so you can see where you
came from and jump back to the right page without repeatedly pressing Back.

Use it when you are deep in docs, search results, product pages, dashboards,
GitHub issues, or research links and need to recover your place quickly.

- View the in-page trail for the current tab.
- Open the trail with a keyboard or mouse shortcut.
- Preview earlier pages from the trail.
- Jump back to any trail entry.
- Open entries in a new tab or window.
- Copy any trail URL.
- Save important paths locally, then fuzzy-search, pin, update, rename,
  preview, or reopen them later.
- Saved trail names and complete navigation trees must be unique; shorter or
  longer versions of a path can still be saved separately.
- Keep live trails session-only; named paths persist only when you save them.

In-Page Trail is focused on in-tab navigation history. It is not a full tab manager,
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
- `storage` - save your settings and named saved paths locally, and mirror live
  trails in session storage (cleared when the browser closes).
- `scripting` - (Chrome) re-inject the content script into open tabs after
  install/update so the shortcut works without reloading pages.
- `<all_urls>` - run the content script that captures configurable shortcuts and
  renders the trail overlay on every page.

## Compatibility
Works on Firefox, Chrome, and Zen Browser.
