// Tauri commands for Pluto's Terminals.
//
// Lifted from Lyfe with KB / journal commands stripped. Kept everything the
// terminals tab depends on: filesystem store (state persistence), folder
// picker, git status, npm scripts, scrollback save/load/delete, transcripts,
// recent files for the project sidebar.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// CREATE_NO_WINDOW — suppresses the conhost.exe console flash that
// would otherwise appear (and steal focus) each time a child process
// is spawned from a non-console app. Mandatory on every non-PTY
// spawn site since git/cmd/etc. are polled periodically by the UI.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    // `mut` is only used on Windows (creation_flags below); silence the unused-mut
    // lint elsewhere rather than dropping it and breaking the Windows build.
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

// ── Data directory helper ─────────────────────────────────────────
// Uses the app's local data directory (e.g., %APPDATA%/com.plutothedev.terminals)
// In dev, falls back to a `data` folder next to package.json so iteration
// preserves state across `cargo tauri dev` restarts.

pub fn get_data_dir(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."));
        let mut dir = exe_dir.clone();
        loop {
            if dir.join("package.json").exists() {
                return dir.join("data");
            }
            if !dir.pop() {
                break;
            }
        }
    }

    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("data"))
}

// ── Store (state persistence; complements localStorage) ──────────

#[tauri::command]
pub fn read_store(app: AppHandle) -> Result<String, String> {
    let path = get_data_dir(&app).join("store.json");
    if path.exists() {
        fs::read_to_string(&path).map_err(|e| e.to_string())
    } else {
        Ok("null".to_string())
    }
}

#[tauri::command]
pub fn write_store(app: AppHandle, data: String) -> Result<(), String> {
    let dir = get_data_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("store.json");
    // Atomic replace (write-tmp + rename, same pattern as the scrollback
    // tail-truncation in pty.rs) so a crash/power-cut mid-write can't leave a
    // truncated or half-written store.json behind.
    let tmp = dir.join("store.json.tmp");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ── Native folder picker (used by Terminals tab project sidebar) ──

#[tauri::command]
pub fn pick_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

// ── Welcome box file ──────────────────────────────────────────────
//
// The MobaXterm-style welcome box is ~2.4 KB of ANSI — too long to send as a
// single shell command line (it would truncate at the tty canonical limit).
// We write it to a file in the data dir and the fresh shell just `cat`s it
// (a short command), so the box prints cleanly before the first prompt.
#[tauri::command]
pub fn write_welcome_file(app: AppHandle, content: String) -> Result<String, String> {
    let dir = get_data_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("welcome.ansi");
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// ── Open a file/dir path with the OS default handler ──────────────
//
// Used when a file path printed in the terminal is clicked. A leading `~/`
// is expanded to the user's home. Opens with `open` (macOS), `start`
// (Windows), or `xdg-open` (other Unix).
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let mut p = path.trim().to_string();
    if let Some(rest) = p.strip_prefix("~/") {
        p = local_home().join(rest).to_string_lossy().to_string();
    } else if p == "~" {
        p = local_home().to_string_lossy().to_string();
    }
    // Reject control characters (newlines, NUL, …) — never valid in a real path or
    // URL and a classic way to smuggle a second command past a launcher.
    if p.is_empty() || p.chars().any(|c| c.is_control()) {
        return Err("refusing to open a path with control characters".into());
    }
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&p).spawn();
    // Windows: launch via explorer.exe, NOT `cmd /C start`. explorer receives the
    // path/URL as a single CreateProcess argument, so cmd metacharacters
    // (& | < > ^ %) are taken literally instead of reparsed as command separators
    // / env-expansion. This closes the clickable-link / update-link command-
    // injection vector: a malicious MOTD/file printing e.g. `/tmp/x&calc` that the
    // user clicks no longer runs `calc`. explorer's exit code is unreliable, so we
    // only assert it spawned.
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("explorer").arg(&p).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&p).spawn();
    spawned.map(|_| ()).map_err(|e| e.to_string())
}

