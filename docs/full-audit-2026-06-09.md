<!-- (C) Claude-authored full-app audit, 2026-06-09 -->
# Pluto's Terminals — Full Audit (2026-06-09)

**Scope:** branch `001-remote-sessions-parity` @ `7dc8270`, v0.3.6 (local copy — 218 commits ahead of public GitHub; confirmed the most up-to-date code). Read-only audit: frontend (~17,900 LOC src/), backend (5,462 LOC src-tauri/src/), UX/visual. Deduplicated against `docs/security-audit-2026-06-08.md` — already-closed items are not re-reported.

**Verdict in one paragraph:** the app is architecturally sound and far more mature than v0 — the worker-thread session model in Rust is genuinely well designed, scrollback persistence (v0.1.29–32) is now correct, memoization and the split-pane-never-remounts design are clever, and the recent security pass closed the right things. What's holding it back is (a) one real functional bug (#1 below), (b) a class of UI-freeze issues from sync Tauri commands, (c) two surviving god-files that make every change risky, and (d) a visual layer that mixes two accent systems, three icon languages, and five button styles — which is exactly why it feels unpolished even though the layout is right.

---

## Priority 1 — fix before anything else

| # | Finding | Where | Why it matters |
|---|---------|-------|----------------|
| 1 | **CRITICAL — Spawned shells lose API keys after keychain migration.** `TerminalPane.jsx:787` reads the raw localStorage blob for `providerKeys`/`anthropicKey`, but `App.jsx:56–66` strips those keys from that blob once keychain mirroring is confirmed (true on every healthy system). Every other consumer uses `readUserSt()` which overlays the keychain cache; this one spawn path doesn't. | `src/features/terminals/TerminalPane.jsx:787` | `ANTHROPIC_API_KEY` injection silently produces nothing for new tabs. One-line fix: use `readUserSt()` from `storageKeys.js`. |
| 2 | **HIGH — Sync commands freeze the UI.** Nearly all blocking commands are sync `#[tauri::command]` and run on the main thread: `ssh_spawn` (30s timeout), all `sftp_*` transfers (blocks for the whole file), `vnc_connect`, `rdp_connect`, `net_ping`/`net_traceroute`, `git_diff`, `mcp_install`, even `pty_write`. A slow SSH host = 30-second dead app; a 1GB SFTP download = frozen window. | `src-tauri/src/pty.rs:791`, `sftp.rs:295`, `vncclient.rs:106`, `rdp.rs:113` | Mark them `async` (keep `rfd` dialog commands main-thread for macOS). Highest-leverage perceived-quality fix in the backend. |
| 3 | **HIGH — Secondary windows have no IPC capability.** `capabilities/default.json` declares `"windows": ["main"]` but `spawn_new_window` creates `win-<id>` windows. Either multi-window terminals get no PTY events, or the capability isn't enforcing what you think. | `src-tauri/capabilities/default.json`, `commands.rs:333` | Add `"win-*"` to the windows list. |
| 4 | **HIGH — Lost-update race on whole-blob `save()`.** Any `save({ ...st, x })` after an `await` resurrects stale state. Concrete instance: setup-checker effect (`TerminalsTab.jsx:258–281`) clobbers the `mobaDefaultForced` migration. Only 2 of ~20 mutations in `useWorkspaceTree` use the safe `stateRef` pattern. | `src/features/terminals/TerminalsTab.jsx:258`, `hooks/useWorkspaceTree.js:31` | Make `save` accept a functional updater, or route all mutations through `stateRef`. |
| 5 | **HIGH — Tauri listener leak on fast unmount.** `await listen('pty://…')` in TerminalPane registers after cleanup if the pane unmounts mid-await; the leaked closure pins a disposed xterm (up to 10k lines of buffer). Fires on every dev mount under StrictMode; in prod on tab close/move/split churn. Same bug in `VncView.jsx:47–87` / `RdpView.jsx:43–75`, where leaked frame handlers keep decoding into detached canvases. | `TerminalPane.jsx:913,951,1320` | The codebase already has the correct cancelled-flag pattern at `TerminalsTab.jsx:470–478` — apply it. |

## Priority 2 — stability & correctness

