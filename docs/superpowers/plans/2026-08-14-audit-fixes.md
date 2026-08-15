<!-- (C) -->
# Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (batched, checkpoint per batch). Steps use `- [ ]`. Each fix: failing test where testable → fix → green → commit. Every CRITICAL/HIGH fix gets an adversarial re-review before its batch closes (pluto's standing build-loop rule — re-review-every-fix is load-bearing, it keeps catching regressions the fixes introduce).

**Goal:** Close all 30 code-level findings from `docs/full-audit-2026-08-14.md` (5 CRITICAL, 8 HIGH, 11 MEDIUM, 6 LOW) + 2 CI-audit jobs, in risk order, each TDD'd and adversarially verified.

**Spec:** `docs/full-audit-2026-08-14.md` @ commit 1f6280f is the source of truth for every defect's file:line + rationale. This plan references findings by ID (C1, H5, etc.).

**Out of scope (separate strategic track, NOT this plan):** the 12 forward-risk items (god-component extraction FR1, IPC contract tests FR2, signing+updater FR3, commands.rs split FR4, Linux CI FR5, vnc replacement FR6-crate, companion convergence FR7, hex-token gate FR8, ptyBridge contract FR9, provider-catalog fetch FR10, marks handshake FR11, release script FR12) — architecture + pluto-decisions. FR6's cargo/npm-audit CI jobs ARE folded in (Batch E, trivial + protective).

**Verification per batch:** full `npx vitest run` (JS) + `cargo test` (Rust, for Rust-touching batches) green before commit-batch-close; adversarial reviewer over the batch diff; every finding it raises fixed and re-reviewed.

**Renderer caveat (M1):** flipping xterm off the DOM renderer is the ONE fix with real platform risk (DOM-only exists because WebGL blank-glyphs in macOS WKWebView). Implemented behind a per-OS gate with DOM as the safe default on macOS, but marked NEEDS-PLUTO-PACKAGED-VERIFICATION on Windows + Linux before it shships — do not treat as done on green tests alone.

---

## Batch A — Release blockers (data loss + availability wedge + tonight's regressions)

### Task A1 — C1: bound the disk-stat mutex (Rust)
**Files:** `src-tauri/src/sysstats.rs:76-103`; test in same file's `#[cfg(test)]`.
- [ ] Read `pty.rs::connect_session` for the established `spawn_blocking` + `tokio::time::timeout` shape.
- [ ] Replace the blocking `DISKS.lock()` + inline `disks.refresh(true)` with: `try_lock()` — on contention, return the last-known-good cached value (add an `AtomicU32`/`Mutex<f32>` last-good disk pct beside `DISKS`) instead of blocking. Wrap the `refresh(true)` in `spawn_blocking` with a 2s `timeout`; on timeout, keep last-good and do NOT hold the lock across the stall.
- [ ] Test: a unit test that the function returns promptly (no panic, valid 0..=100) and that a simulated held lock yields the cached value rather than blocking (use a second thread holding `DISKS` + assert the call returns within a bound).
- [ ] `cargo test sysstats` green.
- [ ] Commit: `fix(sysstats): bound disk refresh — no lock-hang, no thread leak on stalled mounts (C1)`.

### Task A2 — C3: atomic SFTP upload + download (Rust)
**Files:** `src-tauri/src/sftp.rs:110-127` (`do_download`), `:173-190` (`do_upload`); reference `:146-171` (`do_write_text`).
- [ ] `do_upload`: write to `{remote}.plutotmp~` via `sftp.create`, stream, flush, drop, then `sftp.rename(tmp, remote, OVERWRITE|ATOMIC|NATIVE)` with best-effort `unlink(tmp)` on rename error — copy `do_write_text`'s exact pattern. Never `create(remote)` directly.
- [ ] `do_download`: write to `{local}.plutotmp~` via `fs::File::create`, stream, then `fs::rename(tmp, local)`; on any stream error, `fs::remove_file(tmp)` and leave `local` untouched.
- [ ] Test: unit tests that a mid-stream error leaves the destination path unmodified (inject a writer that errors after N bytes; assert original content intact / no partial at dest).
- [ ] `cargo test sftp` green.
- [ ] Commit: `fix(sftp): atomic upload+download — tmp+rename so a dropped transfer never truncates the destination (C3)`.

