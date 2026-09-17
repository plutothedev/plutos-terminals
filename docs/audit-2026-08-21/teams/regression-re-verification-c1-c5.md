<!-- (C) -->
# Regression re-verification (C1–C5)

Audit of plutos-terminals @ `731afc5`, 2026-08-21.

## Summary

All five C-batch fixes are physically present at HEAD and none were reverted or moved away by the 50 intervening commits. The core mechanisms hold: C1's try_lock + timeout, C3's tmp+rename streaming, and C5's disk checkpoint + launch recovery all do what their commits claim, and C5 in particular is clean end to end (capture site through Rust append through the recovery prompt). The debt is in the edges the fixes did not close and in one side effect they introduced: C2 recovers only from a garbled localStorage string and, on the far more likely empty-localStorage variant of the same failure, actively overwrites the backup it just created within ~200 ms of boot; C3's switch from truncate-in-place to rename-over-destination silently drops the remote file's permission bits, so uploading over a 0600 credential file leaves it 0644; C4's dirty guard covers the three tab-close entry points but not the keyboard shortcuts, which stay live under the modal overlay and unmount the editor outright; C1 leaves the one-time Disks initialization outside the try_lock it added. Three of the four are the fix's own blast radius rather than a missed spot, which matches this codebase's pattern of the re-review round finding more than the original.

## Verified sound (14)

- C1 , DISKS is try_lock'd, never blocking-locked: src-tauri/src/sysstats.rs:119, with the last-good fallback at :146 and store_disk_pct at :142. The single-thread stall that survives try_lock is bounded by tokio::time::timeout(2s) around spawn_blocking at src-tauri/src/sysstats.rs:72-81. A regression test pins it: sysstats.rs:181-202 holds the DISKS lock and asserts system_stats_sync returns the cached 42.0 in under 500 ms.
- C1 , the phone companion's system_stats RPC no longer has an independent blocking path; it routes through the same try_lock'd sync core (src-tauri/src/companion.rs:619-622) and the frontend poller's single-flight bool still resets in .finally (src/features/terminals/hooks/independentEffects.js:29-33).
- C2 , the Rust store now has real frontend callers, which it did not at 8c40c62: the mirror write at src/App.jsx:186 and the recovery read at src/App.jsx:250. write_store remains atomic tmp+rename with a per-write-unique tmp suffix (src-tauri/src/commands.rs:89-103, suffix at :82-86).
- C2 , the review's mirror-leak fix held: SECRET_FIELDS are stripped before the blob reaches store.json (src/App.jsx:185-186), against the single canonical list at src/features/terminals/storageKeys.js:25. No plaintext provider key reaches the new at-rest location.
- C2 , the corrupt-blob branch itself is correct and unit-tested: parseWorkspace returns corrupt:true only for a non-empty unparseable string (src/features/terminals/workspaceBoot.js:16-17), and the recovery effect suspends the mirror until it resolves, releasing it in a finally (src/App.jsx:244-267).
- C3 , the truncate-before-stream hazard the finding named is genuinely gone on both legs. do_download now streams through stream_to_file_atomic (src-tauri/src/sftp.rs:156-160), which writes a sibling temp and removes it on any read/write error, leaving dest untouched (:126-152). do_upload stages into a remote temp and unlinks it on failure before the original is ever opened (src-tauri/src/sftp.rs:214-236).
- C3 , the failure path is covered by a real test rather than an assertion that passes vacuously: sftp.rs:604-621 streams a reader that errors after 64 KB and asserts the pre-existing destination is byte-for-byte intact, with a leftover-temp scan that globs the pid-suffixed name (:585-598) instead of a hardcoded one.
- C4 , the modal-level guard is present and correct: RemoteEditor.jsx:113-122 gates onClose behind useConfirm when dirty, and Modal's three dismissal routes (Escape :34, backdrop :80, ✕ :96) all funnel into it.
- C4 , the review's phantom-dirty-key regression stayed fixed: the registry effect is gated on `open` as well as `dirty` (src/features/terminals/RemoteEditor.jsx:78-83), so a discard-close cannot leave a `<session>:undefined` key marked forever, and remoteEditDirty.test.js:27-30 pins that case.
- C4 , save() snapshots the buffer before the await rather than re-reading textRef after it (src/features/terminals/RemoteEditor.jsx:90-93), so keystrokes typed during a slow save are not falsely marked clean.
- C5 , the whole disk crash-net is wired end to end and I could follow it without a gap: capture at src/features/terminals/TerminalPane.jsx:1446, 2 s buffered flush at recording.js:34-50, header seeded with reset:true at recording.js:94, tail flushed before the in-memory drop at recording.js:107-111.
- C5 , the Rust side is sound: recording_checkpoint is async + spawn_blocking with append(!reset)/truncate(reset) (src-tauri/src/commands.rs:1483-1507), and the filename gate reuses transcript_name_valid's full-string reconstruction-equality check (:1476-1481, gate at :1451-1455), so no traversal via a crafted tab id.
- C5 , the ordering the finding complained about is inverted correctly now: stopRecording no longer destroys the only copy before the dialog. finalizeRecording runs only after save_text_to_file returns a path (src/features/terminals/TerminalsTab.jsx:844-846); a cancelled or failed save deliberately keeps the inflight file (:847-853), and the launch recovery loop offers it (:864-895).
- C5 , pruneRecordings leaves the inflight .cast on disk after flushing its tail when a recording's tab disappears (src/features/terminals/recording.js:190-205), so closing a tab mid-recording is recoverable next launch rather than silently discarded.

