// PTY session management for the Terminals tab.
//
// Each session = one shell child process spawned via portable-pty (ConPTY on
// Windows, Unix PTYs elsewhere). The renderer drives the session through the
// `pty_*` Tauri commands; PTY output is streamed back as `pty://{id}` events.
//
// Lifecycle is tied to the SessionRegistry stored as Tauri state. On app exit,
// kill_all() runs from the RunEvent::ExitRequested handler in lib.rs so we
// never orphan a shell child.
//
// Scrollback persistence (v0.1.29):
// The reader thread also appends each output chunk to the on-disk scrollback
// file owned by commands::scrollback_path. This replaces the previous unmount-
// time renderer-side scrollback_save, which raced the process death on
// tray→Quit (the async invoke() never reached Rust before the process exited,
// so scrollback was lost). The Rust-side write is synchronous to the reader
// thread, so every chunk that hits xterm.js is on disk by the time control
// returns. Tail-truncation keeps the file bounded.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::coalesce::Coalescer;
use crate::commands::scrollback_path;
use crate::session::new_id;

// File-size policy (P1-T2 ping-pong rotation): scrollback lives in two
// segment files, `<id>.txt` (current) + `<id>.old.txt` (previous). When the
// current segment exceeds SCROLLBACK_SEGMENT_BYTES it is renamed over `.old`
// and a fresh current is opened — O(1), no read-back, replacing the previous
// truncate_tail which re-read + rewrote 15MB inline ON the PTY reader thread
// (stalling the pane's drain for the whole round trip every 5MB of output).
// Total per-tab budget stays ≤ ~10MB (5MB × 2 segments). The old in-place
// rewrite survives only as the one-shot fallback for a failed rename (AV/
// indexer holding the target without FILE_SHARE_DELETE — our own fs::read
// loads DON'T block rename; std opens FILE_SHARE_READ|WRITE|DELETE).
//
// v0.1.32 history: budget bumped from 200KB/100KB to 10MB/5MB for restore-on-
// relaunch. (T6 caps what's actually REPLAYED to a tail slice — the disk
// budget and the replay payload are decoupled.)
const SCROLLBACK_SEGMENT_BYTES: u64 = 5_000_000;

// ── Output coalescing (P1-T1, plan 2026-08-12-P1-pty-hot-path.md) ───────────
//
// One emit per 4KB read melted the main thread under floods (2-5k
// JSON+eval round-trips/sec/pane) and could silently DROP output past
// Windows' 10k posted-message cap. Every decoded chunk now flows through a
// per-session Coalescer; emits happen at most every ~8ms or 64KB.
//
// Lock-order invariants (binding, from the audited plan):
//   1. Extraction AND emit are atomic under the session's single coalescer
//      mutex — channel order == extraction order. No separate emit mutex.
//   2. The flusher takes the coalescer map only to snapshot Arc clones,
//      releases it, then locks each coalescer. Never emit under a map lock.
//   3. The dirty-set condvar mutex is a leaf: taken only after every other
//      lock is released.
const COALESCE_MAX_BYTES: usize = 64 * 1024;
const COALESCE_MAX_AGE: Duration = Duration::from_millis(8);
/// Hard per-session ceiling on retained-but-undeliverable output (review
/// CRITICAL: retain-on-Err + a flooding pane would otherwise grow without
/// bound while the webview is stalled). Whole-buffer drop + marker, same
/// shape as SSH_OUTBOUND_MAX_BYTES.
const COALESCE_PENDING_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Cadence of the flusher's full-scan backstop; a HARD bound — the scan runs
/// whenever this much time has passed since the last one, no matter how busy
/// the notify traffic is.
const FLUSHER_HEARTBEAT: Duration = Duration::from_millis(250);
/// Consecutive emit failures between backlog marker lines (re-announced every
/// N failures; each marker is itself best-effort on the saturated queue).
const EMIT_FAIL_MARKER_AFTER: u32 = 50;
const BACKLOG_MARKER: &str =
    "\r\n\x1b[1;31m[Pluto's Terminal] output delivery backlogged — retrying.\x1b[0m\r\n";

/// Recover a poisoned lock instead of dying: the guarded data (id sets/maps,
/// the session registry, a writer handle) is structurally valid regardless of
/// where a panicking thread stopped, and a dead flusher would silently stall
/// EVERY local session's age-flushes.
///
/// This is the ONE lock idiom for this file (L3 follow-up). The earlier
/// `.lock().map_err(|_| "registry mutex poisoned")?` on the hot commands meant
/// a single panic under any sessions guard bricked every terminal in the app —
/// no typing, spawning, resizing or killing — while the window still looked
/// alive, recoverable only by restart. Do not reintroduce the map_err shape.
fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Emission seam (review W5): production is AppHandle; tests inject failures
/// per flush path without a webview.
pub trait EmitSink {
    fn emit_pty(&self, id: &str, payload: &str) -> bool;
}

impl EmitSink for AppHandle {
    fn emit_pty(&self, id: &str, payload: &str) -> bool {
        self.emit(&format!("pty://{id}"), payload).is_ok()
    }
}

pub struct CoEntry {
    co: Mutex<Coalescer>,
    fails: AtomicU32,
    /// Local PTYs age-flush via the global flusher; SSH/serial flush inline on
    /// their own idle branches. The heartbeat scan filters on this so inline
    /// transports genuinely never enter the dirty set.
    use_ticker: bool,
}

impl CoEntry {
    fn fresh(use_ticker: bool) -> Arc<Self> {
        Arc::new(Self {
            co: Mutex::new(Coalescer::new(
                COALESCE_MAX_BYTES,
                COALESCE_MAX_AGE,
                COALESCE_PENDING_MAX_BYTES,
                Instant::now(),
            )),
            fails: AtomicU32::new(0),
            use_ticker,
        })
    }
}

/// Lost-wakeup-proof flush signal: the dirty set is mutated ONLY under the
/// condvar's own mutex, and the flusher re-checks it under that mutex before
/// every wait. The FLUSHER_HEARTBEAT full scan is the drift backstop.
#[derive(Default)]
pub struct DirtySignal {
    set: Mutex<HashSet<String>>,
    cv: Condvar,
}

impl DirtySignal {
    fn mark(&self, id: &str) {
        let mut set = lock_recover(&self.set);
        set.insert(id.to_string());
        self.cv.notify_one();
    }
    fn clear(&self, id: &str) {
        lock_recover(&self.set).remove(id);
    }
}

/// Surface cap-dropped bytes as a marker line, in-sequence under the lock.
/// Deliberate property: when emits are failing this marker likely fails too —
/// the count is RESTORED on a failed marker emit, so the loss notice survives
/// until an op runs while the sink is healthy and can actually deliver it.
fn surface_drops(sink: &dyn EmitSink, id: &str, co: &mut Coalescer) {
    let d = co.take_dropped();
    if d > 0 {
        let delivered = sink.emit_pty(
            id,
            &format!(
                "\r\n\x1b[1;31m[Pluto's Terminal] output overflow: {d} bytes dropped while delivery was stalled.\x1b[0m\r\n"
            ),
        );
        if !delivered {
            co.restore_dropped(d);
        }
    }
}

/// Emit `out` for `id` while HOLDING its coalescer lock (invariant 1). On
/// failure — synchronously reportable on Windows when the message queue is
/// full — the payload is retained at the FRONT of pending for the next flush;
/// order holds because nothing can append while the caller owns the lock.
fn emit_under_lock(
    sink: &dyn EmitSink,
    id: &str,
    entry: &CoEntry,
    co: &mut Coalescer,
    out: String,
    now: Instant,
) -> bool {
    // No surface_drops here: every core operation makes exactly ONE trailing
    // surface_drops call after its last emit attempt (re-review 1b — the
    // doubled call re-attempted an undeliverable marker back-to-back).
    if sink.emit_pty(id, &out) {
        entry.fails.store(0, Ordering::Relaxed);
        true
    } else {
        let n = entry.fails.fetch_add(1, Ordering::Relaxed) + 1;
        co.retain_front(out, now);
        if n % EMIT_FAIL_MARKER_AFTER == 0 {
            let _ = sink.emit_pty(id, BACKLOG_MARKER);
        }
        false
    }
}

/// Reader-side chunk path, seam-injectable core. Returns true when the caller
/// must mark the session dirty (ticker sessions only): the buffer became
/// pending, OR a flush attempt failed and its payload was retained — a failed
/// leading-edge/size flush must not strand bytes outside the flusher's view
/// (review W2).
fn coalesce_chunk_core(
    sink: &dyn EmitSink,
    id: &str,
    entry: &CoEntry,
    chunk: &str,
    use_ticker: bool,
    now: Instant,
) -> bool {
    // Per-session poison degrades per-session BY DESIGN (load-bearing,
    // re-review-verified): every dirty-set insertion path requires a
    // successful co.lock()/has_pending() read, so a poisoned session is
    // consumed out of the dirty set once and never re-inserted — silent
    // exclusion of that one session, zero churn, everything else unaffected.
    let Ok(mut co) = entry.co.lock() else { return false };
    let was_pending = co.has_pending();
    let mut needs_mark = false;
    if let Some(out) = co.push(chunk, now) {
        if !emit_under_lock(sink, id, entry, &mut co, out, now) {
            needs_mark = use_ticker;
        }
    } else if use_ticker && !was_pending && co.has_pending() {
        needs_mark = true;
    }
    surface_drops(sink, id, &mut co);
    needs_mark
}

fn coalesce_chunk(app: &AppHandle, id: &str, entry: &Arc<CoEntry>, chunk: &str, use_ticker: bool) {
    if coalesce_chunk_core(app, id, entry, chunk, use_ticker, Instant::now()) {
        // Condvar mutex only after the coalescer lock is released (invariant 3).
        app.state::<SessionRegistry>().dirty.mark(id);
    }
}

/// Drain everything pending and emit it, seam-injectable core. `exit` = this
/// is a teardown path: retry a failed emit once, then drop the tail (the
/// session is going away). Non-exit callers leave a failed emit retained.
fn flush_pending_core(sink: &dyn EmitSink, id: &str, entry: &CoEntry, exit: bool, now: Instant) {
    let Ok(mut co) = entry.co.lock() else { return };
    if let Some(out) = co.take(now) {
        if !emit_under_lock(sink, id, entry, &mut co, out, now) && exit {
            if let Some(out2) = co.take(now) {
                if !emit_under_lock(sink, id, entry, &mut co, out2, now) {
                    let _ = co.take(now); // second failure on a dying session: drop
                }
            }
        }
    }
    surface_drops(sink, id, &mut co);
}

fn flush_pending(app: &AppHandle, id: &str, entry: &Arc<CoEntry>, exit: bool) {
    flush_pending_core(app, id, entry, exit, Instant::now());
}

/// Register a session's coalescer; the reader thread keeps the returned Arc.
fn coalescer_insert(registry: &SessionRegistry, id: &str, use_ticker: bool) -> Arc<CoEntry> {
    let entry = CoEntry::fresh(use_ticker);
    lock_recover(&registry.coalescers).insert(id.to_string(), entry.clone());
    entry
}

/// Reader-exit cleanup: drop the coalescer map entry and any dirty flag.
fn coalescer_remove(app: &AppHandle, id: &str) {
    let registry = app.state::<SessionRegistry>();
    lock_recover(&registry.coalescers).remove(id);
    registry.dirty.clear(id);
    // Drop the H8 window-ownership tag too (review W2): every natural-exit
    // teardown (local EOF, SSH drop, serial unplug) funnels through here, so a
    // session that ends itself no longer leaks a stale id→window tag until its
    // window is destroyed / the app exits. (pty_kill removes the tag directly.)
    lock_recover(&registry.owner).remove(id);
}

/// Snapshot ticker-session Arcs (map lock released before any per-session
/// lock — invariant 2), then collect the ids with pending output.
fn scan_pending_ticker_ids(registry: &SessionRegistry) -> Vec<String> {
    let snapshot: Vec<(String, Arc<CoEntry>)> = lock_recover(&registry.coalescers)
        .iter()
        .filter(|(_, e)| e.use_ticker)
        .map(|(k, e)| (k.clone(), e.clone()))
        .collect();
    snapshot
        .into_iter()
        .filter(|(_, e)| e.co.lock().map(|c| c.has_pending()).unwrap_or(false))
        .map(|(k, _)| k)
        .collect()
}

/// Global age-flusher for local PTY coalescers. Parks on the dirty-set condvar
/// (predicate owned by the condvar mutex); while sessions are pending it ticks
/// at ~COALESCE_MAX_AGE cadence, snapshotting Arcs from the map before locking
/// any session (invariant 2). The heartbeat scan runs whenever
/// FLUSHER_HEARTBEAT has elapsed since the last one — parked OR busy — so no
/// notify pattern can starve the backstop (review W3). Poisoned global locks
/// are recovered, never fatal (review W4). Detached; dies with the process.
pub fn start_flusher(app: AppHandle) {
    thread::spawn(move || {
        let mut last_heartbeat = Instant::now();
        loop {
            let registry = app.state::<SessionRegistry>();
            let mut ids: Vec<String> = Vec::new();
            {
                let mut set = lock_recover(&registry.dirty.set);
                while set.is_empty() {
                    let wait = FLUSHER_HEARTBEAT
                        .saturating_sub(last_heartbeat.elapsed())
                        .max(Duration::from_millis(10));
                    let (s, _res) = registry
                        .dirty
                        .cv
                        .wait_timeout(set, wait)
                        .unwrap_or_else(|p| p.into_inner());
                    set = s;
                    if last_heartbeat.elapsed() >= FLUSHER_HEARTBEAT {
                        // Leaf discipline both directions: release the condvar
                        // mutex, scan, re-acquire.
                        drop(set);
                        let found = scan_pending_ticker_ids(&registry);
                        last_heartbeat = Instant::now();
                        set = lock_recover(&registry.dirty.set);
                        for id in found {
                            set.insert(id);
                        }
                    }
                }
                ids.extend(set.drain());
            }
            // Let the youngest pending bytes approach max_age, then age-flush.
            thread::sleep(COALESCE_MAX_AGE);
            let now = Instant::now();
            // One map lock to resolve all ids (killed sessions drop out).
            let entries: Vec<(String, Arc<CoEntry>)> = {
                let map = lock_recover(&registry.coalescers);
                ids.iter()
                    .filter_map(|id| map.get(id).map(|e| (id.clone(), e.clone())))
                    .collect()
            };
            let mut still_pending: Vec<String> = Vec::new();
            for (id, entry) in entries {
                let Ok(mut co) = entry.co.lock() else { continue };
                if let Some(out) = co.tick(now) {
                    let _ = emit_under_lock(&app, &id, &entry, &mut co, out, now);
                }
                surface_drops(&app, &id, &mut co);
                if co.has_pending() {
                    still_pending.push(id);
                }
            }
            if !still_pending.is_empty() {
                let mut set = lock_recover(&registry.dirty.set);
                for id in still_pending {
                    set.insert(id);
                }
            }
            // Busy-path heartbeat: a stuck session must be swept into view even
            // when other sessions keep the dirty set nonempty forever.
            if last_heartbeat.elapsed() >= FLUSHER_HEARTBEAT {
                let found = scan_pending_ticker_ids(&registry);
                last_heartbeat = Instant::now();
                if !found.is_empty() {
                    let mut set = lock_recover(&registry.dirty.set);
                    for id in found {
                        set.insert(id);
                    }
                }
            }
        }
    });
}

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    // Behind its own mutex so the registry lock only guards the map structure,
    // never the (potentially blocking) write. A backpressured PTY write must
    // not stall keystrokes/resizes/spawns/kills on every other session.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// One-shot readiness signal — the reader thread blocks on the matching
    /// receiver before its first emit so the shell's initial prompt burst can't
    /// race ahead of the frontend's `pty://{id}` listener (a fast local shell
    /// prints its prompt within microseconds). Fired by `pty_ready`.
    ready: mpsc::Sender<()>,
}

