# P1 — PTY/Rust hot path plan (2026-08-12, rev 2 after adversarial audit)

Parent spec: `../specs/2026-08-12-perf-optimization-design.md`. Rev 1 was BLOCKED by the plan-audit (F1 reorder CRITICAL, F2 lost-wakeup CRITICAL, +6 must-fix). This rev folds in every must-fix and every strongly-recommended item. TDD per task; pure logic in testable structs.

## Lock-order invariants (cross-task, binding)

Locks: registry mutex → per-session coalescer mutex → (leaves: condvar mutex, TranscriptHandles mutex, per-session writer mutex). Rules:
1. Extraction AND emit are atomic under the session's single coalescer mutex. There is NO separate emit mutex.
2. The flusher ticker takes the registry only to snapshot `Arc<Mutex<Coalescer>>` clones, releases it, then locks each coalescer for tick+emit. Never emit under the registry lock.
3. No thread takes the registry while holding a coalescer. Reader exit sequence: flush under coalescer → release → registry remove → release → emit `pty-exit://`.
4. Tauri runs Rust-side listeners synchronously on the emitting thread — the companion relay closure (companion.rs:445-452) executes inside the coalescer lock. Constraint: relay closures stay allocation-cheap and never block (current one complies; note added there).

## T1 — Chunk coalescing (drop-bug fix)