## Findings (4)

### HIGH R-C2-1, C2 backup is destroyed by the boot it exists to survive: empty localStorage is not treated as corruption, and the OLED migration overwrites store.json ~200ms later

`src/App.jsx:110`

**What.** `parseWorkspace` (src/features/terminals/workspaceBoot.js:11) returns `{ state: {}, corrupt: false }` for `raw == null || raw === ""`, and only returns `corrupt: true` for a non-empty string that fails `JSON.parse`. App.jsx:110-113 therefore sets both `bootCorruptRef` and `mirrorSuspendedRef` to false on an empty read, so the recovery effect at App.jsx:245 (`if (!bootCorruptRef.current || !isPrimaryWindow()) return;`) never runs and `read_store` is never consulted.

That alone would only be a missed recovery. The damage comes from the mirror still being armed. With `st = {}`, the one-time OLED migration at App.jsx:332-340 fires unconditionally , `if (!stRef.current.oledDefaultMigrated) { save((prev) => ({ ...prev, headerSkin: ..., oledDefaultMigrated: true })); }` , because the flag only exists inside the blob that just came back empty. `save` sets `pendingRef` and schedules `flushNow` (App.jsx:217, 200 ms). `flushNow` reaches App.jsx:184 `if (json != null && isPrimaryWindow() && !mirrorSuspendedRef.current)` , all three are true , and calls `invoke("write_store", ...)` with `{ headerSkin: "oled", oledDefaultMigrated: true }`. `write_store` (src-tauri/src/commands.rs:89-103) does an atomic tmp+rename over store.json, so the good backup is replaced, not appended to.

The suspension mechanism was built for exactly this clobber , App.jsx:104-107 comments that a migration's `save({})` could "CLOBBER store.json before recovery reads it" , but it is armed off `corrupt`, which is false on this path. The C2 fix's own stated trigger is "WebView2 profile corruption after an unclean shutdown → app opens brand-new/empty"; Chromium's LevelDB-backed localStorage discards a damaged database and starts empty rather than returning a garbled string, which is the branch the fix does not cover.

**Failure.** User has a real multi-panel workspace mirrored to store.json. The WebView2 profile is lost or reset (unclean shutdown, profile directory wiped, site data cleared). On next launch localStorage.getItem returns null, so no toast and no recovery attempt is made; the app opens with a default empty layout. ~200 ms later the OLED migration's flush writes the empty default over store.json, so the durable backup is gone too. The workspace is now unrecoverable from either copy, and the user sees no error at any point.

**Fix.** Treat an absent blob as recoverable, not as first run: on `raw == null` with `isPrimaryWindow()`, suspend the mirror and read store.json before defaulting; recover if it parses to a non-empty object, and only then release `mirrorSuspendedRef`. At minimum, gate the mirror write on having completed a boot-time backup read, so no flush can replace store.json before the app has looked at it once.