### Task A3 — C2: durable workspace backup + corruption signal (JS + Rust wire)
**Files:** `src/App.jsx:92-122` (init), the persist/flush path (`:125-174`); `commands.rs:63-86` (`read_store`/`write_store`, already exist).
- [ ] On flush (`flushNow`), after the localStorage write, also `invoke("write_store", { key: "workspace", json })` as a mirror (fire-and-forget, catch-logged). Debounce shares the existing flush timer — no new hot-path cost.
- [ ] On init: if `localStorage.getItem(key)` is a non-empty string that fails `JSON.parse`, this is corruption (not first-run). Do NOT silently `{}`: `invoke("read_store", {key})` for the mirror; if it parses, use it + toast "Recovered your workspace from backup"; if neither parses, toast "Workspace couldn't be read — starting fresh (a backup may exist in the app data folder)" before defaulting.
- [ ] Test: a JS unit around the init helper (extract the parse-or-recover logic into a pure `loadWorkspace(rawLocal, rawBackup)` returning `{state, source}` — test corrupt-local+good-backup → backup, both-corrupt → default+flag, good-local → local).
- [ ] `npx vitest run` green.
- [ ] Commit: `fix(state): mirror workspace to the durable Rust store + recover/flag on corruption instead of silent reset (C2)`.

### Task A4 — C4: RemoteEditor dirty guard (JS)
**Files:** `src/features/terminals/RemoteEditor.jsx`, `src/features/terminals/SftpBrowser.jsx:307-313`.
- [ ] Track `dirty` in RemoteEditor (compare live buffer to loaded content, or set on change). Expose it up, OR intercept close inside the editor.
- [ ] Gate the close: wrap `onClose` with the existing `useConfirm` (pattern already in SftpBrowser for delete) — "Discard unsaved changes to <file>?" when dirty; skip confirm when clean.
- [ ] Test: RTL test (jsdom) — mount editor, simulate an edit, fire close → confirm requested; clean close → no confirm.
- [ ] `npx vitest run` green.
- [ ] Commit: `fix(remote-editor): confirm before discarding unsaved SSH file edits (C4)`.

### Task A5 — C5: checkpoint recordings to disk (JS + Rust)
**Files:** `src/features/terminals/recording.js`, `TerminalsTab.jsx:792-815`; a Rust `recording_checkpoint_append` / reuse `transcript_append`-style atomic append.
- [ ] During capture, append new events to a temp `.cast` in app-data every N events / 3s (piggyback the existing event push; batch to avoid per-event IPC).
- [ ] `stopRecording`: finalize from the temp file (rename to the chosen Save path) rather than only the in-memory Map; on save-dialog cancel, leave the temp for recovery, don't delete the events until the file is durable.
- [ ] On launch: detect a stale checkpoint temp → toast "An interrupted recording was recovered" + offer to save/discard.
- [ ] Test: JS unit that a checkpoint write is scheduled during capture; Rust unit for the atomic append if a new command is added.
- [ ] Both suites green.
- [ ] Commit: `fix(recording): checkpoint to disk during capture — crash/cancel no longer loses the session (C5)`.

### Task A6 — H1: OSC 1337 provenance gate (JS + shell-integration)
**Files:** `TerminalPane.jsx:1043-1069`, `shellIntegration.js` (the injected preexec/precmd hook).
- [ ] Injected hook: emit a per-session nonce (generated at spawn, held in `entry`) inside the OSC payload: `PlutoCmd=<nonce>:<base64>`.
- [ ] Handler: parse the leading nonce; if it does not match the session's issued nonce, do NOT `recordCommand` / tag the block — optionally mark the block source="remote-unverified" for display, never promote to trusted history.
- [ ] Test: unit the handler parse — matching nonce records, missing/wrong nonce does not (extract the payload-parse into a pure fn).
- [ ] `npx vitest run` green.
- [ ] Commit: `fix(security): nonce-gate OSC 1337 command reports — remote streams can't inject trusted history (H1)`.

