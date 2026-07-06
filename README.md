# Wayfind

**Press Alt + H to see where this tab came from.** Wayfind automatically
tracks your within-tab navigation trail and shows it as a compact, draggable
cascading branch overlay with page titles, URL subtitles, and the current page
highlighted. Click any row to jump straight back.

It answers the question every rabbit hole eventually raises: *"How did I get
here?"*

Works on Firefox, Chrome, and Zen Browser (one TypeScript codebase, MV2 +
MV3 dual build).

## How it works

- **Automatic tracking.** The background script listens to `webNavigation`
  events — including SPA `pushState` navigations and hash-route changes — and
  records `{ url, title, favicon, timestamp }` per tab. Only top-level frames
  are tracked, and only titles + URLs (never page content).
- **One shortcut, in-page.** The default shortcut is **Alt + H**, captured by a
  content script in the capture phase — no `commands` API. The shortcut is
  fully configurable: modifier (Alt, Ctrl, or Super), optional Shift, and
  either a letter/top-row digit key **or left, middle, or right click**. It
  works even while a text field is focused (modifier chords don't type
  characters).
- **Cursor + truncate trail model.** The trail mirrors real session history: a
  highlighted cursor marks where you are; jumping back moves the cursor and
  dims the forward entries (like the browser's forward stack); navigating
  somewhere new from mid-trail drops the abandoned forward entries. Because
  trail ≅ history, branch-row clicks use `history.go(delta)` where possible,
  preserving scroll position and the back/forward cache.
- **Session-only storage.** Trails live in `storage.session` (mirrored so an
  MV3 service-worker restart loses nothing) and clear when the browser closes.
  Each tab keeps its most recent **100** pages. Closing a tab deletes its
  trail immediately. Incognito trails stay in memory only.

## Using the overlay

- **Alt + H** (or your configured shortcut) toggles the bar; **Esc** or the ✕
  also hides it.
- **Click** a row to jump back (or forward) to it.
- **Hover** a truncated row for a delayed detail card with the full title, URL,
  and relative timestamp.
- **Right-click** a row for an in-page preview pane, *Open in new tab*, *Open
  in new window*, and *Copy URL*.
- **Drag** the bar by its `⠿` handle to reposition it — the position is
  remembered.
- **Click** the `⚙` button in the bar to open settings.
- **Drag** the preview pane by its `⠿` handle to move only the open preview.
- Trails longer than the configured row budget collapse into a
  **“+N more”** pill; click it to expand in place.
- Connector colors differentiate how each hop happened: a followed link, a
  typed address, or in-page SPA/hash routing. They can be simplified in
  settings.

## Known limitations

- On privileged pages (`about:`, `chrome://`, extension stores) content
  scripts cannot run, so the shortcut is unavailable there. The **toolbar
  popup** remains available for changing the shortcut and opening settings.
- Trails are session-only **by design**: restarting the browser starts fresh.
  Settings persist.
- Firefox needs `webNavigation` (MV2 manifest); Chrome uses the same API in
  the MV3 manifest. The Firefox build declares the `tabs`/`storage`/
  `webNavigation`/`<all_urls>` set; Chrome adds `scripting` for install-time
  content-script re-injection.
- A page-initiated redirect replaces a history entry, which breaks the 1:1
  trail↔history mapping across that hop — Wayfind detects this and falls back
  to a plain navigation for such jumps.

## Development

```bash
npm install
npm run build:firefox   # or build:chrome
npm run ci              # lint, tests, typecheck, verifiers, both builds
```

See `CONTRIBUTING.md` for the architecture tour, `RELEASE.md` for packaging,
`STORE.md` for listing copy, and `PRIVACY.md` for the privacy policy.
