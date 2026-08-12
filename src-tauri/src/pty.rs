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
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
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

// File-size policy: when the on-disk scrollback exceeds MAX_BYTES, rewrite to
// keep the last KEEP_BYTES (sliced at a line boundary if possible so partial
// ANSI escape sequences don't strand across the cut).
//
// v0.1.32: bumped from 200KB/100KB to 10MB/5MB. The original budget was
// matched to the renderer-side in-memory cap (100KB), but for restore-on-
// relaunch the right framing is "how much output does a real session
// produce?" — easily megabytes for claude code conversations, debug sessions,
// or anything that prints a file. Disk is cheap; ~50MB per pane × ~8 panes
// is rounding error on modern storage. xterm's in-memory scrollback at 10000
// lines becomes the binding constraint on what's visible after restore, not
// disk.
const SCROLLBACK_FILE_MAX_BYTES: u64 = 10_000_000;
const SCROLLBACK_FILE_KEEP_BYTES: usize = 5_000_000;

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
    "\r\n\x1b[1;31m[Pluto's Terminals] output delivery backlogged — retrying.\x1b[0m\r\n";

/// Recover a poisoned lock instead of dying: the guarded data (id sets/maps)
/// is structurally valid regardless of where a panicking thread stopped, and
/// a dead flusher would silently stall EVERY local session's age-flushes.
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
                "\r\n\x1b[1;31m[Pluto's Terminals] output overflow: {d} bytes dropped while delivery was stalled.\x1b[0m\r\n"
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
    if sink.emit_pty(id, &out) {
        entry.fails.store(0, Ordering::Relaxed);
        surface_drops(sink, id, co);
        true
    } else {
        let n = entry.fails.fetch_add(1, Ordering::Relaxed) + 1;
        co.retain_front(out, now);
        surface_drops(sink, id, co);
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

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        // Reap the killed child so it doesn't linger as a zombie on unix
        // (kill() alone leaves the exit status uncollected). kill-first means
        // wait() returns promptly instead of blocking on a live process.
        let _ = self.child.wait();
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
}

/// On-disk scrollback writer owned by a single PTY reader thread.
///
/// Every chunk that flows from PTY → xterm is also appended here, so a hard
/// process death (tray→Quit, OS shutdown, crash) at most loses the bytes that
/// are still in the OS write-buffer — typically <4KB. The renderer-side
/// scrollback_save path used to race the process exit; this owns the file
/// instead so there's no IPC round-trip on the hot path.
///
/// Tail-truncation: when `bytes_on_disk` exceeds SCROLLBACK_FILE_MAX_BYTES,
/// rewrite the file keeping the last SCROLLBACK_FILE_KEEP_BYTES, sliced at the
/// next newline boundary to avoid stranding partial ANSI escape sequences
/// across the cut. Reset the counter to whatever was kept.
struct ScrollbackWriter {
    path: PathBuf,
    // Held open for the session lifetime so high-throughput output (e.g.
    // `cat largefile`) doesn't pay an open+close syscall on every 4KB chunk.
    // `None` only between a failed open and the next lazy retry, or while a
    // tail rewrite swaps the file. write(2) hands bytes to the OS buffer just
    // as the per-chunk open path did, so hard-process-death durability is
    // unchanged — only the syscall overhead drops.
    file: Option<File>,
    bytes_on_disk: u64,
}

impl ScrollbackWriter {
    /// Create a new writer for a tab. Creates parent dirs eagerly. Seeds
    /// `bytes_on_disk` from any existing file so we don't lose track on a
    /// pane that was previously persisted, and opens the append handle once.
    fn new(path: PathBuf) -> Self {
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
        }
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
        if self.bytes_on_disk > SCROLLBACK_FILE_MAX_BYTES {
            self.truncate_tail();
        }
    }

    /// Rewrite the file to keep only the last SCROLLBACK_FILE_KEEP_BYTES,
    /// aligned to the first newline after the cut so ANSI escape sequences
    /// don't straddle the boundary. Atomic via write-tmp + rename.
    fn truncate_tail(&mut self) {
        // Drop the append handle first: the rewrite below replaces the file via
        // rename, so an open handle would keep appending to the now-unlinked
        // inode (silently losing all post-truncate output). Reopened against the
        // new file before returning on every path.
        self.file = None;
        let Ok(data) = fs::read(&self.path) else {
            self.reopen();
            return;
        };
        if data.len() <= SCROLLBACK_FILE_KEEP_BYTES {
            self.bytes_on_disk = data.len() as u64;
            self.reopen();
            return;
        }
        // Initial cut at exactly KEEP bytes from the end.
        let cut_from_start = data.len() - SCROLLBACK_FILE_KEEP_BYTES;
        // Walk forward to next newline (within a reasonable window) so we
        // start cleanly. If no newline within 4KB, take the raw cut.
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
            // Rewrite failed (disk full, permissions, cross-device rename): the
            // file is unchanged and still over the cap. Sync the counter to the
            // real on-disk size so we don't re-enter truncate_tail (re-reading
            // the whole file) on every subsequent append chunk.
            self.bytes_on_disk = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        }
        self.reopen();
    }
}

