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
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
}

/// A live session, transport-agnostic. Local PTYs and SSH channels share one
/// registry and one set of `pty_*` commands so none of the renderer's
/// xterm/scrollback/cost/activity machinery has to know the difference.
pub enum Session {
    Local(PtySession),
    Ssh(SshHandle),
}

#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, Session>>,
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
    match sessions.get_mut(&id).ok_or("session not found")? {
        Session::Local(s) => {
            s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        }
        Session::Ssh(h) => {
            h.writes
                .send(data.into_bytes())
                .map_err(|_| "ssh session closed".to_string())?;
        }
    }
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
    // and closes the channel + TCP connection.
    if let Some(Session::Local(mut s)) = sessions.remove(&id) {
        let _ = s.child.kill();
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

/// Open an interactive SSH shell and register it behind the same `pty_*` seam
/// local PTYs use. The `ssh2::Channel` is `!Sync`, so it lives solely on the
/// reader thread; `pty_write`/`pty_resize` reach it via mpsc channels.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn ssh_spawn(
    app: AppHandle,
    state: State<'_, SessionRegistry>,
    host: String,
    port: u16,
    user: String,
    auth: SshAuth,
    cols: u16,
    rows: u16,
    tab_id: Option<String>,
) -> Result<String, String> {
    let port = if port == 0 { 22 } else { port };
    let tcp = TcpStream::connect((host.as_str(), port))
        .map_err(|e| format!("connect to {host}:{port} failed: {e}"))?;
    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| format!("ssh handshake failed: {e}"))?;

    // Host-key verification — never skipped; refuses on a changed key.
    let _fingerprint = verify_host_key(&sess, &host, port)?;

    // Authentication.
    match auth.method.as_str() {
        "password" => {
            let pw = auth.password.as_deref().unwrap_or("");
            sess.userauth_password(&user, pw)
                .map_err(|e| format!("password auth failed: {e}"))?;
        }
        "key" => {
            let key = auth.key_path.as_deref().ok_or("no key path provided")?;
            sess.userauth_pubkey_file(
                &user,
                None,
                std::path::Path::new(key),
                auth.passphrase.as_deref(),
            )
            .map_err(|e| format!("key auth failed: {e}"))?;
        }
        "agent" => {
            let mut agent = sess.agent().map_err(|e| e.to_string())?;
            agent.connect().map_err(|e| format!("ssh-agent connect failed: {e}"))?;
            agent.list_identities().map_err(|e| e.to_string())?;
            let ids = agent.identities().map_err(|e| e.to_string())?;
            let mut ok = false;
            for id in ids {
                if agent.userauth(&user, &id).is_ok() {
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

    let id = new_session_id();
    let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>();
    let (ctrl_tx, ctrl_rx) = mpsc::channel::<SshCtrl>();

    state
        .sessions
        .lock()
        .map_err(|_| "registry mutex poisoned".to_string())?
        .insert(
            id.clone(),
            Session::Ssh(SshHandle {
                writes: write_tx,
                ctrl: ctrl_tx,
            }),
        );

    let mut scrollback_writer = tab_id
        .as_ref()
        .map(|tid| ScrollbackWriter::new(scrollback_path(&app, tid)));

    let id_for_thread = id.clone();
    let app_for_thread = app.clone();
    thread::spawn(move || {
        // Sole owner of the channel + session (both !Sync). Keep the session
        // alive for the channel's lifetime.
        let _sess = sess;
        let mut channel = channel;
        let mut buf = [0u8; 4096];
        loop {
            // 1. Drain writes pushed by pty_write. A disconnected sender means
            //    the registry entry was dropped (pty_kill / kill_all) → tear down.
            loop {
                match write_rx.try_recv() {
                    Ok(data) => {
                        let _ = channel.write_all(&data);
                        let _ = channel.flush();
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        let _ = channel.close();
                        let _ = app_for_thread.emit(&format!("pty-exit://{}", id_for_thread), ());
                        return;
                    }
                }
            }
            // 2. Apply resizes from pty_resize. (Empty/Disconnected → stop here;
            //    kill is handled by the write-channel disconnect above.)
            while let Ok(SshCtrl::Resize(c, r)) = ctrl_rx.try_recv() {
                let _ = channel.request_pty_size(c as u32, r as u32, None, None);
            }
            // 3. Read output (non-blocking → WouldBlock when idle).
            match channel.read(&mut buf) {
                Ok(0) => {
                    if channel.eof() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(8));
                }
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    if let Some(w) = scrollback_writer.as_mut() {
                        w.append(chunk.as_bytes());
                    }
                    let _ = app_for_thread.emit(&format!("pty://{}", id_for_thread), chunk);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if channel.eof() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(8));
                }
                Err(_) => break,
            }
        }
        let _ = channel.close();
        let _ = channel.wait_close();
        let _ = app_for_thread.emit(&format!("pty-exit://{}", id_for_thread), ());
    });

    Ok(id)
}

/// Kill every live PTY child. Called from RunEvent::ExitRequested so we
/// never leave a shell process orphaned when the app closes.
pub fn kill_all(registry: &SessionRegistry) {
    if let Ok(mut sessions) = registry.sessions.lock() {
        for (_id, session) in sessions.drain() {
            // Local: kill the child. Ssh: dropping the handle's senders signals
            // its reader thread to close the channel + connection.
            if let Session::Local(mut s) = session {
                let _ = s.child.kill();
            }
        }
    }
}
