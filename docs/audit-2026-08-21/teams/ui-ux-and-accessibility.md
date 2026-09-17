<!-- (C) -->
# UI, UX and accessibility

Audit of plutos-terminals @ `731afc5`, 2026-08-21.

## Summary

The modal layer is genuinely good , Modal.jsx and TourOverlay.jsx do focus-into, focus-restore, scoped Tab traps and topmost-only Escape correctly, and Toast has a real aria-live region. Everything outside that layer is mouse-only by construction: the tab strip, the session tree rows, the right-dock tab strip and both collapse rails are click-handled divs/spans, and the keybinding registry has no next/previous-tab action at all, so a keyboard user who collapses a panel or opens a second tab has no way back. The bigger and more immediate problem is theme discipline: `--phn-text-bright` is referenced in 8 places and defined in zero, so its hardcoded near-white fallback wins under every skin , under the Light skin (the owner's daily driver) that makes the AI Assistant's input box, its sent-message bubbles and the Monitor's CPU/MEM/DISK readouts invisible. Three more always-visible surfaces (tab rename, session rename, the phone-pairing token) hardcode `#fff` or a near-black fill and wash out the same way. These are not "queued regressions" , they are already live in the shipped light theme.

## Verified sound (8)

- components/Modal.jsx (lines 42-75) , genuinely correct dialog a11y: focuses the first control in .phn-modal-body rather than the header ✕, restores focus to the trigger on close via the effect's cleanup, traps Tab against the dialog node (not window, so nested modals do not fight), and gates Escape on being the last .phn-modal-overlay in document order. role=dialog + aria-modal + aria-label are all present (:88-91).
- features/terminals/tour/TourOverlay.jsx (lines 79-104) , hard Tab trap cycling inside the tour card with a documented reason, Escape exits, arrows navigate, capture-phase listener with stopPropagation so xterm never sees the keystrokes, scrollIntoView on each measured target (:60), and a closedRef single-fire guard against key-repeat.
- components/Toast.jsx (lines 89-92) , the toast region carries role="status" and aria-live="polite", so errors and confirmations are announced. pointerEvents is correctly none on the container and auto on each toast.
- features/terminals/HistorySearch.jsx:36 , the highlighted row is scrolled into view with scrollIntoView({block:"nearest"}) on every move. This is the pattern CommandPalette is missing; the codebase already has the right answer.
- Menu bar and toolbar chrome are keyboard-reachable , MobaMenuBar renders both the top-level triggers and every dropdown item as real <button>s (MobaMenuBar.jsx:34, 50) with Escape-to-close and click-outside dismissal; MobaToolbar (MobaToolbar.jsx:56-67) and FKeyBar (FKeyBar.jsx:33) are likewise real buttons with title text. Disabled menu items use the native disabled attribute rather than a styled div.
- The moba-light terminal palette (headerSkins.js:191-232) is properly reasoned rather than naively darkened , the comments document why ANSI white/brightWhite map to greys instead of near-white, and why the v2 pass chose saturation at ~3.3-4.6:1 over a flat AA darkening that killed hue identity. The light chrome's --phn-text-dim (#666, ~4.9:1) and --phn-text-faint (#808080, ~3.3:1) are explicitly contrast-checked in situ (headerSkins.css:976-980).
- MobaToolbar's dropdown is portaled to document.body with a fixed position captured from the trigger's rect (MobaToolbar.jsx:87-95), and closes on resize/scroll rather than drifting , the overflow-clip and stale-anchor bugs that usually accompany this pattern are both handled.
- eslint.config.js turns jsx-a11y's recommended set on rather than silencing it, so none of the above findings are a deliberate documented opt-out , the plugin was simply added today and the backlog has not been worked yet.

## Findings (11)

### HIGH A11Y-01, --phn-text-bright is referenced 8 times and never defined; its near-white fallback makes the Assistant input, chat bubbles and Monitor values invisible in Light mode

`src/features/terminals/terminals.css:1029`

**What.** `.phn-assistant-input textarea { background: var(--phn-surface-alt-bg, #1E2125); color: var(--phn-text-bright, #F2F4F7); }`. I grepped the whole of `src/` for `phn-text-bright`: 8 hits, every one a `var(--phn-text-bright, #F2F4F7)` *use*, and zero declarations. It is absent from `:root` (headerSkins.css:20-63), from `[data-phn-skin="moba"]` (:905), `[data-phn-skin="oled"]` (:940), `[data-phn-skin="moba-light"]` (:970), and from the derived token map in customThemes.js `deriveChrome()` (:99-123). So it always resolves to the literal `#F2F4F7`. Under moba-light the surfaces underneath it are light: `--phn-surface-alt-bg: #ffffff` (headerSkins.css:973) and `--phn-surface-bg: #ececec` (:972). The eight sites: terminals.css:1029 (assistant textarea, #F2F4F7 on #ffffff ≈ 1.05:1), :1021 `.phn-msg.user .phn-msg-body` (your own sent messages, #F2F4F7 on accent-subtle-over-#ececec ≈ 1.3:1), :1047 `.phn-mon-gauge-top .val` (the CPU/MEM/DISK percentages, #F2F4F7 on `.moba-rightdock` #ececec ≈ 1.08:1), :1002 `.moba-railcol:hover`, :1012 `.moba-rd-collapse:hover, .moba-tree-collapse:hover`, :1026 `.phn-msg-actions button:hover`, :1037 `.phn-assistant-clear:hover`, and TerminalPanel.jsx:597 (the tab strip's `+` hover). Note the neighbouring rules got this right , `.moba-rd-close:hover` (headerSkins.css:151) uses `--phn-text-active`, which IS defined per skin (#000000 under light). This is one missing token declaration, not 8 separate mistakes.

**Failure.** Switch to the Light skin (Ctrl+\, the daily-driver theme), open the right dock's Assistant tab and type a prompt: the textarea shows a blinking cursor and nothing else , the typed text is #F2F4F7 on #ffffff. Send it and your own message bubble is equally blank. Switch the dock to Monitor and the CPU/MEM/DISK percentage values beside each gauge are blank too (the grey `.lbl` labels and the coloured bars still render, so the panel looks half-broken rather than obviously unthemed).

**Fix.** Declare `--phn-text-bright` in every skin block (headerSkins.css `:root`, `[data-phn-skin="moba"]`, `"oled"`, `"moba-light"`) and in `deriveChrome()` in customThemes.js , for moba-light it should be #000000, matching `--phn-text-active`. Cheapest correct fix given it is semantically identical to the existing token: add `--phn-elevated`-style aliasing at :root, i.e. `--phn-text-bright: var(--phn-text-active, #F2F4F7);`, which is the same pattern already used for `--phn-elevated-bg` at headerSkins.css:54. Then add a CI grep asserting every `var(--phn-*)` name used has at least one declaration , this class of bug is invisible to eslint and to the dark-mode eye.

### HIGH A11Y-02, Collapsed session-tree and right-dock rails are click-only divs, and the collapsed state persists , a keyboard user loses both panels permanently

`src/features/terminals/TerminalsTab.jsx:1214`

**What.** `{dockCollapsed ? (<div className="moba-railcol" onClick={() => collapseDock(false)} title="Show side panel">` , a bare div, no tabIndex, no role, no key handler; `.moba-railcol` (terminals.css:994-1001) sets only `cursor: pointer`. The session-tree rail at TerminalsTab.jsx:1105 is the identical construction. The collapse direction, by contrast, IS keyboard-reachable: `.moba-rd-collapse` is a real `<button>` (DockTabStrip.jsx:23) and `.moba-tree-collapse` is a real `<button>` (ProjectSidebar.jsx:481). I grepped every call site of `collapseDock`/`collapseTree`: the only non-tour callers are those two buttons (collapse) and these two divs (expand). Nothing in usePaletteCommands.jsx, MenuBar.jsx or keybindings.js touches them. And the state is durable , useDockResize.js:23-24 writes `pt:dockCollapsed` / `pt:treeCollapsed` to localStorage and :18-19 reads them back on boot.

**Failure.** Tab to the right dock's `›` collapse button and press Enter. The dock collapses to a 26px rail. There is now no keyboard route back: the rail is a div, no menu item, palette command or keybinding calls `collapseDock(false)`. The same sequence on the session tree's `‹` button loses the entire saved-session list. Because both flags are persisted to localStorage, restarting the app does not recover them , the user is permanently down to the terminal grid until they use a mouse.

**Fix.** Make the rails real controls: `<button className="moba-railcol" onClick={...}>` (it is already a flex column, so the element swap is cosmetic-neutral once `background:none;border:none;font:inherit` are added), or at minimum add `role="button" tabIndex={0}` plus an Enter/Space `onKeyDown`. Belt-and-braces: add "Show/hide sessions panel" and "Show/hide side panel" entries to usePaletteCommands.jsx so the state is recoverable from Ctrl+K regardless.

### HIGH A11Y-03, Tab-rename and session-rename inputs hardcode color:#fff over an ~#ffffff background , renaming is blind typing under the Light skin

`src/features/terminals/TerminalPanel.jsx:554`

**What.** The inline rename input rendered when you double-click a tab uses `background: "rgba(255,255,255,0.08)"` (line 552) and `color: "#fff"` (line 554), with `outline: "none"` (line 559). That input is rendered inside `.moba-tab`, whose fill under moba-light is `--phn-tab-bg-active: #ffffff` for the active tab and `--phn-tab-bg: #d6d6d6` for inactives (headerSkins.css:987-988). 8% white over #ffffff is #ffffff, so it is pure white text on pure white. The identical bug exists in the session tree: ProjectSidebar.jsx:597 `background: "rgba(255,255,255,0.06)"` and :599 `color: "#fff"`, rendered on `--phn-surface-alt-bg: #ffffff` (headerSkins.css:973). Both files already import correct tokens for this , ProjectSidebar declares `FG = "var(--phn-text-fg, #CCCCCC)"` at line 10 and uses `ACCENT` for the input's own border on the very next line (:598) , so the `#fff` is an oversight, not a deliberate override.

**Failure.** Under the Light skin, double-click a tab to rename it. The blue focus border appears, the caret blinks, and the existing label plus everything you type is invisible (white on white). You cannot see what you are about to commit; pressing Enter renames the tab to whatever you typed blind, and Escape is the only safe exit. Same on double-clicking a session row in the tree.

**Fix.** Replace both with tokens: `color: "var(--phn-text-active, #fff)"` and `background: "var(--phn-hover-bg, rgba(255,255,255,0.08))"` , `--phn-hover-bg` is already defined as `rgba(0,0,0,0.07)` for moba-light (headerSkins.css:983) and exists in every other skin, so it flips direction correctly. Also drop `outline: "none"` or pair it with a visible `:focus` treatment.

### HIGH A11Y-04, Phone-pairing link and access token render near-black on near-black in Light mode , the token cannot be read off the screen

`src/features/terminals/RemoteControlModal.jsx:34`

**What.** The `Field` helper's value box hardcodes `background: "#0e1114"` (line 34) and sets no `color`, so it inherits the modal body's. `.phn-modal` sets `color: var(--phn-text-fg, #C9CDD4)` (headerSkins.css:184), and moba-light defines `--phn-text-fg: #2a2a2a` (headerSkins.css:975). #2a2a2a on #0e1114 is roughly 1.3:1. Meanwhile `.phn-modal` background is `var(--phn-elevated-bg)`, which resolves through `:root`'s `--phn-elevated-bg: var(--phn-surface-bg, #181818)` (headerSkins.css:54) to moba-light's `#ececec` , so the dialog around it is correctly light, and only these two boxes are dark. `Field` is used exactly twice, at lines 93 and 94, for `label="Link"` (the companion URL) and `label="Access token"`. The adjacent Copy button has the same problem inverted: line 36 hardcodes `background: "#23272d"` with `color: var(--phn-text-fg, #cfd6dd)` = #2a2a2a under light.

**Failure.** Under the Light skin, open Tools → Remote control (phone) and start the server. The dialog is light grey, but the two boxes holding the pairing URL and the bearer token are near-black rectangles with near-black text inside , unreadable. Since the whole purpose of the screen is to read the URL and token to type or check them against the phone, the feature is unusable without falling back to the Copy button and pasting somewhere else, or toggling to dark mode. The 'Copy' button labels are unreadable too, so even that fallback is guesswork.

**Fix.** Swap the two hardcoded fills for tokens that already exist and already invert per skin: `background: "var(--phn-page-bg, #0e1114)"` for the value box (moba-light: #d9d9d9) and `background: "var(--phn-surface-bg, #23272d)"` for the Copy button (moba-light: #ececec). Both keep the current dark appearance under moba/oled.

### HIGH A11Y-05, No keyboard path exists to switch tabs within a panel , the tab strip is mouse-only and the action is not even remappable

`src/features/terminals/keybindings.js:24`

**What.** `KEY_ACTIONS` (keybindings.js:16-48) is the complete registry the Settings → Keybindings UI remaps from. Its "Tabs" category has exactly three entries: `newTab` (Ctrl+Shift+T, :24), `closeTab` (Ctrl+Shift+W, :25), `reopenTab` (Ctrl+Shift+Z, :26). There is no next-tab / previous-tab / tab-by-index action. Ctrl+1..8 (:40-47) is `switchPanel`, which changes `activePanelId` , a different axis; each panel keeps its own tab strip. I then grepped every caller of `switchTab`: TerminalPanel.jsx:509 (`onClick` on the tab div) and TerminalsTab.jsx:1141 (`onFocusTab` from the AgentDashboard, also a click). usePaletteCommands.jsx has 30+ entries and none of them switch tabs , its only per-item generator is `state.panels.map(...)` → "Switch to panel N" (:135-142). The tab elements themselves are `<div className="moba-tab" onMouseDown onClick onDoubleClick onContextMenu>` (TerminalPanel.jsx:504-513) with no tabIndex, no role and no key handler, and the close affordance is a `<span onClick>` (:568-576). Because the action does not exist in `KEY_ACTIONS`, a user cannot even add the binding themselves in Settings.

**Failure.** Press Ctrl+Shift+T four times to open five tabs in a panel. You are now on tab 5. There is no keystroke, menu item or palette command that returns you to tab 1: the tab strip cannot take focus, Ctrl+1..8 moves between panels rather than tabs, and Settings → Keybindings offers no action to bind. The only non-mouse route back is Ctrl+Shift+W four times, which kills four live PTY sessions to get there.

**Fix.** Add `nextTab` / `prevTab` (Ctrl+Tab / Ctrl+Shift+Tab, or Ctrl+PageDown/PageUp to avoid fighting the terminal) and optionally `tab1..tab9` to `KEY_ACTIONS`, wired to the existing `switchTab` in the shortcuts ref. Separately, give the tab strip proper semantics , `role="tablist"` on `.moba-tabstrip`, `role="tab"` + `aria-selected` + roving `tabIndex` on each `.moba-tab`, with Left/Right arrow handling , so it is navigable as well as reachable.

### MEDIUM A11Y-06, Command palette arrow-key highlight never scrolls into view; past ~5 items the selection leaves the viewport and Enter runs an unseen command

`src/components/CommandPalette.jsx:74`

**What.** The result list is `<div style={{ marginTop: 14, maxHeight: 360, overflowY: "auto" }}>` (line 66) and each row is a plain `<div key={cmd.id} onClick=... >` (line 74) with no ref and no `data-idx`. `onKey` (lines 38-53) only calls `setHighlight`; there is no `scrollIntoView` anywhere in the file , I grepped the whole of `src/` for `scrollIntoView` and it appears in exactly two places, HistorySearch.jsx:36 and tour/TourOverlay.jsx:60. HistorySearch does precisely the right thing for the same interaction pattern: `listRef.current?.querySelector(\`[data-idx="${cur}"]\`)?.scrollIntoView({ block: "nearest" })`. So the palette is the outlier, not the convention. Each row is ~62-68px tall (10px padding top and bottom, a 12px label, a 10px hint, 4px margin), so roughly 5 rows fit in the 360px box, while `usePaletteCommands` returns ~33 base commands plus one per panel.

**Failure.** Press Ctrl+K, type nothing, and hold ArrowDown. The highlight moves to row 6 and disappears below the fold; the list does not scroll, so the visible rows all look unselected and the palette appears frozen. Continue pressing and Enter fires whatever invisible row the counter landed on , with the default ordering that includes things like 'Reset workspace' and 'Open new window' near the end. Mousing over the list while arrowing makes it worse, since `onMouseEnter` (line 76) yanks the highlight back to whatever is under the cursor.

**Fix.** Copy the HistorySearch pattern verbatim: put a `listRef` on the scroll container, add `data-idx={i}` to each row, and add `useEffect(() => { listRef.current?.querySelector(`[data-idx="${highlight}"]`)?.scrollIntoView({ block: "nearest" }); }, [highlight]);`.

### MEDIUM A11Y-07, Right-dock tab strip is three click-only <span>s; the Assistant and Monitor panels have no keyboard, menu or palette route at all

`src/features/terminals/chrome/DockTabStrip.jsx:13`

**What.** The three dock tabs render as `<span className={...} onClick={() => setDockTab(t.id)} title={t.label}>` (DockTabStrip.jsx:13-22) , no tabIndex, no role, no key handler; `.moba-rd-tab` (headerSkins.css:136-141) only sets `cursor: pointer`. The collapse control beside them is a real `<button>` (:23), which makes the omission look accidental. I grepped every `setDockTab` call site in `src/`: this line, `focusFilesDock` in useSftpDock.js:74 (which hardcodes `"files"`), the tour's `prep` hooks in tourSteps.js:117/124/131, and the useState declaration. So `"files"` is reachable without a mouse , via the F4 key in FKeyBar.jsx:26, the palette's `files` command (usePaletteCommands.jsx:70) and MenuBar's 'Files (SFTP)' entry, all of which funnel into `selectRibbon("files")` → `focusFilesDock()` (TerminalsTab.jsx:728). Nothing anywhere reaches `"assistant"` or `"monitor"`. Note these are distinct features from the menu-reachable modals: `dockTab === "assistant"` renders `<DockAssistant>`, the persistent chat (TerminalsTab.jsx:1224), not the Ask-AI or Agent-Mode dialogs, and `dockTab === "monitor"` renders `<DockMonitor>` (:1226), the only consumer of `useSystemStats` (:385).

**Failure.** A keyboard-only user can Tab through the menu bar, the toolbar, the F-key bar and the dock's collapse button, but never onto the SFTP / Assistant / Monitor tabs. Since the dock defaults to `"files"` (TerminalsTab.jsx:116) and no keybinding, menu item or Ctrl+K command sets the other two, the AI Assistant chat panel and the CPU/MEM/DISK monitor are unreachable for the entire session without a mouse.

**Fix.** Change the three `<span>`s to `<button type="button">` (the `.moba-rd-tab` rule needs `background:none;border:0;font:inherit` added) and give the strip `role="tablist"` with `role="tab"` + `aria-selected` on each. Then add 'AI Assistant panel' and 'System monitor panel' commands to usePaletteCommands.jsx calling `setDockTab`, matching the existing `files` entry.

### MEDIUM A11Y-08, Quick-connect input kills its outline and has no focus style , the intended :focus rule targets a class no JSX uses

`src/features/terminals/terminals.css:572`

**What.** `.moba-qc-inline input { flex: 1; background: transparent; border: none; outline: none; min-width: 0; ... }` (terminals.css:572-575). There is no `.moba-qc-inline input:focus` and no `.moba-qc-inline:focus-within` rule anywhere in the file. The rule that was clearly meant to cover it, `.moba-qc-input:focus { border-color: var(--phn-link, #7c9cf5); }` (terminals.css:368), targets a different class: I grepped `moba-qc` across all `.jsx`/`.js` in `src/` and the only markup hit is `<div className="moba-qc-inline">` in chrome/Toolbar.jsx:59 , `.moba-qc-input` and `.moba-qc-icon` (terminals.css:353-368) are dead CSS left over from a rename. The wrapper's border is static (`.moba-qc-inline` :565-571) and never changes on focus. This is the only free-text input in the always-visible toolbar, and its Enter handler opens an SSH connection: `onKeyDown={(e) => { if (e.key === "Enter") { quickConnect(e.currentTarget.value); ... } }}` (Toolbar.jsx:64).

**Failure.** Tab forward from the toolbar buttons. Focus lands in the quick-connect field with zero visual change , no outline (suppressed), no border change (rule is on a dead class), no background change. The user has no way to tell whether keystrokes are going to the terminal or to this box; typing a shell command here and pressing Enter fires `quickConnect(...)` and attempts an SSH connection to the typed string instead of running the command.

**Fix.** Add `.moba-qc-inline:focus-within { border-color: var(--phn-link, #7c9cf5); box-shadow: var(--phn-ring); }` and delete the orphaned `.moba-qc-icon` / `.moba-qc-input` block at terminals.css:353-368 so the next person does not edit the dead rule again. Note the global fallback at styles.css:38-41 only covers `button`, not inputs, so nothing else catches this.

### MEDIUM A11Y-09, Session-tree row hover feedback is 4% white over a #ffffff sidebar , zero hover response in Light mode, and the correct token already exists

`src/features/terminals/ProjectSidebar.jsx:562`

**What.** The only hover affordance on a session row is `background: isHover ? "rgba(255,255,255,0.04)" : "transparent"` (ProjectSidebar.jsx:562), driven by the `onMouseEnter`/`onMouseLeave` pair at :551-552. The sidebar it sits in is `.phn-sidebar { background: var(--phn-surface-alt-bg, #0d0d0d) }` (headerSkins.css:153), and moba-light sets `--phn-surface-alt-bg: #ffffff` (headerSkins.css:973). 4% white composited over #ffffff is #ffffff , a mathematically zero-delta hover. The row is also a `<div onMouseDown>` with no `:hover` CSS class to fall back on. The right token is already defined for exactly this: moba-light declares `--phn-hover-bg: rgba(0,0,0,0.07)` (headerSkins.css:983), and every other skin declares its own (`:root` :62, moba :923).

**Failure.** Under the Light skin, move the mouse down the Sessions tree. Nothing highlights , no row ever indicates it is under the cursor. With a dozen saved SSH hosts at 23px row height there is no feedback about which one a click will open, so mis-clicks open the wrong host and start a real connection. Under the dark skins the same code produces a visible lift, so the bug is invisible to anyone testing in dark mode.

**Fix.** `background: isHover ? "var(--phn-hover-bg, rgba(255,255,255,0.04))" : "transparent"`. The token already inverts per skin, so this is a one-line change with no dark-mode delta.

### MEDIUM A11Y-10, Every connect-modal form field is visually labelled but programmatically unlabelled , 25 <label> elements with no htmlFor and no wrapped input

`src/features/terminals/RdpConnectModal.jsx:65`

**What.** `<label style={label}>Host</label>` followed by a sibling `<input ref={hostRef} style={field} ... />` (RdpConnectModal.jsx:65-66). The label neither carries `htmlFor` nor wraps the input, and the input has no `id`, `aria-label` or `aria-labelledby` , so the two are related only by visual proximity. The same construction repeats through the whole connect surface: RdpConnectModal.jsx:65, 69, 75, 79, 84 (Host, Port, Username, Domain, Password), VncConnectModal.jsx:55, 59, 64, SerialModal.jsx:57, 67, TunnelsModal.jsx:65, 70, 74, 109, 138, and ProjectDialog.jsx:323, 355, 365, 389, 401, 430, 445, 459, 479, 515 , 25 sites, all confirmed by eslint's `jsx-a11y/label-has-associated-control` and by reading the RDP and project-dialog markup. The app does know how to do this correctly elsewhere: Modal.jsx:91 sets `aria-label` on the dialog and :98 sets `aria-label="Close dialog"` on the close button.

**Failure.** A screen-reader user opening Sessions → RDP remote desktop hears five unlabelled 'edit' fields in a row , 'edit, blank' for Host, Port, Username and Domain, and 'protected edit' for Password , with no way to tell which is which; the visible captions are never announced because nothing associates them. Sighted users hit the smaller version: clicking the word 'Host' does not focus the Host field, which is the standard behaviour everywhere else in Windows.

**Fix.** Give each input an `id` and each label a matching `htmlFor` (or wrap: `<label style={label}>Host<input .../></label>`, which needs no ids). Mechanical across all 25 sites; eslint.json already enumerates the exact file:line list to work from.

### LOW A11Y-11, Colour-swatch selection ring is a hardcoded 2px solid #fff on a light context menu , you cannot see which tab or session colour is applied

`src/features/terminals/TerminalPanel.jsx:842`

**What.** In the tab context menu the selected swatch is marked by `border: c ? (tab.color === c ? "2px solid #fff" : "1px solid rgba(255,255,255,0.25)") : "1px solid #777"` (TerminalPanel.jsx:842-843). The menu it sits in is `background: "var(--phn-surface-bg, #2d2d2d)"` (:823), which under moba-light is `#ececec` (headerSkins.css:972) , a white ring on #ececec is about 1.06:1. The unselected ring, `rgba(255,255,255,0.25)`, is likewise invisible over #ececec. ProjectSidebar.jsx:849 has the identical construction for the session colour picker (`border: project.color === c.id ? \`2px solid #fff\` : \`1px solid ${BORDER}\``) , and note the unselected branch there already uses the `BORDER` token from :14, so only the selected branch was missed.

**Failure.** Under the Light skin, right-click a tab (or a session row) and open the colour row. The eight coloured dots render, but the ring marking the currently-applied colour does not, so there is no way to tell which colour the tab already has or whether a click registered. Under dark skins the ring is clearly visible, so this reads as 'the colour did not apply' rather than as a theme bug.

**Fix.** Use `2px solid var(--phn-text-active, #fff)` for the selected ring and `1px solid var(--phn-surface-border, rgba(255,255,255,0.25))` for the rest; both tokens already invert correctly per skin (moba-light: #000000 and #bdbdbd).