### Task A7 — H5: tofu atlas rebuild on registry liveness, not fiber `alive` (JS)  [tonight's regression]
**Files:** `TerminalPane.jsx:1141-1150`.
- [ ] Change `if (!alive) return;` to gate on `entryLive()` (the discipline every other create-once callback in the file uses), so a re-attached fiber after a tab-move still benefits from the `fonts.ready` rebuild. Verify the re-attach path (`isFirstMount===false`, ~:781-824) either re-registers or shares the subscription.
- [ ] Test: hard to unit (needs fonts.ready + move); add a comment-anchored guard test if feasible, else verify in the visual loop (move a tab pre-font-load, confirm glyphs).
- [ ] `npx vitest run` green.
- [ ] Commit: `fix(terminal): atlas rebuild survives tab-move — gate on entryLive not fiber alive (H5)`.

### Task A8 — H6: `ssh_key_generate` off the UI thread (Rust)
**Files:** `src-tauri/src/sshconfig.rs:286-354`.
- [ ] Convert to `pub async fn`; wrap the `Command::output()` in `tauri::async_runtime::spawn_blocking` (shape of `netools.rs::net_ping`).
- [ ] `cargo test` (existing sshconfig tests) green; confirm the command still returns the same shape.
- [ ] Commit: `fix(ssh): generate keys off the UI thread — no window freeze during RSA keygen (H6)`.

### Task A9 — H7: memoize the chrome (JS)
**Files:** `chrome/MenuBar.jsx`, `Toolbar.jsx`, `StatusBar.jsx`, `FKeyBar.jsx`, `DockTabStrip.jsx`, `ModalHost.jsx`; verify prop stability at the `TerminalsTab` call sites.
- [ ] Wrap each in `memo(...)`. For each, audit its props at the call site for inline object/array/callback literals that would defeat memo; stabilize with `useCallback`/`useMemo` where needed (the grid components prove the pattern).
- [ ] Test: existing suites must stay green (behavior-neutral); optionally a render-count assertion if a harness exists.
- [ ] `npx vitest run` green.
- [ ] Commit: `perf(chrome): memoize the always-on chrome shell — no whole-shell re-render per agent tick (H7)`.

**Batch A close:** full `npx vitest run` + `cargo test` green → adversarial reviewer over the Batch A diff → fix findings, re-review → build + install ceremony so pluto can smoke the data-loss fixes → push both remotes.

---

## Batch B — Correctness + felt performance

### Task B1 — H2: notebook/store cross-process write lock (Rust)
`commands.rs` `notebook_write_sync` (:2164) + `write_store` (:75): add a per-target-path `Mutex`/lock-file (reuse `mcp/manager.rs::cfg_write_lock` pattern or pid-suffix the tmp name) so concurrent windows/instances can't clobber the same tmp. Test: two concurrent writes to one path both survive or serialize. Commit.

### Task B2 — H3: per-pane error boundaries (JS)
Wrap the fragile render surfaces (Monaco `RemoteEditor`/`DiffView`, `VncView` canvas, custom-theme CSS apply) in boundaries that destroy only that pane's session; reserve `App.jsx`'s `destroyAll()` boundary for unattributable faults. Test: a throwing child pane doesn't unmount siblings. Commit.

### Task B3 — H4: Agent Mode close = stop (JS)
`ModalHost.jsx:196` `onClose` → also `stopRef.current=true` + resolve the pending approval with "stop"; add a status-bar "agent running" indicator (shared state) so a closed-modal agent stays visible. Test: close-while-pending resolves the promise + sets stop. Commit.