impl PtySession {
    /// Kill + reap by VALUE — callable only on a session already removed from
    /// the registry, which makes wait-under-lock structurally impossible
    /// (P1-T4, plan-audit F13): the old Drop-side wait() froze EVERY pane's
    /// keystrokes whenever a tab closed, because `drop(sessions.remove(&id))`
    /// waited on the child while holding the registry mutex that pty_write
    /// and pty_resize also need.
    fn reap(mut self) {
        let _ = self.child.kill();
        // Collect the exit status so the killed child doesn't linger as a
        // zombie on unix. kill-first means wait() returns promptly.
        let _ = self.child.wait();
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Last resort only — reap(self) is the sanctioned teardown. NO wait()
        // here: a future `sessions.remove(&id);` with an unbound temporary
        // would otherwise silently reintroduce wait-under-lock and compile
        // clean. An unreaped-killed child on such a path dies with the
        // process (and is a non-concept on Windows).
        let _ = self.child.kill();
    }
}

/// Control signals to an SSH session's reader thread. Resize is the only live
/// control message; kill happens implicitly when the registry entry (and thus
/// the `SshHandle`'s senders) is dropped — the reader thread sees the channel
/// disconnect and tears the connection down.
enum SshCtrl {
    Resize(u16, u16),
}

/// Registry-side handle to an SSH session. The `ssh2::Channel` is `!Sync` and is
/// used for both reads and writes, so it lives *solely* on the reader thread.
/// `pty_write` pushes bytes through `writes`; `pty_resize` pushes through
/// `ctrl`. Dropping this handle drops both senders, which the reader thread
/// detects (recv disconnect) and exits — closing the channel + TCP connection.
pub struct SshHandle {
    writes: mpsc::Sender<Vec<u8>>,
    ctrl: mpsc::Sender<SshCtrl>,
    /// One-shot readiness signal. The reader thread blocks on the matching
    /// receiver before its first read, so the server's initial MOTD/prompt burst
    /// can't be emitted before the frontend's `pty://{id}` listener exists.
    /// `pty_ready` fires this once the listener is attached. Replaces a fixed
    /// 150ms warm-up that lost the race whenever the listener registration's two
    /// IPC round-trips ran long (busy event loop, other tabs streaming).
    ready: mpsc::Sender<()>,
}

/// Registry-side handle to a serial-port session. The write half lives here for
/// `pty_write`; the reader thread owns a cloned handle and loops on a short read
/// timeout, checking `alive` so `pty_kill` can stop it promptly.
pub struct SerialHandle {
    // Behind its own mutex for the same reason as PtySession::writer — keep
    // blocking serial I/O off the shared registry lock.
    writer: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    alive: Arc<AtomicBool>,
    /// Readiness gate, same as PtySession::ready — wait for the frontend's
    /// `pty://{id}` listener before the first emit. Fired by `pty_ready`.
    ready: mpsc::Sender<()>,
}

/// A live session, transport-agnostic. Local PTYs, SSH channels, and serial
/// ports share one registry and one set of `pty_*` commands so none of the
/// renderer's xterm/scrollback/cost/activity machinery has to know the difference.
pub enum Session {
    Local(PtySession),
    Ssh(SshHandle),
    Serial(SerialHandle),
}

#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, Session>>,
    /// Per-session output coalescers (P1-T1). Separate map so the hot flush
    /// path never contends with the session map that guards writes/kills.
    coalescers: Mutex<HashMap<String, Arc<CoEntry>>>,
    dirty: DirtySignal,
    /// session id → owning window label (audit H8). Recorded at pty_ready (the
    /// one transport-agnostic post-spawn choke point). Lets the
    /// WindowEvent::Destroyed handler proactively reap a secondary window's
    /// sessions when a fast close / Alt+F4 outruns the frontend's per-tab
    /// pty_kill, instead of leaking the shell child + threads until app exit.
    owner: Mutex<HashMap<String, String>>,
}

/// On-disk scrollback writer owned by a single PTY reader thread.
///
/// Every chunk that flows from PTY → xterm is also appended here, so a hard
/// process death (tray→Quit, OS shutdown, crash) at most loses the bytes that
/// are still in the OS write-buffer — typically <4KB. The renderer-side
/// scrollback_save path used to race the process exit; this owns the file
/// instead so there's no IPC round-trip on the hot path.
///
/// Rotation: when `bytes_on_disk` exceeds `segment_bytes`, the current file
/// is renamed over `<id>.old.txt` (clobbering the previous segment) and a
/// fresh current is opened — constant-time on the reader thread. NO BufWriter
/// anywhere here (deliberate, re-review F11): every chunk is in the OS buffer
/// by the time emit returns, so tray→Quit loses at most the current chunk —
/// the v0.1.29 durability contract this module was built around.
struct ScrollbackWriter {
    path: PathBuf,
    // Held open for the session lifetime so high-throughput output (e.g.
    // `cat largefile`) doesn't pay an open+close syscall on every chunk.
    // `None` only between a failed open and the next lazy retry, or while a
    // rotation swaps files. write(2) hands bytes to the OS buffer just
    // as the per-chunk open path did, so hard-process-death durability is
    // unchanged — only the syscall overhead drops.
    file: Option<File>,
    bytes_on_disk: u64,
    /// Segment cap — a field (not the const) so tests rotate at toy sizes.
    segment_bytes: u64,
}

impl ScrollbackWriter {
    /// Create a new writer for a tab. Creates parent dirs eagerly. Seeds
    /// `bytes_on_disk` from any existing file so we don't lose track on a
    /// pane that was previously persisted, and opens the append handle once.
    /// A legacy over-budget single file (pre-rotation, up to 10MB) simply
    /// rotates whole into `.old` on the first over-cap append — no migration.
    fn new(path: PathBuf) -> Self {
        Self::with_segment(path, SCROLLBACK_SEGMENT_BYTES)
    }

    fn with_segment(path: PathBuf, segment_bytes: u64) -> Self {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let bytes_on_disk = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        Self {
            path,
            file,
            bytes_on_disk,
            segment_bytes,
        }
    }

    /// `<id>.txt` → `<id>.old.txt`, the previous-segment sibling.
    fn old_path(&self) -> PathBuf {
        self.path.with_extension("old.txt")
    }

    /// (Re)open the append handle against the current file. Used after a tail
    /// rewrite swapped the inode, or to recover from an earlier open failure.
    fn reopen(&mut self) {
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .ok();
    }

    /// Append a chunk. Best-effort: on I/O failure we silently swallow rather
    /// than tear down the PTY reader — losing scrollback is worse for the
    /// pane's correctness than losing scrollback durability.
    fn append(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        // Self-heal if a prior open/truncate left us without a handle, without
        // reopening on every chunk in the common (handle-present) path.
        if self.file.is_none() {
            self.reopen();
        }
        if let Some(f) = self.file.as_mut() {
            if f.write_all(bytes).is_ok() {
                self.bytes_on_disk = self.bytes_on_disk.saturating_add(bytes.len() as u64);
            }
        }
        if self.bytes_on_disk > self.segment_bytes {
            self.rotate();
        }
    }

    /// Constant-time segment rotation: current → `.old` (clobber), fresh
    /// current. Runs on the reader thread, so it must never re-read the file.
    fn rotate(&mut self) {
        // Close our own append handle FIRST: rename on this toolchain has
        // POSIX semantics, so a live handle would follow the file into `.old`
        // and every subsequent append would land in the wrong segment.
        self.file = None;
        match fs::rename(&self.path, self.old_path()) {
            Ok(()) => {
                self.bytes_on_disk = 0;
                self.reopen();
            }
            Err(_) => {
                // Third-party handle without FILE_SHARE_DELETE on the target
                // (AV scanner, indexer, backup agent) — our own reads don't
                // block rename. One-shot in-place fallback bounds the file;
                // the counter resyncs on every path inside.
                self.truncate_in_place();
            }
        }
    }

    /// Fallback only (rotation rename failed): rewrite the current file to
    /// keep the last `segment_bytes`, aligned to the first newline after the
    /// cut so ANSI escape sequences don't straddle the boundary. Atomic via
    /// write-tmp + rename. This is the pre-T2 truncate_tail, demoted from the
    /// hot path — it re-reads the whole file, which is exactly what rotation
    /// exists to avoid.
    fn truncate_in_place(&mut self) {
        self.file = None;
        let Ok(data) = fs::read(&self.path) else {
            self.reopen();
            return;
        };
        let keep_bytes = self.segment_bytes as usize;
        if data.len() <= keep_bytes {
            self.bytes_on_disk = data.len() as u64;
            self.reopen();
            return;
        }
        // Initial cut at exactly the segment size from the end, then walk
        // forward to the next newline (within 4KB) so we start cleanly.
        let cut_from_start = data.len() - keep_bytes;
        let scan_end = (cut_from_start + 4096).min(data.len());
        let aligned = data[cut_from_start..scan_end]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| cut_from_start + i + 1)
            .unwrap_or(cut_from_start);
        let kept = &data[aligned..];

        let tmp_path = self.path.with_extension("txt.tmp");
        if fs::write(&tmp_path, kept).is_ok() && fs::rename(&tmp_path, &self.path).is_ok() {
            self.bytes_on_disk = kept.len() as u64;
        } else {
            // Rewrite failed too (disk full, permissions): file unchanged and
            // still over the cap. Sync the counter to the real on-disk size so
            // we don't re-enter this whole-file read on every append chunk.
            self.bytes_on_disk = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        }
        self.reopen();
    }
}

/// Cap on the SSH outbound buffer while the channel's flow-control window is
/// stalled. Past this the connection is effectively wedged — we drop ALL
/// pending writes (never silently a partial chunk) and tell the user.
const SSH_OUTBOUND_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Idle-wait escalation for the SSH reader loop (P1-T7). The fixed 8ms sleep
/// burned 125 wakeups/s per IDLE session; escalating 8→16→32ms cuts that to
/// ~31/s while `recv_timeout` on the write channel keeps keystroke latency
/// BETTER than the old sleep (a write wakes the loop instantly instead of
/// waiting out the sleep). Serial is excluded: its 100ms port read-timeout IS
/// its backoff, and serial writes bypass the reader loop entirely.
struct Backoff {
    cur: Duration,
}

impl Backoff {
    const FLOOR: Duration = Duration::from_millis(8);
    const CEIL: Duration = Duration::from_millis(32);

    fn new() -> Self {
        Self { cur: Self::FLOOR }
    }

    /// The wait to use NOW; escalates for the next consecutive idle round.
    fn wait(&mut self) -> Duration {
        let w = self.cur;
        self.cur = (self.cur * 2).min(Self::CEIL);
        w
    }

    fn reset(&mut self) {
        self.cur = Self::FLOOR;
    }
}

/// Decode one streamed byte chunk as UTF-8, carrying any incomplete trailing
/// multibyte sequence in `pending` for the next call. A naive per-chunk
/// `from_utf8_lossy` permanently corrupts a multibyte char that straddles a
/// read boundary (it becomes U+FFFD in both the emit and the scrollback file);
/// this keeps the ≤3 trailing bytes of an unfinished sequence and prepends
/// them to the next chunk instead. Genuinely invalid bytes (error mid-buffer,
/// i.e. `error_len()` is Some) still fall back to lossy decoding, matching the
/// old behavior for non-UTF-8 shell output (CP-1252 etc.).
pub(crate) fn decode_utf8_stream(pending: &mut Vec<u8>, new_bytes: &[u8]) -> String {
    pending.extend_from_slice(new_bytes);
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_owned();
            pending.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            // Incomplete sequence at the tail (≤3 bytes by UTF-8 construction):
            // decode the valid prefix, carry the tail.
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out
        }
        Err(_) => {
            // Invalid bytes mid-buffer — lossy-decode everything.
            let out = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            out
        }
    }
}

#[cfg(test)]
mod utf8_stream_tests {
    use super::decode_utf8_stream;

    #[test]
    fn multibyte_split_across_chunks_is_not_corrupted() {
        // The whole point of the carry: a char straddling a read boundary must not
        // become U+FFFD. 😀 = F0 9F 98 80, split down the middle.
        let mut p = Vec::new();
        let a = decode_utf8_stream(&mut p, &[0xF0, 0x9F]);
        assert_eq!(a, ""); // nothing decodable yet
        assert_eq!(p, vec![0xF0, 0x9F]); // incomplete tail carried
        let b = decode_utf8_stream(&mut p, &[0x98, 0x80]);
        assert_eq!(b, "😀");
        assert!(p.is_empty());
    }

    #[test]
    fn valid_prefix_emitted_incomplete_tail_carried() {
        // "ab" + first byte of é (C3), then the rest (A9).
        let mut p = Vec::new();
        assert_eq!(decode_utf8_stream(&mut p, &[0x61, 0x62, 0xC3]), "ab");
        assert_eq!(p, vec![0xC3]);
        assert_eq!(decode_utf8_stream(&mut p, &[0xA9]), "é");
        assert!(p.is_empty());
    }

    #[test]
    fn complete_utf8_returns_all_and_clears() {
        let mut p = Vec::new();
        assert_eq!(decode_utf8_stream(&mut p, "hello".as_bytes()), "hello");
        assert!(p.is_empty());
    }

