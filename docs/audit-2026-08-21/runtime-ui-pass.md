<!-- (C) -->
# Runtime UI / accessibility pass (2026-08-21, HEAD `731afc5`)

Method: `npm run dev` on :5310, driven through the Browser pane against the real
React app. Not a static read. Every number below was measured in a running
instance, with CSS transitions disabled so no value was sampled mid-animation.

**A measurement error worth recording.** The first contrast sweep reported the
F-key bar at 1.93:1 and I nearly filed it as a critical light-mode regression. It
was wrong. The browser pane was not compositing frames, so a `CSSTransition` on
`.phn-fn { transition: color 120ms }` was frozen at `currentTime: 0`, and
`getComputedStyle` returned the *previous* skin's colour while the CSS custom
property at the same element already read the new one. Disabling transitions
resolved it to the correct token. The theme system works. Every figure below was
re-measured with `transition: none` forced.

---

## 1. Keyboard reachability: tab switching has no keyboard path (HIGH)

Verified three independent ways.

**DOM.** The terminal tab strip (`.moba-tab`), the new-tab `+` control, and the
right-dock tabs (`.moba-rd-tab`: SFTP / Assistant / Monitor) each return
`UNREACHABLE-BY-KEYBOARD`: they are not focusable, carry no `role`, no `tabindex`,
and have no focusable ancestor. 16 such truly-unreachable clickable elements exist
on the default screen.

**Keybinding registry.** `src/features/terminals/keybindings.js:16-50` defines
`newTab` (Ctrl+Shift+T), `closeTab`, `reopenTab`, pane splits, pane focus nav
(Ctrl+Alt+arrows) and panel switching (Ctrl+1 to Ctrl+8, which switches *panels*,
not tabs). **There is no next-tab, previous-tab, or go-to-tab-N action anywhere in
the registry.**

**Running app.** Tabbing through the whole default screen yields 56 focusable
controls; none of them is a terminal tab or a dock tab.

Failure: open three terminal tabs in one panel, then try to move between them
without a mouse. There is no way to do it. For a workstation positioned against
MobaXterm whose core use case is many concurrent agent tabs, this is the single
most consequential usability gap found in this pass.

Fix: add `nextTab` / `prevTab` (Ctrl+Tab / Ctrl+Shift+Tab) and `goToTab1..9` to
`KEY_ACTIONS`, and give the strip `role="tablist"` with roving `tabindex` so the
tabs are focusable too.

## 2. `src/styles.css` is theme-unaware, and everything it sets is dark-only (HIGH)

One root cause, three separate visible consequences in light mode. All values are
literals with no `var(--phn-*)` and no `moba-light` override:

```
body { background: #0a0a0a; color: #E6E6E6; }
button:focus, button:focus-visible { outline: 1px solid #7c9cf5; outline-offset: 2px; }
```

**(a) The window's base layer stays black under the light skin.** With
`data-phn-skin="moba-light"` active, `html` and `body` compute to `rgb(10,10,10)`
while `.phn-page` correctly paints `#d9d9d9`. `src-tauri/tauri.conf.json` sets the
same `backgroundColor: "#0a0a0a"`. Invisible in steady state because `.phn-page`
covers the viewport, but every moment before React paints (cold boot, window
resize, skin flip) shows black behind a light UI.

**(b) The inherited default text colour is `#E6E6E6`,** near-white. Any text node
that does not set its own colour is near-invisible on the light chrome. Nothing
guarantees every node sets one.

**(c) The global focus ring is hardcoded `#7c9cf5`.** Against the light page
background `#d9d9d9` that is roughly 1.96:1, below the 3:1 WCAG minimum for a
non-text focus indicator. The keyboard focus ring is at its least visible in the
theme the app's own owner uses daily.

Fix: move all three to tokens and give `moba-light` its overrides.

## 3. Contrast: light mode is the worst of the three skins (MEDIUM)

Measured across every visible text node, in all three skins, transitions disabled.

