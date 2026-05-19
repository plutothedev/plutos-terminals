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

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::scrollback_path;

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

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, PtySession>>,
}

fn new_session_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("pty_{:x}", nanos)
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
    bytes_on_disk: u64,
}

impl ScrollbackWriter {
    /// Create a new writer for a tab. Creates parent dirs eagerly. Seeds
    /// `bytes_on_disk` from any existing file so we don't lose track on a
    /// pane that was previously persisted.
    fn new(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let bytes_on_disk = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Self { path, bytes_on_disk }
    }

    /// Append a chunk. Best-effort: on I/O failure we silently swallow rather
    /// than tear down the PTY reader — losing scrollback is worse for the
    /// pane's correctness than losing scrollback durability.
    fn append(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let opened = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path);
        if let Ok(mut f) = opened {
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
        let Ok(data) = fs::read(&self.path) else { return; };
        if data.len() <= SCROLLBACK_FILE_KEEP_BYTES {
            self.bytes_on_disk = data.len() as u64;
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
        }
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

    let id = new_session_id();
    let session = PtySession {
        master: pair.master,
        child,
        writer,
    };
    state
        .sessions
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())?
        .insert(id.clone(), session);

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
    let id_for_thread = id.clone();
    let app_for_thread = app.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    // Persist the same UTF-8 bytes xterm receives, so a hard
                    // process death between emit and disk-flush still
                    // preserves what we just rendered. Best-effort.
                    if let Some(w) = scrollback_writer.as_mut() {
                        w.append(chunk.as_bytes());
                    }
                    let _ = app_for_thread.emit(&format!("pty://{}", id_for_thread), chunk);
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit(&format!("pty-exit://{}", id_for_thread), ());
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(
    state: State<'_, SessionRegistry>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())?;
    let session = sessions.get_mut(&id).ok_or("session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, SessionRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())?;
    let session = sessions.get(&id).ok_or("session not found")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(10),
            cols: cols.max(40),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, SessionRegistry>, id: String) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

/// Kill every live PTY child. Called from RunEvent::ExitRequested so we
/// never leave a shell process orphaned when the app closes.
pub fn kill_all(registry: &SessionRegistry) {
    if let Ok(mut sessions) = registry.sessions.lock() {
        for (_id, mut session) in sessions.drain() {
            let _ = session.child.kill();
        }
    }
}