    #[test]
    fn invalid_midbuffer_falls_back_to_lossy_and_clears() {
        // A genuinely invalid byte mid-buffer (non-UTF-8 shell output) must not be
        // carried forever; it lossy-decodes and clears (old CP-1252 behavior).
        let mut p = Vec::new();
        let s = decode_utf8_stream(&mut p, &[0x41, 0xFF, 0x42]); // A, invalid, B
        assert!(s.contains('\u{FFFD}'));
        assert!(s.starts_with('A') && s.ends_with('B'));
        assert!(p.is_empty());
    }
}

#[cfg(target_os = "windows")]
fn pick_shell() -> (String, Vec<String>) {
    let candidates: Vec<Option<String>> = vec![
        std::env::var("ProgramFiles")
            .ok()
            .map(|p| format!("{}\\PowerShell\\7\\pwsh.exe", p)),
        std::env::var("ProgramFiles(x86)")
            .ok()
            .map(|p| format!("{}\\PowerShell\\7\\pwsh.exe", p)),
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|p| format!("{}\\Microsoft\\PowerShell\\7\\pwsh.exe", p)),
        // winget installs PowerShell 7 as an MSIX/Store package — pwsh is reached
        // via its execution alias here (modern PSReadLine = autosuggestions).
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|p| format!("{}\\Microsoft\\WindowsApps\\pwsh.exe", p)),
    ];
    for opt in candidates.into_iter().flatten() {
        if std::path::Path::new(&opt).exists() {
            return (opt, vec!["-NoLogo".into()]);
        }
    }
    // Fallback: Windows PowerShell 5 with PSReadLine.
    //
    // v0.1.31: dropped the `Clear-Host` that used to run alongside the
    // PSReadLine import. -NoLogo already suppresses the startup banner, so
    // Clear-Host was redundant — and when ConPTY translated `[Console]::Clear()`
    // it sometimes erased the scrollback buffer that scrollback_load had just
    // replayed (visible briefly, then gone). Removing it lets the replay
    // survive into the live session, which is the whole point of v0.1.29+.
    (
        "powershell.exe".into(),
        vec![
            "-NoLogo".into(),
            "-NoExit".into(),
            "-Command".into(),
            "Import-Module PSReadLine -ErrorAction SilentlyContinue".into(),
        ],
    )
}

#[cfg(not(target_os = "windows"))]
fn pick_shell() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    (shell, vec![])
}

/// Expand ${VARNAME} placeholders in a string. Resolution order: caller-
/// supplied `extra` map first, then the process env, then empty string for
/// unknowns. Used by pty_spawn so prompt packs ship cross-machine paths like
/// "${USERPROFILE}/Documents/myvault", and the renderer can pass app-settings
/// values (VAULT, custom keys) that aren't in the parent process env.
fn expand_env_vars_with_extra(s: &str, extra: &Option<HashMap<String, String>>) -> String {
    let mut result = String::with_capacity(s.len());
    let mut remaining = s;
    while let Some(start) = remaining.find("${") {
        result.push_str(&remaining[..start]);
        let after = &remaining[start + 2..];
        if let Some(end) = after.find('}') {
            let var_name = &after[..end];
            if !var_name.is_empty() {
                let value = extra
                    .as_ref()
                    .and_then(|m| m.get(var_name).cloned())
                    .or_else(|| std::env::var(var_name).ok())
                    .unwrap_or_default();
                result.push_str(&value);
                remaining = &after[end + 1..];
                continue;
            }
        }
        // Couldn't find closing } or empty var — treat "${" as literal.
        result.push_str("${");
        remaining = &remaining[start + 2..];
    }
    result.push_str(remaining);
    result
}

/// Thin async wrapper (P1-T5): ConPTY CreateProcess takes tens-to-hundreds of
/// ms on Windows, and the sync command shape ran it ON THE MAIN THREAD — N
/// restored tabs at boot serialized N process creations through the UI.
/// Registry insert still happens before Ok(id) returns (inside the sync
/// core), so no frontend write can race a not-yet-registered session.
/// Double-spawn safety is unchanged: the frontend's entry-identity orphan
/// guard kills a spawn whose pane entry was superseded while awaiting.
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    window: tauri::WebviewWindow,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    extra_env: Option<HashMap<String, String>>,
    tab_id: Option<String>,
) -> Result<String, String> {
    // Owning-window label captured here (audit H8, review W1): tag ownership at
    // BIRTH inside the sync core alongside the sessions insert, not later at
    // pty_ready — so a window destroyed during the spawn→ready gap can't leave
    // an untagged, unreapable orphan.
    let owner_label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        pty_spawn_sync(app, owner_label, cwd, cols, rows, extra_env, tab_id)
    })
    .await
    .map_err(|e| format!("spawn task failed: {e}"))?
}

fn pty_spawn_sync(
    app: AppHandle,
    owner_label: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    extra_env: Option<HashMap<String, String>>,
    tab_id: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(10),
            cols: cols.max(40),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let (shell_cmd, shell_args) = pick_shell();
    let mut cmd = CommandBuilder::new(&shell_cmd);
    for arg in shell_args {
        cmd.arg(arg);
    }

    // Validate cwd; fall back to home if unusable so a bad path doesn't exit-loop the shell.
    // Also expand ${VARNAME} placeholders — first against the caller-supplied
    // extra_env (so VAULT / ANTHROPIC_API_KEY etc. saved in app settings work
    // even though they aren't in the parent process env), then against the
    // process env. So prompt packs ship cross-machine paths
    // (e.g. "${USERPROFILE}/Documents/myvault" or "${VAULT}") without manual edits.
    if let Some(p) = cwd.as_deref() {
        let expanded = expand_env_vars_with_extra(p, &extra_env);
        let path = std::path::Path::new(&expanded);
        if path.exists() && path.is_dir() {
            cmd.cwd(&expanded);
        }
    }

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("FORCE_COLOR", "1");
    cmd.env("CLICOLOR", "1");

    // Optional caller-supplied env (e.g. ANTHROPIC_API_KEY persisted from the
    // welcome screen). Each new spawned shell inherits these so `claude` and
    // friends just work without a per-shell paste.
    if let Some(env_map) = extra_env {
        for (k, v) in env_map {
            cmd.env(k, v);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;

    let id = new_id("pty");
    let (ready_tx, ready_rx) = mpsc::channel::<()>();
    let session = PtySession {
        master: pair.master,
        child,
        writer: Arc::new(Mutex::new(writer)),
        ready: ready_tx,
    };
    lock_recover(&app.state::<SessionRegistry>().sessions)
        .insert(id.clone(), Session::Local(session));
    // Tag ownership at birth (audit H8) — sessions lock above is already
    // released, so this second lock never nests (lock-order safe).
    lock_recover(&app.state::<SessionRegistry>().owner).insert(id.clone(), owner_label);

    // Build the scrollback writer if the renderer supplied a tab_id. Owning
    // the file from this thread (rather than from a renderer-side unmount
    // handler) means every chunk that goes to xterm is also on disk before
    // we move on. tray→Quit and OS shutdown therefore lose at most the bytes
    // still in the OS write buffer (typically <4KB).
    let mut scrollback_writer = tab_id
        .as_ref()
        .map(|tid| ScrollbackWriter::new(scrollback_path(&app, tid)));

    // Reader thread: pump bytes -> Tauri event AND scrollback file.
    // Exits on EOF / read error.
    //
    // v0.1.30: write the lossy-decoded chunk bytes (same as what we emit to
    // xterm), not the raw read bytes. PowerShell on Windows can emit non-
    // UTF-8 bytes (CP-1252 smart quotes, em-dashes, etc.). The xterm emit
    // path already lossy-converts to valid UTF-8 with U+FFFD replacements;
    // the disk file needs to match because scrollback_load uses
    // String::from_utf8_lossy on read — but if the file has invalid UTF-8
    // and the read implementation is strict, we'd lose the whole file.
    // Writing the lossy bytes guarantees the file is valid UTF-8.
    let co_entry = coalescer_insert(&app.state::<SessionRegistry>(), &id, true);
    let id_for_thread = id.clone();
    let app_for_thread = app.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 65536];
        // Wait for the frontend's `pty://{id}` listener (signaled via pty_ready)
        // before the first emit, so a fast shell's initial prompt can't race
        // ahead of the subscription. Output stays buffered in the OS pipe until
        // the first read below, so nothing is dropped. The 2s timeout is a
        // fallback for a lost/never-sent signal (matches the SSH path); the
        // frontend attaches its listener before signaling, so a fallback start
        // still streams to a live listener — it just costs this latency.
        let _ = ready_rx.recv_timeout(Duration::from_secs(2));
        // Incomplete trailing UTF-8 bytes carried across read chunks (see
        // decode_utf8_stream) so a multibyte char straddling a read boundary
        // isn't corrupted to U+FFFD in the emit + scrollback file.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = decode_utf8_stream(&mut pending, &buf[..n]);
                    if chunk.is_empty() {
                        continue;
                    }
                    // Persist the same UTF-8 bytes xterm receives, so a hard
                    // process death between emit and disk-flush still
                    // preserves what we just rendered. Best-effort. Disk gets
                    // every chunk immediately; only the EMIT is coalesced.
                    if let Some(w) = scrollback_writer.as_mut() {
                        w.append(chunk.as_bytes());
                    }
                    coalesce_chunk(&app_for_thread, &id_for_thread, &co_entry, &chunk, true);
                }
                Err(_) => break,
            }
        }
        // EOF with an unfinished sequence still buffered — flush it lossily so
        // no bytes are silently dropped.
        if !pending.is_empty() {
            let tail = String::from_utf8_lossy(&pending).into_owned();
            if let Some(w) = scrollback_writer.as_mut() {
                w.append(tail.as_bytes());
            }
            coalesce_chunk(&app_for_thread, &id_for_thread, &co_entry, &tail, true);
        }
        // Drain the coalescer BEFORE pty-exit so the tail can never arrive
        // after the exit event (invariant 1 makes exit strictly last).
        flush_pending(&app_for_thread, &id_for_thread, &co_entry, true);
        coalescer_remove(&app_for_thread, &id_for_thread);
        // The shell exited on its own (EOF/read error): reap the registry entry
        // here rather than waiting on a pty_kill the frontend might never send,
        // otherwise the Session (and its zombie child) leaks until app exit.
        // Remove under the lock, REAP AFTER the guard is gone (P1-T4) — the
        // old `drop(sessions.remove(..))` waited on the child while holding
        // the registry mutex, stalling every other pane's keystrokes.
        // lock_recover, not `.lock().ok()` (L3 follow-up): swallowing poison
        // here silently leaked the Session + its zombie child until app exit.
        let removed = lock_recover(&app_for_thread.state::<SessionRegistry>().sessions)
            .remove(&id_for_thread);
        if let Some(Session::Local(s)) = removed {
            s.reap(); // reader thread, no locks held — free to block
        }
        let _ = app_for_thread.emit(&format!("pty-exit://{}", id_for_thread), ());
    });

    Ok(id)
}

/// A write destination cloned out of the registry so the actual (potentially
/// blocking) write runs *after* the registry guard is dropped. SSH writes are
/// already a non-blocking mpsc send, so they're handled inline under the lock.
enum WriteTarget {
    Local(Arc<Mutex<Box<dyn Write + Send>>>),
    Serial(Arc<Mutex<Box<dyn serialport::SerialPort>>>),
}

#[tauri::command]
pub async fn pty_write(
    state: State<'_, SessionRegistry>,
    id: String,
    data: String,
) -> Result<(), String> {
    pty_write_sync(state, id, data)
}

