# Current Tab History - In-Page Trail

**Press Alt + H to show In-Page Trail.** In-Page Trail automatically tracks
the pages visited inside each tab and shows them as a compact, draggable vertical
trail with page titles, URL subtitles, and the current page highlighted. Click
any row to jump straight back.

It answers the browsing problem: *"How did I get here, and which step do I
need to return to?"*

Works on Firefox, Chrome, and Zen Browser (one TypeScript codebase, MV2 + MV3
dual build).

## How it works

- **Automatic tracking.** The background script listens to `webNavigation`
  events, including SPA `pushState` navigations and hash-route changes, and
  records `{ url, title, favicon, timestamp }` per tab. Only top-level frames
  are tracked, and only titles + URLs are stored.
- **One shortcut, in-page.** The default shortcut is **Alt + H**, captured by a
  content script in the capture phase. The shortcut is configurable: modifier
  (Alt, Ctrl, or Super), optional Shift, and either a letter/top-row digit key
  or left, middle, or right click.
- **Cursor + truncate trail model.** The trail mirrors real session history: a
  highlighted cursor marks where you are; jumping back moves the cursor and
  dims forward entries; navigating somewhere new from mid-trail drops the
  abandoned forward entries. Trail-row clicks use `history.go(delta)` where
  possible, preserving scroll position and the back/forward cache.
- **Session-only storage.** Trails live in `storage.session` and clear when the
  browser closes. Each tab keeps its most recent **100** pages. Closing a tab
  deletes its trail immediately. Incognito trails stay in memory only.

## Using the overlay

- **Alt + H** (or your configured shortcut) toggles the trail; **Esc** or the
  close button hides it.
- **Click** a row to jump back or forward to it.
- **Click the ⋯ button** beside a row to show the full title, URL, relative
  timestamp, preview, *Open in new tab*, *Open in new window*, and *Copy URL*.
- **Right-click** a row to open the same menu without using the ⋯ button.
- **Drag** the trail by its handle to reposition it; the position is remembered.
- **Click** the settings button in the trail to open settings.
- **Drag** the preview pane by its handle after opening a preview from the row
  menu.
- Trails longer than the configured row budget collapse into a **+N more** row;
  click it to expand in place, then use **Show less** to collapse again.

## Known limitations

- On privileged pages (`about:`, `chrome://`, extension stores), content scripts
  cannot run, so the shortcut and in-page trail are unavailable there. The
  **toolbar popup** remains available for changing the shortcut and opening
  settings.
- Trails are session-only by design: restarting the browser starts fresh.
  Settings persist.
- Firefox needs `webNavigation` in the MV2 manifest; Chrome uses the same API
  in the MV3 manifest. Chrome also uses `scripting` for install-time
  content-script re-injection.
- A page-initiated redirect replaces a history entry, which breaks the 1:1
  trail-to-history mapping across that hop. In-Page Trail detects this and falls
  back to a plain navigation for such jumps.

## Development

```bash
npm install
npm run build:firefox   # or build:chrome
npm run ci              # lint, tests, typecheck, verifiers, both builds
```

See `CONTRIBUTING.md` for the architecture tour, `RELEASE.md` for packaging,
`STORE.md` for listing copy, and `PRIVACY.md` for the privacy policy.