### HIGH R-C3-1, C3's tmp+rename upload silently strips the destination's permissions: overwriting a 0600 remote credential file leaves it world-readable 0644

`src-tauri/src/sftp.rs:214`

**What.** `do_upload` (src-tauri/src/sftp.rs:207-247) replaced the old truncate-in-place write with `let tmp = unique_tmp(remote)` (:214), `sftp.create(Path::new(&tmp))` (:216), then `sftp.rename(tmp -> remote, OVERWRITE|ATOMIC|NATIVE)` (:237-241). There is no `setstat` anywhere in the file , `grep -n setstat src-tauri/src/sftp.rs` returns nothing.

`Sftp::create` in the pinned ssh2 crate hardcodes mode 0o644 (~/.cargo/registry/src/index.crates.io-*/ssh2-0.9.6/src/sftp.rs:213-220: `self.open_mode(filename, OpenFlags::WRITE | OpenFlags::TRUNCATE, 0o644, OpenType::File)`). Before the fix, `create(remote)` on an *existing* file was an O_CREAT|O_TRUNC open, and POSIX open() ignores the mode argument when the file already exists , the destination inode and its mode survived. After the fix the payload lands in a brand-new inode at 0644 (minus the server umask) and `rename(2)` swaps that inode into place, so the destination's original mode, owner, ACLs and hard links are replaced by the temp's.

Same mechanism replaces a symlinked destination: writing through `/etc/nginx/sites-enabled/default` used to follow the link; the rename now replaces the link itself with a regular file. `stream_to_file_atomic` (:126-152) has the local-side equivalent via `fs::File::create`. The truncate-before-stream hazard C3 named is genuinely gone , this is the cost the fix introduced, not a reversion.

`sftp_upload` (:457-481) builds the destination as `<dir>/<name>` from the picked local filename and overwrites with no prompt, so hitting an existing restricted file needs no unusual action.

**Failure.** User edits ~/.ssh/id_ed25519 (mode 0600 on the server) or a 0600 .pgpass / .netrc / .env locally, then uses the SFTP dock's upload button with that directory open. The upload succeeds and reports success. The remote file is now mode 0644: every other local user on that host can read the private key, and ssh itself will refuse it with "UNPROTECTED PRIVATE KEY FILE". Nothing in the UI indicates the permissions changed.

**Fix.** Stat the destination before staging and, when it exists, carry its mode (and where the SFTP session permits, uid/gid) onto the temp via `sftp.setstat` before the rename , or `open_mode` the temp with the destination's mode instead of the crate's 0644 default. Apply the same to `do_write_text` (:180-205) and to `stream_to_file_atomic` on the local side. Resolve a symlinked destination to its target before choosing the rename path.

### HIGH R-C4-1, C4's dirty guard is bypassed by keyboard shortcuts, which stay live under the modal overlay and unmount RemoteEditor instead of closing it

`src/features/terminals/TerminalsTab.jsx:333`

**What.** The fix has two halves and both only cover *closing*. RemoteEditor.jsx:113-122 `requestClose` confirms when dirty, but it is only reached through `Modal`'s Escape / backdrop / ✕ (src/components/Modal.jsx:34, 80, 96). The registry half (`hasUnsavedRemoteEdits`, src/features/terminals/remoteEditDirty.js:15) is consulted by `confirmDiscardIfDirty` (TerminalsTab.jsx:464-470), which is wired to exactly three callers: `guardedCloseTab`, `guardedCloseOtherTabs`, `guardedDetachTab` (:471-479).

RemoteEditor is mounted inside SftpBrowser, which TerminalsTab renders conditionally: `... : activeTab?.connection ? (<SftpBrowser ... />) : (<LocalFileBrowser ... />)` (:1227-1235). Anything that changes which tab is active unmounts the editor outright , no onClose, no registry consultation, and `useSftpDock` tears the SFTP session down as well.