| Skin | Failures | Worst pair | Ratio | Need |
|---|---|---|---|---|
| **moba-light** | **27** | `#808080` on `#d9d9d9` (×9) | **2.80** | 4.5 |
| oled | 13 | `#67696e` on `#000000` (×12) | 3.82 | 4.5 |
| moba | 13 | `#67696e` on `#101113` (×12) | 3.44 | 4.5 |

Light-mode breakdown:

| Pair | Ratio | Count | What |
|---|---|---|---|
| `#808080` on `#d9d9d9` | 2.80 | 9 | F-key bar shortcut labels (F1 to F9, Ctrl+K, …) |
| `#666666` on `#d9d9d9` | 4.07 | 10 | F-key action labels, home tagline |
| `#f87171` on `#ffffff` | 2.77 | 1 | error text in the snippets panel |
| `#808080` on `#ececec` | 3.34 | 4 | tool captions (Connect / Workspace / AI · Tools) |
| `#d9d9d9` on `#1170cc` | 3.53 | 1 | the primary CTA, "Start local terminal" |
| `#06121f` on `#1170cc` | 3.78 | 1 | "Start tour" |
| `#1170cc` on `#ececec` | 4.22 | 1 | GitHub link in the status bar |

The most interesting one is precise. `headerSkins.css:976-981` documents its own
contrast reasoning:

> Contrast on the #ececec surface: dim #666 ≈ 4.9:1 …, faint #808080 ≈ 3.3:1
> (fine for hints …)

That math is right **for `#ececec`**, and the measurement confirms it (3.34).
But the F-key bar's background is `--phn-page-bg: #d9d9d9`, not `#ececec`, and on
that darker surface the same `--phn-text-faint` token drops to **2.80:1**. The
token was validated against one surface and then used on another. `#666666` on
`#d9d9d9` lands at 4.07, also under AA, for the same reason.

Fix: either lighten the F-key bar to `--phn-surface-bg`, or add a
`--phn-text-faint-on-page` variant validated against `#d9d9d9`.

## 4. No document structure for assistive tech (MEDIUM)

`main=0 nav=0 header=0 footer=0 aside=0`, and zero `<h1>` elements in the entire
rendered app. A screen-reader user gets one flat list of 56 controls with no
landmarks to jump between and no page heading. The controls themselves are mostly
fine: real `<button>` elements with `title` attributes that surface as accessible
names, which is better than the raw `249 onClick vs 30 aria-*` grep suggested.

## 5. Two first-run overlays compete, and one is invisible to assistive tech (MEDIUM)

On a first launch the **Setup checker** dialog (`role="dialog"`,
`aria-modal="true"`, z-index 9990) and the **tour overlay** (z-index 9985) render
at the same time. The tour is not inside the dialog and carries no dialog role.
Focus lands inside the modal (`activeElement` = "Re-run checks"). Result: the tour
is painted underneath a modal that owns focus, and a screen-reader user is told
about only one of the two.

Fix: sequence them. The tour should not mount until the setup dialog closes.

## 6. Accessibility lint concentration (context, not a finding)

129 `jsx-a11y` errors across 30 files, concentrated in:

| Count | File |
|---|---|
| 22 | `TerminalPanel.jsx` (the tab strip, matching finding 1) |
| 19 | `ProjectSidebar.jsx` |
| 11 | `ProjectDialog.jsx` |
| 7 | `SnippetsDrawer.jsx` |
| 6 each | `LocalFileBrowser.jsx`, `SftpBrowser.jsx`, `TerminalPane.jsx` |

The top two files are the session tree and the tab strip, which is exactly where
the runtime probe found the unreachable controls. The static and runtime evidence
agree.

## What this pass could not cover

Running under `npm run dev` in a plain browser means `isTauri()` is false and every
`invoke()` rejects, so anything behind a live PTY, SSH, SFTP, RDP, VNC or keychain
call was not exercised. The boot console showed exactly two warnings, both
expected in that mode (`scrollback sweep failed`, `transcript sweep failed`, both
`Cannot read properties of undefined (reading 'invoke')`). The packaged-app
surface, and everything in `live-test-matrix.md`, still needs a real build.