/// Sync body of `pty_write` — also called directly by the companion-server
/// dispatcher (`companion.rs`), which runs outside Tauri's IPC layer.
pub fn pty_write_sync(
    state: State<'_, SessionRegistry>,
    id: String,
    data: String,
) -> Result<(), String> {
    // Short critical section: resolve the session, then either fire the
    // non-blocking SSH send inline or clone out the writer Arc. The registry
    // guard drops at the end of this block — BEFORE any blocking I/O — so a
    // backpressured write to one pane can't stall keystrokes/resizes/kills/
    // spawns on every other session sharing the registry lock.
    let target = {
        let mut sessions = lock_recover(&state.sessions);
        match sessions.get_mut(&id).ok_or("session not found")? {
            Session::Ssh(h) => {
                h.writes
                    .send(data.into_bytes())
                    .map_err(|_| "ssh session closed".to_string())?;
                return Ok(());
            }
            Session::Local(s) => WriteTarget::Local(s.writer.clone()),
            Session::Serial(h) => WriteTarget::Serial(h.writer.clone()),
        }
        // registry guard dropped here
    };

    // Blocking I/O outside the registry lock, holding only this session's own
    // writer mutex (uncontended — the renderer drives one xterm per tab).
    // Poison is recovered like the registry locks: the guarded value is a
    // writer HANDLE (structurally valid wherever a panicking thread stopped),
    // and the alternative is a pane that can never be typed into again.
    match target {
        WriteTarget::Local(w) => {
            let mut w = lock_recover(&w);
            w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        }
        WriteTarget::Serial(w) => {
            let mut w = lock_recover(&w);
            w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
            let _ = w.flush();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, SessionRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty_resize_sync(state, id, cols, rows)
}

/// Sync body of `pty_resize` — also called directly by the companion-server
/// dispatcher (`companion.rs`), which runs outside Tauri's IPC layer.
pub fn pty_resize_sync(
    state: State<'_, SessionRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = lock_recover(&state.sessions);
    match sessions.get(&id).ok_or("session not found")? {
        Session::Local(s) => {
            s.master
                .resize(PtySize {
                    rows: rows.max(10),
                    cols: cols.max(40),
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
        }
        Session::Ssh(h) => {
            h.ctrl
                .send(SshCtrl::Resize(cols.max(40), rows.max(10)))
                .map_err(|_| "ssh session closed".to_string())?;
        }
        // Serial ports have no concept of terminal size — nothing to resize.
        Session::Serial(_) => {}
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, SessionRegistry>, id: String) -> Result<(), String> {
    // Remove under a SHORT lock; all blocking teardown happens on an owned
    // value with the guard long gone (P1-T4 — the old shape waited on the
    // child inside the registry mutex, freezing every pane's keystrokes for
    // the duration of a process exit).
    let removed = {
        let mut sessions = lock_recover(&state.sessions);
        sessions.remove(&id)
    };
    lock_recover(&state.owner).remove(&id); // drop the H8 ownership tag (no-op if untagged)
    match removed {
        Some(Session::Local(s)) => {
            // ConPTY kill+wait can block; keep it off the async runtime too.
            let _ = tauri::async_runtime::spawn_blocking(move || s.reap()).await;
        }
        Some(Session::Serial(h)) => {
            h.alive.store(false, Ordering::Relaxed);
        }
        // Ssh: dropping the handle's senders signals its reader thread, which
        // closes the channel + TCP connection on its own.
        Some(Session::Ssh(_)) | None => {}
    }
    Ok(())
}

/// Signal that the frontend has attached its `pty://{id}` listener and the
/// session may begin streaming output. Every transport's reader thread blocks
/// on this before its first emit so the initial prompt/MOTD burst can't race
/// the subscription. Safe to call for any session id — an unknown id is a no-op.
#[tauri::command]
pub fn pty_ready(state: State<'_, SessionRegistry>, id: String) -> Result<(), String> {
    let sessions = lock_recover(&state.sessions);
    // Each reader thread recv's exactly once; a redundant/late send (e.g. after
    // the timeout fallback already let it proceed) is buffered+unread, so
    // ignoring the result is safe for every variant.
    match sessions.get(&id) {
        Some(Session::Local(s)) => {
            let _ = s.ready.send(());
        }
        Some(Session::Ssh(h)) => {
            let _ = h.ready.send(());
        }
        Some(Session::Serial(h)) => {
            let _ = h.ready.send(());
        }
        None => {}
    }
    Ok(())
}

/// Basename of the shell new tabs will spawn (e.g. "zsh", "pwsh.exe"). Surfaced
/// in the status bar so users can see at a glance which shell they're in.
/// Matches whatever `pick_shell` chooses for this platform.
#[tauri::command]
pub fn default_shell() -> String {
    let (shell, _) = pick_shell();
    std::path::Path::new(&shell)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or(shell)
}

// ───────────────────────────── SSH transport ──────────────────────────────

/// Auth method for an SSH session, mirroring the frontend session model.
/// `password` is transient — the frontend prompts at connect time and never
/// persists it. `key_path`/`passphrase` are for key auth; `agent` needs neither.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAuth {
    pub method: String, // "password" | "key" | "agent"
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Base64, standard alphabet. `pad` controls the trailing `=`: the OpenSSH-style
/// "SHA256:…" host-key fingerprint is unpadded, a known_hosts key blob is padded
/// (that is what libssh2's own writer emits and its reader expects). Tiny inline
/// impl avoids a base64 dep.
fn base64(data: &[u8], pad: bool) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(A[((n >> 18) & 63) as usize] as char);
        out.push(A[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(A[((n >> 6) & 63) as usize] as char);
        } else if pad {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(A[(n & 63) as usize] as char);
        } else if pad {
            out.push('=');
        }
    }
    out
}

/// The OpenSSH key-algorithm name for this key type, as it appears on a
/// known_hosts line. Must match libssh2's own writer (knownhost.c
/// `knownhost_writeline`), because libssh2's reader is what parses our line
/// back on the next connect.
fn host_key_name(t: ssh2::HostKeyType) -> Result<&'static str, String> {
    use ssh2::HostKeyType;
    Ok(match t {
        HostKeyType::Rsa => "ssh-rsa",
        HostKeyType::Dss => "ssh-dss",
        HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
        HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
        HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
        HostKeyType::Ed25519 => "ssh-ed25519",
        HostKeyType::Unknown => return Err("server uses an unknown host-key type".into()),
    })
}

/// Build the single OpenSSH `known_hosts` line that pins this host key.
///
/// The host field follows OpenSSH: `[host]:port` for a non-default port, the
/// bare `host` for 22. That is also the order libssh2's `check_port` probes
/// (knownhost.c:374 tries `[host]:port` first, then the bare name), so a line
/// written this way is found on the first probe, and the same host reached on
/// two different ports can no longer collide on one pin. Pins already on disk
/// under the bare name still match, via check_port's second probe.
fn known_hosts_line(
    host: &str,
    port: u16,
    key_type: ssh2::HostKeyType,
    key: &[u8],
) -> Result<String, String> {
    // Whitespace in the host field would parse back as an entirely different
    // entry. Refuse rather than write a pin that means something else.
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err(format!("refusing to pin a host key under the name {host:?}"));
    }
    let name = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    Ok(format!(
        "{name} {} {} added by Pluto's Terminal",
        host_key_name(key_type)?,
        base64(key, true)
    ))
}

/// Append one line to `known_hosts`, creating the file (and `~/.ssh`) if needed.
///
/// Append, never rewrite. `KnownHosts::write_file` serialises libssh2's entire
/// in-memory collection over the file, and that collection is routinely a subset
/// of what is on disk: libssh2's reader BREAKS out of its parse loop on the first
/// line it cannot handle (knownhost.c:975) and never stores comments or blank
/// lines at all. Rewriting from it silently deletes the user's other pins out of
/// a file that `ssh`, `git` and `scp` share, taking their MITM protection with
/// them (audit R1/SEC-1). An append can only ever add our own line.
fn append_known_host_line(path: &Path, line: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let mut f = OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    // Plenty of real known_hosts files end without a trailing newline; a bare
    // append would fuse our entry onto the tail of theirs and destroy both. The
    // handle is append-mode, so writes still land at EOF after this seek. We
    // seek only to LOOK at the last byte.
    let needs_newline = match f.metadata().map(|m| m.len()) {
        Ok(0) | Err(_) => false,
        Ok(_) => {
            let mut last = [0u8; 1];
            f.seek(SeekFrom::End(-1))
                .and_then(|_| f.read_exact(&mut last))
                .is_ok()
                && last[0] != b'\n'
        }
    };
    let mut out = String::new();
    if needs_newline {
        out.push('\n');
    }
    out.push_str(line.trim_matches(|c| c == '\r' || c == '\n'));
    out.push('\n');
    f.write_all(out.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    f.flush()
        .map_err(|e| format!("flush {}: {e}", path.display()))
}

/// Why libssh2 could not hand us the whole of `known_hosts`.
///
/// Both variants make a NotFound answer from libssh2 untrustworthy, but they are
/// not equivalent. `Unopened` is recoverable: the file is usually healthy and
/// only libssh2's narrow-CRT open failed, so the lookup is redone here. There is
/// no such recovery for `Unparsed`, where the file really does hold a line
/// nothing can read. They are not equivalent to the user either: they point at
/// two different fixes, and the wrong one costs pins. Told to "remove the
/// malformed line" of a file that has none, the obvious next move is to empty
/// the file, which loses exactly what the append-never-rewrite rule above exists
/// to protect (audit R1/SEC-1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KnownHostsGap {
    /// libssh2 never opened the file. Its reader goes through the NARROW CRT
    /// `fopen` (knownhost.c:973, `FOPEN_READTEXT`), so on Windows a path the
    /// active ANSI code page cannot represent fails here while Rust's wide API
    /// reads the same file perfectly; an unreadable-permissions file lands here
    /// too. NOTHING is loaded, so EVERY host reads as first-seen, not merely the
    /// ones below some line. Recoverable, unlike `Unparsed`: the file itself is
    /// usually fine, so `scan_known_hosts` reads it here instead.
    Unopened,
    /// libssh2 opened it and broke out of the parse loop on a line it could not
    /// handle (knownhost.c:975-980), so every entry below that line is missing.
    Unparsed,
}

/// Classify a `KnownHosts::read_file` failure. libssh2 surfaces both failure
/// modes as a bare `Err` and the code is the only thing that separates them:
/// `LIBSSH2_ERROR_FILE` (-16) is its `fopen` failing, while the parse loop
/// reports `LIBSSH2_ERROR_KNOWN_HOSTS` (-46).
fn classify_known_hosts_error(code: ssh2::ErrorCode) -> KnownHostsGap {
    match code {
        ssh2::ErrorCode::Session(-16) => KnownHostsGap::Unopened,
        // Anything else keeps the long-standing reading. Guessing "unopened" on
        // a code we do not recognise would blame the wrong thing in the one
        // direction that talks the user into editing a healthy file.
        _ => KnownHostsGap::Unparsed,
    }
}

/// What our own read of `known_hosts` can say about a host.
///
/// Only consulted when libssh2 could not open the file, so its own answer is
/// worthless. The rules deliberately mirror libssh2's `check_port` rather than
/// OpenSSH's: the same two probe forms (knownhost.c:372-386), the same
/// case-sensitive comparison, and the algorithm field ignored exactly as
/// libssh2 ignores it (the ssh2 crate passes no KEY_MASK bits, so knownhost.c:
/// 451-461 matches on the base64 key blob alone). Agreeing with the library is
/// the point: a host must not read as known down one path and new down the
/// other. Where this differs it only ever refuses what libssh2 would have
/// allowed, never the reverse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalPinScan {
    /// An entry names this host and holds exactly this key.
    Match,
    /// An entry names this host and holds a different key: a changed host key.
    Mismatch,
    /// Nothing in the file names this host, so it is genuinely first-seen.
    NotFound,
    /// The file holds something this reader cannot evaluate, so "nothing names
    /// this host" cannot be trusted and accept-new is not safe. Carries what it
    /// tripped over, because the user's fix differs per cause.
    Undecidable(&'static str),
}

/// Whether one `known_hosts` host field (`a,b,!c`) covers any of the names.
enum PatternMatch {
    Yes,
    No,
    /// `|1|salt|hash`: an HMAC-SHA1 of the host name under a per-entry salt.
    /// Nothing in this build can compute it, so the entry cannot be ruled in
    /// OR out.
    Hashed,
}

/// `*` (any run) and `?` (exactly one character), the two wildcards OpenSSH
/// allows in a `known_hosts` host pattern.
///
/// Iterative with a single backtrack point rather than recursive, so a pattern
/// full of stars cannot go exponential on a long host name.
fn glob_match(pat: &str, name: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let n: Vec<char> = name.chars().collect();
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut resume) = (usize::MAX, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            resume = ni;
            pi += 1;
        } else if star != usize::MAX {
            // Give the last `*` one more character and retry from there.
            pi = star + 1;
            resume += 1;
            ni = resume;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Match a comma-separated host field against the names `check_port` probes.
fn host_patterns_match(field: &str, names: &[&str]) -> PatternMatch {
    let mut hit = false;
    for pat in field.split(',') {
        if pat.starts_with('|') {
            return PatternMatch::Hashed;
        }
        let (negated, pat) = match pat.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, pat),
        };
        if names.iter().any(|n| glob_match(pat, n)) {
            if negated {
                // OpenSSH's negation excludes the WHOLE entry, not just this
                // pattern, so there is nothing left to match here.
                return PatternMatch::No;
            }
            hit = true;
        }
    }
    if hit {
        PatternMatch::Yes
    } else {
        PatternMatch::No
    }
}

/// Look `host` up in `known_hosts` ourselves, through Rust's wide file API.
///
/// This exists because libssh2's reader goes through the NARROW CRT `fopen`
/// (knownhost.c:973). On Windows that cannot open a path the active ANSI code
/// page cannot represent, which is every profile directory belonging to a
/// Cyrillic, CJK or accented username. The file is perfectly healthy and every
/// other read in this module opens it fine; only libssh2's cannot. Doing the
/// lookup here closes that loop, and it is the same loop `append_known_host_line`
/// already writes through.
///
/// Anything this reader cannot evaluate answers `Undecidable` rather than
/// `NotFound`, because the two are not interchangeable: `NotFound` authorises
/// accept-new, and getting that wrong on an already-pinned host is exactly the
/// blind trust an MITM needs.
fn scan_known_hosts(
    path: &Path,
    host: &str,
    port: u16,
    key: &[u8],
) -> Result<LocalPinScan, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    // libssh2 stores the key as base64 and compares with strcmp, so comparing
    // the encoded forms is the same comparison, and it needs no decoder.
    let wanted = base64(key, true);
    // The two names check_port probes, in its order: the port-scoped form
    // first, then the bare host, for EVERY port (knownhost.c:372-386). A bare
    // pin therefore answers on any port, which is what the pins already on disk
    // from before the bracket form was written rely on.
    let ported = format!("[{host}]:{port}");
    let names = [ported.as_str(), host];

    let mut matched_key = false;
    let mut mismatched = false;
    let mut undecidable: Option<&'static str> = None;

    for line in bytes.split(|b| *b == b'\n') {
        let Ok(line) = std::str::from_utf8(line) else {
            undecidable = undecidable.or(Some("a line that is not valid UTF-8"));
            continue;
        };
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('@') {
            // @cert-authority delegates trust to a CA key, and @revoked forbids
            // a key outright. Both change the answer for hosts this scan would
            // otherwise call first-seen, and neither is evaluable here.
            undecidable = undecidable.or(Some("a @cert-authority or @revoked marker"));
            continue;
        }
        let mut fields = line.split_whitespace();
        let (Some(patterns), Some(_algorithm), Some(blob)) =
            (fields.next(), fields.next(), fields.next())
        else {
            undecidable = undecidable.or(Some("a line it could not parse"));
            continue;
        };
        match host_patterns_match(patterns, &names) {
            PatternMatch::Hashed => {
                undecidable = undecidable.or(Some("a hashed host name"));
            }
            PatternMatch::No => {}
            PatternMatch::Yes if blob == wanted => matched_key = true,
            PatternMatch::Yes => mismatched = true,
        }
    }

    // Precedence, and the order matters. A key we positively recognise wins
    // only when the whole file was readable, since an entry this reader skipped
    // could be a @revoked line for that very key. A host known under a
    // DIFFERENT key is reported ahead of an unreadable line because both refuse
    // and "the key changed" is the sharper warning of the two.
    Ok(match (matched_key, mismatched, undecidable) {
        (true, _, None) => LocalPinScan::Match,
        (_, true, _) => LocalPinScan::Mismatch,
        (_, _, Some(what)) => LocalPinScan::Undecidable(what),
        _ => LocalPinScan::NotFound,
    })
}

