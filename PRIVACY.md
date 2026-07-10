# Privacy Policy - In-Page Trail

In-Page Trail **does not collect, transmit, or share** any personal data. There are
no analytics, no telemetry, no external servers, and no network requests made by
the extension. Everything stays on your device.

## What is stored, and where

- `tabtrailSettings` (local extension storage, `storage.local`) - your shortcut
  configuration (modifier, optional Shift, key or mouse button), overlay
  position, and display options.
- `tabtrailSavedTrails` (local extension storage, `storage.local`) - named path
  snapshots you explicitly save from the trail overlay (each name, page URLs,
  titles, favicon URLs, timestamps, and pinned state for that path). These
  remain until **you delete them** from the Saved trails library; they are not
  cleared when a tab or the browser closes. Creation and mutation are refused
  when requested by a private or incognito tab, so private-browsing paths are
  never added to durable storage.
- `tabtrailTrail:<tabId>` entries (session storage, `storage.session`) - each
  tab's navigation trail: page URLs, titles, favicon URLs, and timestamps.
  Session storage is held in memory and **cleared when the browser closes**; a
  trail is also deleted the moment its tab closes. On browsers without
  `storage.session`, the mirror falls back to local storage and is wiped at the
  next browser startup, preserving the same session-only behavior. Trails for
  private/incognito tabs are kept in memory only and never written to disk.
- `storageSchemaVersion` (local) - an internal number used to migrate stored
  data between versions.

Only page titles and URLs are recorded - never page content, form data,
keystrokes, or screenshots. Named snapshots store only the path you chose to
save, not full browsing history.

## Permissions and why they are needed

- `webNavigation` - observe when a tab commits a navigation (including SPA
  pushState and hash changes) so the trail can be recorded.
- `tabs` - read tab titles and favicon URLs for trail entries, and navigate a
  tab when you click a trail row.
- `storage` - persist the settings and session-scoped trails described above.
- `scripting` - (Chrome) re-inject the content script into open tabs after
  install or update.
- `<all_urls>` - run the small content script that listens for the shortcut and
  renders the trail overlay. It never reads page content or sends anything
  anywhere.

## Contact

Questions about privacy can be raised as an issue in the project repository.