/// Cap on the SSH outbound buffer while the channel's flow-control window is
/// stalled. Past this the connection is effectively wedged — we drop ALL
/// pending writes (never silently a partial chunk) and tell the user.
const SSH_OUTBOUND_MAX_BYTES: usize = 4 * 1024 * 1024;

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

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, SessionRegistry>,
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
    state
        .sessions
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())?
        .insert(id.clone(), Session::Local(session));

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
        // Dropping the removed PtySession kills + waits the child (Drop impl).
        if let Ok(mut sessions) = app_for_thread
            .state::<SessionRegistry>()
            .sessions
            .lock()
        {
            drop(sessions.remove(&id_for_thread));
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
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "registry mutex poisoned".to_string())?;
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
    match target {
        WriteTarget::Local(w) => {
            let mut w = w.lock().map_err(|_| "writer mutex poisoned".to_string())?;
            w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        }
        WriteTarget::Serial(w) => {
            let mut w = w.lock().map_err(|_| "writer mutex poisoned".to_string())?;
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
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())?;
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
pub fn pty_kill(state: State<'_, SessionRegistry>, id: String) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())?;
    // Removing the entry drops it: Local → PtySession::drop kills the child;
    // Ssh → SshHandle's senders drop, the reader thread sees the disconnect
    // and closes the channel + TCP connection; Serial → flip `alive` so its
    // reader thread exits on the next read-timeout tick.
    match sessions.remove(&id) {
        Some(Session::Local(mut s)) => {
            let _ = s.child.kill();
            // Reap so the dead child doesn't linger as a zombie on unix.
            let _ = s.child.wait();
        }
        Some(Session::Serial(h)) => {
            h.alive.store(false, Ordering::Relaxed);
        }
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
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())?;
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

/// Base64 (standard alphabet, no padding) — for the OpenSSH-style
/// "SHA256:…" host-key fingerprint. Tiny inline impl avoids a base64 dep.
fn base64_no_pad(data: &[u8]) -> String {
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
        }
        if chunk.len() > 2 {
            out.push(A[(n & 63) as usize] as char);
        }
    }
    out
}

fn host_key_format(t: ssh2::HostKeyType) -> Result<ssh2::KnownHostKeyFormat, String> {
    use ssh2::{HostKeyType, KnownHostKeyFormat};
    Ok(match t {
        HostKeyType::Rsa => KnownHostKeyFormat::SshRsa,
        HostKeyType::Dss => KnownHostKeyFormat::SshDss,
        HostKeyType::Ecdsa256 => KnownHostKeyFormat::Ecdsa256,
        HostKeyType::Ecdsa384 => KnownHostKeyFormat::Ecdsa384,
        HostKeyType::Ecdsa521 => KnownHostKeyFormat::Ecdsa521,
        HostKeyType::Ed25519 => KnownHostKeyFormat::Ed25519,
        HostKeyType::Unknown => return Err("server uses an unknown host-key type".into()),
    })
}

