<!-- (C) -->
# Full audit — plutos-terminals @ 8c40c62 (2026-08-14)

Six-dimension parallel audit (frontend correctness, Rust backend/IPC, security, performance, resilience, forward-risk), each an independent adversarial reviewer over the whole repo. Six load-bearing CRITICAL/HIGH findings were then re-verified by reading the cited code directly — all six confirmed real, zero false positives, which raises confidence in the unverified remainder.

Overall: this is a heavily self-audited, mature codebase. The core session/PTY/scrollback/notebook machinery survived every reviewer. The debt clusters in the surfaces prior review had not reached, and in two fast-growing files (TerminalPane.jsx +42% in 10 weeks, commands.rs 3x). Nothing here is exploitable-RCE or a live crash-on-normal-path. The real exposure is silent data loss, one availability wedge, and render cost under multi-agent load.

Legend: [VERIFIED] = re-read and confirmed in code during this audit. Others carry the source auditor's file:line and rationale.

---

## CRITICAL — fix before next release

### C1. Disk-stat mutex has no timeout; a stalled drive wedges every window's status bar + leaks threads [VERIFIED]
`src-tauri/src/sysstats.rs:76-103`. `DISKS.lock()` is a blocking lock; `disks.refresh(true)` (:79) has no timeout, and the only single-flight guard is client-side per-window (`independentEffects.js` inFlight bool). A disconnected network share, sleeping external drive, or locked BitLocker/VeraCrypt volume — likely on this app's power-user audience — hangs `refresh()` forever. The first poller holds the lock for the process's life; every other window's poller and the phone companion's `system_stats` RPC block on `.lock()` and never resolve or reject (so `.catch()` never fires, inFlight never resets → status bar frozen forever, no error surfaced). Each new poller leaks one blocking-pool thread. No recovery but kill.
Fix: `spawn_blocking` + `tokio::time::timeout` around `refresh(true)` (mirror the bounded-TCP pattern in `pty.rs::connect_session`), or `try_lock()` returning "unavailable" instead of blocking.

### C2. Workspace/session-tree state lives in one localStorage blob with no durable backup; corruption silently resets to empty [VERIFIED]
`src/App.jsx:92-122`. `JSON.parse(localStorage...)` falls back to `{}` on any parse failure — no toast, no log. The Rust durable store (`commands.rs:63-86` `read_store`/`write_store`, correctly atomic) is registered but has **zero frontend callers** (only a comment references it). Entire tab/panel/session-tree layout exists in one WebView2-LevelDB profile with no independent copy. WebView2 profile corruption after an unclean shutdown → app opens brand-new/empty, no warning, no recovery.
Fix: mirror the per-window blob through `write_store` on flush; on a parse failure of a non-empty raw string, surface a toast + offer the Rust backup before defaulting to `{}`.

### C3. SFTP upload/download truncate the destination before streaming; a dropped transfer can destroy the original remote file [VERIFIED]
`src-tauri/src/sftp.rs:110-127` (`do_download`, `fs::File::create` truncates local) and `:173-190` (`do_upload`, `sftp.create` truncates remote). Neither uses tmp+rename. The sibling `do_write_text` (:146-171) sits between them with the atomic pattern AND a comment explaining this exact hazard — the fix was never applied to the two transfer paths. A dropped SSH connection mid-upload over an existing remote file (config, service file) truncates the ORIGINAL on open → a failed upload destroys content that existed before the user tried to update it. Download leaves a silently truncated local file.
Fix: apply the `do_write_text` tmp+rename to both; delete the partial local file on download error, never touch the remote path until fully staged.

### C4. RemoteEditor discards unsaved SSH edits on Escape/backdrop/X — no dirty guard [VERIFIED PATTERN]
`src/features/terminals/RemoteEditor.jsx` (whole file) has no autosave, no unmount flush, no dirty check; `Modal.jsx` Escape/backdrop/✕ all call `onClose()` unconditionally, and `SftpBrowser.jsx:307` wires it to `setEditTarget(null)`. Sibling `NotebookView.jsx` (same author) has 2s autosave + unmount flush + dirty warning; `SftpBrowser` itself uses `useConfirm` for delete. Edit a remote file, hit Escape instead of Ctrl+S → every unsaved edit gone, no warning — for a feature whose whole purpose is editing files on someone else's machine.
Fix: gate `onClose` behind `useConfirm` when dirty (the pattern already exists in the same file).

### C5. Session recording is 100% in-memory and self-deletes before the save dialog resolves
`src/features/terminals/recording.js:16,45-52`. Up to 100k events live only in a renderer JS Map; no incremental disk write. `stopRecording()` deletes the Map entry, THEN `TerminalsTab.jsx:792-815` awaits the native Save-As. Crash/force-kill/dialog-cancel/save-failure anywhere before the dialog resolves → entire (possibly hours-long) capture unrecoverable, no partial `.cast` on disk.
Fix: checkpoint `rec.events` to a temp file every N events/seconds; recover a stale temp on next launch.

