# Privacy Policy - In-Page Trail

In-Page Trail **does not collect, transmit, or share** any personal data with the
developer or any third-party analytics service. There are no analytics, no
telemetry, and no In-Page Trail backend. Trail data stays on your device in
extension storage (and in memory for private windows).

## What is stored, and where

- `tabtrailSettings` (local extension storage, `storage.local`) - your shortcut
  configuration (modifier, optional Shift, key or mouse button), overlay
  position, and display options.
- `tabtrailSavedTrails` (local extension storage, `storage.local`) - named path
  snapshots you explicitly save from the trail overlay (each name, page URLs,
  titles, favicon URLs, timestamps, pinned state, and optional **viewport pixel
  offsets (scroll position)** plus optional scroll-root selector metadata for
  that path). These remain until **you delete them** from the Saved trails
  library; they are not cleared when a tab or the browser closes. Creation and
  mutation are refused when requested by a private or incognito tab, so
  private-browsing paths are never added to durable storage. Durable scroll is
  written only when you save or update a path — not continuously while browsing.
- `tabtrailTrail:<tabId>` entries (session storage, `storage.session`) - each
  tab's navigation trail: page URLs, titles, favicon URLs, timestamps, and
  optional **viewport pixel offsets (scroll position)** with optional scroll-root
  selector metadata. Session storage is held in memory and **cleared when the
  browser closes**; a trail is also deleted the moment its tab closes. On
  browsers without `storage.session`, the mirror falls back to local storage and
  is wiped at the next browser startup, preserving the same session-only
  behavior. Trails for private/incognito tabs are kept in memory only and never
  written to disk (including scroll metadata).
- `storageSchemaVersion` (local) - an internal number used to migrate stored
  data between versions.

Only page titles, URLs, and numeric viewport offsets are recorded - never page content,
form data, keystrokes, or screenshots. Named snapshots store only the path you chose
to save, not full browsing history.

## Network activity

In-Page Trail does **not** phone home. The only optional network activity is
user-driven and limited to URLs already on your trail:

- **Trail row preview.** When you open a preview, the extension may issue a
  short `HEAD` (and, if needed, headers-only `GET`) request to **that same page
  URL** to read framing headers (`X-Frame-Options` / CSP `frame-ancestors`) and
  decide whether an embed is allowed. Requests use `credentials: "omit"` and do
  not upload trail data. If the site allows embedding, the preview may load that
  URL in an extension-hosted iframe the way a normal tab load would.
- No other remote endpoints are contacted for analytics, accounts, sync, or
  crash reporting.

## Overlay surface

The trail UI runs in an **extension-origin iframe** (`web_accessible_resources`)
so page scripts cannot read overlay events or state. Communication with the page
host uses an authenticated `MessagePort` and stays inside the browser.

## Permissions and why they are needed

- `webNavigation` - observe when a tab commits a navigation (including SPA
  pushState and hash changes) so the trail can be recorded.
- `tabs` - read tab titles and favicon URLs for trail entries, and navigate a
  tab when you click a trail row.
- `storage` - persist the settings, named saved trails, and session-scoped
  trail mirrors described above.
- `scripting` - (Chrome) re-inject the content script into open tabs after
  install or update.
- `<all_urls>` - run the content scripts that capture the shortcut, host the
  overlay frame, and sample scroll offsets for restore. They do not read page
  DOM content into durable storage and do not send data to the developer.

## Contact

Questions about privacy can be raised as an issue in the project repository.