/// Pin a first-seen host key (OpenSSH "accept-new").
///
/// `gap` is `None` when libssh2 read the WHOLE file (or there is no file yet).
/// Split out of `verify_host_key` so the pinning decision is reachable without a
/// live SSH session, which is the only way it can be tested.
fn pin_new_host_key(
    kh_path: &Path,
    gap: Option<KnownHostsGap>,
    host: &str,
    port: u16,
    key_type: ssh2::HostKeyType,
    key: &[u8],
) -> Result<(), String> {
    // An incomplete read makes check_port answer NotFound for hosts that ARE
    // already pinned, so accept-new here would blind-trust one of them and an
    // active MITM on it would read as a first sighting. Match/Mismatch stay
    // trustworthy, so only this branch refuses.
    match gap {
        None => {}
        Some(KnownHostsGap::Unparsed) => {
            return Err(format!(
                "cannot safely verify {host}:{port}: {} could not be fully parsed, so an \
                 already-known host can read as first-seen. Refusing to trust a new key. \
                 Fix or remove the malformed line and reconnect.",
                kh_path.display()
            ));
        }
        Some(KnownHostsGap::Unopened) => {
            // libssh2 loaded NOTHING, so the NotFound that got us here says
            // nothing about this host. Refusing outright was the first answer
            // and it was wrong: libssh2 opens the file through the narrow CRT,
            // so a Windows profile path the active ANSI code page cannot
            // represent lands here on a completely healthy file, and refusing
            // left every user with a non-ASCII username unable to SSH to ANY
            // new host. Fail-closed cannot mean the feature is dead for a whole
            // class of users. Our own reads and writes go through the wide API,
            // which opens the same file fine, so do the lookup here and decide
            // on evidence again.
            match scan_known_hosts(kh_path, host, port, key) {
                // Already pinned under this exact key. Nothing to add: a second
                // identical line is noise the user then has to reconcile.
                Ok(LocalPinScan::Match) => return Ok(()),
                Ok(LocalPinScan::Mismatch) => {
                    return Err(format!(
                        "HOST KEY MISMATCH for {host}:{port}: {} already pins a different \
                         key for it. Refusing to connect (possible man-in-the-middle). If \
                         this change was intentional, remove the host's line from that file \
                         and reconnect.",
                        kh_path.display()
                    ));
                }
                // Genuinely first-seen, on the evidence of the whole file.
                Ok(LocalPinScan::NotFound) => {}
                Ok(LocalPinScan::Undecidable(what)) => {
                    return Err(format!(
                        "cannot safely verify {host}:{port}: {} could not be opened by the \
                         SSH library, and reading it here found {what}, so an already-known \
                         host can still read as first-seen. Refusing to trust a new key. Do \
                         not empty the file, that would lose the keys it has already pinned.",
                        kh_path.display()
                    ));
                }
                Err(e) => {
                    return Err(format!(
                        "cannot safely verify {host}:{port}: {} could not be opened by the \
                         SSH library and cannot be read here either ({e}), so NOTHING is \
                         loaded and every host reads as first-seen. Refusing to trust a new \
                         key. Do not empty the file, that would lose the keys it has already \
                         pinned.",
                        kh_path.display()
                    ));
                }
            }
        }
    }
    let line = known_hosts_line(host, port, key_type, key)?;
    append_known_host_line(kh_path, &line)
        .map_err(|e| format!("failed to record the host key for {host}:{port}: {e}"))
}

/// Verify the server's host key against the user's `~/.ssh/known_hosts`, with
/// OpenSSH "accept-new" semantics: a matching known key proceeds; a *changed*
/// key is REFUSED (possible MITM); a first-seen host is pinned and allowed.
/// Returns the SHA-256 fingerprint for display/logging.
fn verify_host_key(sess: &ssh2::Session, host: &str, port: u16) -> Result<String, String> {
    let (key, key_type) = sess.host_key().ok_or("server presented no host key")?;
    // Copy out of the session borrow: the key has to outlive the KnownHosts
    // read and the pin below, both of which drive libssh2 again.
    let key = key.to_vec();

    let fingerprint = sess
        .host_key_hash(ssh2::HashType::Sha256)
        .map(|h| format!("SHA256:{}", base64(h, false)))
        .unwrap_or_else(|| "unknown".into());

    let mut known = sess.known_hosts().map_err(|e| e.to_string())?;
    let kh_path = home_dir()
        .map(|h| h.join(".ssh").join("known_hosts"))
        .ok_or("cannot locate home directory for known_hosts")?;
    // A missing file just means "no hosts known yet", not an error. Any OTHER
    // failure leaves the collection short of what is on disk, so a NotFound
    // below cannot be trusted to mean the host is genuinely new: libssh2 either
    // never opened the file, or broke out of its parse loop and dropped every
    // entry past that line. Match and Mismatch stay trustworthy either way.
    let gap = match known.read_file(&kh_path, ssh2::KnownHostFileKind::OpenSSH) {
        Ok(_) => None,
        Err(_) if !kh_path.exists() => None,
        Err(e) => Some(classify_known_hosts_error(e.code())),
    };

    match known.check_port(host, port, &key) {
        ssh2::CheckResult::Match => Ok(fingerprint),
        ssh2::CheckResult::Mismatch => Err(format!(
            "HOST KEY MISMATCH for {host}:{port} — the server's key changed ({fingerprint}). \
             Refusing to connect (possible man-in-the-middle). If this change was intentional, \
             remove the host's line from ~/.ssh/known_hosts and reconnect."
        )),
        ssh2::CheckResult::NotFound => {
            // First sight: pin the key (accept-new) so a later change is caught.
            pin_new_host_key(&kh_path, gap, host, port, key_type, &key)?;
            Ok(fingerprint)
        }
        ssh2::CheckResult::Failure => Err("host-key check failed".into()),
    }
}

#[cfg(test)]
mod known_hosts_tests {
    // Audit R1/SEC-1: pinning a first-seen host key used to read the user's
    // ~/.ssh/known_hosts into libssh2 and write the WHOLE collection back, which
    // deletes everything libssh2's parser could not load. `verify_host_key`
    // itself needs a live SSH session, so the pinning half is split into
    // `pin_new_host_key` and exercised here against a real file.
    use super::*;

    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    /// A private `<tmp>/<unique>/.ssh/known_hosts` path. The dir does NOT exist
    /// yet, so every test also proves the create-parents path.
    fn kh_path(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let mut p = std::env::temp_dir();
        p.push(format!("plutokh-{}-{n}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p.join(".ssh").join("known_hosts")
    }

    /// The same private path with non-ASCII characters in it: the shape of
    /// Windows profile path this whole branch is about. libssh2's reader goes
    /// through the NARROW CRT `fopen` (knownhost.c:973), so on a box whose
    /// active ANSI code page cannot represent these characters it cannot open
    /// the file at all, while every read here goes through Rust's wide API and
    /// works. Written as escapes so the source file stays ASCII.
    fn kh_path_non_ascii(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let mut p = std::env::temp_dir();
        p.push(format!(
            "plutokh-Bj\u{f6}rn-\u{41c}\u{438}\u{448}\u{430}-\u{6f22}\u{5b57}-{}-{n}-{tag}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&p);
        p.join(".ssh").join("known_hosts")
    }

    // 32 bytes: an ed25519 blob is not a multiple of 3, so this also pins the
    // base64 padding the line format needs.
    fn key() -> Vec<u8> {
        (0u8..32).collect()
    }

    /// A DIFFERENT key for the same host: what an active MITM looks like.
    fn other_key() -> Vec<u8> {
        (32u8..64).collect()
    }

    /// Load `path` into a real libssh2 known-hosts collection, with no server
    /// anywhere.
    ///
    /// `ssh2::Session::new()` allocates no socket (ssh2-0.9.6 session.rs:160
    /// leaves `tcp: None`) and `known_hosts()` is a bare `libssh2_knownhost_init`
    /// on it, so libssh2's own parser and `check_port` are both reachable
    /// entirely offline. Every other test here asserts on the STRING we produce,
    /// which only proves our formatter agrees with itself. `known_hosts_line` is
    /// hand-rolled specifically to be read back by this parser, so the contract
    /// that actually matters is whether libssh2 accepts what we wrote, and this
    /// is the only thing that answers it. `read_file` erroring IS the assertion:
    /// its reader breaks out of the parse loop on a line it cannot handle
    /// (knownhost.c:975).
    fn libssh2_reads(path: &Path) -> ssh2::KnownHosts {
        let sess = ssh2::Session::new().expect("libssh2 session (no socket needed)");
        let mut known = sess.known_hosts().expect("knownhost collection");
        known
            .read_file(path, ssh2::KnownHostFileKind::OpenSSH)
            .unwrap_or_else(|e| panic!("libssh2 refused the known_hosts we wrote: {e}"));
        known
    }

    #[test]
    fn pinning_preserves_every_existing_byte_of_known_hosts() {
        // The R1 failure: the file holds a comment, a blank line, a good entry,
        // a line libssh2's parser aborts on, and a good entry BELOW it. A
        // rewrite-from-the-parse keeps at most the first entry. An append keeps
        // the whole file, so the original must survive as a byte-exact prefix.
        let path = kh_path("preserve");
        let original = concat!(
            "# my hosts, hand-maintained\n",
            "\n",
            "gitlab.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB\n",
            "broken.example.com this-line-libssh2-cannot-parse\n",
            "prod-db.internal ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB me@work\n",
        );
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, original).unwrap();

        pin_new_host_key(&path, None, "new-host.example.com", 22, ssh2::HostKeyType::Ed25519, &key())
            .unwrap();

        let after = fs::read_to_string(&path).unwrap();
        assert!(
            after.starts_with(original),
            "pinning must not rewrite the file; it now reads:\n{after}"
        );
        assert_eq!(after.lines().count(), original.lines().count() + 1);
        assert!(after.lines().last().unwrap().starts_with("new-host.example.com ssh-ed25519 "));
    }

    #[test]
    fn pinning_does_not_glue_onto_a_last_line_with_no_newline() {
        // Plenty of real known_hosts files end without a trailing newline. A bare
        // append would fuse our entry onto the tail of theirs and destroy BOTH.
        let path = kh_path("noeol");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "last.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB").unwrap();

        pin_new_host_key(&path, None, "new.example.com", 22, ssh2::HostKeyType::Ed25519, &key())
            .unwrap();

        let after = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = after.lines().collect();
        assert_eq!(lines.len(), 2, "the two entries must stay separate lines: {after:?}");
        assert_eq!(lines[0], "last.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB");
        assert!(lines[1].starts_with("new.example.com ssh-ed25519 "));
    }

    #[test]
    fn refuses_to_pin_when_the_file_was_not_fully_parsed() {
        // A partial parse makes check_port answer NotFound for every host at or
        // below the bad line, so accept-new would blind-trust a host that IS
        // already pinned, and an active MITM on it would read as a first sighting.
        let path = kh_path("partial");
        let original = "good.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB\n";
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, original).unwrap();

        let err = pin_new_host_key(
            &path,
            Some(KnownHostsGap::Unparsed),
            "new.example.com",
            22,
            ssh2::HostKeyType::Ed25519,
            &key(),
        )
        .unwrap_err();

        assert!(err.contains("malformed line"), "unhelpful error: {err}");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            original,
            "a refused pin must not touch the file"
        );
    }

    #[test]
    fn a_known_hosts_libssh2_could_not_open_is_not_reported_as_a_malformed_line() {
        // libssh2 reports "could not open the file" and "aborted mid-parse" as
        // the same bare Err, and both used to read as a parse failure. The two
        // are not interchangeable to the user: sending someone whose file merely
        // could not be OPENED off to "fix or remove the malformed line" points
        // at contents that are perfectly fine, and the obvious next move is to
        // empty the file, losing every pin R1 exists to protect.
        //
        // An unopened file no longer refuses on its own, because our own read
        // usually settles it. This is the case where it cannot: a hashed host
        // name needs an HMAC-SHA1 over the name under a per-entry salt, which
        // nothing in this build can compute, so the entry can be neither ruled
        // in nor out and accept-new stays unsafe. The refusal survives; the
        // wrong explanation must still not come with it.
        let path = kh_path("unopenable");
        let original = concat!(
            "|1|F1E1jrLZDBHQOJ6xUCPP1p3jGxg=|nMbLnbFHCEE4vsxJn7pSt2E5+2g= ",
            "ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB\n"
        );
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, original).unwrap();

        let err = pin_new_host_key(
            &path,
            Some(KnownHostsGap::Unopened),
            "new.example.com",
            22,
            ssh2::HostKeyType::Ed25519,
            &key(),
        )
        .unwrap_err();