### Task B4 — H8: window-scoped PTY cleanup (Rust)
Tag sessions by owning window label (map beside `SessionRegistry`); on `WindowEvent::Destroyed` for `win-*`, kill that window's sessions in Rust rather than trusting the frontend round-trip. Test: unit the tag/lookup. Commit.

### Task B5 — M3: rAF the dock-resize drag (JS)
`useDockResize.js:31` — buffer `clientX` in a ref, commit `setDockWidth` via `requestAnimationFrame` (the `costRafRef` pattern). Commit. (Compounds with H7; do after.)

### Task B6 — M4: WebLinks through openExternal (JS)
`TerminalPane.jsx:867` — `new WebLinksAddon((e,uri)=>openExternal(uri))`. Test: the handler routes through openExternal. Commit.

### Task B7 — M5: secret scanner env/kubectl shapes (JS)
`secretScan.js:10-18` — add a conservative `(_KEY|_SECRET|_TOKEN|_PASSWORD)\s*[=:]\s*<value>` pattern + bare-AWS-secret shape; soften ShareModal copy to "scanned for known key formats". Extend the fuzz test with env-dump lines. Commit.

### Task B8 — M6: drag-reorder indicator above the tab fill (CSS)  [tonight's work]
`terminals.css` — replace the `.tab-drop-before/after` box-shadow with a `z-index:2` positioned bar (paints above the negative-z trapezoid fill), or an element appended by `markTabInsert`. Verify in the visual loop (drag-reorder shows the drop bar). Commit.

### Task B9 — M7: SSH keychain-await panel race (JS)
`useSessionDispatch.js` + `useSshConnect.js` — re-derive `panelId` from `stateRef.current.activePanelId` AFTER the `secret_get` await (the `openAgentWorktree` fix). Commit.

### Task B10 — M8: window-title staleness guard (JS)  [tonight's work]
`independentEffects.js:85` `useWindowTitle` — track latest label in a ref; skip `setTitle` if the label changed by the time the import/invoke resolves (sibling `cancelled`-flag pattern). Test: extend `useWindowTitle.test.js`. Commit.

### Task B11 — M9: blocking work off tokio workers (Rust)
`commands.rs` (`gh_pr_create`, `worktree_add/remove`, `git_diff`, `recent_files`, `mcp_install`, `check_command_version`), `rdp.rs::rdp_connect`, `vncclient.rs::vnc_connect`, `netools.rs::net_port_scan`, `share.rs` token cmds — wrap each blocking body in `spawn_blocking` (standard pattern in the file). Group-commit by file. `cargo test` green.

### Task B12 — M10: field-level userSt merge (JS)
`App.jsx:198` — merge changed fields instead of full-object overwrite on cross-window write (reuse `sync/merge.js` LWW-by-field). Test: two-field concurrent write keeps both. Commit.

### Task B13 — M11: quota-exceeded toast (JS)
`App.jsx:139` — on `setItem` quota error, one-time (deduped) toast suggesting trimming themes/workspaces, instead of console-only. Commit.

**Batch B close:** suites green → adversarial reviewer over Batch B diff → fix + re-review → push.

---

## Batch C — Renderer + boot (higher risk)

### Task C1 — M2: stagger tab mount at boot (JS)  **DOWNGRADED — already mitigated (2026-08-15)**
`TerminalPanel.jsx:603` — render non-active restored tabs behind a lightweight placeholder; reveal via the existing `trickle` cadence so the first paint isn't a synchronous N-terminal mount. Test: mount-count assertion at boot. Commit.

