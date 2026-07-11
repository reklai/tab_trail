# Overlay UI — reconstruction guide

How to rebuild the **in-page trail overlay** if architecture or chrome is lost.
This documents the **current** system (not a redesign). Prefer fixing modules
in place; only full-rebuild when a layer is fundamentally wrong.

**Product job:** show the current tab’s navigation path as floating,
extension-isolated chrome that intercepts input **only where UI paints**, so the
page stays usable everywhere else.

---

## Architecture (two documents, two shadows)

```
Page top frame (content script)
  OverlayFrameController  →  closed shadow + full-viewport extension iframe
       clip-path = union of hit surfaces (gaps stay click-through)
       MessagePort (protocol v2) after nonce claim
            │
Extension document (overlayFrame.html)
  overlayFrame.ts  →  open shadow #ht-panel-host
       getBaseStyles() + breadcrumbTrail.css + savedTrailsPanel.css
       .wf-layer → live bar, menus, library, previews, notices
```

| Layer | Primary files | Role |
|-------|---------------|------|
| Page host | `src/lib/ui/overlayFrame/overlayFrameController.ts` | Iframe shell, clip, hibernate/destroy, RPC |
| Geometry | `src/lib/ui/overlayFrame/surfaceGeometry.ts` | Multi-subpath rounded clip-path |
| Protocol | `src/lib/common/contracts/overlayFrame.ts` | HOST_*/FRAME_*/RPC map (v2) |
| Frame | `src/entryPoints/overlayFrame/overlayFrame.ts` | Auth, mount UI, surface measurement |
| Panel shell | `src/lib/common/utils/panelHost.ts` | Open shadow, design tokens |
| Live UI | `src/lib/ui/panels/breadcrumbTrail/*` | Bar, menus, library, notices, previews |
| Wire-up | `src/lib/appInit/topFrameOverlay.ts` | `TRAIL_SHOW` / claim / updates |

### Lifecycle contracts

1. **`HOST_INIT`** — seed settings only (no DOM mount).
2. **`HOST_SHOW`** — always paint / remount the trail UI.
3. **`HOST_HIBERNATE`** — unmount panel DOM, empty surfaces, keep iframe warm.
4. **Close** — explicit intent only:
   - `close({ mode: "hibernate" })` — toggle / user hide
   - `close({ mode: "destroy", reason })` — pagehide, faults, dispose  
   Never string-match English close reasons.

---

## Design identity

**Vernacular:** timeline / branch chrome (nodes, current page, fork edges) —
not a generic dashboard card.

**Tokens** live in `getBaseStyles()` (`panelHost.ts`), injected under `:host` in
the panel shadow:

| Role | Values |
|------|--------|
| Canvas | `#1e1e1e` / elevated `#252525` |
| Text | `#e0e0e0` → strong `#fff` |
| Accent | `#0a84ff` (+ soft blues) |
| Success / “here” | greens `#32d74b` / `#4ec970` |
| Danger / close | `#ff5f57` |
| Warning / grip | `#febc2e` / gold grip |
| Type | mono: SF Mono → JetBrains Mono → Fira Code → Consolas |
| Radius | token `10px`; chrome often **8px** (matches clip radius) |
| Shadow | **none** — solid elevated fill, no drop shadow |

**Signature:** compact mono branch list + **selective hit isolation** (clip
through the page). That isolation is the product, not a dimmer modal.

### Layout sketch

```
Page interactive except under clip
┌─ transparent full-viewport iframe ─────────────────────────┐
│  ┌ .wf-bar (hit surface) ─────────────────────────────┐    │
│  │ ⚙ ☰  In-Page Trail              ⠿  ✕               │    │
│  │  ○ …  ● current ⋯  ○ forward ⋯                     │    │
│  └────────────────────────────────────────────────────┘    │
│  menus / library / dialogs / preview (also hit surfaces)   │
│  notice stack (bottom)                                     │
└────────────────────────────────────────────────────────────┘
```

---

## Style injection

```text
esbuild imports *.css as text
  breadcrumbTrail.ts:
    style.textContent = getBaseStyles() + breadcrumbTrail.css + savedTrailsPanel.css
    panelShadow.appendChild(style)
```