        assert!(
            !err.contains("malformed line") && !err.contains("fully parsed"),
            "blames a malformed line in a file that has none: {err}"
        );
        assert!(err.contains("could not be opened"), "unhelpful error: {err}");
        assert!(err.contains("hashed host name"), "must name the real cause: {err}");
        // Still fail closed: the hashed entry could be this very host.
        assert!(err.contains("Refusing to trust a new key"), "must still refuse: {err}");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            original,
            "a refused pin must not touch the file"
        );
    }

    #[test]
    fn a_failed_open_and_a_failed_parse_are_told_apart_by_their_libssh2_code() {
        // knownhost.c:986 answers LIBSSH2_ERROR_FILE (-16) when its fopen fails,
        // and :977 answers LIBSSH2_ERROR_KNOWN_HOSTS (-46) when a line will not
        // parse. Both arrive as a bare Err, so the code is the whole signal.
        use ssh2::ErrorCode::Session;
        assert_eq!(classify_known_hosts_error(Session(-16)), KnownHostsGap::Unopened);
        assert_eq!(classify_known_hosts_error(Session(-46)), KnownHostsGap::Unparsed);
        // An unrecognised code keeps the old reading rather than claiming a file
        // could not be opened when we do not actually know that.
        assert_eq!(classify_known_hosts_error(Session(-1)), KnownHostsGap::Unparsed);
    }

    #[test]
    fn pinning_creates_the_ssh_dir_and_file_on_a_fresh_machine() {
        let path = kh_path("fresh");
        assert!(!path.exists());

        pin_new_host_key(&path, None, "first.example.com", 22, ssh2::HostKeyType::Rsa, &key())
            .unwrap();

        let after = fs::read_to_string(&path).unwrap();
        assert!(after.starts_with("first.example.com ssh-rsa "));
        assert!(after.ends_with('\n'));
    }

    #[test]
    fn non_default_ports_pin_under_the_bracket_form() {
        // OpenSSH's own convention, and the first thing libssh2's check_port
        // looks up. Port 22 stays bare or the bracket form would never match.
        let bare = known_hosts_line("h.example.com", 22, ssh2::HostKeyType::Ed25519, &key()).unwrap();
        assert!(bare.starts_with("h.example.com ssh-ed25519 "), "{bare}");
        let ported =
            known_hosts_line("h.example.com", 2222, ssh2::HostKeyType::Ed25519, &key()).unwrap();
        assert!(ported.starts_with("[h.example.com]:2222 ssh-ed25519 "), "{ported}");
    }

    #[test]
    fn key_type_names_match_what_libssh2_writes_and_reads() {
        // These strings are the contract with libssh2's own parser; a typo would
        // pin a line that silently never matches again (knownhost.c:782-793).
        use ssh2::HostKeyType::*;
        for (t, want) in [
            (Rsa, "ssh-rsa"),
            (Dss, "ssh-dss"),
            (Ecdsa256, "ecdsa-sha2-nistp256"),
            (Ecdsa384, "ecdsa-sha2-nistp384"),
            (Ecdsa521, "ecdsa-sha2-nistp521"),
            (Ed25519, "ssh-ed25519"),
        ] {
            let line = known_hosts_line("h", 22, t, &key()).unwrap();
            assert_eq!(line.split(' ').nth(1).unwrap(), want, "in line: {line}");
        }
        assert!(known_hosts_line("h", 22, Unknown, &key()).is_err());
    }

    #[test]
    fn a_host_name_with_whitespace_is_refused_rather_than_written() {
        // "evil.example.com other.example.com" would parse back as a pin for a
        // host we never talked to.
        for bad in ["evil.example.com other.example.com", "with\ttab", ""] {
            assert!(
                known_hosts_line(bad, 22, ssh2::HostKeyType::Ed25519, &key()).is_err(),
                "{bad:?} should not produce a line"
            );
        }
    }

    #[test]
    fn libssh2_matches_the_pin_we_wrote_for_it() {
        // The round trip the string assertions cannot make: write the line with
        // our own formatter, hand the file to libssh2, and let ITS check_port
        // answer. A padding slip, a key-name typo or a host field libssh2 reads
        // differently all land as NotFound here, which in production is a pin
        // that silently never matches again, so every reconnect re-pins and a
        // changed key never raises the MISMATCH it exists to raise.
        let path = kh_path("roundtrip");
        pin_new_host_key(&path, None, "h.example.com", 22, ssh2::HostKeyType::Ed25519, &key())
            .unwrap();

        let known = libssh2_reads(&path);

        assert!(
            matches!(known.check_port("h.example.com", 22, &key()), ssh2::CheckResult::Match),
            "libssh2 does not recognise its own pin: {:?}",
            known.check_port("h.example.com", 22, &key())
        );
        // And the whole point of pinning: a different key on that host is the
        // MITM answer, not another first sighting.
        assert!(
            matches!(
                known.check_port("h.example.com", 22, &other_key()),
                ssh2::CheckResult::Mismatch
            ),
            "a changed key must read as Mismatch: {:?}",
            known.check_port("h.example.com", 22, &other_key())
        );
    }

    #[test]
    fn libssh2_scopes_a_non_default_port_pin_to_that_port() {
        // `[host]:port` is what check_port probes first (knownhost.c:374). The
        // string test above proves we WRITE that form; this proves libssh2 reads
        // it back as the port-scoped entry it is meant to be, so a dev box on
        // 2222 and a bastion on 22 can no longer share one pin.
        let path = kh_path("ported");
        pin_new_host_key(&path, None, "h.example.com", 2222, ssh2::HostKeyType::Ed25519, &key())
            .unwrap();

        let known = libssh2_reads(&path);

        assert!(
            matches!(known.check_port("h.example.com", 2222, &key()), ssh2::CheckResult::Match),
            "the bracket form must match on its own port: {:?}",
            known.check_port("h.example.com", 2222, &key())
        );
        assert!(
            matches!(known.check_port("h.example.com", 22, &key()), ssh2::CheckResult::NotFound),
            "port 22 must not inherit the 2222 pin: {:?}",
            known.check_port("h.example.com", 22, &key())
        );
    }

    #[test]
    fn a_pin_appended_after_a_missing_final_newline_still_parses() {
        // `pinning_does_not_glue_onto_a_last_line_with_no_newline` checks this by
        // splitting the file ourselves, which cannot see what libssh2 makes of
        // the result. A fused line would leave OUR entry unfindable and take the
        // pre-existing one with it, and both failures are silent.
        let path = kh_path("noeol-roundtrip");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "last.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB").unwrap();

        pin_new_host_key(&path, None, "new.example.com", 22, ssh2::HostKeyType::Ed25519, &key())
            .unwrap();

        let known = libssh2_reads(&path);

        assert!(
            matches!(known.check_port("new.example.com", 22, &key()), ssh2::CheckResult::Match),
            "the appended pin must survive the newline repair: {:?}",
            known.check_port("new.example.com", 22, &key())
        );
    }

    #[test]
    fn known_hosts_keys_are_padded_but_fingerprints_are_not() {
        // libssh2 emits padded base64 for the key blob and its reader expects it;
        // the SHA256: fingerprint OpenSSH shows the user is unpadded.
        let line = known_hosts_line("h", 22, ssh2::HostKeyType::Ed25519, &key()).unwrap();
        let blob = line.split(' ').nth(2).unwrap();
        assert_eq!(blob.len() % 4, 0, "key blob must be padded: {blob}");
        assert!(blob.ends_with('='), "32 bytes needs one pad char: {blob}");
        assert!(!base64(&key(), false).contains('='));
        assert_eq!(base64(b"", true), "");
        assert_eq!(base64(b"a", true), "YQ==");
        assert_eq!(base64(b"ab", true), "YWI=");
        assert_eq!(base64(b"abc", true), "YWJj");
    }

    #[test]
    fn a_non_ascii_profile_path_can_still_pin_a_new_host() {
        // The regression: refusing outright whenever libssh2 could not OPEN the
        // file killed accept-new for every user whose profile path the narrow
        // CRT cannot represent, which is to say every Cyrillic, CJK or accented
        // Windows username. Fail-closed cannot mean the feature is dead for a
        // whole class of users, so the lookup is done here instead.
        let path = kh_path_non_ascii("newhost");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = "other.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB\n";
        fs::write(&path, original).unwrap();

        pin_new_host_key(
            &path,
            Some(KnownHostsGap::Unopened),
            "new.example.com",
            22,
            ssh2::HostKeyType::Ed25519,
            &key(),
        )
        .unwrap();

        let after = fs::read_to_string(&path).unwrap();
        assert!(after.starts_with(original), "the existing pin must survive: {after}");
        assert!(
            after.lines().last().unwrap().starts_with("new.example.com ssh-ed25519 "),
            "the new host must be pinned: {after}"
        );
    }

    #[test]
    fn an_already_pinned_host_is_recognised_when_libssh2_could_not_open_the_file() {
        // The security half of the same fix, and the reason the branch refused
        // in the first place: with libssh2 holding NOTHING its NotFound means
        // nothing, so accept-new would blind-trust a host that is already
        // pinned and an active MITM on it would read as a first sighting. Our
        // own read sees the pin, so the host stays known and is not re-pinned.
        let path = kh_path_non_ascii("known");
        pin_new_host_key(&path, None, "h.example.com", 22, ssh2::HostKeyType::Ed25519, &key())
            .unwrap();
        let before = fs::read_to_string(&path).unwrap();

        pin_new_host_key(
            &path,
            Some(KnownHostsGap::Unopened),
            "h.example.com",
            22,
            ssh2::HostKeyType::Ed25519,
            &key(),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            before,
            "a host we already trust must not collect a second pin"
        );
    }

    #[test]
    fn a_changed_key_is_refused_when_libssh2_could_not_open_the_file() {
        // The MITM answer has to survive the new route. check_port cannot give
        // it here, because libssh2 loaded nothing, so our own read is the only
        // thing standing between the user and a silently re-pinned host.
        let path = kh_path_non_ascii("mitm");
        pin_new_host_key(&path, None, "h.example.com", 22, ssh2::HostKeyType::Ed25519, &key())
            .unwrap();
        let before = fs::read_to_string(&path).unwrap();

        let err = pin_new_host_key(
            &path,
            Some(KnownHostsGap::Unopened),
            "h.example.com",
            22,
            ssh2::HostKeyType::Ed25519,
            &other_key(),
        )
        .unwrap_err();

        assert!(err.contains("MISMATCH"), "unhelpful error: {err}");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            before,
            "a refused pin must not touch the file"
        );
    }

    #[test]
    fn our_own_lookup_probes_the_same_two_host_forms_libssh2_does() {
        // knownhost.c:372-386: check_port builds `[host]:port` and probes it
        // first, then the bare name, for EVERY port. Reading the file ourselves
        // has to agree with that, or a host pinned under one form reads as
        // first-seen under the other and collects a second contradictory pin.
        let path = kh_path_non_ascii("ports");
        pin_new_host_key(&path, None, "h.example.com", 2222, ssh2::HostKeyType::Ed25519, &key())
            .unwrap();
        let before = fs::read_to_string(&path).unwrap();
        assert!(before.starts_with("[h.example.com]:2222 "), "{before}");

        // Same host on the same port: the bracket form is found, nothing is added.
        pin_new_host_key(
            &path,
            Some(KnownHostsGap::Unopened),
            "h.example.com",
            2222,
            ssh2::HostKeyType::Ed25519,
            &key(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), before);

        // Port 22 is a different identity and must still pin separately.
        pin_new_host_key(
            &path,
            Some(KnownHostsGap::Unopened),
            "h.example.com",
            22,
            ssh2::HostKeyType::Ed25519,
            &key(),
        )
        .unwrap();
        let after = fs::read_to_string(&path).unwrap();
        assert!(
            after.lines().last().unwrap().starts_with("h.example.com ssh-ed25519 "),
            "the bracket pin must not answer for port 22: {after}"
        );
    }

    #[test]
    fn a_wildcard_pin_is_not_mistaken_for_an_unknown_host() {
        // OpenSSH host patterns glob, and libssh2 honours that. Ignoring it
        // would let a host covered by a `*.example.com` pin read as first-seen,
        // which is precisely the blind trust this branch exists to refuse.
        let path = kh_path_non_ascii("wildcard");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = format!("*.example.com ssh-ed25519 {}\n", base64(&other_key(), true));
        fs::write(&path, &original).unwrap();

        let err = pin_new_host_key(
            &path,
            Some(KnownHostsGap::Unopened),
            "h.example.com",
            22,
            ssh2::HostKeyType::Ed25519,
            &key(),
        )
        .unwrap_err();

        assert!(err.contains("MISMATCH"), "unhelpful error: {err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), original);

        // The other half of the glob, so neither direction can go vacuous: a
        // pattern that does NOT cover this host must leave it first-seen. A
        // matcher stubbed to always agree fails here; one stubbed to never
        // agree fails above.
        let elsewhere = kh_path_non_ascii("wildcard-miss");
        fs::create_dir_all(elsewhere.parent().unwrap()).unwrap();
        fs::write(&elsewhere, format!("*.other.com ssh-ed25519 {}\n", base64(&other_key(), true)))
            .unwrap();

        pin_new_host_key(
            &elsewhere,
            Some(KnownHostsGap::Unopened),
            "h.example.com",
            22,
            ssh2::HostKeyType::Ed25519,
            &key(),
        )
        .unwrap();

        let after = fs::read_to_string(&elsewhere).unwrap();
        assert!(
            after.lines().last().unwrap().starts_with("h.example.com ssh-ed25519 "),
            "a pattern for another domain must not claim this host: {after}"
        );
    }
}

/// Open a TCP connection, complete the SSH handshake, verify the host key, and
/// authenticate — returning a ready session (blocking mode). Shared by the
/// interactive shell (`ssh_spawn`) and SFTP (`sftp::sftp_connect`).
///
/// `verify_as` overrides the name/port the host key is checked + pinned under.
/// Normal connections pass `None` (verify under the connect host:port). The
/// jump-host path connects to 127.0.0.1:<ephemeral> but passes the real target
/// `(host, port)` so the target's key pins under its true identity in
/// known_hosts (not a throwaway localhost port that never matches again).
pub fn connect_session(
    host: &str,
    port: u16,
    user: &str,
    auth: &SshAuth,
    verify_as: Option<(&str, u16)>,
) -> Result<ssh2::Session, String> {
    let port = if port == 0 { 22 } else { port };
    // Bound the TCP connect: a dead/firewalled host otherwise parks this worker
    // thread on the OS default (~21s on Windows). Try each resolved address (so a
    // dual-stack host with an unreachable first address still connects) with a 10s
    // per-address timeout; first success wins.
    let tcp = {
        let addrs = (host, port)
            .to_socket_addrs()
            .map_err(|e| format!("resolve {host}:{port}: {e}"))?;
        let mut last = String::from("no address resolved");
        let mut sock = None;
        for addr in addrs {
            match TcpStream::connect_timeout(&addr, Duration::from_secs(10)) {
                Ok(s) => { sock = Some(s); break; }
                Err(e) => last = e.to_string(),
            }
        }
        sock.ok_or_else(|| format!("connect to {host}:{port} failed: {last}"))?
    };
    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    // Bound blocking libssh2 ops (handshake, host-key, userauth, channel setup)
    // so a genuinely stalled negotiation fails with an error instead of hanging
    // "connecting" forever. A healthy connect is ~700ms, so 30s is generous.
    // The reader thread flips to non-blocking after setup, so this governs only
    // the connect phase.
    sess.set_timeout(30_000);
    sess.set_tcp_stream(tcp);
    sess.handshake()
        .map_err(|e| format!("ssh handshake failed: {e}"))?;

    // Host-key verification — never skipped; refuses on a changed key.
    let (vh, vp) = verify_as.unwrap_or((host, port));
    verify_host_key(&sess, vh, vp)?;

    match auth.method.as_str() {
        "password" => {
            let pw = auth.password.as_deref().unwrap_or("");
            sess.userauth_password(user, pw)
                .map_err(|e| format!("password auth failed: {e}"))?;
        }
        "key" => {
            let key = auth.key_path.as_deref().ok_or("no key path provided")?;
            sess.userauth_pubkey_file(
                user,
                None,
                std::path::Path::new(key),
                auth.passphrase.as_deref(),
            )
            .map_err(|e| format!("key auth failed: {e}"))?;
        }
        "agent" => {
            let mut agent = sess.agent().map_err(|e| e.to_string())?;
            agent
                .connect()
                .map_err(|e| format!("ssh-agent connect failed: {e}"))?;
            agent.list_identities().map_err(|e| e.to_string())?;
            let ids = agent.identities().map_err(|e| e.to_string())?;
            let mut ok = false;
            for id in ids {
                if agent.userauth(user, &id).is_ok() {
                    ok = true;
                    break;
                }
            }
            if !ok {
                return Err("ssh-agent: no identity authenticated".into());
            }
        }
        other => return Err(format!("unknown auth method: {other}")),
    }
    if !sess.authenticated() {
        return Err("authentication failed".into());
    }
    Ok(sess)
}