`coalesce.rs`: `Coalescer { pending: String, first_pending_at: Option<Instant>, last_emit_at: Instant, max_bytes: 64KB, max_age: 8ms }`.
- `push(s, now) -> Option<String>`: if pending empty AND `now - last_emit_at >= max_age` → **leading-edge flush**: return `Some(s)` immediately (preserves keystroke-echo latency; xterm's `_didUserInput` fast path stays effective). Else append; return flush when pending ≥ max_bytes.
- `tick(now) -> Option<String>`: flush when oldest pending ≥ max_age.
- `take() -> Option<String>`: unconditional (exit paths).
Unit tests: thresholds, leading edge, ordering, exact boundary, take, last_emit_at bookkeeping.

Wiring (local PTY reader): decode → scrollback append (unchanged; the 64KB read buffer alone collapses write syscalls) → lock coalescer → push → if `Some`, emit WHILE HOLDING the lock → unlock. Emit is serialize + PostMessageW/channel enqueue (µs–low-ms) — safe under the lock, and the single lock makes reorder impossible (audit F1).

Global flusher thread: condvar whose predicate is a **dirty SET of session ids** (not a bare counter — the reader's release-coalescer-then-acquire-condvar window makes counters drift-prone; the set self-heals) mutated ONLY under the condvar's own mutex; reader adds + notifies under that mutex on empty→nonempty; ticker rechecks under the mutex before every wait; parked heartbeat `wait_timeout(250ms)` as backstop — and the heartbeat wake does a **full registry scan** for nonempty coalescers, not a bare predicate recheck, so predicate drift can never stall output (re-audit pin 1). **Killed-session cleanup:** every registry-remove path (pty_kill, reader reap, kill_all) also clears the id from the dirty set under the condvar mutex, and the ticker additionally prunes ids absent from its registry snapshot — a stale entry must not pin the ticker awake forever. Leaf discipline both directions: ticker drops the condvar guard before the registry/coalescer pass; reader takes the condvar mutex only after releasing the coalescer. While active: wake ~8ms, snapshot Arcs per invariant 2, tick each. Detached at exit; retained emits die with the process; failure counter must not log-spam during EventLoopClosed teardown.

SSH + serial loops: coalesce inline; on WouldBlock/TimedOut with pending → flush, then wait (T7). Any backend-injected `pty://` string (the 4MB stall marker, pty.rs:1052-1060) flushes pending under the coalescer lock first, then emits the marker in-sequence (audit F5).

Exit paths (reader EOF reap, pty_kill, kill_all): `take()` + emit tail under the coalescer lock BEFORE `pty-exit://`. The single-lock rule means a concurrent ticker extract+emit completes before `take()` proceeds — exit event is strictly last.

Failure semantics (audit F3 + re-audit pin 2, verified against tauri-2.11/tao-0.35 source): the emit rate is **bounded by the 8ms max_age + 64KB granularity** (~1.7k emits/s worst-case flood with size-flushes dominating; still 3+ orders below saturating a 10k queue) — that bound is the actual cross-platform saturation defense. On Windows, queue-full IS synchronously reportable (`PostMessageW` → `Err(FailedToSendMessage)`). **Retain-on-Err covers ALL FOUR flush paths — leading-edge, size, tick, take:** on emit Err the flushed string is pushed back to the FRONT of pending under the coalescer lock (nothing can append concurrently there, so prepend preserves order); `take()`-at-exit retries once then drops (process exiting). The emit is an injectable seam (closure/trait) with a fail-injection unit test per path. Consecutive-failure counter + best-effort marker line after N (itself an emit — may fail; acceptable). On macOS/Linux channels are unbounded and saturation is invisible — no counter fiction claimed there.

Frontend riders: bump the boot-conceal cap 65536 → 131072 (TerminalPane.jsx:1345) so one coalesced chunk can't force-flush setup noise.

Read buf 4096 → 65536 (all three loops).

## T2 — Scrollback rotation ping-pong

Replace truncate_tail (pty.rs:200-246). `<id>.txt` current + `<id>.old.txt` previous. On current > 5MB: **close own append handle first** (POSIX-semantics rename would otherwise move the file under the live handle and appends land in `.old`), rename current→old (REPLACE_EXISTING), open fresh current, resync bytes_on_disk (0 on success; kept-length on fallback; metadata resync on double failure, today's pattern).

NO BufWriter anywhere in this task (audit F11: it silently regressed the v0.1.29 durability contract — every chunk OS-buffered by emit time, tray-Quit loses ≤ current chunk — and the syscall win is already delivered by the 64KB read buffer). Direct `write_all` stays.

Rename-failure reality (audit F9): our own `fs::read` loads DON'T block rename (std opens FILE_SHARE_READ|WRITE|DELETE; rename is FileRenameInfoEx/POSIX). The real blockers are AV/indexer/backup handles without FILE_SHARE_DELETE. Keep retry-next-append + one-shot in-place-truncate fallback. The contention test must force failure via `OpenOptionsExt::share_mode(0)` on the target — a plain std read handle would pass vacuously.

Sweep + delete (audit F8): `sweep_stale_scrollback`'s keep-set gains `{id}.old.txt` (live month-old tabs must not lose their older half); `scrollback_delete` removes both files. Tests for both.

Migration: existing single file = current, no old. Zero migration code.

## T3 — transcript_append off the main thread + pooled handles

commands.rs:971-993 → thin `pub async fn` wrapper over a sync core in spawn_blocking. `TranscriptHandles(Mutex<HashMap<(date,name), File>>)`:
- Cache TODAY-dated handles only. Incoming NON-today date (real steady-state: midnight-flush uses the pre-roll date; a moved pane's dead interval appends stale dates for days — TerminalPane.jsx:1072-1086) → uncached write-through (open/append/close), and NEVER mass-evicts the cache (audit F12a).
- Lazy per-entry eviction: drop an entry when its own key-date != server-today.
- Explicit `flush()` (well, direct File write_all needs none — use File directly, NOT BufWriter, keeping ≤5s loss window; the syscall win is the open/close elision) at end of each append (audit F12c).
- GC-safety verified by audit: transcript retention ages by dir name with ≥1-day floor — today's dirs never swept; no delete-while-open.
JS ordering (audit F12b): per-pane promise chain — each `transcript_append` invoke chains on the previous one's promise so threshold-flush and unmount-flush can't interleave out of order.

## T4 — Kill paths: never wait under the lock, never on the UI thread

- Move `wait()` OUT of `Drop for PtySession` into explicit `fn reap(self)`; Drop keeps `kill()` only as last resort (audit F13 — makes the invariant structural: a future `sessions.remove(&id);` temporary can't reintroduce wait-under-lock).
- pty_kill → async fn: lock → remove → unlock → spawn_blocking(kill + reap).
- Reader reap (564-570): remove under lock, drop guard, then reap on the reader thread.
- kill_all (app exit, main thread): collect under one short lock; kill each; parallel reap threads reporting via channel; `recv_timeout` overall 2s (std threads have no join-timeout); proceed regardless — orphans acceptable (kill already sent; ConPTY/conhost dies with the process).

## T5 — pty_spawn async

pty.rs:414 → thin async wrapper, ConPTY spawn + ScrollbackWriter::new in spawn_blocking, registry insert before `Ok(id)`. Caller trace (audit-verified): sole caller TerminalPane.jsx:1196 awaits; startCommands/bridge-writer/pty_ready all strictly after. Double-spawn protection = **entry identity + orphan guard** (TerminalPane.jsx:1198-1217 kills the spawn if `getEntry(tabId) !== entry` on arrival) + `entry.setupDone` — tests name and exercise THAT mechanism (no "spawnedRef" — doesn't exist).

## T6 — scrollback_load tail-slice

Sync core `scrollback_load_sync(app, tab_id, cap)` + thin `pub async fn` command wrapper (spawn_blocking). **companion.rs:510-515 calls the sync fn directly — point it at the core** (audit F10i; also fixes the companion's 10MB-over-WebSocket read).
Slice: open CURRENT and hold the handle (a held handle keeps its bytes across a concurrent rotation rename — audit F10ii); the do-I-need-old decision is sized from **fstat on the held handle at read time**, not the open-time length (re-audit nit 3); read old's tail as needed, then read from the held current handle; emit old-part then current-part; combined ≤ CAP = 256KB. Align forward to next `\n` ONLY when the slice start > 0 (audit F15 — offset-0 must be byte-identical; test pins it). Lossy UTF-8 (writer emits valid UTF-8; `\n` never a continuation byte).
Riders: delete dead `SCROLLBACK_REPLAY_LINES` + stale comment (TerminalPane.jsx:92-95); update the now-obsolete large-restore rationale comments (pty.rs:41-48, TerminalPane.jsx:775-779) in the same commit.
Replay safety (audit-verified): replay is fully OSC-suppressed (`restoringScrollback` gates OSC 133 + PlutoCmd) — truncation cannot corrupt block/sticky machinery.

## T7 — SSH idle backoff (SSH ONLY)

Serial is out: its 100ms port read-timeout IS the backoff, and serial writes bypass the reader loop entirely (audit F18) — serial gets only the inline coalescer flush on TimedOut.
SSH: replace `thread::sleep(8ms)` with **`write_rx.recv_timeout(backoff)`** — a keystroke wakes the loop instantly (send immediately, fold into the normal drain); backoff escalates 8→16→32ms on consecutive idle timeouts; resets to 8ms on ANY activity, read OR write (audit F17 — the sleep-gates-both-directions trap: plain sleep would have ADDED ~64ms to SSH echo; recv_timeout makes idle CPU drop AND latency improve). Pure `Backoff` struct, unit-tested.

## Gates & measurement

cargo test (coalescer, rotation incl. share_mode(0) contention, tail-slice incl. offset-0 identity, handles, backoff, reap-shape) + full suite; vitest; build. Debug-only `PTY_STATS` env flag: emits/sec + bytes/emit counters; record a `yes`-flood before/after in the stream log. Whole-stream adversarial audit → fix → re-review every fix → per-task commits.

## Non-goals

VNC/RDP frame path (after P1 proves the pattern), frontend replay gating (P4-3), transcript fold-into-reader.