6. **RDP accepts any TLS certificate** (`rdp.rs:138–141` — `danger_accept_invalid_certs(true)`). SSH got TOFU pinning; RDP got nothing. Mirror `verify_host_key` with a persisted SPKI fingerprint.
7. **VNC worker trusts server-supplied PixelFormat and has no socket timeouts** (`vncclient.rs:82–95, 114`). Malformed shifts wrap silently in release; a stalling server hangs the handshake forever (on the main thread, per #2). Validate at connect + set timeouts.
8. **Exited local PTYs leak registry entries and zombie children** (`pty.rs:456` emits exit but never removes the session; `kill()` never followed by `wait()`). Remove on reader-thread EOF + reap.
9. **Unbounded SSH write buffering** (`pty.rs:488–490, 874`) — wedged server + broadcast/paste loop grows memory indefinitely. Add a high-water mark.
10. **Multibyte UTF-8 split at chunk boundaries** corrupts output *and* persisted scrollback with U+FFFD (`pty.rs:444, 922, 1006`; same in `llm.rs:192`). Carry incomplete trailing bytes across reads.
11. **`store.json` written non-atomically** (`commands.rs:78`) — crash mid-write corrupts the whole persisted layout. The scrollback path already does tmp+rename; copy it.
12. **Duplicating/reopening a password-auth SSH tab produces a dead session** — the transient password is keyed to the old tabId (`useWorkspaceTree.js:193–202`; `TerminalPane.jsx:842–846`). Copy the password in `duplicateTab`; fall back to keychain on reopen.
13. **xterm block decorations accumulate without bound** (`TerminalPane.jsx:618` — pushed, never disposed). Dispose on evict when `blocksRef` caps at 200.
14. **Companion server gaps:** dispatch runs blocking I/O (10MB scrollback reads) on the tokio runtime with no `spawn_blocking`; `subscribe` has no dedup/cap (amplification); `stop()` leaves `tailscale serve` configured and push subscriptions in the keychain (`companion.rs:116–128, 323, 341–355, 580–586`).
15. **Factory reset doesn't wipe all state** — leaves cmd history, macros, dock prefs, dismissed-update flags, and on-disk scrollback/transcripts (`SettingsModal.jsx:37–53`). Centralize key prefixes in `storageKeys.js` and iterate.
16. **No signed updater channel** (audit HIGH #3, still open) — no `tauri-plugin-updater`, no signing key wired into the bundle. The UpdateBanner just links to GitHub.
17. **Spawn effect depends only on `[cwd]`** (`TerminalPane.jsx:1328`) — connection/serial changes are silently ignored; the "remount via key" contract is enforced nowhere. Key `TerminalPane` on composed session identity.
18. **Windows path bugs:** SSH `Include` glob splits on `/` only (`sshconfig.rs:69` → scans CWD); root-disk stat matches `"/"` only (`sysstats.rs:63` → status bar reports an arbitrary disk).
19. **Render-phase side effects** — `bindingsRef.current = setResolved(...)` mutates a shared module cache during render (`TerminalsTab.jsx:638–660`); unsafe under StrictMode/concurrent. Move to effects.
20. **`ssh_key_generate` passes the passphrase on the command line** (`sshconfig.rs:274–275`) — visible to any local process via argv. Set it via stdin (`ssh-keygen -p`) or an in-process generator.
21. **Auto-approve types "1" based on regex over terminal output** (`TerminalPane.jsx:366–399`). Gates are thoughtful but it's still pattern-matching attacker-influenceable bytes. Harden via an OSC-tagged marker; log every auto-approval.
22. **`llm_complete` parses JSON before checking HTTP status** (`llm.rs:50, 95`) — gateway 502s surface as "error decoding response body". The streaming path does it right; mirror it.
23. **`recent_files` corrupts paths from `git status --porcelain`** (`commands.rs:659–663` — trim-then-slice eats the first filename char for unstaged entries; renames unhandled).

## Priority 3 — architecture & maintainability

24. **`TerminalPane.jsx` (1,624 lines)** — a single ~860-line effect contains xterm setup, OSC parsing, scrollback replay, env resolution, 4 spawn transports, and ~220 lines of welcome-banner string building. Extract `welcomeBanner.js`, `shellIntegration.js`, `spawnEnv.js`, `useCommandBlocks`.
25. **`TerminalsTab.jsx` (1,345 lines, 44 hooks)** renders all chrome + 27 always-mounted modals, and rebuilds the ~40-item palette array and menus on every render — including renders from per-token cost telemetry and the 2.5s sysstats poll. Split into `AppChrome` / `WorkspaceGrid` / `ModalsHost`; memo the arrays; wrap `ProjectSidebar` (890 lines, unmemoized) in `memo`.
26. **Telemetry re-renders the whole tab during agent streaming** (`useTabTelemetry.js:22–28, 66–85`). Throttle cost emission to ~1Hz or move telemetry to `useSyncExternalStore` read only by the status bar/dashboard.
27. **`ptyBridge` is an invisible second state manager** with a single overloaded change pulse (`emitDims` fires for non-dims changes). Wrap in `useSyncExternalStore` with separate channels; the singleton itself is fine.
28. **70+ IPC commands behind one coarse capability** — the webview is the de-facto privilege boundary, mitigated mainly by a CSP that still allows `'unsafe-eval'`. Tighten when convenient.
29. **`moveTab` kills + respawns the PTY** (documented in `useWorkspaceTree.js:250–254`) — the known parity gap vs Warp/MobaXterm. The fix needs a PTY registry outside React; `ptyBridge` is 80% of the way there.
30. Smaller items: unused imports (`TerminalsTab.jsx:69–71`, `App.jsx:17,20`); `?w=` parsing duplicated 7× (export `isPrimaryWindow()` from `storageKeys.js`); double ANSI-strip per chunk on the hottest path; `.catch` missing on two `listen()` chains; pervasive `onMouseEnter` inline-style mutation instead of CSS (see UX #6); hidden panes keep full 10k-line buffers forever (~16MB/pane).

## UX / visual polish — why it doesn't feel finished

The layout is right. These are the systemic reasons the *look* reads unpolished:

1. **Two clashing accent systems.** The moba theme accent is blood-orange `#E04A1F`, but the CSS fallbacks and many inline styles still hard-code the mockup-12 steel blue `#4D8FE0`/`#4DAAFC` (tab underlines, pane outlines, focus rings, divider hover, palette highlight). Orange hovers next to blue underlines is the single clearest "unfinished" tell. Stragglers also include mint `#5fd7a7` menu fallback and magenta `#FF0080` in Toast errors + status-bar Discord link.
2. **Three icon languages at once:** multicolor filled SVGs (`icons.jsx`), monochrome stroke icons (`toolbarIcons.jsx`), and raw emoji (home cards, palette, sidebar platform glyphs, status bar). Pick the stroke set; reserve color for state.
3. **8px chrome typography** (toolbar labels, group captions) is below the legibility floor and below the smallest defined type token (10px). The token system exists; the moba chrome bypasses it.
4. **Rainbow per-icon tinting** — 8 hard-coded hues across 11 toolbar buttons means color encodes identity, not meaning, so nothing stands out.
5. **Border overload, no elevation logic** — every region fenced by 1px `#242424`; shadow tokens defined but used only on modals; 4px black gutter mat around the terminal grid.
6. **Hover/focus done via JS inline-style mutation; keyboard focus effectively invisible** — no `:focus-visible` path on most chrome; global focus rule fights the theme's focus ring.
7. **Five parallel button idioms** — `ui.jsx` primitives exist but CommandPalette, LockScreen, Welcome, ProjectSidebar, and Toast each roll their own.
8. **Mono/sans font voice flips between adjacent surfaces** — toasts, context menus, palette input, fnbar pin JetBrains Mono inside a sans chrome.
9. **Menu hover is a full accent fill** (bright orange flash); three different dropdown shapes for one pattern.
10. **Duplicate entry points**: quick-connect ×4, cost ×2, model ×2; "Workflows"/"Snippets"/"Workflows panel" name the same thing; "Agent" vs "Agents" adjacent in the toolbar with the same icon.
11. **Thin empty/loading states** — raw error strings in SFTP, italic "thinking…", no quick-connect feedback, bare tree when no sessions.
12. **Contrast failures** — `--phn-text-faint #586068` (~2.9:1) used for real content; sub-9px captions; menus/tabs not keyboard-navigable.
13. **Leftover flair fighting the workstation tone** — rainbow conic focus ring, tab-shake animation, a Welcome screen with its own separate aesthetic.
14. **Active tab never visually merges with the terminal** (tab `#16181C` vs terminal `#000`), so it reads as a third grey instead of a connected surface.
15. **Tab overflow has no affordance** — hidden scrollbar, wheel-only, no fade/arrows.

**Redesign note:** the 12 existing mockups all explored dark mono/industrial/native single-accent variants. Unexplored territory: consolidated chrome (merge menubar/toolbar rows), real elevation/shadow systems, accent-on-state-only schemes, glass/translucency, and a strong branded identity. The four new mockups (`design-mockups/13–16`) target exactly that space.

## What's notably good (keep doing this)

The worker-thread-per-transport backend idiom with mpsc channels and drop-to-teardown; the `pty_ready` handshake; scrollback persistence v3 (reader-thread-owned, atomic truncation); `TerminalPanel` memoization and the flat %-positioned split tree that never remounts a live PTY; consistently careful secrets handling (keychain, transient password maps, hasKey-only mirrors) — which is exactly why finding #1, the one path that bypasses it, matters; disciplined invariant comments; the recent hook extraction direction.

## Suggested order of attack

1. Finding #1 (one line, real functional bug) → #3 (capability) → #5 (listener leaks) — small, surgical.
2. Async-ify the blocking commands (#2) — biggest perceived-quality win.
3. The visual reskin (pick a mockup) — fixes UX #1–#9 wholesale, because the reskin should *delete* the fallback blues, emoji, and per-icon tints rather than patch them.
4. `save()` functional-updater refactor (#4) + telemetry throttle (#26).
5. God-file decomposition (#24/#25) — do it *after* the reskin so you're not splitting files you're about to restyle.
6. Backend P2 batch (#6–#11, #14) as a single hardening pass.