---

## HIGH

### H1. OSC 1337 command reports are trusted from any stream (incl. remote SSH output), persisted to cross-session history, replayed on one click [VERIFIED]
`TerminalPane.jsx:1043-1069`. The OSC 1337 `PlutoCmd=<base64>` handler is registered per tab on every transport. `restoringScrollback` gates replay but there is NO gate for a live remote stream. A malicious/compromised SSH host (or a `cat`'d/`curl`'d file) emits a hidden `PlutoCmd` payload; the screen shows only ordinary text, but `recordCommand()` writes the attacker's string into persistent cross-session history with no source tag, and tags the block for "Re-run command". Later the user runs it from history search → executes on whatever tab is focused then, possibly a different local/elevated shell.
Fix: stamp the app's own preexec hook with a per-session rotating nonce alongside `PlutoCmd`; reject/flag any OSC 1337 report without a matching recent nonce.

### H2. Notebook + store cross-window/process write race reopens the 2026-08-03 fix [VERIFIED]
`notebookIo.js:67-91` (`inflightWrites` Map is module-scoped to one JS context); `commands.rs:2164-2189` (`notebook_write_sync` uses a deterministic `<name>.md.tmp`, no per-path lock); `write_store` (`commands.rs:75-86`) same fixed `store.json.tmp`. Two windows (detach-to-window is supported) or two launched instances (single-instance guard absent) editing the same notebook race the same tmp path; last `rename` wins, silently reverting the other's edits — the exact class the 8/03 single-process fix closed, reopened at the window/process boundary. Blast radius of the missing single-instance guard.
Fix: OS-level advisory lock / lock-file keyed by target path in the Rust write commands, independent of the JS queue.

### H3. One ErrorBoundary; a single pane's render crash tears down every live session in the window
`App.jsx:82-84` is the only boundary; `componentDidCatch` calls `destroyAll()` → kills every PTY/SSH/serial/RDP/VNC in the window. A render bug in one pane (bad Monaco diff, malformed AI-stream chunk, theme CSS edge case) drops all OTHER healthy panes' live work — active SSH sessions, in-flight SFTP transfers, serial connections.
Fix: wrap the fragile render surfaces (Monaco editors, VncView canvas, custom-theme CSS) in per-pane boundaries that destroy only that pane; reserve `destroyAll()` for unattributable faults.

### H4. Agent Mode's approval promise never settles; closing the modal doesn't stop the loop
`AgentMode.jsx:140-164` — `requestApproval` returns a promise with no reject/timeout; `ModalHost.jsx:196` `onClose` hides the always-mounted modal without touching `stopRef`/`approveRef`/`running`. Escape while a tool call is pending → auto-run MCP tools can keep firing invisibly; approval-gated calls hang forever on a promise only reopening the modal can resolve (and it may present a stale, context-detached request). Undermines "shell commands always require visible approval."
Fix: wire `onClose` to the Stop path (`stopRef=true; resolveApproval("stop")`); add a status-bar "agent running" indicator so a closed-modal agent stays visible.