/// Open an interactive SSH shell and register it behind the same `pty_*` seam
/// local PTYs use. The `ssh2::Channel` is `!Sync`, so it lives solely on the
/// reader thread; `pty_write`/`pty_resize` reach it via mpsc channels.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_spawn(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, SessionRegistry>,
    host: String,
    port: u16,
    user: String,
    auth: SshAuth,
    cols: u16,
    rows: u16,
    tab_id: Option<String>,
    host_key_alias: Option<String>,
    host_key_port: Option<u16>,
) -> Result<String, String> {
    // Full TCP+SSH handshake off the runtime, same treatment sftp_connect
    // already gets (P3-T5). connect_session is bounded (10s per resolved
    // address + a 30s libssh2 timeout) but that is still up to ~40s of a
    // PARKED tokio worker per call, and N simultaneous connects to dead hosts
    // starve every other async IPC command in the app.
    //
    // The State<'_, SessionRegistry> guard can't cross the 'static boundary,
    // so nothing registry-side goes in here — the insert below still runs on
    // the runtime after the await, exactly as before.
    let sess = tauri::async_runtime::spawn_blocking(move || {
        // For jump-host connections (host = 127.0.0.1:<tunnel port>), verify/pin
        // the host key under the real target identity instead of the throwaway
        // port. Built inside the closure because verify_as BORROWS
        // host_key_alias, and a borrow can't be moved into a 'static task.
        let verify_as = host_key_alias
            .as_deref()
            .map(|h| (h, host_key_port.unwrap_or(port)));
        connect_session(&host, port, &user, &auth, verify_as)
    })
    .await
    .map_err(|e| format!("ssh connect task failed: {e}"))??;

    // Interactive shell on a PTY channel.
    let mut channel = sess.channel_session().map_err(|e| e.to_string())?;
    channel
        .request_pty(
            "xterm-256color",
            None,
            Some((cols.max(40) as u32, rows.max(10) as u32, 0, 0)),
        )
        .map_err(|e| format!("request_pty failed: {e}"))?;
    channel.shell().map_err(|e| format!("shell failed: {e}"))?;

    // Non-blocking so the reader thread can interleave reads, writes, resizes.
    sess.set_blocking(false);

    let id = new_id("pty");
    let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>();
    let (ctrl_tx, ctrl_rx) = mpsc::channel::<SshCtrl>();
    let (ready_tx, ready_rx) = mpsc::channel::<()>();

    lock_recover(&state.sessions).insert(
        id.clone(),
        Session::Ssh(SshHandle {
            writes: write_tx,
            ctrl: ctrl_tx,
            ready: ready_tx,
        }),
    );
    lock_recover(&state.owner).insert(id.clone(), window.label().to_string()); // tag at birth (audit H8)

    let mut scrollback_writer = tab_id
        .as_ref()
        .map(|tid| ScrollbackWriter::new(scrollback_path(&app, tid)));

    let co_entry = coalescer_insert(&app.state::<SessionRegistry>(), &id, false);
    let id_for_thread = id.clone();
    let app_for_thread = app.clone();
    thread::spawn(move || {
        // Sole owner of the channel + session (both !Sync). Keep the session
        // alive for the channel's lifetime.
        let _sess = sess;
        let mut channel = channel;
        let mut buf = [0u8; 65536];
        // Wait until the frontend signals (via `pty_ready`) that its
        // `pty://{id}` listener is attached before emitting the server's initial
        // MOTD/prompt burst. SSH servers push that the instant the shell opens;
        // without the handshake the first output races ahead of the subscription
        // and is lost, leaving the tab stuck on "connecting" even though the
        // shell is live. Output stays buffered in libssh2 until the read loop
        // below drains it, so nothing is dropped. The timeout is a safety net
        // for a lost/never-sent signal: starting the read loop then is harmless
        // because the frontend attaches its listener *before* it signals, so a
        // fallback start still streams the buffered output to a live listener —
        // it just costs this much latency. Kept short so a dropped `pty_ready`
        // can't strand a live tab on "connecting"; a healthy signal lands in a
        // few ms, well before this fires.
        let _ = ready_rx.recv_timeout(Duration::from_secs(2));
        // Outbound bytes awaiting the channel's flow-control window. The channel
        // is non-blocking (set_blocking(false) above), so a write can accept only
        // part of a buffer when the window is full; the unwritten tail stays here
        // and is retried next tick. write_all would instead treat that WouldBlock
        // as fatal and silently drop the tail — truncating large pastes.
        let mut outbound: VecDeque<u8> = VecDeque::new();
        // Idle-wait escalation (P1-T7); reset on any read OR write activity.
        let mut backoff = Backoff::new();
        // Incomplete trailing UTF-8 bytes carried across read chunks (see
        // decode_utf8_stream).
        let mut pending: Vec<u8> = Vec::new();
        loop {
            // 1. Pull queued writes from pty_write into the outbound buffer. A
            //    disconnected sender means the registry entry was dropped
            //    (pty_kill / kill_all) → tear down. Writes drained HERE are
            //    activity too — reset the idle backoff (stream-audit W1: only
            //    the recv_timeout branches reset, so a write arriving while
            //    the loop was mid-iteration left the next idle wait at up to
            //    32ms, the exact class T7 exists to kill).
            loop {
                match write_rx.try_recv() {
                    Ok(data) => {
                        outbound.extend(data);
                        backoff.reset();
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        let _ = channel.close();
                        // Tail before exit — the exit event must be last.
                        flush_pending(&app_for_thread, &id_for_thread, &co_entry, true);
                        coalescer_remove(&app_for_thread, &id_for_thread);
                        let _ = app_for_thread.emit(&format!("pty-exit://{}", id_for_thread), ());
                        return;
                    }
                }
            }
            // 1a. Backpressure cap: if the SSH window has been stalled long
            //     enough for 4MB of writes to pile up, the connection is
            //     effectively wedged. Drop ALL pending writes at once (never
            //     silently a single chunk) and tell the user via the terminal
            //     stream so the loss is visible.
            if outbound.len() > SSH_OUTBOUND_MAX_BYTES {
                outbound.clear();
                // The marker rides the coalesced stream IN SEQUENCE: drain any
                // pending output first, then emit the marker, all under the
                // session's coalescer lock so it can't overtake earlier bytes.
                if let Ok(mut co) = co_entry.co.lock() {
                    let now = Instant::now();
                    if let Some(out) = co.take(now) {
                        let _ = emit_under_lock(
                            &app_for_thread, &id_for_thread, &co_entry, &mut co, out, now,
                        );
                    }
                    // Direct emit_under_lock caller = this op's own trailing
                    // surface_drops (round-3 review: this site lost coverage
                    // when the helper's internal call was de-duplicated).
                    surface_drops(&app_for_thread, &id_for_thread, &mut co);
                    let _ = app_for_thread.emit(
                        &format!("pty://{}", id_for_thread),
                        "\r\n\x1b[1;31m[Pluto's Terminal] SSH connection stalled: outbound \
                         buffer exceeded 4MB — pending writes dropped.\x1b[0m\r\n",
                    );
                }
            }
            // 1b. Drain the outbound buffer to the channel with flow control.
            //     When the window is full the write reports WouldBlock; keep the
            //     unwritten tail and retry next tick (mirrors forward.rs::pump).
            let had_outbound = !outbound.is_empty();
            while !outbound.is_empty() {
                let (front, _) = outbound.as_slices();
                match channel.write(front) {
                    Ok(0) => break,
                    Ok(n) => {
                        outbound.drain(..n);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => break,
                }
            }
            if had_outbound {
                let _ = channel.flush();
            }
            // 2. Apply resizes from pty_resize. (Empty/Disconnected → stop here;
            //    kill is handled by the write-channel disconnect above.)
            while let Ok(SshCtrl::Resize(c, r)) = ctrl_rx.try_recv() {
                let _ = channel.request_pty_size(c as u32, r as u32, None, None);
            }
            // 3. Read output (non-blocking → WouldBlock when idle). Idle
            //    branches flush the coalescer inline (this loop never relies
            //    on the global flusher), then WAIT ON THE WRITE CHANNEL with
            //    an escalating timeout (P1-T7): a keystroke wakes the loop
            //    instantly — a plain sleep gated BOTH directions and would
            //    have added up to 2× the backoff to SSH echo latency. Idle
            //    CPU drops (8→32ms escalation ≈ 125→31 wakeups/s) AND
            //    interactive latency improves relative to the fixed sleep.
            //    Disconnected here = pty_kill/kill_all dropped the senders →
            //    break into the shared teardown below (flush, remove, close,
            //    pty-exit), same as EOF.
            match channel.read(&mut buf) {
                Ok(0) => {
                    if channel.eof() {
                        break;
                    }
                    flush_pending(&app_for_thread, &id_for_thread, &co_entry, false);
                    match write_rx.recv_timeout(backoff.wait()) {
                        Ok(data) => {
                            outbound.extend(data);
                            backoff.reset();
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                Ok(n) => {
                    backoff.reset();
                    let chunk = decode_utf8_stream(&mut pending, &buf[..n]);
                    if chunk.is_empty() {
                        continue;
                    }
                    if let Some(w) = scrollback_writer.as_mut() {
                        w.append(chunk.as_bytes());
                    }
                    coalesce_chunk(&app_for_thread, &id_for_thread, &co_entry, &chunk, false);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if channel.eof() {
                        break;
                    }
                    flush_pending(&app_for_thread, &id_for_thread, &co_entry, false);
                    match write_rx.recv_timeout(backoff.wait()) {
                        Ok(data) => {
                            outbound.extend(data);
                            backoff.reset();
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                Err(_) => break,
            }
        }
        // Flush any unfinished UTF-8 sequence still buffered at EOF.
        if !pending.is_empty() {
            let tail = String::from_utf8_lossy(&pending).into_owned();
            if let Some(w) = scrollback_writer.as_mut() {
                w.append(tail.as_bytes());
            }
            coalesce_chunk(&app_for_thread, &id_for_thread, &co_entry, &tail, false);
        }
        // Tail before exit — strictly ordered ahead of pty-exit.
        flush_pending(&app_for_thread, &id_for_thread, &co_entry, true);
        coalescer_remove(&app_for_thread, &id_for_thread);
        let _ = channel.close();
        let _ = channel.wait_close();
        let _ = app_for_thread.emit(&format!("pty-exit://{}", id_for_thread), ());
    });

    Ok(id)
}

// ───────────────────────────── Serial console ──────────────────────────────

/// List available serial ports (USB/UART device names).
#[tauri::command]
pub fn serial_list() -> Vec<String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default()
}

/// Open a serial port at `baud` and register it behind the same `pty_*` seam.
/// A reader thread streams bytes as `pty://{id}`; `pty_write` sends to the
/// device. The reader uses a short read timeout so `pty_kill` (which flips
/// `alive`) stops it promptly even when the device is silent.
#[tauri::command]
pub async fn serial_spawn(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, SessionRegistry>,
    path: String,
    baud: u32,
    tab_id: Option<String>,
) -> Result<String, String> {
    let port = serialport::new(&path, baud)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| format!("open serial {path} failed: {e}"))?;
    let reader = port
        .try_clone()
        .map_err(|e| format!("clone serial handle failed: {e}"))?;

    let alive = Arc::new(AtomicBool::new(true));
    let id = new_id("pty");
    let (ready_tx, ready_rx) = mpsc::channel::<()>();
    lock_recover(&state.sessions).insert(
        id.clone(),
        Session::Serial(SerialHandle {
            writer: Arc::new(Mutex::new(port)),
            alive: alive.clone(),
            ready: ready_tx,
        }),
    );
    lock_recover(&state.owner).insert(id.clone(), window.label().to_string()); // tag at birth (audit H8)

    let mut scrollback_writer = tab_id
        .as_ref()
        .map(|tid| ScrollbackWriter::new(scrollback_path(&app, tid)));

    let co_entry = coalescer_insert(&app.state::<SessionRegistry>(), &id, false);
    let id_for_thread = id.clone();
    let app_for_thread = app.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 65536];
        // Gate the first emit on the frontend's listener (see pty_spawn).
        let _ = ready_rx.recv_timeout(Duration::from_secs(2));
        // Incomplete trailing UTF-8 bytes carried across read chunks (see
        // decode_utf8_stream).
        let mut pending: Vec<u8> = Vec::new();
        while alive.load(Ordering::Relaxed) {
            match reader.read(&mut buf) {
                Ok(0) => {
                    flush_pending(&app_for_thread, &id_for_thread, &co_entry, false);
                    thread::sleep(Duration::from_millis(20));
                }
                Ok(n) => {
                    let chunk = decode_utf8_stream(&mut pending, &buf[..n]);
                    if chunk.is_empty() {
                        continue;
                    }
                    if let Some(w) = scrollback_writer.as_mut() {
                        w.append(chunk.as_bytes());
                    }
                    coalesce_chunk(&app_for_thread, &id_for_thread, &co_entry, &chunk, false);
                }
                // No data within the port timeout (the serial loop's natural
                // idle cadence) — flush anything coalesced, re-check `alive`.
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    flush_pending(&app_for_thread, &id_for_thread, &co_entry, false);
                }
                // Device unplugged / fatal error.
                Err(_) => break,
            }
        }
        // Flush any unfinished UTF-8 sequence still buffered at exit.
        if !pending.is_empty() {
            let tail = String::from_utf8_lossy(&pending).into_owned();
            if let Some(w) = scrollback_writer.as_mut() {
                w.append(tail.as_bytes());
            }
            coalesce_chunk(&app_for_thread, &id_for_thread, &co_entry, &tail, false);
        }
        // Tail before exit — strictly ordered ahead of pty-exit.
        flush_pending(&app_for_thread, &id_for_thread, &co_entry, true);
        coalescer_remove(&app_for_thread, &id_for_thread);
        let _ = app_for_thread.emit(&format!("pty-exit://{}", id_for_thread), ());
    });

    Ok(id)
}

/// Kill every live PTY child. Called from RunEvent::ExitRequested so we
/// never leave a shell process orphaned when the app closes.
pub fn kill_all(registry: &SessionRegistry) {
    // Coalescer bookkeeping first: the process is exiting, retained output is
    // moot, and a stale dirty entry must not pin the flusher awake. Poison on
    // these global locks is recovered like everywhere else (re-review W4).
    lock_recover(&registry.coalescers).clear();
    lock_recover(&registry.dirty.set).clear();
    lock_recover(&registry.owner).clear(); // H8 ownership tags — moot at exit
    // Drain under ONE short lock (recovered on poison — leaving children
    // alive at exit is strictly worse than touching a poisoned map), then do
    // every kill+reap on owned values outside it (P1-T4: 10 live panes used
    // to serialize 10 child-process waits on the main thread here).
    let drained: Vec<Session> = {
        let mut sessions = lock_recover(&registry.sessions);
        sessions.drain().map(|(_, s)| s).collect()
    };
    let (tx, rx) = mpsc::channel::<()>();
    let mut reap_count = 0usize;
    for session in drained {
        match session {
            Session::Local(s) => {
                // Parallel reap threads; kill fires immediately in each.
                reap_count += 1;
                let tx = tx.clone();
                thread::spawn(move || {
                    s.reap();
                    let _ = tx.send(());
                });
            }
            Session::Serial(h) => {
                h.alive.store(false, Ordering::Relaxed);
            }
            // Ssh: dropping the handle's senders signals its reader thread to
            // close the channel + connection.
            Session::Ssh(_) => {}
        }
    }
    drop(tx);
    // Bounded exit: std threads have no join-timeout, so collect completions
    // via channel with a 2s TOTAL deadline (plan T4). Kills were already
    // issued; a straggler's conhost/ConPTY dies when our handles close at
    // process exit — an unreaped-killed child is acceptable at shutdown.
    let deadline = Instant::now() + Duration::from_secs(2);
    for _ in 0..reap_count {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || rx.recv_timeout(left).is_err() {
            break;
        }
    }
}

/// Kill every PTY owned by `label` (audit H8). Called from the
/// WindowEvent::Destroyed handler for a secondary ("win-*") window, so a fast
/// close / Alt+F4 / unresponsive unmount that outruns the frontend's per-tab
/// pty_kill can't leave that window's shell children + reader threads +
/// coalescers + scrollback writers alive invisibly until full app exit.
///
/// Lock discipline: take `owner` first (collect ids, drop the tags), release it,
/// THEN touch coalescers/dirty/sessions — never two registry locks at once, so
/// there's no ordering hazard with pty_ready (which tags owner only after it has
/// already released the sessions lock) or the hot flush path.
pub fn kill_window_sessions(registry: &SessionRegistry, label: &str) {
    let ids: Vec<String> = {
        let mut owner = lock_recover(&registry.owner);
        let ids: Vec<String> = owner
            .iter()
            .filter(|(_, w)| w.as_str() == label)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            owner.remove(id);
        }
        ids
    };
    if ids.is_empty() {
        return;
    }
    {
        let mut co = lock_recover(&registry.coalescers);
        for id in &ids {
            co.remove(id);
        }
    }
    {
        let mut dirty = lock_recover(&registry.dirty.set);
        for id in &ids {
            dirty.remove(id);
        }
    }
    let drained: Vec<Session> = {
        let mut sessions = lock_recover(&registry.sessions);
        ids.iter().filter_map(|id| sessions.remove(id)).collect()
    };
    // Reap off-lock, one detached thread per local child (mirrors kill_all).
    // No join here: the window is already gone, so nothing waits on this — the
    // children die promptly and their handles close regardless.
    for session in drained {
        match session {
            Session::Local(s) => {
                thread::spawn(move || s.reap());
            }
            Session::Serial(h) => {
                h.alive.store(false, Ordering::Relaxed);
            }
            Session::Ssh(_) => {}
        }
    }
}

