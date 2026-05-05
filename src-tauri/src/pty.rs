// PTY session management for the Terminals tab.
//
// Each session = one shell child process spawned via portable-pty (ConPTY on
// Windows, Unix PTYs elsewhere). The renderer drives the session through the
// `pty_*` Tauri commands; PTY output is streamed back as `pty://{id}` events.
//
// Lifecycle is tied to the SessionRegistry stored as Tauri state. On app exit,
// kill_all() runs from the RunEvent::ExitRequested handler in lib.rs so we
// never orphan a shell child.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

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
    // Fallback: Windows PowerShell 5 with PSReadLine + cleared banner.
    (
        "powershell.exe".into(),
        vec![
            "-NoLogo".into(),
            "-NoExit".into(),
            "-Command".into(),
            "Import-Module PSReadLine -ErrorAction SilentlyContinue; Clear-Host".into(),
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

    // Reader thread: pump bytes -> Tauri event. Exits on EOF / read error.
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