The global shortcut handler (:331-362) stands down only for `isCapturing()` (:333) and `tourOpenRef.current` (:336). There is no check for an open modal, and it is a window capture-phase listener (:361), so it fires while the RemoteEditor overlay (`position: fixed; inset: 0; z-index: 9990`, src/features/terminals/headerSkins.css:164-175) is blocking the mouse. Unguarded actions that change the active tab: `addTab` (:919, Ctrl+Shift+T , `useWorkspaceTree.addTab` sets `activeTabId: newTab.id`, hooks/useWorkspaceTree.js:84-86), `switchPanel` (:932, Ctrl+1..Ctrl+8, keybindings.js:40-46), and `reopenTab` (:929, Ctrl+Shift+Z , hooks/useWorkspaceTree.js:228-230 sets `activeTabId: last.tab.id`). `onClosePanel={closePanel}` (:1191) is likewise unguarded and closes every tab in the panel.

Ctrl+Shift+Z is the sharpest case: it is Monaco's Redo, but the capture-phase handler consumes it with `preventDefault(); stopPropagation();` (:357-359) before the editor sees it.

**Failure.** User opens a remote file in the SFTP dock's in-app editor over SSH, types unsaved changes, then presses Ctrl+Shift+T for a new tab (or Ctrl+2 to switch panel, or Ctrl+Shift+Z expecting Redo when a tab was closed earlier in the session). The new/reopened tab has no `.connection`, so the dock swaps to LocalFileBrowser, RemoteEditor unmounts and the SFTP session is disconnected. Every unsaved edit is gone with no confirm and no toast , the exact outcome C4 was filed to prevent, reached without touching Escape, the backdrop or ✕.

**Fix.** Have the global shortcut handler stand down when a modal is open (`document.querySelector('.phn-modal-overlay')` , the same live-DOM check Modal.jsx:32 already uses for Escape), so the editor keeps the keyboard while it is up. Separately, route the active-tab-changing mutations through `confirmDiscardIfDirty` the way the close paths are , at minimum `switchPanel`, `reopenTab` and `closePanel` , since those are reachable from the command palette and the panel chrome too.

### MEDIUM R-C1-1, C1's try_lock does not cover the one-time Disks initialization, which sits outside it in OnceLock::get_or_init and still blocks every later poller

`src-tauri/src/sysstats.rs:118`

**What.** The fix is otherwise intact and well-tested: `disks_mutex.try_lock()` at :119, the cached last-good fallback at :146, the `spawn_blocking` + 2 s `tokio::time::timeout` wrapper at :72-81, and a regression test asserting a held DISKS lock does not block the caller at :181-202. The companion's RPC path calls `system_stats_sync` directly (src-tauri/src/companion.rs:621) and so inherits the try_lock too.

The gap is evaluation order on :118: `DISKS.get_or_init(|| Mutex::new(sysinfo::Disks::new_with_refreshed_list()))` runs to completion *before* `.try_lock()` is reached. `OnceLock::get_or_init` blocks other threads for the duration of the initializing closure, so the try_lock defence does not apply to the very first call. The module's own comment at :24-27 states the model that makes this reachable , "a stale network mount stalls the whole status bar on the OS stat timeout" , which is the same enumeration `new_with_refreshed_list()` performs.

Consequence is the thread leak the C1 commit message claims to have closed ("no lock-hang, no thread leak on stalled mounts"): the tauri command returns after 2 s, but the blocking task stays parked, and each subsequent poll spawns another that parks in `get_or_init` behind it. `LAST_DISK_PCT` is still 0.0 at that point, so the `cached()` fallback at :66-71 also reports `cpu: 0.0` and `mem_total: 0` , DockMonitor renders that as a literal "0%" CPU gauge (src/features/terminals/DockMonitor.jsx:56) rather than an unavailable state.

**Failure.** A network share or sleeping external volume is already unresponsive when the app launches. The first system_stats poll parks inside Disks::new_with_refreshed_list(); the status bar shows CPU 0% / DISK 0% indefinitely. Every 5 s poll thereafter (per window) spawns another blocking-pool thread that parks in get_or_init behind it, accumulating without bound. Since that pool is shared with the companion's RPC dispatch (companion.rs:429) and pty_write_sync, sustained accumulation eventually starves other blocking work. Recovery still requires killing the app.

**Fix.** Move the initialization behind the same bound as the refresh: build the Disks handle inside the timed spawn_blocking body and store it via `OnceLock::set` (or a `Mutex<Option<Disks>>` with try_lock) so a stalled first enumeration parks one thread rather than gating every later caller. Separately, make the timeout fallback distinguish itself from real zeros so the UI shows "unavailable" instead of 0%.