- Panel shadow: **open** (geometry + a11y).
- Page iframe shell: **closed** shadow.
- Frame document CSS (`overlayFrame.css`) is only a transparent canvas — not panel chrome.
- Tokens must sit on `:host` inside the shadow, not only document `:root`.

---

## Hit surfaces and clipping

Mark every interactive floating pane with `data-tabtrail-hit-surface`:

- `.wf-bar`, `.wf-menu`, `.wf-dialog`, `.wf-library-panel`
- `.wf-trail-tree-preview`, `.wf-preview-pane`, each `.wf-notice`

Frame measures rects → `FRAME_SURFACES_UPDATED` (max **32**; notices **merge**
into one rect). Host builds a **multi-subpath** rounded `clip-path` so **gaps
between surfaces stay click-through**. Empty clip: hide iframe
(`pointer-events: none`).

Also:

- `.wf-layer`: `pointer-events: none`; panes opt into `auto`
- Wheel: `data-tabtrail-wheel-surface` / `data-tabtrail-scroll-region` + interaction shield
- Z-order inside shadow: preview **12** · library **13** · menu/dialog/tree **14** · notices **16**

---

## Interaction model (rows)

| Target | Live trail | Saved library |
|--------|------------|---------------|
| Body left-click | **Jump** to that entry (same tab) | none today; if added → open trail, **not** menu |
| ⋯ left-click | Menu | Menu |
| Row right-click | Same menu (optional accelerator) | Same menu |
| Pin | n/a | Toggle pin |

Do **not** open the overflow menu from body left-click. ⋯ is the primary
menu affordance.

---

## Reconstruction order (if rebuilding)

Do phases in order; stop and test after each.

| Phase | Build | Prove with |
|-------|-------|------------|
| **A** Host + geometry | `surfaceGeometry`, controller cold open/destroy, `topFrameOverlay` | geometry + controller-dom tests |
| **B** Frame bootstrap | connect/claim, surface loop, clip apply | protocol + controller-dom + trigger-dom |
| **C** Tokens + panel host | `getBaseStyles`, open shadow, `.wf-layer` | panel host renders empty layer |
| **D** Live trail | bar, jump rows, ⋯, shield, Esc | `breadcrumb-trail-dom` |
| **E** Secondary surfaces | `contextMenu`, stack, preview, notices | context-menu + breadcrumb tests |
| **F** Saved trails | `savedTrailsUi`, library, dialogs, mutations | saved-trails-panel-dom, private-saved-trails |
| **G** Warm path | hibernate/`HOST_SHOW`, chord guard, geometry observers | overlay-frame-controller warm tests, runtime-wiring |

### Module map (UI)

```
breadcrumbTrail.ts
  panelHost, interactionShield, overlaySurfaces, contextMenu
  liveTrailPreview, liveTrailNotices, trailPresentation
  savedTrailsPanel
    savedTrailsSession (savedTrailsUi)
    savedTrailsLibrary → search, dialogs, mutations, tree preview
```

Use **`savedTrailsUi` directly** — no thin pass-through facade helpers.

---

## Invariants (do not regress)

1. Frame background always **transparent**.
2. Clip is multi-subpath, not one big bounding box.
3. Privileged work (tabs, storage) only via **host RPC**.
4. Non-modal: **no** full-page dimmer.
5. Hibernate vs destroy remains explicit on the controller API.
6. Mount paint only on **`HOST_SHOW`**.
7. Clip radius stays aligned with UI corner radius (**8px**).

---

## Verification

```bash
npm test
npm run typecheck
npm run lint
```

Manual smoke:

1. Toggle open → jump a non-current row → ⋯ menu → library → Esc peels surfaces.
2. Toggle close (hibernate) → reopen (warm, no full iframe reload).
3. Click **between** bar and a notice — page still receives the click.
4. Mouse-chord close does not open the **page** context menu under the pointer.

Browser builds: `npm run build:firefox` / `build:chrome` and temporary load from `dist/`.

---

## Related

- `CONTRIBUTING.md` — project layout, PR checks, and overlay smoke process
- `STABILITY.md` — stability/reliability/performance strategy (soft vs hard
  failures, latency budgets, diagnostics API, race table)
- `README.md` — end-user overlay gestures
- `src/lib/common/contracts/overlayFrame.ts` — wire protocol