/// Verify the server's host key against the user's `~/.ssh/known_hosts`, with
/// OpenSSH "accept-new" semantics: a matching known key proceeds; a *changed*
/// key is REFUSED (possible MITM); a first-seen host is pinned and allowed.
/// Returns the SHA-256 fingerprint for display/logging.
fn verify_host_key(sess: &ssh2::Session, host: &str, port: u16) -> Result<String, String> {
    let (key, key_type) = sess.host_key().ok_or("server presented no host key")?;
    // Copy out of the borrow so we can mutate KnownHosts below.
    let key = key.to_vec();

    let fingerprint = sess
        .host_key_hash(ssh2::HashType::Sha256)
        .map(|h| format!("SHA256:{}", base64_no_pad(h)))
        .unwrap_or_else(|| "unknown".into());

    let mut known = sess.known_hosts().map_err(|e| e.to_string())?;
    let kh_path = home_dir()
        .map(|h| h.join(".ssh").join("known_hosts"))
        .ok_or("cannot locate home directory for known_hosts")?;
    // Missing file just means "no hosts known yet" — not an error.
    let _ = known.read_file(&kh_path, ssh2::KnownHostFileKind::OpenSSH);

    match known.check_port(host, port, &key) {
        ssh2::CheckResult::Match => Ok(fingerprint),
        ssh2::CheckResult::Mismatch => Err(format!(
            "HOST KEY MISMATCH for {host}:{port} — the server's key changed ({fingerprint}). \
             Refusing to connect (possible man-in-the-middle). If this change was intentional, \
             remove the host's line from ~/.ssh/known_hosts and reconnect."
        )),
        ssh2::CheckResult::NotFound => {
            // First sight: pin the key (accept-new) so a later change is caught.
            let fmt = host_key_format(key_type)?;
            known
                .add(host, &key, "added by Pluto's Terminals", fmt)
                .map_err(|e| format!("failed to record host key: {e}"))?;
            if let Some(parent) = kh_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = known.write_file(&kh_path, ssh2::KnownHostFileKind::OpenSSH);
            Ok(fingerprint)
        }
        ssh2::CheckResult::Failure => Err("host-key check failed".into()),
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
    // For jump-host connections (host = 127.0.0.1:<tunnel port>), verify/pin the
    // host key under the real target identity instead of the throwaway port.
    let verify_as = host_key_alias
        .as_deref()
        .map(|h| (h, host_key_port.unwrap_or(port)));
    let sess = connect_session(&host, port, &user, &auth, verify_as)?;

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

    state
        .sessions
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())?
        .insert(
            id.clone(),
            Session::Ssh(SshHandle {
                writes: write_tx,
                ctrl: ctrl_tx,
                ready: ready_tx,
            }),
        );

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
        // Incomplete trailing UTF-8 bytes carried across read chunks (see
        // decode_utf8_stream).
        let mut pending: Vec<u8> = Vec::new();
        loop {
            // 1. Pull queued writes from pty_write into the outbound buffer. A
            //    disconnected sender means the registry entry was dropped
            //    (pty_kill / kill_all) → tear down.
            loop {
                match write_rx.try_recv() {
                    Ok(data) => outbound.extend(data),
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
                    let _ = app_for_thread.emit(
                        &format!("pty://{}", id_for_thread),
                        "\r\n\x1b[1;31m[Pluto's Terminals] SSH connection stalled: outbound \
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
            //    on the global flusher), THEN sleep.
            match channel.read(&mut buf) {
                Ok(0) => {
                    if channel.eof() {
                        break;
                    }
                    flush_pending(&app_for_thread, &id_for_thread, &co_entry, false);
                    thread::sleep(Duration::from_millis(8));
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
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if channel.eof() {
                        break;
                    }
                    flush_pending(&app_for_thread, &id_for_thread, &co_entry, false);
                    thread::sleep(Duration::from_millis(8));
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
    state
        .sessions
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())?
        .insert(
            id.clone(),
            Session::Serial(SerialHandle {
                writer: Arc::new(Mutex::new(port)),
                alive: alive.clone(),
                ready: ready_tx,
            }),
        );

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
    // moot, and a stale dirty entry must not pin the flusher awake.
    if let Ok(mut map) = registry.coalescers.lock() {
        map.clear();
    }
    if let Ok(mut set) = registry.dirty.set.lock() {
        set.clear();
    }
    if let Ok(mut sessions) = registry.sessions.lock() {
        for (_id, session) in sessions.drain() {
            // Local: kill the child. Ssh: dropping the handle's senders signals
            // its reader thread to close the channel + connection. Serial: flip
            // `alive` so its reader thread exits.
            match session {
                Session::Local(mut s) => {
                    let _ = s.child.kill();
                    // Reap after kill — no zombies left behind at app exit.
                    let _ = s.child.wait();
                }
                Session::Serial(h) => {
                    h.alive.store(false, Ordering::Relaxed);
                }
                Session::Ssh(_) => {}
            }
        }
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