### H5. Tofu-glyph fix regresses on tab-move — gated on `alive`, not registry liveness [VERIFIED] [tonight's work]
`TerminalPane.jsx:1141-1150`. The `clearTextureAtlas()` rebuild (tonight's tofu fix) is gated on the per-mount `alive` flag and only registered on first mount. Drag a tab to another panel before `document.fonts.ready` resolves (real on cold start / first launch) → first fiber's `alive=false`, the re-attached fiber never re-registers the handler → that pane keeps tofu glyphs permanently (nothing else calls `clearTextureAtlas`). Straight regression of the bug shipped-fixed today.
Fix: gate on `entryLive()` (as every other create-once callback in the file does), or hoist the `fonts.ready` subscription to key off `entry`, not the fiber.

### H6. `ssh_key_generate` is a synchronous command that freezes the whole UI during keygen [VERIFIED against pinned Tauri source]
`sshconfig.rs:286-354`. A non-`async` `#[tauri::command]` runs inline on the UI event-loop thread; `cmd.output()` blocks on `ssh-keygen` (RSA-4096 offered) → the entire window (all tabs/panes/keystrokes) freezes for keygen duration, worse on entropy-starved VMs. The same blocking-off-thread discipline is applied correctly a dozen other places.
Fix: `pub async fn` + `spawn_blocking` around `Command::output()` (shape of `netools.rs::net_ping`).

### H7. All always-on chrome is unmemoized → re-render storm under agent fleet [VERIFIED]
`chrome/MenuBar|Toolbar|StatusBar|FKeyBar|DockTabStrip|ModalHost.jsx` + dock bodies are all plain functions, none `memo()` (contrast `TerminalPanel`/`ProjectSidebar` which are memo'd with stabilized props). `useTabTelemetry` commits cost 1/sec **per tab** from inside `TerminalsTab`'s body → N agent tabs = up to N whole-chrome re-renders/sec, exactly during a busy fleet. Felt as chrome sluggishness under the app's core use case.
Fix: `memo()` the chrome components (the grid already proves the pattern).

### H8. PTY sessions aren't Rust-bound to their window → orphan shells on secondary-window close
`lib.rs:226-243`, `pty.rs`. `SessionRegistry` is global, untagged by window. Secondary windows are destroyed on close; the only thing killing their PTYs is the frontend's per-tab async `pty_kill` before webview teardown. Alt+F4 / unresponsive unmount / webview destroyed before the invoke resolves → shell child + reader thread + coalescer + scrollback writer survive invisibly until full app exit.
Fix: tag sessions by owning window label; on `WindowEvent::Destroyed` for `win-*`, Rust proactively kills that window's sessions.

---

## MEDIUM

- **M1. xterm uses the DOM renderer on all platforms** (`TerminalPane.jsx:948`). WebGL was dropped for a macOS WKWebView blank-glyph bug; no canvas/webgl addon is even a dependency. Windows/Linux pay per-cell DOM updates instead of a canvas blit — the throughput ceiling for 8 panels of streaming output. Fix: per-OS gate, try `@xterm/addon-canvas` off macOS.
- **M2. Boot mounts every tab's full xterm object graph synchronously** (`TerminalPanel.jsx:603`, `trickle.js` staggers only PTY spawn). No `MAX_TABS`. Heavy restored session = main-thread block on paint, worsening with accumulated tabs. Fix: placeholder non-active tabs until trickle reveals them.
- **M3. Dock-resize drag drives per-mousemove `setDockWidth`** (`useDockResize.js:31`), unthrottled, compounding H7. Fix: buffer clientX in a ref, commit via rAF (pattern exists as `costRafRef`).
- **M4. WebLinksAddon uses its unmanaged default `window.open`** (`TerminalPane.jsx:867`), bypassing the app's hardened `open_path`. A remote host prints a phishing URL → opens outside the vetted path. Fix: `new WebLinksAddon((e,uri)=>openExternal(uri))`.
- **M5. Secret scanner misses the shapes this app actually shows** (`secretScan.js:10-18`): bare 40-char AWS secret key, `KEY=value` env dumps, base64/hex secrets (`kubectl get secret -o yaml`). UI implies full scan. `cat .env` → share → raw secret to a public gist. Fix: add a `_KEY|_SECRET|_TOKEN|_PASSWORD=value` pattern; soften copy to "known key formats".
- **M6. Trapezoid tab fill paints over the drag-reorder indicator** [tonight's work] (`terminals.css:405-431` vs `:452`). The opaque `::before/::after` fills (negative z-index children paint above the element's own box-shadow) cover the `.tab-drop-before/after` inset shadow — the only in-strip reorder cue. Fix: dedicated `z-index:2` bar element instead of box-shadow.
- **M7. SSH keychain-await panel race** (`useSessionDispatch.js`, `useSshConnect.js`). `panelId` read before the `secret_get` await, reused after — the fix `openAgentWorktree` already applies (re-read from live ref) wasn't applied here. Click a passworded session, switch panels during the keychain lookup → tab lands on the wrong panel. Fix: re-derive panelId from `stateRef.current` after the await.
- **M8. Window-title `setTitle` has no staleness guard** [tonight's work] (`independentEffects.js:85`). Fast tab-switching → out-of-order IPC resolves can leave the OS titlebar on a stale label (document.title is fine). Sibling hooks use a `cancelled` flag. Fix: same flag.
- **M9. Blocking subprocess/network in `async` command bodies** (`commands.rs` `gh_pr_create` (2 sequential net calls), `worktree_add/remove`, `git_diff`, `recent_files`, `mcp_install`; `rdp_connect`/`vnc_connect` handshakes; `net_port_scan` inline join; `share.rs` `gh auth token`). Ties up a tokio worker per call; several firing together can delay unrelated commands. Fix: `spawn_blocking` each (pattern already standard in the file).
- **M10. Multi-window `userSt` is last-write-wins** (`App.jsx:198`), full-object overwrite. Two windows changing different fields near-simultaneously → one clobbers the other. Fix: field-level merge (the `sync/merge.js` approach already exists).
- **M11. localStorage quota-exceeded is caught and downgraded to console-only** (`App.jsx:139`). Large workspace crosses quota → every further layout change silently stops persisting. Fix: one-time toast on quota error.

---

## LOW

- L1. Drag handlers (`TerminalPanel.jsx` tab/divider, `useDockResize`) add document listeners on mousedown, removed only on mouseup — no unmount cleanup; component unmount mid-drag leaks the listener + stale closure. Defensive no-op on mutate, so leak-not-crash.
- L2. Silent-reset-on-parse-failure is systemic (`macros.js:64`, `ptyBridge.js:124` history) — same root as C2, lower stakes. Fix: shared `safeParse(raw,{onCorrupt})`.
- L3. Poisoned-mutex inconsistency — `sftp/forward/rdp/vncclient/companion` registries return permanent "poisoned" until restart; `pty.rs` chose `lock_recover`. Mirror it.
- L4. `checkCost` per-frame regex scan compounds under many busy panes (already rAF-coalesced per pane; drop to 2/sec if ever needed).
- L5. `save_text_to_file` uses a single `fs::write`, no tmp+rename — inconsistent with the codebase standard (low likelihood, user-triggered).
- L6. Cloud-sync LWW resolves by `Date.now()` — a clock-skewed machine's stale writes always win. Standard LWW caveat.

---

## FORWARD-RISK (strategic — compounding cost if ignored)

1. **TerminalPane.jsx is the new god component** — 2110 lines (+42% in 10 weeks), 52 hooks, untestable as a unit. Continue the proven extraction (spawn state machine, OSC wiring) before the next pane feature; hold near 1200.
2. **The 102-command JS↔Rust IPC boundary has zero integration tests** — vitest mocks `@backend`, cargo tests units; nothing verifies the contract. Regressions in serial/tunnels/RDP/notebook hide until manual smoke. Generate a command manifest from Rust, assert JS call sites against it, add one CI boot-smoke over 5 golden flows.
3. **Unsigned binaries + link-only updater** — no `tauri-plugin-updater`; every future security fix propagates at the speed of manual re-download through SmartScreen/Gatekeeper, and can't retrofit onto installed copies. Combined with vendored OpenSSL/libssh2/libgit2 (forced-release events are a *when*). Buy certs + wire the signed updater before the next growth push.
4. **commands.rs is a 2811-line junk drawer** both machines edit — merge-conflict magnet for the two-machine flow, dilutes review of security-sensitive code (`mcp_install`) next to trivia. Split by domain at a quiet window.
5. **Linux ships every release and has never executed** — `test.yml` runs cargo Windows-only (keyring no-backend). AppImage/deb built by CI, run by nobody. Add a Linux cargo-test leg + headless AppImage boot check.
6. **`vnc 0.4` (2016, unmaintained) parses untrusted RFB server data**; `ssh2`/libssh2 maintenance-mode; `web-push` gappy. No `cargo audit`/`npm audit` in CI. Add both audit jobs this week; roadmap replacing/sandboxing `vnc` before marketing VNC.
7. **Phone companion is a second hand-written frontend frozen in the Rust binary** (vendored xterp copy, `include_str!`). Pick one future (mini-app with vendor-refresh + version pin, or the WS transport) and kill the other in writing.
8. **Theme-token discipline eroding** — 393 raw hex literals vs 467 `var(--…)` in JSX; every hardcoded hex is a queued light-mode regression (already fired once). CI grep gate banning new hex in JSX outside theme files.
9. **ptyBridge is an undocumented event bus** with ad-hoc multi-window scoping in comments only. Write the ownership/scoping contract into the header + a two-realm test fixture before the next bridge client.
10. **Provider catalog bakes fast-drifting model IDs into slow releases** (`providers.js`, 16 providers). Move to fetched-JSON-with-bundled-fallback (CSP already allows api.github.com).
11. **Shell-integration injection (zsh/bash/pwsh only) is load-bearing for half the differentiators** and degrades silently on remote/fish/hostile-rc to the 120s timeout path. Add a per-tab marks-capability handshake surfaced in UI.
12. **Release hygiene** — 3-file manual version bump, dual-remote push, stale `main`, NSIS exit code lies, stale docs on the public branch mislead agents. Add a bump script + CI version-match check.

---

## Recommended fix order

**Before any public/wider release (data loss + availability):** C1 (disk mutex), C3 (SFTP truncate), C2 (workspace backup), C4 (RemoteEditor guard), C5 (recording checkpoint), H1 (OSC provenance), H5 (tofu regression — cheap, tonight's), H6 (ssh_key_generate — cheap).

**Next pass (correctness + felt performance):** H2, H3, H4, H7 (memo — cheap, high payoff), H8; then M6/M8 (tonight's), M3, M7.

**Infrastructure (do once, pays forever):** FR2 (IPC contract test), FR3 (signing + updater), FR6 (cargo/npm audit in CI) — these change the trajectory.