// ── Git worktrees for parallel AI agents ──────────────────────────
//
// Each agent runs in its own worktree (own directory + branch, sharing the
// repo's one .git) so parallel agents never clobber each other's files or
// branch. Worktrees live under <repo>/.worktrees/<branch>; that folder is
// added to the repo's LOCAL exclude (.git/info/exclude) so it never dirties
// `git status` and the tracked .gitignore is left untouched.
fn sanitize_branch(b: &str) -> String {
    b.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '/' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

#[tauri::command]
pub async fn worktree_add(repo: String, branch: String) -> Result<String, String> {
    let repo_path = PathBuf::from(&repo);
    if !repo_path.join(".git").exists() {
        return Err("Not a git repository (no .git found).".into());
    }
    let safe = sanitize_branch(&branch);
    let wt = repo_path.join(".worktrees").join(safe.replace('/', "-"));

    // Keep .worktrees/ out of `git status` via the repo's local exclude file.
    let exclude = repo_path.join(".git").join("info").join("exclude");
    if let Ok(mut content) = fs::read_to_string(&exclude) {
        if !content.contains(".worktrees/") {
            if !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str(".worktrees/\n");
            let _ = fs::write(&exclude, content);
        }
    }

    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["worktree", "add", "-b", &safe])
        .arg(&wt)
        .output()
        .map_err(|e| format!("git not found: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(wt.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn worktree_remove(repo: String, path: String) -> Result<(), String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["worktree", "remove", "--force", &path])
        .output()
        .map_err(|e| format!("git not found: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

// ── Diff review + one-click PR for agent worktrees ────────────────
//
// git_diff returns the worktree's changes vs HEAD (uncommitted) plus, if the
// branch has commits beyond its merge-base with the default branch, those too —
// so an agent's work is reviewable whether or not it committed. gh_pr_create
// pushes the branch and opens a PR with gh (requires gh auth + a remote).
#[tauri::command]
pub async fn git_diff(path: String) -> Result<String, String> {
    let run = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(args)
            .output()
    };
    // Committed work vs the branch point (origin/HEAD or main/master), if resolvable.
    let mut diff = String::new();
    for base in ["origin/HEAD", "main", "master"] {
        if let Ok(mb) = run(&["merge-base", "HEAD", base]) {
            if mb.status.success() {
                let base_sha = String::from_utf8_lossy(&mb.stdout).trim().to_string();
                if let Ok(d) = run(&["diff", "--no-color", &format!("{base_sha}...HEAD")]) {
                    if d.status.success() {
                        diff.push_str(&String::from_utf8_lossy(&d.stdout));
                    }
                }
                break;
            }
        }
    }
    // Uncommitted working-tree changes vs HEAD.
    if let Ok(d) = run(&["diff", "--no-color", "HEAD"]) {
        if d.status.success() {
            let s = String::from_utf8_lossy(&d.stdout);
            if !s.trim().is_empty() {
                if !diff.is_empty() {
                    diff.push_str("\n");
                }
                diff.push_str(&s);
            }
        } else {
            return Err(String::from_utf8_lossy(&d.stderr).trim().to_string());
        }
    }
    Ok(diff)
}

#[tauri::command]
pub async fn gh_pr_create(path: String) -> Result<String, String> {
    let push = std::process::Command::new("git")
        .current_dir(&path)
        .args(["push", "-u", "origin", "HEAD"])
        .output()
        .map_err(|e| format!("git not found: {e}"))?;
    if !push.status.success() {
        return Err(format!(
            "git push failed: {}",
            String::from_utf8_lossy(&push.stderr).trim()
        ));
    }
    let out = std::process::Command::new("gh")
        .current_dir(&path)
        .args(["pr", "create", "--fill"])
        .output()
        .map_err(|e| format!("gh CLI not found — install it to open PRs: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ── OS notification (agent finished / needs input) ────────────────
//
// Fired when an agent transitions to done — or pauses for approval — while the
// app is in the background. macOS uses osascript; Linux notify-send; Windows is
// best-effort (no-op if neither path matches).
#[tauri::command]
pub fn notify(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let t = title.replace('"', "'");
        let b = body.replace('"', "'");
        let script = format!("display notification \"{b}\" with title \"{t}\"");
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("notify-send")
            .args([&title, &body])
            .spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (&title, &body); // best-effort: native toast needs a module; skip.
    }
    Ok(())
}

// ── Quit the whole app (Exit toolbar button) ──────────────────────
//
// Fires app.exit(0), which triggers RunEvent::ExitRequested → kill_all()
// so no PTY children orphan. This is the same path as the tray "Quit".
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

// ── Spawn a new app window (v0.1.19 multi-window) ──────────────────
//
// Each new window gets its own URL fragment (?w=<id>) so the React app
// can isolate localStorage state per window via STORAGE_KEY suffix. The
// window inherits app config + dev tools + tray-hide behavior. Closing
// secondary windows hides them like the main window (so PTY sessions
// keep running). True quit still happens via the tray menu.

#[tauri::command]
pub async fn spawn_new_window(app: tauri::AppHandle, window_id: String) -> Result<String, String> {
    let safe_id: String = window_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    if safe_id.is_empty() {
        return Err("window_id must contain at least one alphanumeric char".into());
    }
    let label = format!("win-{}", safe_id);
    if app.get_webview_window(&label).is_some() {
        // Already exists — focus it.
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.show();
            let _ = w.set_focus();
        }
        return Ok(label);
    }

    let url = tauri::WebviewUrl::App(format!("index.html?w={}", safe_id).into());
    tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title(&format!("Pluto's Terminal — {}", safe_id))
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .decorations(true)
        .build()
        .map_err(|e| format!("spawn_new_window failed: {e}"))?;
    Ok(label)
}

// ── Save text to a user-picked file path (v0.1.18 session recording) ──
//
// Used by the asciinema recorder to write .cast files. Caller passes the
// suggested filename + extension; user picks final path via native save
// dialog. Returns Ok(Some(path)) on success, Ok(None) if user canceled,
// Err on disk error. Frontend handles user feedback (toast).

#[tauri::command]
pub fn save_text_to_file(
    suggested_name: String,
    extension: String,
    extension_label: String,
    contents: String,
) -> Result<Option<String>, String> {
    let dialog = rfd::FileDialog::new()
        .set_file_name(&suggested_name)
        .add_filter(&extension_label, &[&extension])
        .add_filter("All files", &["*"]);
    let chosen = dialog.save_file();
    match chosen {
        Some(path) => {
            fs::write(&path, contents).map_err(|e| e.to_string())?;
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

// ── Setup-check helpers (used by SetupChecker for first-run prereq detection) ──
//
// The app expects users to have Node.js + Claude Code CLI on PATH. These
// commands try `<bin> --version` and report the trimmed stdout if it succeeds,
// or None if the binary isn't found / the call fails. Used by the 🚀 setup
// modal to show users a clear "Node ✓ / Claude ✗ / API key ✓" checklist on
// first launch instead of letting them type `claude` and hit "command not
// recognized" as their first impression.

// ── MCP installer (v0.1.8 Tier 1 #2) ──────────────────────────────
//
// Runs `claude mcp add ...` directly (no shell) so the user doesn't have to
// copy + paste install commands. The frontend passes an explicit argv vector;
// argv[0] MUST be "claude". Because there is NO shell, there is no command
// chaining / substitution to guard against — the previous denylist let `$(...)`
// through, so this argv form is both simpler and strictly safer. Result is
// reported back to the frontend as { ok, stdout, stderr }.

#[derive(serde::Serialize, serde::Deserialize)]
pub struct McpInstallResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
pub async fn mcp_install(argv: Vec<String>) -> Result<McpInstallResult, String> {
    if argv.first().map(String::as_str) != Some("claude") {
        return Err("Only `claude` invocations are allowed.".to_string());
    }
    // No shell runs, so ${PWD}/$HOME/%USERPROFILE% can't be expanded downstream.
    // Resolve the placeholder to the real home dir here, as a single argv element
    // (so a home path containing spaces stays one argument). Mirrors the prior
    // behavior, which expanded the filesystem-MCP root to the user's home.
    let home = local_home().to_string_lossy().into_owned();
    let resolved: Vec<String> = argv[1..]
        .iter()
        .map(|a| match a.as_str() {
            "${PWD}" | "$HOME" | "%USERPROFILE%" => home.clone(),
            _ => a.clone(),
        })
        .collect();

    // SECURITY (audit 2026-06-19): on Windows these tokens reach `cmd /c claude ...`,
    // and std does NOT caret-escape cmd metacharacters when the spawned program is
    // cmd.exe, so a standalone `&` or a `>` redirect inside any arg gets reparsed by
    // cmd.exe as command chaining / redirection (a verified RCE PoC drove `calc`
    // through this path). The frontend builds argv from a fixed catalog, but this
    // command is directly invokable from the webview, so do not trust the caller:
    // reject any token carrying a shell metacharacter. Legitimate catalog tokens and
    // the resolved home path contain none of these.
    if let Some(bad) = resolved
        .iter()
        .find(|a| a.chars().any(|c| matches!(c, '&' | '|' | '<' | '>' | '^' | '%' | '"' | '\n' | '\r')))
    {
        return Err(format!(
            "Refusing MCP install: a path or argument contains a character the Windows shell would misinterpret ({bad}). Pick a folder whose name has no & | < > ^ % or quote characters."
        ));
    }

    // Unix: exec `claude` directly — no shell at all, so there is no
    // metacharacter / command-chaining surface regardless of the args.
    // Windows: the Claude CLI is an npm shim (`claude.cmd`), which CreateProcess
    // (and thus a bare Command::new("claude")) won't resolve — only `.exe`. Route
    // through `cmd /c claude …` so PATHEXT finds the `.cmd`, passing every token
    // as a SEPARATE arg rather than one reparsed string. std quotes spaces/quotes
    // but does NOT caret-escape cmd metacharacters (& | < > ^ %) when the spawned
    // program is cmd.exe, which is why the metacharacter guard above runs first and
    // rejects any such token before it reaches this branch (the Unix no-shell branch
    // is safe either way).
    #[cfg(target_os = "windows")]
    let output = silent_command("cmd")
        .arg("/c")
        .arg("claude")
        .args(&resolved)
        .output()
        .map_err(|e| format!("Failed to run claude: {e}"))?;

    #[cfg(not(target_os = "windows"))]
    let output = silent_command("claude")
        .args(&resolved)
        .output()
        .map_err(|e| format!("Failed to run claude: {e}"))?;

    Ok(McpInstallResult {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[tauri::command]
pub async fn check_command_version(name: String) -> Option<String> {
    if name.is_empty() || name.contains(['/', '\\', '.', ' ']) {
        // Reject obviously-malformed inputs — only bare command names allowed.
        return None;
    }
    let output = silent_command(&name).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let combined = if !output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        String::from_utf8_lossy(&output.stderr).into_owned()
    };
    let first_line = combined.lines().next().unwrap_or("").trim().to_string();
    if first_line.is_empty() {
        None
    } else {
        Some(first_line)
    }
}

// ── Git branch + dirty status for a project's cwd ─────────────────

#[derive(Serialize, Deserialize)]
pub struct GitBranchStatus {
    pub branch: String,
    pub dirty: bool,
}

#[tauri::command]
pub async fn git_branch_status(cwd: String) -> Option<GitBranchStatus> {
    let path = std::path::Path::new(&cwd);
    if !path.exists() || !path.is_dir() {
        return None;
    }
    let branch_out = silent_command("git")
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("HEAD")
        .current_dir(&cwd)
        .output()
        .ok()?;
    if !branch_out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string();
    if branch.is_empty() {
        return None;
    }
    let status_out = silent_command("git")
        .arg("status")
        .arg("--porcelain")
        .current_dir(&cwd)
        .output()
        .ok()?;
    let dirty = !String::from_utf8_lossy(&status_out.stdout)
        .trim()
        .is_empty();
    Some(GitBranchStatus { branch, dirty })
}

// ── npm scripts from a project's package.json ─────────────────────

#[tauri::command]
pub fn read_npm_scripts(cwd: String) -> Vec<String> {
    let pkg = std::path::Path::new(&cwd).join("package.json");
    if !pkg.exists() {
        return vec![];
    }
    let content = match fs::read_to_string(&pkg) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    json.get("scripts")
        .and_then(|s| s.as_object())
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

// ── Scrollback persistence + session transcripts ──────────────────

pub fn safe_filename(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn scrollback_path(app: &AppHandle, tab_id: &str) -> PathBuf {
    get_data_dir(app)
        .join("terminals")
        .join("scrollback")
        .join(format!("{}.txt", safe_filename(tab_id)))
}

#[tauri::command]
pub fn scrollback_save(app: AppHandle, tab_id: String, content: String) -> Result<(), String> {
    let path = scrollback_path(&app, &tab_id);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn scrollback_load(app: AppHandle, tab_id: String) -> Option<String> {
    let path = scrollback_path(&app, &tab_id);
    if !path.exists() {
        return None;
    }
    // v0.1.30: read raw bytes + lossy-decode instead of read_to_string. The
    // previous version returned None for files containing any invalid UTF-8
    // (e.g. raw bytes written by the v0.1.29 PTY reader thread before we
    // started lossy-decoding on write). Lossy-decoding means existing files
    // still load — invalid bytes show as U+FFFD, which is what xterm.js
    // already renders for those sequences during live output.
    fs::read(&path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn scrollback_delete(app: AppHandle, tab_id: String) -> Result<(), String> {
    let path = scrollback_path(&app, &tab_id);
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    Ok(())
}

// Append a chunk to a daily session transcript.
// Path: data/terminals/transcripts/{date}/{name}.md
#[tauri::command]
pub fn transcript_append(
    app: AppHandle,
    date: String,
    name: String,
    content: String,
) -> Result<(), String> {
    use std::io::Write;
    let dir = get_data_dir(&app)
        .join("terminals")
        .join("transcripts")
        .join(safe_filename(&date));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.md", safe_filename(&name)));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Recent files for the project sidebar ──────────────────────────
// Pulls from git status (currently modified) + git log (recently committed),
// then a directory walk fallback for non-git folders. Filters lockfiles,
// binaries, build artifacts.

#[tauri::command]
pub async fn recent_files(cwd: String) -> Vec<String> {
    let path = std::path::Path::new(&cwd);
    if !path.exists() || !path.is_dir() {
        return vec![];
    }

    let mut files: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let push =
        |f: String, files: &mut Vec<String>, seen: &mut std::collections::HashSet<String>| {
            if !seen.contains(&f) {
                seen.insert(f.clone());
                files.push(f);
            }
        };

    // 1. git status --porcelain (currently modified files)
    if let Ok(out) = silent_command("git")
        .args(["status", "--porcelain"])
        .current_dir(&cwd)
        .output()
    {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                // Porcelain v1: two status bytes + a space, then the path. Do
                // NOT trim_start first — unstaged entries lead with a space
                // (" M file"), and trimming shifted the [3..] slice into the
                // middle of the filename. Renames/copies are "XY old -> new";
                // keep the post-rename path.
                if line.len() < 4 {
                    continue;
                }
                let path = &line[3..];
                let f = match path.split_once(" -> ") {
                    Some((_, new)) => new,
                    None => path,
                }
                .to_string();
                if !f.is_empty() {
                    push(f, &mut files, &mut seen);
                }
            }
        }
    }

    // 2. git log --name-only (recently committed)
    if let Ok(out) = silent_command("git")
        .args([
            "log",
            "--all",
            "--pretty=format:",
            "--name-only",
            "-n",
            "30",
        ])
        .current_dir(&cwd)
        .output()
    {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let f = line.trim().to_string();
                if !f.is_empty() {
                    push(f, &mut files, &mut seen);
                }
            }
        }
    }

    // 3. Filter junk + verify file exists + cap at 5
    let bad_dirs = ["node_modules", "__pycache__", "target", "dist", ".git/"];
    let bad_ext = [
        ".lock", ".log", ".min.js", ".min.css", ".ico", ".png", ".jpg", ".jpeg", ".gif", ".svg",
        ".woff", ".woff2", ".ttf", ".eot", ".map", ".pyc", ".pkl", ".db", ".sqlite", ".exe",
        ".dll", ".so", ".dylib", ".o", ".obj",
    ];
    let bad_files = [
        ".DS_Store",
        ".gitignore",
        ".gitattributes",
        "package-lock.json",
        "yarn.lock",
        "bun.lockb",
    ];

    let filtered: Vec<String> = files
        .into_iter()
        .filter(|f| !bad_dirs.iter().any(|d| f.contains(d)))
        .filter(|f| {
            let lower = f.to_lowercase();
            !bad_ext.iter().any(|e| lower.ends_with(e))
        })
        .filter(|f| {
            let base = std::path::Path::new(f)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            !bad_files.contains(&base)
        })
        .filter(|f| path.join(f).exists())
        .take(5)
        .collect();

    if !filtered.is_empty() {
        return filtered;
    }
    mtime_sorted_files(path, &bad_dirs, &bad_ext, &bad_files)
}

fn mtime_sorted_files(
    root: &std::path::Path,
    bad_dirs: &[&str],
    bad_ext: &[&str],
    bad_files: &[&str],
) -> Vec<String> {
    use std::time::SystemTime;

    let source_ext = [
        ".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".rb", ".php", ".html", ".css",
        ".scss", ".vue", ".svelte", ".cs", ".cpp", ".c", ".h", ".hpp", ".swift", ".kt", ".dart",
        ".sh", ".md", ".json", ".yaml", ".yml", ".toml", ".sql", ".lua", ".ex", ".exs", ".clj",
    ];

    let mut entries: Vec<(String, SystemTime)> = Vec::new();
    walk_dir(root, root, 3, bad_dirs, &mut entries);
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    entries
        .into_iter()
        .map(|(rel, _)| rel)
        .filter(|f| {
            let lower = f.to_lowercase();
            if !source_ext.iter().any(|e| lower.ends_with(e)) {
                return false;
            }
            if bad_ext.iter().any(|e| lower.ends_with(e)) {
                return false;
            }
            let base = std::path::Path::new(f)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            !bad_files.contains(&base)
        })
        .take(5)
        .collect()
}

fn walk_dir(
    root: &std::path::Path,
    dir: &std::path::Path,
    depth: i32,
    bad_dirs: &[&str],
    entries: &mut Vec<(String, std::time::SystemTime)>,
) {
    if depth < 0 {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let p = entry.path();
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name.starts_with('.') {
            continue;
        }
        if bad_dirs.iter().any(|d| name == d.trim_end_matches('/')) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.is_dir() {
                walk_dir(root, &p, depth - 1, bad_dirs, entries);
            } else if meta.is_file() {
                if let Ok(rel) = p.strip_prefix(root) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    if let Ok(mtime) = meta.modified() {
                        entries.push((rel_str, mtime));
                    }
                }
            }
        }
    }
}

// ── Local file browser (MobaXterm-style left "Sftp" panel for local fs) ──

#[derive(Serialize)]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: Option<u64>,
}

pub(crate) fn local_home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// List a local directory (single level). `path` null/empty → home. Returns the
/// resolved absolute path + entries (dirs first, then case-insensitive by name).
#[tauri::command]
pub fn list_directory(path: Option<String>) -> Result<(String, Vec<LocalEntry>), String> {
    let dir = match path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => local_home(),
    };
    let resolved = fs::canonicalize(&dir).unwrap_or(dir);
    let read = fs::read_dir(&resolved).map_err(|e| format!("{}: {e}", resolved.display()))?;
    let mut entries = Vec::new();
    for ent in read.flatten() {
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = ent.file_name().to_string_lossy().into_owned();
        // Skip dotfiles to keep the tree tidy (MobaXterm hides them by default).
        if name.starts_with('.') {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        entries.push(LocalEntry {
            name,
            path: ent.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            mtime,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok((resolved.to_string_lossy().into_owned(), entries))
}