#[cfg(test)]
mod window_ownership_tests {
    // Audit H8: kill_window_sessions must reap ONLY the target window's tagged
    // sessions and leave every other window's alone. Real Session values need
    // live PTY handles, so this exercises the id-selection + tag/coalescer/dirty
    // cleanup (the window-scoping logic that's the actual risk) against an empty
    // sessions map — filter_map over it is a no-op, which is exactly the
    // "already-dead session, tag lingers" case the handler must tolerate.
    use super::*;

    #[test]
    fn reaps_only_the_target_windows_tags() {
        let reg = SessionRegistry::default();
        {
            let mut o = lock_recover(&reg.owner);
            o.insert("s1".into(), "win-A".into());
            o.insert("s2".into(), "win-A".into());
            o.insert("s3".into(), "win-B".into());
        }
        {
            let mut d = lock_recover(&reg.dirty.set);
            d.insert("s1".into());
            d.insert("s3".into());
        }

        kill_window_sessions(&reg, "win-A");

        let o = lock_recover(&reg.owner);
        assert!(!o.contains_key("s1"), "win-A tag s1 should be cleared");
        assert!(!o.contains_key("s2"), "win-A tag s2 should be cleared");
        assert!(o.contains_key("s3"), "win-B tag s3 must survive");
        let d = lock_recover(&reg.dirty.set);
        assert!(!d.contains("s1"), "s1 dirty entry swept with its window");
        assert!(d.contains("s3"), "s3 (win-B) dirty entry untouched");
    }

    #[test]
    fn no_matching_label_is_a_noop() {
        let reg = SessionRegistry::default();
        lock_recover(&reg.owner).insert("s1".into(), "win-A".into());
        kill_window_sessions(&reg, "win-does-not-exist");
        assert!(lock_recover(&reg.owner).contains_key("s1"));
    }

    #[test]
    fn empty_registry_is_a_noop() {
        let reg = SessionRegistry::default();
        kill_window_sessions(&reg, "win-A"); // must not panic on empty maps
        assert!(lock_recover(&reg.owner).is_empty());
    }
}

#[cfg(test)]
mod coalesce_wiring_tests {
    // Fail-injection coverage for every flush path (plan T1 requirement; the
    // review found the shipped wiring untested and hiding two real bugs: a
    // failed leading-edge/size flush never marked the session dirty, and
    // pending grew unbounded under sustained emit failure).
    use super::*;
    use std::cell::{Cell, RefCell};

    struct MockSink {
        fail: Cell<bool>,
        attempted: RefCell<Vec<String>>,
        delivered: RefCell<Vec<String>>,
    }

    impl MockSink {
        fn new(fail: bool) -> Self {
            Self {
                fail: Cell::new(fail),
                attempted: RefCell::new(Vec::new()),
                delivered: RefCell::new(Vec::new()),
            }
        }
        fn payload_attempts(&self) -> usize {
            self.attempted.borrow().len()
        }
    }

    impl EmitSink for MockSink {
        fn emit_pty(&self, _id: &str, payload: &str) -> bool {
            self.attempted.borrow_mut().push(payload.to_string());
            if self.fail.get() {
                false
            } else {
                self.delivered.borrow_mut().push(payload.to_string());
                true
            }
        }
    }

    #[test]
    fn failed_leading_edge_marks_dirty_for_ticker_sessions() {
        let sink = MockSink::new(true);
        let entry = CoEntry::fresh(true);
        let needs_mark =
            coalesce_chunk_core(&sink, "t1", &entry, "hello", true, Instant::now());
        assert!(needs_mark, "retained payload must enter the flusher's view");
        assert!(entry.co.lock().unwrap().has_pending(), "payload retained");
    }

    #[test]
    fn failed_leading_edge_no_mark_for_inline_sessions() {
        let sink = MockSink::new(true);
        let entry = CoEntry::fresh(false);
        let needs_mark =
            coalesce_chunk_core(&sink, "t1", &entry, "hello", false, Instant::now());
        assert!(!needs_mark, "inline transports never touch the dirty set");
        assert!(entry.co.lock().unwrap().has_pending());
    }

    #[test]
    fn became_pending_marks_dirty_and_success_does_not() {
        let sink = MockSink::new(false);
        let entry = CoEntry::fresh(true);
        let now = Instant::now();
        // Fresh coalescer is backdated: first chunk leading-edges, delivered.
        let first = coalesce_chunk_core(&sink, "t1", &entry, "a", true, now);
        assert!(!first, "successful leading edge needs no mark");
        assert_eq!(sink.delivered.borrow().len(), 1);
        // Immediately after: coalesces (too soon for another leading edge).
        let second = coalesce_chunk_core(&sink, "t1", &entry, "b", true, now);
        assert!(second, "empty->nonempty transition must mark dirty");
    }

    #[test]
    fn failed_size_flush_marks_dirty() {
        let sink = MockSink::new(false);
        let entry = CoEntry::fresh(true);
        let now = Instant::now();
        coalesce_chunk_core(&sink, "t1", &entry, "x", true, now); // leading edge ok
        sink.fail.set(true);
        let big = "b".repeat(COALESCE_MAX_BYTES);
        let needs_mark = coalesce_chunk_core(&sink, "t1", &entry, &big, true, now);
        assert!(needs_mark, "failed size flush must mark dirty");
        assert!(entry.co.lock().unwrap().has_pending());
    }

    #[test]
    fn exit_flush_retries_once_then_drops() {
        let sink = MockSink::new(false);
        let entry = CoEntry::fresh(true);
        let now = Instant::now();
        coalesce_chunk_core(&sink, "t1", &entry, "x", true, now); // leading edge ok
        coalesce_chunk_core(&sink, "t1", &entry, "tail", true, now); // pending
        sink.fail.set(true);
        let before = sink.payload_attempts();
        flush_pending_core(&sink, "t1", &entry, true, now);
        // Exactly two payload attempts (initial + one retry), then the tail is
        // dropped so the dying session can't wedge.
        assert_eq!(sink.payload_attempts() - before, 2);
        assert!(!entry.co.lock().unwrap().has_pending(), "tail dropped on exit");
    }

    #[test]
    fn overflow_marker_survives_until_sink_recovers() {
        let sink = MockSink::new(true);
        let entry = CoEntry::fresh(true);
        let now = Instant::now();
        // Flood a failing sink far past the pending cap: the cap fires, and
        // every marker attempt fails too — the drop count must NOT be lost.
        let chunk = "c".repeat(COALESCE_MAX_BYTES);
        let rounds = (COALESCE_PENDING_MAX_BYTES / COALESCE_MAX_BYTES) + 3;
        for _ in 0..rounds {
            coalesce_chunk_core(&sink, "t1", &entry, &chunk, true, now);
        }
        // Nothing was delivered while failing.
        assert_eq!(sink.delivered.borrow().len(), 0);
        // Sink recovers: the very next op surfaces the overflow marker.
        sink.fail.set(false);
        coalesce_chunk_core(&sink, "t1", &entry, "back", true, now);
        let delivered = sink.delivered.borrow();
        assert!(
            delivered.iter().any(|p| p.contains("output overflow")),
            "recovered sink must deliver the loss notice: {delivered:?}"
        );
    }

    #[test]
    fn backlog_marker_reannounces_every_n() {
        let sink = MockSink::new(true);
        let entry = CoEntry::fresh(true);
        let now = Instant::now();
        coalesce_chunk_core(&sink, "t1", &entry, "seed", true, now); // fail #1 (leading edge)
        for _ in 0..(2 * EMIT_FAIL_MARKER_AFTER) {
            flush_pending_core(&sink, "t1", &entry, false, now);
        }
        let markers = sink
            .attempted
            .borrow()
            .iter()
            .filter(|p| p.as_str() == BACKLOG_MARKER)
            .count();
        assert_eq!(markers, 2, "marker re-announces every {EMIT_FAIL_MARKER_AFTER} failures");
    }
}

#[cfg(test)]
mod scrollback_rotation_tests {
    use super::*;

    fn tmp_scrollback(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("plutos-terminals-tests")
            .join(format!("{}-{}", name, new_id("t")));
        let _ = fs::create_dir_all(&dir);
        dir.join("tab_x.txt")
    }

    #[test]
    fn rotate_at_cap_moves_current_to_old_and_resets() {
        let path = tmp_scrollback("rotate-basic");
        let mut w = ScrollbackWriter::with_segment(path.clone(), 64);
        w.append(b"first-segment-data-first-segment-data-first-segment-data-1234567890\n"); // >64
        let old = path.with_extension("old.txt");
        assert!(old.exists(), "rotation must create the .old segment");
        assert!(
            fs::read_to_string(&old).unwrap().contains("first-segment"),
            "old carries the rotated bytes"
        );
        assert_eq!(w.bytes_on_disk, 0, "counter resets for the fresh segment");
        w.append(b"second\n");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "second\n",
            "appends after rotation land in the fresh current, not .old"
        );
    }

    #[test]
    fn second_rotation_clobbers_old() {
        let path = tmp_scrollback("rotate-clobber");
        let mut w = ScrollbackWriter::with_segment(path.clone(), 8);
        w.append(b"AAAAAAAAAA"); // rotate #1: old = A's
        w.append(b"BBBBBBBBBB"); // rotate #2: old = B's
        let old = fs::read_to_string(path.with_extension("old.txt")).unwrap();
        assert!(old.starts_with('B'), "second rotation replaces old: {old}");
    }

    #[test]
    fn legacy_oversize_single_file_rotates_whole_on_first_over_cap_append() {
        let path = tmp_scrollback("legacy");
        fs::write(&path, vec![b'L'; 100]).unwrap(); // pre-existing over-budget file
        let mut w = ScrollbackWriter::with_segment(path.clone(), 64);
        assert_eq!(w.bytes_on_disk, 100, "seeded from disk");
        w.append(b"new\n"); // 104 > 64 -> rotates the whole legacy file
        let old = fs::read(path.with_extension("old.txt")).unwrap();
        assert_eq!(old.len(), 104, "legacy content + new chunk moved to old");
        assert_eq!(w.bytes_on_disk, 0);
    }

    #[cfg(windows)]
    #[test]
    fn rename_blocked_by_no_share_handle_falls_back_to_in_place_truncate() {
        use std::os::windows::fs::OpenOptionsExt;
        let path = tmp_scrollback("contention");
        let old = path.with_extension("old.txt");
        // Simulate an AV/indexer: hold the rename TARGET open with share_mode
        // 0 so MoveFileEx/REPLACE_EXISTING fails. (A plain std read handle
        // would NOT block the rename — FILE_SHARE_DELETE is default.)
        fs::write(&old, b"held").unwrap();
        let _guard = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&old)
            .unwrap();
        let mut w = ScrollbackWriter::with_segment(path.clone(), 16);
        w.append(b"line-one-is-long\nline-two-is-longer\n"); // > 16 -> rotate fails -> fallback
        let current = fs::read(&path).unwrap();
        assert!(
            current.len() <= 16 + 4096,
            "fallback bounds the file near the segment cap: {}",
            current.len()
        );
        assert!(
            w.bytes_on_disk <= (16 + 4096) as u64,
            "counter resynced by fallback"
        );
        // Release the AV-style handle first — share_mode(0) blocks even our
        // own verification read while held — then confirm the target survived
        // the failed rename untouched.
        drop(_guard);
        assert_eq!(fs::read(&old).unwrap(), b"held");
        // Appends keep flowing afterwards.
        w.append(b"after\n");
        assert!(fs::read_to_string(&path).unwrap().ends_with("after\n"));
    }
}

#[cfg(test)]
mod backoff_tests {
    use super::*;

    #[test]
    fn escalates_to_ceiling_and_resets_on_activity() {
        let mut b = Backoff::new();
        assert_eq!(b.wait(), Duration::from_millis(8));
        assert_eq!(b.wait(), Duration::from_millis(16));
        assert_eq!(b.wait(), Duration::from_millis(32));
        assert_eq!(b.wait(), Duration::from_millis(32), "capped at ceiling");
        b.reset();
        assert_eq!(b.wait(), Duration::from_millis(8), "activity resets to floor");
    }
}