**Investigation finding (2026-08-15): NOT implemented — premise already substantially mitigated, and the proposed fix conflicts with existing architecture.**
- The two *expensive* boot operations are ALREADY deferred: `term.open()` (DOM host + renderer) is gated behind `openIfVisible` / IntersectionObserver (`TerminalPane.jsx:1139`), so a hidden restored tab never builds its renderer until first shown; and PTY *spawn* is already staggered one-tab-per-tick by the `trickle` core (`trickle.js`, P4-T5). What remains synchronous at boot is only N `new Terminal()` JS-object constructions (no DOM) — modest for realistic tab counts.
- The proposed "placeholder until trickle reveals it" MOUNT-gate conflicts with the entry lifecycle: registry entries are created *on mount* via `ensureEntry` (`paneRegistry.js:105`), and `trickleTick` iterates `getEntry(paneId)` to find spawnable panes — it returns `null` for an un-mounted tab. Deferring mount would hide those tabs from the very trickle meant to reveal them, unless the entry/mount/trickle contract is restructured (pre-create all entries at boot; drive mount AND spawn from trickle). That's a meaningful change to a delicate, heavily-audited component for marginal gain.
- **Decision:** left as-is. Revisit only if profiling a large (15+ tab) workspace shows the `new Terminal()` burst is a measured jank source.

### Task C2 — M1: per-OS renderer gate (JS)  **NEEDS-PLUTO-PACKAGED-VERIFICATION**
`TerminalPane.jsx:948` — add `@xterm/addon-canvas`; gate: DOM on macOS (the WKWebView blank-glyph reason), canvas on Windows/Linux. Ship behind the gate but DO NOT mark done on green tests — pluto verifies glyph rendering in the packaged app on Windows (and Linux if reachable) before this batch closes. If any blank-glyph regression, revert to DOM everywhere. Commit only after pluto's visual OK.

**Batch C close:** pluto packaged-verifies the renderer → push.

---

## Batch D — LOW

- **L1** drag-listener unmount cleanup (`TerminalPanel.jsx` tab/divider + `useDockResize`): register via effect cleanup / `AbortController`, remove on unmount. Commit.
- **L2** shared `safeParse(raw,{onCorrupt})` helper; route `macros.js:64`, `ptyBridge.js:124`, and A3's init through it. Commit.
- **L3** poisoned-mutex recovery: mirror `pty.rs::lock_recover` in `sftp/forward/rdp/vncclient/companion` registries. Commit.
- **L4** `checkCost` cap to 2/sec if profiling shows it (else skip — already rAF-coalesced). Defer unless measured.
- **L5** `save_text_to_file` tmp+rename for consistency. Commit.
- **L6** cloud-sync LWW clock-skew note in `sync/merge.js` + a guard if cheap (monotonic-ish counter). Comment-only if no cheap fix. Commit.

**Batch D close:** suites green → light review → push.

---

## Batch E — CI audit jobs (folded-in FR6)

### Task E1 — cargo-audit + npm-audit CI
`.github/workflows/audit.yml` (audit.yml already exists per v0.5.0 notes — extend or add): add `cargo audit` (install `cargo-audit`, run, allow-list documented) + `npm audit --audit-level=high` jobs, non-blocking initially (report), then blocking once the current baseline is triaged. Commit.

**Batch E close:** CI green → push.

---

## Self-review

- **Coverage:** every C/H/M/L finding from `full-audit-2026-08-14.md` maps to a task (A1-A9 = C1-C5,H1,H5,H6,H7; B1-B13 = H2,H3,H4,H8,M3-M11; C1-C2 = M2,M1; D = L1-L6; E = FR6-CI). No code finding unmapped.
- **Risk ordering:** data-loss + wedge + tonight's-regressions first (A), correctness+perf next (B), platform-risky renderer isolated (C, gated on pluto), cosmetic/consistency last (D/E).
- **The loop:** every CRITICAL/HIGH batch closes with an adversarial reviewer + re-review-every-fix (the rule that caught the tour's Tab-trap escape and the tofu-atlas nonce bug). Rust + JS suites both gate each batch.
- **Escape hatch:** M1 renderer is the only fix that can't be signed off on tests alone; explicitly gated on pluto's packaged verification.
