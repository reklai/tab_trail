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
  records `{ url, title, favicon, timestamp }` plus last-known scroll offsets
  per tab. Only top-level frames are tracked; page content is never stored.
- **One shortcut, in-page.** The default shortcut is **Alt + H**, captured by a
  content script in the capture phase. The shortcut is configurable: modifier
  (Alt, Ctrl, or Super), optional Shift, and either a letter/top-row digit key
  or left, middle, or right click.
- **Cursor + truncate trail model.** Native portions of a trail mirror real
  session history: a
  highlighted cursor marks where you are; jumping back moves the cursor and
  dims forward entries; navigating somewhere new from mid-trail drops the
  abandoned forward entries. Trail-row clicks use `history.go(delta)` where
  possible, preserving scroll position and the back/forward cache. When the
  jump must fall back to plain navigation — or when you open a **saved trail**
  / seed a path into a new tab or window — In-Page Trail restores the last-known
  viewport for that entry (both axes, multi-attempt for late layout). Seeded
  paths mark only the first edge as history-backed, so in-path jumps almost
  always use force restore rather than `history.go`.
- **Session-only storage.** Trails live in `storage.session` and clear when the
  browser closes. Each tab keeps its most recent **100** pages. Closing a tab
  deletes its trail immediately. Incognito trails stay in memory only. Scroll
  on saved paths becomes durable only when you save or update a path.

## Using the overlay

- **Alt + H** (or your configured shortcut) toggles the trail; **Esc** or the
  close button hides it.
- **Click** a row to jump back or forward to it.
- **Click the ⋯ button** beside a row to show the full title, URL, relative
  timestamp, preview, *Open in new tab*, *Open in new window*, *Copy URL*, and
  *Save trail up to this point in path* (stores a named snapshot from the first
  page through that row). A new tab inherits the path through that row as a
  branch, then records its own navigation independently.
- **Right-click** a row to open the same menu without using the ⋯ button.
- **Drag** the trail by its handle to reposition it; the position is remembered.
- **Click** the settings button in the trail to open settings.
- **Click** the Saved trails button (to the right of settings) to open your
  named path library. Open a trail in the current tab or a new tab beside it,
  preview the full path as a node tree, fuzzy-search names and pages with live
  match highlighting, pin, update, rename, or remove it. Each recent
  update or removal keeps its own 8-second Undo. New tabs inherit the saved
  path. Saved trail names and complete navigation trees must be unique; shorter
  or longer versions of a path can still be saved separately. Private windows
  cannot save or change durable trails, preventing private paths from entering
  persistent local storage.
- **Drag** the preview pane by its handle after opening a preview from the row
  menu.
- Trails longer than the configured row budget collapse into a **+N more** row;
  click it to expand in place, then use **Show less** to collapse again.

## Known limitations

- On privileged pages (`about:`, `chrome://`, extension stores), content scripts
  cannot run, so the shortcut and in-page trail are unavailable there. The
  **toolbar popup** remains available for changing the shortcut and opening
  settings.
- Live trails are session-only by design: restarting the browser starts fresh.
  Settings and **named saved trails** persist in local storage until you change
  or delete them.
- Firefox needs `webNavigation` in the MV2 manifest; Chrome uses the same API
  in the MV3 manifest. Chrome also uses `scripting` for install-time
  content-script re-injection.
- A page-initiated redirect or an inherited new-tab prefix does not map 1:1 to
  the new tab's native history. In-Page Trail detects those edges and falls back
  to plain navigation for such jumps, then restores last-known scroll when
  available.
- Scroll restore is best-effort: virtualized lists, unusual nested scrollers,
  and major layout shifts after the restore window may still land off-target.
  Nested primary scrollers are detected heuristically (one optional element
  root); full nested-tree capture is out of scope.

## Development

```bash
npm install
npm run build:firefox   # or build:chrome
npm run ci              # lint, tests, typecheck, verifiers, both builds
```

See `CONTRIBUTING.md` for the architecture tour, `RELEASE.md` for packaging,
`STORE.md` for listing copy, and `PRIVACY.md` for the privacy policy.
