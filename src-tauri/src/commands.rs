// Tauri commands for Pluto's Terminals.
//
// Lifted from Lyfe with KB / journal commands stripped. Kept everything the
// terminals tab depends on: filesystem store (state persistence), folder
// picker, git status, npm scripts, scrollback save/load/delete, transcripts,
// recent files for the project sidebar.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
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
    let mut safe = sanitize_branch(&branch);
    // git reads a leading '-' as a flag, so a sanitized name like "--upload-pack"
    // would be a latent argument-injection surface if the arg order ever changed;
    // also refuse an empty result. Callers pass agent/<ts>, but this command is
    // directly invokable from the webview, so don't trust the input.
    if safe.is_empty() || safe.starts_with('-') {
        safe = format!("wt-{}", safe.trim_start_matches('-'));
    }
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
    // Only remove a worktree that actually lives under the repo. This command is
    // directly invokable from the webview with a raw path and runs a --force
    // remove; confining it to the repo tree keeps a hostile/buggy caller from
    // pointing it at an unrelated registered worktree elsewhere on disk.
    let repo_c = std::fs::canonicalize(&repo).map_err(|e| e.to_string())?;
    // Don't require the leaf to exist: `git worktree remove --force` is also how
    // you prune a worktree whose directory was already deleted by hand. Resolve
    // the nearest existing ancestor and re-append the missing tail, so a
    // deleted-dir worktree can still be pruned while containment is still proven.
    let path_c = match std::fs::canonicalize(&path) {
        Ok(c) => c,
        Err(_) => {
            let pb = PathBuf::from(&path);
            let parent = pb.parent().ok_or("path not accessible")?;
            let file = pb.file_name().ok_or("path not accessible")?;
            std::fs::canonicalize(parent)
                .map_err(|_| "path not accessible".to_string())?
                .join(file)
        }
    };
    if !path_c.starts_with(&repo_c) {
        return Err("refusing to remove a worktree outside the repository".into());
    }
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

/// The Windows cmd metacharacters that `cmd /c claude ...` would reparse as command
/// chaining / redirection / env-expansion (std does not caret-escape them when the
/// spawned program is cmd.exe). Returns the first argument carrying one, if any.
fn first_shell_metachar_arg(args: &[String]) -> Option<&str> {
    args.iter()
        .map(String::as_str)
        .find(|a| a.chars().any(|c| matches!(c, '&' | '|' | '<' | '>' | '^' | '%' | '"' | '\n' | '\r')))
}

#[cfg(test)]
mod mcp_install_guard_tests {
    use super::first_shell_metachar_arg;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn rejects_cmd_metacharacters_but_allows_normal_paths() {
        // The injection vectors: a standalone `&`, a `>` redirect, an env-expansion `%`.
        assert_eq!(first_shell_metachar_arg(&v(&["mcp", "add", "x", "&"])), Some("&"));
        assert_eq!(first_shell_metachar_arg(&v(&["a>b"])), Some("a>b"));
        assert_eq!(first_shell_metachar_arg(&v(&["%PATH%"])), Some("%PATH%"));
        assert_eq!(first_shell_metachar_arg(&v(&["ok", "x|y"])), Some("x|y"));
        // Legitimate catalog tokens + a normal Windows path carry none of these.
        assert!(first_shell_metachar_arg(&v(&["mcp", "add", "fs", "--", "npx", "-y", "server"])).is_none());
        assert!(first_shell_metachar_arg(&v(&["C:\\Users\\pluto\\my-project"])).is_none());
        assert!(first_shell_metachar_arg(&v(&[])).is_none());
    }

    // Rationale lock (audit 2026-07-01): the guard blocks the cmd.exe chars that
    // actually enable command chaining / redirection / env-expansion. It does NOT
    // block `(` `)` `!` and that is deliberate: cmd.exe needs a command separator
    // (& | newline — all blocked) to start a new command, so a bare paren stays
    // argument text and can't inject; `!` is inert unless delayed expansion is on
    // (this code uses plain `cmd /c`, never `cmd /v:on`). Blocking `(` `)` would
    // instead reject legitimate paths like `C:\Program Files (x86)\...`. This test
    // pins that decision so a well-meaning "tighten the list" change gets a review.
    #[test]
    fn parens_and_bang_are_intentionally_allowed() {
        assert!(first_shell_metachar_arg(&v(&["C:\\Program Files (x86)\\tool"])).is_none());
        assert!(first_shell_metachar_arg(&v(&["path", "with!bang"])).is_none());
        // …but a real chaining primitive next to them is still caught.
        assert_eq!(first_shell_metachar_arg(&v(&["(evil)", "&", "calc"])), Some("&"));
    }
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
    if let Some(bad) = first_shell_metachar_arg(&resolved) {
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

// ── Agent rule-file collection (Stream A) ─────────────────────────
// (C) Narrow, bounded probe: reads ONLY AGENTS.md / CLAUDE.md walking up from
// cwd to the git root (inclusive; 12-level cap) or, when no git root exists,
// only the nearest 3 levels. Symlinks are skipped BEST-EFFORT (symlink_metadata
// check, then read — a swap between the two syscalls can still be followed),
// and hardlinks are undetectable here entirely; the JS layer's per-content-hash
// approval gate is the real backstop for both. No generic file-read IPC is
// exposed; the webview privilege boundary stays narrow. Early-stops past
// 32 KiB total (JS budget is 16 KiB).

const RULE_FILE_NAMES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];
const RULE_FILE_CAP: usize = 8 * 1024; // input-slice cap per file (lossy decode may exceed by a few bytes)
const RULE_WALK_MAX_LEVELS: usize = 12; // with a git root
const RULE_WALK_NON_GIT_LEVELS: usize = 3; // without one
const RULE_TOTAL_CAP: usize = 32 * 1024; // early-stop bound

#[derive(Serialize, Debug, PartialEq)]
pub struct RuleFile {
    pub path: String,
    pub name: String,
    pub content: String,
    pub truncated: bool,
}

fn display_path(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest); // \\?\UNC\srv\share -> \\srv\share
    }
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

fn read_rule_file(p: &std::path::Path) -> Option<RuleFile> {
    let meta = std::fs::symlink_metadata(p).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None; // skip links (best-effort; see module comment); dirs named AGENTS.md are noise
    }
    let bytes = std::fs::read(p).ok()?;
    let truncated = bytes.len() > RULE_FILE_CAP;
    let slice = if truncated { &bytes[..RULE_FILE_CAP] } else { &bytes[..] };
    // from_utf8_lossy turns a mid-sequence cut into U+FFFD at the tail — fine
    // for prompt text, never mojibake, never a panic.
    let content = String::from_utf8_lossy(slice).into_owned();
    Some(RuleFile {
        path: display_path(p),
        name: p.file_name()?.to_string_lossy().into_owned(),
        content,
        truncated,
    })
}

pub fn collect_rule_files_sync(cwd: String) -> Vec<RuleFile> {
    let start = match std::fs::canonicalize(std::path::Path::new(&cwd)) {
        Ok(p) if p.is_dir() => p,
        _ => return Vec::new(),
    };
    let mut levels: Vec<std::path::PathBuf> = Vec::new();
    let mut found_git = false;
    let mut dir = start;
    for i in 0..RULE_WALK_MAX_LEVELS {
        levels.push(dir.clone());
        if dir.join(".git").exists() { // .exists() covers the worktree FILE form too
            found_git = true;
            break;
        }
        if i + 1 >= RULE_WALK_MAX_LEVELS { break; }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
    if !found_git {
        levels.truncate(RULE_WALK_NON_GIT_LEVELS);
    }
    // Collect root-most first (injection order: root -> cwd, nearer wins by recency).
    let mut out: Vec<RuleFile> = Vec::new();
    let mut total = 0usize;
    for level in levels.iter().rev() {
        for name in RULE_FILE_NAMES {
            if total > RULE_TOTAL_CAP { return out; }
            if let Some(rf) = read_rule_file(&level.join(name)) {
                total += rf.content.len();
                out.push(rf);
            }
        }
    }
    out
}

#[tauri::command]
pub async fn collect_rule_files(cwd: String) -> Vec<RuleFile> {
    collect_rule_files_sync(cwd)
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

// (scrollback_save was removed in P1-T6: it had zero JS callers since the
// reader thread took file ownership in v0.1.29, and a whole-file overwrite
// would now fight the T2 segment rotation.)

/// Replay cap for a tab restore (P1-T6). The renderer keeps ~100KB in memory
/// and xterm caps at 10k lines, so reading megabytes on the MAIN THREAD at
/// boot just to discard ~97% of it was pure startup cost (up to 10MB × N tabs
/// pre-P1). 256KB of tail more than fills xterm's scrollback window.
const SCROLLBACK_REPLAY_CAP: usize = 256 * 1024;

/// Drop everything through the first newline when the slice started at a cut
/// (so ANSI sequences never straddle the boundary); a slice from offset 0 is
/// returned byte-identical. No newline in the slice → keep it raw rather than
/// lose the only content.
fn align_forward(buf: Vec<u8>, cut_mid_file: bool) -> Vec<u8> {
    if !cut_mid_file {
        return buf;
    }
    match buf.iter().position(|&b| b == b'\n') {
        Some(i) => buf[i + 1..].to_vec(),
        None => buf,
    }
}

/// Testable core: up to `cap` tail bytes across the two rotation segments,
/// old-part first then current — chronological replay order.
fn scrollback_tail(current: &std::path::Path, old: &std::path::Path, cap: usize) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    // Hold the current handle across the whole stitch: a concurrent rotation
    // renames the file out from under the PATH, but a held handle keeps
    // reading the same bytes. Sizing uses fstat on the HELD handle at read
    // time, not a racy pre-open metadata call.
    let mut cur = fs::File::open(current).ok();
    let cur_len = cur
        .as_ref()
        .and_then(|f| f.metadata().ok())
        .map(|m| m.len() as usize)
        .unwrap_or(0);
    let mut parts: Vec<Vec<u8>> = Vec::new();
    if cur_len < cap {
        // Fill the remaining budget from the old segment's tail.
        let budget = cap - cur_len;
        if let Ok(mut of) = fs::File::open(old) {
            if let Ok(m) = of.metadata() {
                let olen = m.len() as usize;
                let off = olen.saturating_sub(budget);
                if of.seek(SeekFrom::Start(off as u64)).is_ok() {
                    let mut buf = Vec::new();
                    if of.read_to_end(&mut buf).is_ok() {
                        parts.push(align_forward(buf, off > 0));
                    }
                }
            }
        }
    }
    let cur_missing = cur.is_none();
    if let Some(f) = cur.as_mut() {
        let off = cur_len.saturating_sub(cap);
        if f.seek(SeekFrom::Start(off as u64)).is_ok() {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                parts.push(align_forward(buf, off > 0));
            }
        }
    }
    if cur_missing && parts.iter().all(|p| p.is_empty()) {
        return None; // fresh tab: neither segment exists
    }
    let joined = parts.concat();
    // Lossy-decode (v0.1.30 rationale): legacy files may carry invalid UTF-8;
    // U+FFFD matches what xterm renders live.
    Some(String::from_utf8_lossy(&joined).into_owned())
}

/// Sync core for direct in-process callers (the phone companion dispatches on
/// its own blocking pool and calls this without the IPC wrapper).
pub fn scrollback_load_sync(app: &AppHandle, tab_id: &str) -> Option<String> {
    let path = scrollback_path(app, tab_id);
    let old = path.with_extension("old.txt");
    scrollback_tail(&path, &old, SCROLLBACK_REPLAY_CAP)
}

#[tauri::command]
pub async fn scrollback_load(app: AppHandle, tab_id: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || scrollback_load_sync(&app, &tab_id))
        .await
        .ok()
        .flatten()
}

#[tauri::command]
pub fn scrollback_delete(app: AppHandle, tab_id: String) -> Result<(), String> {
    let path = scrollback_path(&app, &tab_id);
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    // The previous rotation segment goes with it (P1-T2) — orphaning it would
    // leak up to 5MB per deleted tab until the 30-day age sweep.
    let old = path.with_extension("old.txt");
    if old.exists() {
        let _ = fs::remove_file(&old);
    }
    Ok(())
}

// ── Scrollback GC: keep-set + age sweep ───────────────────────────
// Per-tab scrollback lives in TWO segment files, `<id>.txt` + `<id>.old.txt`
// (~5MB each — see SCROLLBACK_SEGMENT_BYTES / rotation in pty.rs), which
// otherwise accumulate forever as
// tabs are closed. A file is deleted ONLY when it is BOTH (a) not owned by any
// currently-open tab — the caller passes the union of open tab ids across every
// window as a KEEP-list — AND (b) not written in `max_age` (default 30 days).
// The keep-list is a safety EXCLUSION, so an incomplete set only ever KEEPS more
// files (fail-safe), never deletes a wanted one; the age bound then reclaims the
// truly-abandoned remainder. (Workspaces re-mint tab ids on load, so a
// workspace-saved tab owns no scrollback under its stored id — only open tabs
// do, which is exactly what the keep-list carries.)

/// True iff `modified` is more than `max_age` before `now`. A future mtime
/// (clock skew) counts as fresh, never stale.
fn scrollback_is_stale(
    modified: std::time::SystemTime,
    now: std::time::SystemTime,
    max_age: std::time::Duration,
) -> bool {
    now.duration_since(modified)
        .map(|age| age > max_age)
        .unwrap_or(false)
}

/// Days → retention window, floored at 1 day (a caller passing 0 must never mean
/// "wipe everything") and saturating so a huge value can't overflow/panic.
fn max_age_from_days(days: Option<u64>) -> std::time::Duration {
    let d = days.unwrap_or(30).max(1);
    std::time::Duration::from_secs(d.saturating_mul(24 * 60 * 60))
}

/// Delete `*.txt` scrollback files under `dir` that are BOTH not in `keep`
/// (filename set of live tabs) AND older than `max_age`. Returns how many were
/// removed. Missing dir / unreadable mtime → skip.
fn sweep_stale_scrollback(
    dir: &std::path::Path,
    max_age: std::time::Duration,
    now: std::time::SystemTime,
    keep: &std::collections::HashSet<String>,
) -> usize {
    let mut removed = 0usize;
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0, // no scrollback dir yet — nothing to sweep
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue; // only our own scrollback files
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if keep.contains(&name) {
            continue; // owned by an open tab — keep regardless of age
        }
        let modified = match entry.metadata().and_then(|m| m.modified()) {
            Ok(m) => m,
            Err(_) => continue, // can't read mtime — leave it
        };
        if scrollback_is_stale(modified, now, max_age) && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// GC abandoned scrollback. `keep_tab_ids` = every tab id currently open in any
/// window (the caller gathers these); their files are kept regardless of age.
#[tauri::command]
pub fn scrollback_sweep(
    app: AppHandle,
    keep_tab_ids: Vec<String>,
    max_age_days: Option<u64>,
) -> Result<usize, String> {
    let dir = get_data_dir(&app).join("terminals").join("scrollback");
    // Both rotation segments of a live tab are protected: `.old.txt` carries
    // the older half of an open tab's history, and its mtime FREEZES at
    // rotation time — age alone would wrongly reap it on month-old resident
    // sessions (re-review F8; this app lives in the tray for weeks).
    let keep: std::collections::HashSet<String> = keep_tab_ids
        .iter()
        .flat_map(|id| {
            let stem = safe_filename(id);
            [format!("{stem}.txt"), format!("{stem}.old.txt")]
        })
        .collect();
    Ok(sweep_stale_scrollback(
        &dir,
        max_age_from_days(max_age_days),
        std::time::SystemTime::now(),
        &keep,
    ))
}

#[cfg(test)]
mod scrollback_sweep_tests {
    use super::{max_age_from_days, scrollback_is_stale, sweep_stale_scrollback};
    use std::collections::HashSet;
    use std::time::{Duration, SystemTime};

    fn none() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn is_stale_compares_age() {
        let now = SystemTime::now();
        let day = Duration::from_secs(86_400);
        assert!(scrollback_is_stale(now - day * 31, now, day * 30));
        assert!(!scrollback_is_stale(now - day, now, day * 30));
        assert!(!scrollback_is_stale(now + day, now, day * 30)); // future = fresh
    }

    #[test]
    fn sweep_removes_stale_txt_only() {
        let dir = std::env::temp_dir().join(format!("sb-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("t-a.txt"), "x").unwrap();
        std::fs::write(dir.join("t-b.txt"), "x").unwrap();
        std::fs::write(dir.join("keep.md"), "x").unwrap(); // non-.txt must survive
        // Evaluate "now" an hour ahead so the just-written files read as aged.
        let future = SystemTime::now() + Duration::from_secs(3_600);
        let removed = sweep_stale_scrollback(&dir, Duration::from_secs(1), future, &none());
        assert_eq!(removed, 2);
        assert!(!dir.join("t-a.txt").exists());
        assert!(!dir.join("t-b.txt").exists());
        assert!(dir.join("keep.md").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweep_keeps_owned_even_when_stale() {
        // The core safety property: a file whose tab is still open is NEVER
        // deleted, even if its mtime is ancient.
        let dir = std::env::temp_dir().join(format!("sb-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("t-open.txt"), "x").unwrap();
        std::fs::write(dir.join("t-closed.txt"), "x").unwrap();
        let keep: HashSet<String> = ["t-open.txt".to_string()].into_iter().collect();
        let future = SystemTime::now() + Duration::from_secs(3_600);
        let removed = sweep_stale_scrollback(&dir, Duration::from_secs(1), future, &keep);
        assert_eq!(removed, 1); // only the closed one
        assert!(dir.join("t-open.txt").exists()); // stale but owned — kept
        assert!(!dir.join("t-closed.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweep_keeps_fresh_files() {
        let dir = std::env::temp_dir().join(format!("sb-fresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("t-a.txt"), "x").unwrap();
        let removed = sweep_stale_scrollback(
            &dir,
            Duration::from_secs(10_000_000_000),
            SystemTime::now(),
            &none(),
        );
        assert_eq!(removed, 0);
        assert!(dir.join("t-a.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweep_missing_dir_is_zero() {
        let missing = std::env::temp_dir().join("sb-nope-xyz-does-not-exist-12345");
        let _ = std::fs::remove_dir_all(&missing);
        assert_eq!(
            sweep_stale_scrollback(&missing, Duration::from_secs(1), SystemTime::now(), &none()),
            0
        );
    }

    #[test]
    fn max_age_floors_and_saturates() {
        let day = 86_400u64;
        assert_eq!(max_age_from_days(None), Duration::from_secs(30 * day));
        assert_eq!(max_age_from_days(Some(0)), Duration::from_secs(day)); // 0 floored to 1
        assert_eq!(max_age_from_days(Some(7)), Duration::from_secs(7 * day));
        let _ = max_age_from_days(Some(u64::MAX)); // must not panic (saturating_mul)
    }
}

// ── Transcript append (P1-T3: async + pooled today-handles) ────────
// The old shape was a sync command (main thread) doing open+write+close per
// 8KB flush per pane — hundreds of main-thread open/close cycles per second
// under floods. Handles for TODAY's files are now pooled; the command is a
// thin async wrapper over spawn_blocking.

/// Pooled append handles keyed (date, name). Cached entries are TODAY-only:
/// a NON-today append (the midnight flush uses the pre-roll date; a moved
/// pane's dead interval can append a stale date for days — TerminalPane's
/// documented lifecycle) is written through UNCACHED and never evicts the
/// cache wholesale (plan-audit F12a: mass-evict-on-stale-date thrashed the
/// pool forever on one stale pane). Stale-dated entries are evicted lazily.
/// GC safety: transcript retention ages by dir name with a ≥1-day floor, so
/// today's dir — the only one with live cached handles — is never swept (no
/// delete-while-open conflict on Windows). Raw File, no BufWriter: the
/// syscall win is the open/close elision; durability stays ≤ one flush.
#[derive(Default)]
pub struct TranscriptHandles(Mutex<HashMap<(String, String), fs::File>>);

/// Testable core: append under `base` (…/transcripts), pooling handles for
/// `today`-dated files in `pool`.
fn transcript_write(
    pool: &TranscriptHandles,
    base: &std::path::Path,
    today: &str,
    date: &str,
    name: &str,
    content: &str,
) -> Result<(), String> {
    use std::io::Write;
    let open_append = |date: &str, name: &str| -> Result<fs::File, String> {
        let dir = base.join(safe_filename(date));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(format!("{}.md", safe_filename(name))))
            .map_err(|e| e.to_string())
    };
    if date != today {
        // Write-through, uncached, cache untouched.
        return open_append(date, name)?
            .write_all(content.as_bytes())
            .map_err(|e| e.to_string());
    }
    let mut map = pool.0.lock().unwrap_or_else(|p| p.into_inner());
    // Lazy eviction: date rolled — closed handles for yesterday's files.
    map.retain(|(d, _), _| d == today);
    let key = (date.to_string(), name.to_string());
    if !map.contains_key(&key) {
        map.insert(key.clone(), open_append(date, name)?);
    }
    let file = map.get_mut(&key).expect("just inserted");
    if let Err(first) = file.write_all(content.as_bytes()) {
        // Cached handle went bad (file pruned externally, volume hiccup):
        // drop it and retry once through a fresh open before failing.
        map.remove(&key);
        let mut fresh = open_append(date, name)?;
        fresh
            .write_all(content.as_bytes())
            .map_err(|e| format!("{first}; retry: {e}"))?;
        map.insert(key, fresh);
    }
    Ok(())
}

pub fn transcript_append_sync(
    app: &AppHandle,
    date: &str,
    name: &str,
    content: &str,
) -> Result<(), String> {
    let base = get_data_dir(app).join("terminals").join("transcripts");
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    transcript_write(
        &app.state::<TranscriptHandles>(),
        &base,
        &today,
        date,
        name,
        content,
    )
}

#[tauri::command]
pub async fn transcript_append(
    app: AppHandle,
    date: String,
    name: String,
    content: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        transcript_append_sync(&app, &date, &name, &content)
    })
    .await
    .map_err(|e| format!("append task failed: {e}"))?
}

// ── Transcript read/list (Stream D share prep) ─────────────────────
// (C) Dir-scoped, DATED read-side companion to transcript_append above.
// Mirrors the notebook IO shape (Stream C, ~:1250-1367): a narrow surface
// scoped under <data_dir>/terminals/transcripts/, name-gated, no arbitrary
// paths. Two differences from notebook_path, both intentional:
//   1. A transcript is DATED — on-disk layout is transcripts/{date}/{name}.md,
//      one file per (date, name) pair, so list/read/read_all all reason
//      about a date component too.
//   2. `name` here is a bare stem (e.g. "myproject-a1b2c3") that never
//      carries ".md" from the caller — transcript_append appends the
//      extension itself — so, unlike notebook_path, we must NOT require a
//      ".md" suffix on the input name.
//
// AUDIT: validation is FULL-STRING reconstruction-equality against
// safe_filename's own output, never a substring/regex shape match. An
// unanchored `\d{4}-\d{2}-\d{2}` match would accept
// "../../etc/2024-01-01" (a validly-shaped date IS present as a substring)
// while the whole string still escapes the transcripts dir once joined.
// Reconstruction-equality closes that: safe_filename maps every character
// outside [A-Za-z0-9_-] to '_', so any '.', '/', or '\\' anywhere in the
// input breaks equality with the sanitized output and the whole value is
// rejected outright — never silently rewritten, same posture as
// notebook_path.

// A date is valid iff it is exactly "YYYY-MM-DD" shaped (10 bytes, every
// byte already inside safe_filename's allowlist so sanitizing is a no-op)
// AND it parses as a genuine calendar date — rejects shape-only garbage
// like "2020-13-99" that would survive a regex but isn't a real day.
fn transcript_date_valid(date: &str) -> bool {
    date.len() == 10
        && safe_filename(date) == date
        && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
}

// A name is valid iff sanitizing it is a no-op, it isn't empty (an empty
// stem would resolve to a bare ".md" file — never a legal transcript name),
// and it isn't a reserved Windows device name (release-audit fix: win32's
// legacy DOS-device resolution intercepts "con"/"nul"/… regardless of the
// ".md" appended later — same RESERVED_NAMES gate notebook_path applies).
fn transcript_name_valid(name: &str) -> bool {
    !name.is_empty()
        && safe_filename(name) == name
        && !RESERVED_NAMES.contains(&name.to_lowercase().as_str())
}

fn transcripts_dir(app: &AppHandle) -> PathBuf {
    get_data_dir(app).join("terminals").join("transcripts")
}

#[derive(Serialize, Debug, PartialEq)]
pub struct TranscriptEntry {
    pub date: String,
    pub name: String,
}

// Read one file, rejecting a symlinked target instead of following it —
// `symlink_metadata` reports the link itself (never the thing it points to),
// so `file_type().is_file()` is false for a symlink even when its target is
// an ordinary file, and a missing path surfaces as an Err here (not a panic
// or a silent None). Lossy-decodes like `scrollback_load`: a transcript is
// ANSI-stripped PTY output and can carry stray non-UTF8 bytes, so one bad
// byte must never fail the whole share.
fn transcript_read_file_lossy(path: &std::path::Path) -> Result<String, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "transcript not found".to_string())?;
    if !meta.file_type().is_file() {
        return Err("transcript not found".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// Sync core: walk transcripts/ one date-dir deep. A missing transcripts/ dir
// is not an error, just an empty share picker (mirrors notebook_list_sync's
// "missing/empty dir -> empty library" posture) — unlike notebook_list_sync
// this does NOT create the dir, since transcript_append already creates it
// on first write and list is meant to be a read-only walk. Each date
// directory is itself name-gated (skips any stray non-date directory
// dropped into transcripts/) and each ".md" file inside is
// is_file+non-symlink+name-gated — the SAME gates read/read_all use, so any
// entry list returns is guaranteed readable. Sorted newest-date-first.
fn transcript_list_sync(dir: &std::path::Path) -> Vec<TranscriptEntry> {
    let mut dates: Vec<String> = fs::read_dir(dir)
        .map(|read| {
            read.flatten()
                .filter(|ent| ent.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|ent| ent.file_name().to_string_lossy().into_owned())
                .filter(|d| transcript_date_valid(d))
                .collect()
        })
        .unwrap_or_default();
    dates.sort();
    dates.reverse(); // newest-date-first

    let mut out: Vec<TranscriptEntry> = Vec::new();
    for date in dates {
        let date_dir = dir.join(&date);
        let mut names: Vec<String> = fs::read_dir(&date_dir)
            .map(|read| {
                read.flatten()
                    .filter(|ent| {
                        fs::symlink_metadata(ent.path())
                            .map(|m| m.file_type().is_file())
                            .unwrap_or(false)
                    })
                    .filter_map(|ent| {
                        let fname = ent.file_name().to_string_lossy().into_owned();
                        let stem = fname.strip_suffix(".md")?.to_string();
                        if transcript_name_valid(&stem) { Some(stem) } else { None }
                    })
                    .collect()
            })
            .unwrap_or_default();
        names.sort_by_key(|n| n.to_lowercase());
        out.extend(
            names
                .into_iter()
                .map(|name| TranscriptEntry { date: date.clone(), name }),
        );
    }
    out
}

// Sync core: read one dated transcript. Both date and name are validated
// full-string before touching the filesystem; an invalid shape is an Err,
// never a silent empty result. Absent file -> Err (matches
// notebook_read_sync: the caller decides what "no transcript here" means,
// never silently reseeded here).
fn transcript_read_sync(dir: &std::path::Path, date: &str, name: &str) -> Result<String, String> {
    if !transcript_date_valid(date) {
        return Err("invalid transcript date".into());
    }
    if !transcript_name_valid(name) {
        return Err("invalid transcript name".into());
    }
    let path = dir.join(date).join(format!("{name}.md"));
    transcript_read_file_lossy(&path)
}

// Sync core: concatenate every dated file for `name` across ALL dates,
// oldest-first (dates are fixed-width YYYY-MM-DD, so a lexical sort IS a
// chronological one), each prefixed with a `\n--- <date> ---\n` header —
// the "whole session" a transcript share reads. `name` is validated
// full-string up front; each per-date read reuses the same
// symlink-rejecting lossy reader as transcript_read_sync, so a symlinked
// file for one date among several genuine ones is skipped rather than
// aborting the whole concatenation (list already excludes it from the
// picker; this is defense in depth for a direct call). No dated file found
// at all -> Err.
fn transcript_read_all_sync(dir: &std::path::Path, name: &str) -> Result<String, String> {
    transcript_read_all_capped(dir, name, TRANSCRIPT_READ_CAP)
}

// Release-audit fix: the whole-session concat had no size bound — a long-lived
// project pulled multiple MB into JS memory, through 7 regex passes, into one
// <pre>, and into a 30s-timeout gist POST. Budgeted walk instead: accumulate
// whole days NEWEST-first until the byte budget is spent (the newest output is
// what a share is about), then assemble the kept days oldest-first with the
// unchanged header format. First kept day over budget on its own keeps its
// TAIL at a char boundary. Every drop is disclosed with an omission note.
const TRANSCRIPT_READ_CAP: usize = 1024 * 1024; // bytes of assembled content
const TRANSCRIPT_OMITTED_NOTE: &str = "\n--- [earlier transcript omitted: size cap] ---\n";

fn transcript_read_all_capped(dir: &std::path::Path, name: &str, cap: usize) -> Result<String, String> {
    if !transcript_name_valid(name) {
        return Err("invalid transcript name".into());
    }
    let mut dates: Vec<String> = fs::read_dir(dir)
        .map(|read| {
            read.flatten()
                .filter(|ent| ent.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|ent| ent.file_name().to_string_lossy().into_owned())
                .filter(|d| transcript_date_valid(d))
                .collect()
        })
        .unwrap_or_default();
    dates.sort(); // oldest-first (fixed-width dates: lexical == chronological)

    // Collect newest-first under the budget; keep a CONTIGUOUS newest run
    // (stop at the first day that doesn't fit — no gaps mid-transcript).
    let mut kept: Vec<(String, String)> = Vec::new();
    let mut used = 0usize;
    let mut found = false;
    let mut omitted = false;
    for date in dates.iter().rev() {
        let path = dir.join(date).join(format!("{name}.md"));
        let Ok(content) = transcript_read_file_lossy(&path) else { continue };
        found = true;
        let header_len = date.len() + 10; // "\n--- {date} ---\n"
        if used + header_len + content.len() > cap {
            if kept.is_empty() {
                // The single newest day alone exceeds the budget: keep its
                // tail (newest bytes), aligned up to a char boundary.
                let budget = cap.saturating_sub(header_len).min(content.len());
                let mut start = content.len() - budget;
                while start < content.len() && !content.is_char_boundary(start) {
                    start += 1;
                }
                kept.push((date.clone(), content[start..].to_string()));
            }
            omitted = true;
            break;
        }
        used += header_len + content.len();
        kept.push((date.clone(), content));
    }
    if !found {
        return Err("no transcript found for this name".into());
    }

    let mut out = String::new();
    if omitted {
        out.push_str(TRANSCRIPT_OMITTED_NOTE);
    }
    for (date, content) in kept.iter().rev() {
        out.push_str(&format!("\n--- {date} ---\n"));
        out.push_str(content);
    }
    Ok(out)
}

#[tauri::command]
pub async fn transcript_list(app: AppHandle) -> Vec<TranscriptEntry> {
    transcript_list_sync(&transcripts_dir(&app))
}

#[tauri::command]
pub async fn transcript_read(app: AppHandle, date: String, name: String) -> Result<String, String> {
    transcript_read_sync(&transcripts_dir(&app), &date, &name)
}

#[tauri::command]
pub async fn transcript_read_all(app: AppHandle, name: String) -> Result<String, String> {
    transcript_read_all_sync(&transcripts_dir(&app), &name)
}

// ── Transcript GC: age sweep over whole date-dirs ─────────────────
// transcript_append writes forever with no rotation, so an active user's
// transcripts dir grows without bound (a busy day is single-digit MB per pane)
// and nothing in the UI reveals it exists. Mirrors the scrollback sweep, with
// one difference: transcripts are already partitioned into YYYY-MM-DD dirs, so
// age comes from the DIRECTORY NAME rather than an mtime — deterministic, and
// immune to a stray touch bumping a whole day. No keep-set is needed: today's
// dir can never be older than the retention window. `today` is injected for
// testability, matching the injected-now pattern used elsewhere in this file.
const TRANSCRIPT_RETENTION_DAYS: u64 = 90;

fn sweep_stale_transcripts(
    dir: &std::path::Path,
    max_age_days: u64,
    today: chrono::NaiveDate,
) -> usize {
    let mut removed = 0usize;
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0, // no transcripts dir yet — nothing to sweep
    };
    for entry in entries.flatten() {
        // file_type() reports the on-disk type without following symlinks, so a
        // symlinked "dir" is never recursively removed.
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !transcript_date_valid(&name) {
            continue; // not a dir we created — leave it alone
        }
        let Ok(date) = chrono::NaiveDate::parse_from_str(&name, "%Y-%m-%d") else { continue };
        // A future-dated dir (clock skew) counts as fresh, never stale.
        let age = today.signed_duration_since(date).num_days();
        if age > max_age_days as i64 && fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[tauri::command]
pub async fn transcript_sweep(app: AppHandle, max_age_days: Option<u64>) -> Result<usize, String> {
    let days = max_age_days.unwrap_or(TRANSCRIPT_RETENTION_DAYS).max(1);
    Ok(sweep_stale_transcripts(
        &transcripts_dir(&app),
        days,
        chrono::Local::now().date_naive(),
    ))
}

#[cfg(test)]
mod transcript_sweep_tests {
    use super::*;
    use std::fs;

    fn day(dir: &std::path::Path, date: &str) {
        let d = dir.join(date);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("proj-abc123.md"), "content").unwrap();
    }
    fn today() -> chrono::NaiveDate {
        chrono::NaiveDate::from_ymd_opt(2026, 8, 3).unwrap()
    }

    #[test]
    fn removes_only_dirs_past_the_retention_window() {
        let tmp = tempfile::tempdir().unwrap();
        day(tmp.path(), "2026-08-03"); // today
        day(tmp.path(), "2026-07-05"); // 29 days
        day(tmp.path(), "2026-01-01"); // way past
        let removed = sweep_stale_transcripts(tmp.path(), 90, today());
        assert_eq!(removed, 1);
        assert!(tmp.path().join("2026-08-03").is_dir());
        assert!(tmp.path().join("2026-07-05").is_dir());
        assert!(!tmp.path().join("2026-01-01").exists());
    }

    #[test]
    fn boundary_is_exclusive_exactly_at_the_window_is_kept() {
        let tmp = tempfile::tempdir().unwrap();
        day(tmp.path(), "2026-05-05"); // exactly 90 days before 2026-08-03
        assert_eq!(sweep_stale_transcripts(tmp.path(), 90, today()), 0);
        assert!(tmp.path().join("2026-05-05").is_dir());
    }

    #[test]
    fn a_future_dated_dir_is_never_swept() {
        let tmp = tempfile::tempdir().unwrap();
        day(tmp.path(), "2027-01-01"); // clock skew
        assert_eq!(sweep_stale_transcripts(tmp.path(), 90, today()), 0);
        assert!(tmp.path().join("2027-01-01").is_dir());
    }

    #[test]
    fn foreign_dirs_and_files_are_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("not-a-date")).unwrap();
        fs::write(tmp.path().join("2026-01-01.md"), "a file, not a dir").unwrap();
        assert_eq!(sweep_stale_transcripts(tmp.path(), 90, today()), 0);
        assert!(tmp.path().join("not-a-date").is_dir());
        assert!(tmp.path().join("2026-01-01.md").is_file());
    }

    #[test]
    fn missing_dir_is_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(sweep_stale_transcripts(&tmp.path().join("nope"), 90, today()), 0);
    }
}

#[cfg(test)]
mod transcript_read_tests {
    use super::*;
    use std::fs;

    fn write_dated(dir: &std::path::Path, date: &str, name: &str, content: &str) {
        let date_dir = dir.join(date);
        fs::create_dir_all(&date_dir).unwrap();
        fs::write(date_dir.join(format!("{name}.md")), content).unwrap();
    }

    #[test]
    fn list_on_missing_dir_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("does-not-exist-yet");
        let got = transcript_list_sync(&dir);
        assert!(got.is_empty());
    }

    #[test]
    fn list_on_empty_existing_dir_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let got = transcript_list_sync(tmp.path());
        assert!(got.is_empty());
    }

    #[test]
    fn read_all_concatenates_oldest_first_with_separators() {
        let tmp = tempfile::tempdir().unwrap();
        write_dated(tmp.path(), "2024-01-02", "proj-abc123", "second\n");
        write_dated(tmp.path(), "2024-01-01", "proj-abc123", "first\n");
        let got = transcript_read_all_sync(tmp.path(), "proj-abc123").unwrap();
        assert_eq!(
            got,
            "\n--- 2024-01-01 ---\nfirst\n\n--- 2024-01-02 ---\nsecond\n"
        );
    }

    #[test]
    fn list_is_newest_date_first() {
        let tmp = tempfile::tempdir().unwrap();
        write_dated(tmp.path(), "2024-01-01", "a", "x");
        write_dated(tmp.path(), "2024-02-01", "b", "y");
        let got = transcript_list_sync(tmp.path());
        let dates: Vec<&str> = got.iter().map(|e| e.date.as_str()).collect();
        assert_eq!(dates, vec!["2024-02-01", "2024-01-01"]);
    }

    #[test]
    fn traversal_date_rejected_full_string_not_substring() {
        // Shape-valid AS A SUBSTRING ("2024-01-01" sits inside the string) but
        // the WHOLE string escapes the transcripts dir — a naive unanchored
        // regex/contains check would accept this; full-string
        // reconstruction-equality must not.
        let tmp = tempfile::tempdir().unwrap();
        assert!(transcript_read_sync(tmp.path(), "../../etc/2024-01-01", "name").is_err());
        assert!(!transcript_date_valid("../../etc/2024-01-01"));
    }

    #[test]
    fn traversal_name_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["a/b", "../x"] {
            assert!(
                transcript_read_sync(tmp.path(), "2024-01-01", bad).is_err(),
                "expected rejection for {bad:?}"
            );
            assert!(
                transcript_read_all_sync(tmp.path(), bad).is_err(),
                "expected rejection for {bad:?}"
            );
        }
    }

    #[test]
    fn invalid_calendar_date_rejected() {
        // Shape-valid (10 chars, digits+hyphens) but not a REAL date.
        let tmp = tempfile::tempdir().unwrap();
        assert!(!transcript_date_valid("2020-13-99"));
        assert!(transcript_read_sync(tmp.path(), "2020-13-99", "name").is_err());
    }

    #[test]
    fn name_with_dotdot_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["..", "a..b", "..name"] {
            assert!(!transcript_name_valid(bad), "expected rejection for {bad:?}");
            assert!(
                transcript_read_all_sync(tmp.path(), bad).is_err(),
                "expected rejection for {bad:?}"
            );
        }
    }

    #[test]
    fn reserved_device_names_rejected() {
        // Release-audit fix: win32's legacy DOS-device resolution intercepts
        // "con"/"nul"/"com1"/… regardless of the ".md" extension appended
        // later, so a transcript name that IS a device name silently breaks
        // recording (nul) or errors weirdly (con). Same RESERVED_NAMES gate
        // the notebook path already applies, case-insensitively.
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["con", "CON", "nul", "com1", "LPT9"] {
            assert!(!transcript_name_valid(bad), "expected rejection for {bad:?}");
            assert!(
                transcript_read_all_sync(tmp.path(), bad).is_err(),
                "expected rejection for {bad:?}"
            );
        }
        // Near-misses stay valid — the gate is exact-match, not substring.
        assert!(transcript_name_valid("console"));
        assert!(transcript_name_valid("con-1"));
    }

    #[test]
    fn symlinked_md_file_is_not_listed() {
        // Ports rule_file_tests::symlinked_rule_file_is_skipped /
        // notebook_io_tests::symlinked_md_file_is_not_listed's exact pattern:
        // symlink creation on Windows needs Developer Mode / privilege; if the
        // OS refuses, the vector doesn't exist in this environment — pass
        // trivially rather than failing the whole suite on an unrelated box.
        let tmp = tempfile::tempdir().unwrap();
        let secret = tmp.path().join("secret.txt");
        fs::write(&secret, "PRIVATE KEY MATERIAL").unwrap();
        let date_dir = tmp.path().join("2024-01-01");
        fs::create_dir_all(&date_dir).unwrap();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&secret, date_dir.join("linked.md")).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&secret, date_dir.join("linked.md")).is_ok();
        if !made { return; }
        let got = transcript_list_sync(tmp.path());
        assert!(got.is_empty(), "symlinked .md file must never be listed");
    }

    #[test]
    fn read_direct_on_symlinked_target_is_err() {
        // Read-path symlink check — NOT just the list-exclusion case: even
        // called directly against the exact (date, name), a symlinked file
        // must be rejected rather than followed.
        let tmp = tempfile::tempdir().unwrap();
        let secret = tmp.path().join("secret.txt");
        fs::write(&secret, "PRIVATE KEY MATERIAL").unwrap();
        let date_dir = tmp.path().join("2024-01-01");
        fs::create_dir_all(&date_dir).unwrap();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&secret, date_dir.join("linked.md")).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&secret, date_dir.join("linked.md")).is_ok();
        if !made { return; }
        assert!(transcript_read_sync(tmp.path(), "2024-01-01", "linked").is_err());
        assert!(transcript_read_all_sync(tmp.path(), "linked").is_err());
    }

    #[test]
    fn single_date_read() {
        let tmp = tempfile::tempdir().unwrap();
        write_dated(tmp.path(), "2024-03-04", "solo-name", "hello world\n");
        let got = transcript_read_sync(tmp.path(), "2024-03-04", "solo-name").unwrap();
        assert_eq!(got, "hello world\n");
    }

    #[test]
    fn read_all_cap_drops_oldest_days_first_with_omission_note() {
        // Release-audit fix: the whole-session concat had no size bound. The
        // cap keeps the NEWEST contiguous run of whole days; the kept days
        // still render oldest-first with the same headers.
        let tmp = tempfile::tempdir().unwrap();
        write_dated(tmp.path(), "2024-01-01", "n", "oldest");
        write_dated(tmp.path(), "2024-01-02", "n", "middle");
        write_dated(tmp.path(), "2024-01-03", "n", "newest");
        let day = |content: &str| content.len() + "2024-01-03".len() + 10; // header cost
        let cap = day("newest") + day("middle"); // fits two days, not three
        let got = transcript_read_all_capped(tmp.path(), "n", cap).unwrap();
        assert!(got.contains("newest") && got.contains("middle"));
        assert!(!got.contains("oldest"));
        assert!(got.contains("omitted"), "must disclose the drop: {got:?}");
        assert!(got.find("middle").unwrap() < got.find("newest").unwrap(), "kept days stay oldest-first");
    }

    #[test]
    fn read_all_cap_single_oversized_day_keeps_tail() {
        // A single newest day bigger than the whole budget keeps its TAIL
        // (newest output) rather than erroring or returning nothing.
        let tmp = tempfile::tempdir().unwrap();
        let content = format!("{}{}", "H".repeat(100), "T".repeat(50));
        write_dated(tmp.path(), "2024-01-03", "n", &content);
        let got = transcript_read_all_capped(tmp.path(), "n", 80).unwrap();
        assert!(got.contains(&"T".repeat(50)), "tail must survive: {got:?}");
        assert!(!got.contains(&"H".repeat(50)), "head must be dropped: {got:?}");
        assert!(got.contains("omitted"));
    }

    #[test]
    fn read_all_under_cap_is_byte_identical_to_uncapped() {
        let tmp = tempfile::tempdir().unwrap();
        write_dated(tmp.path(), "2024-01-01", "n", "small");
        let capped = transcript_read_all_capped(tmp.path(), "n", 1024).unwrap();
        let uncapped = transcript_read_all_sync(tmp.path(), "n").unwrap();
        assert_eq!(capped, uncapped);
        assert!(!capped.contains("omitted"));
    }

    #[test]
    fn absent_read_is_err() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(transcript_read_sync(tmp.path(), "2024-03-04", "nope").is_err());
        assert!(transcript_read_all_sync(tmp.path(), "nope").is_err());
    }

    #[test]
    fn invalid_utf8_byte_reads_lossy_not_err() {
        let tmp = tempfile::tempdir().unwrap();
        let date_dir = tmp.path().join("2024-05-06");
        fs::create_dir_all(&date_dir).unwrap();
        let mut bytes = b"before-".to_vec();
        bytes.push(0xFF); // invalid standalone UTF-8 byte
        bytes.extend_from_slice(b"-after");
        fs::write(date_dir.join("lossy-name.md"), &bytes).unwrap();
        let got = transcript_read_sync(tmp.path(), "2024-05-06", "lossy-name");
        assert!(got.is_ok(), "invalid UTF-8 byte must lossy-decode, not error");
        assert!(got.unwrap().contains("before-"));
    }

    #[test]
    fn non_canonical_name_on_disk_excluded_from_list() {
        // Mirrors notebook_io_tests::non_canonical_name_on_disk_is_excluded_from_list_and_read:
        // a stray .md file with a space in the stem must not surface in list.
        let tmp = tempfile::tempdir().unwrap();
        write_dated(tmp.path(), "2024-01-01", "has space", "hi");
        let got = transcript_list_sync(tmp.path());
        assert!(got.is_empty(), "non-canonical stem must not be listed");
    }
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

// ── Notebooks (Stream C) ───────────────────────────────────────────
// (C) Narrow, dir-scoped IO: names are sanitized single-segment filenames under
// <data_dir>/notebooks/ — no separators, no traversal, no arbitrary paths.
// Writes are atomic (tmp+rename, same pattern as write_store).

fn notebooks_dir(app: &AppHandle) -> PathBuf {
    get_data_dir(app).join("notebooks")
}

// AUDIT-CORRECTED: safe_filename is a MUTATING sanitizer whose allowlist has no
// '.', so validating the whole name against it rejects every legal *.md name.
// Validate the STEM only, then re-append a normalized ".md". Also reject the
// reserved Windows device names (win32-primary app).
const RESERVED_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

// Dir-scoped name gate — the audit-corrected core (five audit rounds; do not
// "simplify" this). Adapted from the plan's `notebook_path(app: &AppHandle,
// name)` to take `dir: &Path` directly so it is unit-testable without an
// AppHandle, mirroring `collect_rule_files_sync`; the three command wrappers
// below pass `notebooks_dir(&app)` in. A name that changes shape under
// sanitization is rejected outright, never silently rewritten — Task C-3's
// name prompt appends ".md" itself; this check is the backstop, not the UX.
fn notebook_path(dir: &std::path::Path, name: &str) -> Result<PathBuf, String> {
    let lower = name.to_lowercase();
    if name.len() < 4 || !lower.ends_with(".md") {
        return Err("notebook name must end in .md".into());
    }
    let stem = &name[..name.len() - 3];
    let clean = safe_filename(stem);
    if clean.is_empty() || clean != stem {
        return Err("invalid notebook name".into());
    }
    if RESERVED_NAMES.contains(&clean.to_lowercase().as_str()) {
        return Err("reserved name".into());
    }
    Ok(dir.join(format!("{clean}.md")))
}

// Sync core: create-if-missing + list ".md" FILES only — a directory that
// happens to be named "*.md" is excluded via file_type() (reports the on-disk
// type without following symlinks, so a symlinked entry is never listed
// either), case-insensitively name-sorted (matches list_directory's sort
// convention above). A missing/empty dir is not an error — it's just an
// empty notebook library.
//
// The candidate filter is `notebook_path(dir, name).is_ok()` — the SAME gate
// read/write use — not a looser ad-hoc suffix check. A quality-review catch:
// a bare `.to_lowercase().ends_with(".md")` filter would list a file dropped
// into the dir by something other than notebook_write (e.g. a stray
// "my notes.md" with a space) that then fails to open, because read/write
// reject it. Filtering through the real gate guarantees list only ever
// returns names that read/write also accept — a non-canonical *.md file
// on disk simply isn't a valid notebook by our naming rule, so it doesn't
// appear.
fn notebook_list_sync(dir: &std::path::Path) -> Vec<String> {
    fs::create_dir_all(dir).ok();
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|read| {
            read.flatten()
                .filter(|ent| ent.file_type().map(|t| t.is_file()).unwrap_or(false))
                .map(|ent| ent.file_name().to_string_lossy().into_owned())
                .filter(|name| notebook_path(dir, name).is_ok())
                .collect()
        })
        .unwrap_or_default();
    names.sort_by_key(|n| n.to_lowercase());
    names
}

// Sync core: read one notebook. A missing file is an Err (not ""); the
// caller (NotebookView, Task C-4) decides whether that means "new notebook"
// vs. "restored tab whose file vanished" — never silently reseeded here.
// Rejects a symlinked target instead of following it (release-audit fix:
// list excludes symlinks, but a direct invoke bypasses the picker — the read
// path must hold the same line transcript_read_file_lossy does).
fn notebook_read_sync(dir: &std::path::Path, name: &str) -> Result<String, String> {
    let path = notebook_path(dir, name)?;
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !meta.file_type().is_file() {
        return Err("notebook not found".into());
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

// Sync core: atomic write — tmp file + rename, same pattern as write_store
// above — so a crash/power-cut mid-write can't leave a truncated or
// half-written notebook behind, and a rerun always replaces the owned
// content rather than appending to it.
fn notebook_write_sync(dir: &std::path::Path, name: &str, content: &str) -> Result<(), String> {
    let path = notebook_path(dir, name)?;
    // Defense-in-depth twin of the read-side symlink check: a destination that
    // exists but is not a regular file (symlink, dir) is never mutated — the
    // rename would replace the link rather than write through it, but a
    // notebook name that is secretly a link is not a state we accept.
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if !meta.file_type().is_file() {
            return Err("notebook path is not a regular file".into());
        }
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut tmp_name = path
        .file_name()
        .ok_or_else(|| "invalid notebook path".to_string())?
        .to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        // Don't leak the tmp file if the rename itself fails (e.g. a
        // permissions error) — best-effort cleanup, error is still reported.
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
pub async fn notebook_list(app: AppHandle) -> Vec<String> {
    notebook_list_sync(&notebooks_dir(&app))
}

#[tauri::command]
pub async fn notebook_read(app: AppHandle, name: String) -> Result<String, String> {
    notebook_read_sync(&notebooks_dir(&app), &name)
}

#[tauri::command]
pub async fn notebook_write(app: AppHandle, name: String, content: String) -> Result<(), String> {
    notebook_write_sync(&notebooks_dir(&app), &name, &content)
}

#[cfg(test)]
mod rule_file_tests {
    use super::*;
    use std::fs;

    fn mkdirs(root: &std::path::Path, rel: &str) -> std::path::PathBuf {
        let p = root.join(rel);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn collects_root_first_and_stops_at_git_root() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkdirs(tmp.path(), "repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(repo.join("AGENTS.md"), "root rules").unwrap();
        let sub = mkdirs(tmp.path(), "repo/sub");
        fs::write(sub.join("CLAUDE.md"), "sub rules").unwrap();
        // decoy ABOVE the git root must NOT be collected
        fs::write(tmp.path().join("AGENTS.md"), "outside").unwrap();

        let got = collect_rule_files_sync(sub.to_string_lossy().to_string());
        let names: Vec<(String, String)> =
            got.iter().map(|r| (r.name.clone(), r.content.clone())).collect();
        assert_eq!(
            names,
            vec![
                ("AGENTS.md".into(), "root rules".into()),
                ("CLAUDE.md".into(), "sub rules".into()),
            ]
        );
        assert!(got.iter().all(|r| !r.truncated));
        // display paths must not carry the \\?\ canonicalize prefix
        assert!(got.iter().all(|r| !r.path.starts_with(r"\\?\")));
    }

    #[test]
    fn git_file_worktree_form_stops_the_walk() {
        let tmp = tempfile::tempdir().unwrap();
        let wt = mkdirs(tmp.path(), "wt");
        fs::write(wt.join(".git"), "gitdir: elsewhere").unwrap(); // worktree form: a FILE
        fs::write(wt.join("AGENTS.md"), "wt rules").unwrap();
        fs::write(tmp.path().join("AGENTS.md"), "outside").unwrap();
        let got = collect_rule_files_sync(wt.to_string_lossy().to_string());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].content, "wt rules");
    }

    #[test]
    fn caps_file_at_8kib_and_flags_truncated() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkdirs(tmp.path(), "r");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(repo.join("AGENTS.md"), "x".repeat(10_000)).unwrap();
        let got = collect_rule_files_sync(repo.to_string_lossy().to_string());
        assert_eq!(got.len(), 1);
        assert!(got[0].truncated);
        assert!(got[0].content.len() <= 8 * 1024);
    }

    #[test]
    fn multibyte_cut_at_8kib_is_lossy_not_garbage() {
        // 8 KiB boundary lands mid-emoji: decode must yield U+FFFD at the tail,
        // never split bytes rendered as mojibake, and never panic.
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkdirs(tmp.path(), "r");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let filler = "a".repeat(8 * 1024 - 2); // next char's 4 bytes straddle the cap
        let content = format!("{filler}🦀🦀🦀");
        fs::write(repo.join("CLAUDE.md"), content).unwrap();
        let got = collect_rule_files_sync(repo.to_string_lossy().to_string());
        assert_eq!(got.len(), 1);
        assert!(got[0].truncated);
        assert!(got[0].content.chars().all(|c| c == 'a' || c == '\u{FFFD}'));
    }

    #[test]
    fn bad_cwd_returns_empty() {
        let got = collect_rule_files_sync("Z:\\definitely\\not\\here".into());
        assert!(got.is_empty());
    }

    #[test]
    fn display_path_strips_extended_prefixes() {
        use std::path::Path;
        assert_eq!(display_path(Path::new(r"\\?\C:\x\AGENTS.md")), r"C:\x\AGENTS.md");
        assert_eq!(display_path(Path::new(r"\\?\UNC\srv\share\AGENTS.md")), r"\\srv\share\AGENTS.md");
        assert_eq!(display_path(Path::new(r"C:\plain\AGENTS.md")), r"C:\plain\AGENTS.md");
    }

    #[test]
    fn non_git_walk_keeps_only_nearest_3_levels() {
        // Hermetic: everything inside the tempdir; no .git anywhere.
        let tmp = tempfile::tempdir().unwrap();
        let deep = mkdirs(tmp.path(), "l1/l2/l3/l4/l5");
        // level 1 up from cwd (l4): collected. level 4 up (l1): NOT collected.
        fs::write(tmp.path().join("l1/l2/l3/l4").join("AGENTS.md"), "near").unwrap();
        fs::write(tmp.path().join("l1").join("AGENTS.md"), "far").unwrap();
        let got = collect_rule_files_sync(deep.to_string_lossy().to_string());
        let contents: Vec<&str> = got.iter().map(|r| r.content.as_str()).collect();
        assert_eq!(contents, vec!["near"]);
    }

    #[test]
    fn git_walk_is_capped_at_12_levels() {
        // Hermetic: git root sits 13 levels above cwd — beyond the cap, so its
        // rule file must NOT be collected; a nearer one must be.
        let tmp = tempfile::tempdir().unwrap();
        let root = mkdirs(tmp.path(), "g");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("AGENTS.md"), "too far").unwrap();
        let deep = mkdirs(tmp.path(), "g/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12/d13");
        fs::write(tmp.path().join("g/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12").join("CLAUDE.md"), "near").unwrap();
        let got = collect_rule_files_sync(deep.to_string_lossy().to_string());
        let contents: Vec<&str> = got.iter().map(|r| r.content.as_str()).collect();
        // no .git within 12 levels -> treated as non-git -> nearest-3 cap applies;
        // "near" is 1 level up so it survives either way, "too far" must not appear.
        assert_eq!(contents, vec!["near"]);
    }

    #[test]
    fn symlinked_rule_file_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkdirs(tmp.path(), "r");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let secret = tmp.path().join("secret.txt");
        fs::write(&secret, "PRIVATE KEY MATERIAL").unwrap();
        // Symlink creation on Windows needs Developer Mode / privilege; if the OS
        // refuses, the vector doesn't exist in this environment — pass trivially.
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&secret, repo.join("AGENTS.md")).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&secret, repo.join("AGENTS.md")).is_ok();
        if !made { return; }
        let got = collect_rule_files_sync(repo.to_string_lossy().to_string());
        assert!(got.is_empty(), "symlinked rule file must never be read");
    }

    #[test]
    fn early_stop_past_32kib_total() {
        let tmp = tempfile::tempdir().unwrap();
        // 6 nested dirs inside a git root, each with an 8 KiB AGENTS.md = 48 KiB available.
        let root = mkdirs(tmp.path(), "g");
        fs::create_dir_all(root.join(".git")).unwrap();
        let mut rel = String::from("g");
        for i in 0..6 {
            fs::write(tmp.path().join(&rel).join("AGENTS.md"), "y".repeat(8 * 1024)).unwrap();
            rel = format!("{rel}/s{i}");
            mkdirs(tmp.path(), &rel);
        }
        let cwd = tmp.path().join(&rel);
        let got = collect_rule_files_sync(cwd.to_string_lossy().to_string());
        let total: usize = got.iter().map(|r| r.content.len()).sum();
        assert!(total <= 32 * 1024 + 8 * 1024, "early stop must bound total near 32KiB");
        assert!(got.len() < 6, "must stop before collecting all 6 files");
    }
}

// (C) Notebook IO tests — written before the implementation per plan Task C-1
// (docs/superpowers/plans/2026-07-21-C-notebooks-prompts.md), mirroring
// rule_file_tests' style (tempdir-based, no AppHandle needed — the cores
// under test take `dir: &Path` directly).
#[cfg(test)]
mod notebook_io_tests {
    use super::*;
    use std::fs;

    #[test]
    fn list_on_missing_dir_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("does-not-exist-yet");
        let got = notebook_list_sync(&dir);
        assert!(got.is_empty());
        assert!(dir.is_dir(), "list_sync should create the dir like write_store creates its parent");
    }

    #[test]
    fn list_on_empty_existing_dir_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let got = notebook_list_sync(tmp.path());
        assert!(got.is_empty());
    }

    #[test]
    fn list_returns_md_files_only_sorted_by_name() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("b.md"), "b").unwrap();
        fs::write(tmp.path().join("a.md"), "a").unwrap();
        fs::write(tmp.path().join("notes.txt"), "not a notebook").unwrap();
        // A directory that happens to be named "*.md" must not be listed as a file.
        fs::create_dir_all(tmp.path().join("sub.md")).unwrap();
        let got = notebook_list_sync(tmp.path());
        assert_eq!(got, vec!["a.md".to_string(), "b.md".to_string()]);
    }

    #[test]
    fn write_then_read_roundtrip_for_legal_name() {
        // "notes.md" is a completely ordinary legal name — this is the exact
        // case the rev-1 gate bug broke (it validated the WHOLE name,
        // including the '.', against safe_filename's no-'.' allowlist,
        // which rejects every *.md name including this one).
        let tmp = tempfile::tempdir().unwrap();
        notebook_write_sync(tmp.path(), "notes.md", "# Hello\nworld\n").unwrap();
        let got = notebook_read_sync(tmp.path(), "notes.md").unwrap();
        assert_eq!(got, "# Hello\nworld\n");
    }

    #[test]
    fn write_is_atomic_no_tmp_file_left_behind() {
        let tmp = tempfile::tempdir().unwrap();
        notebook_write_sync(tmp.path(), "notes.md", "content").unwrap();
        assert!(!tmp.path().join("notes.md.tmp").exists());
        assert!(tmp.path().join("notes.md").exists());
    }

    #[test]
    fn overwrite_replaces_content_not_appends() {
        let tmp = tempfile::tempdir().unwrap();
        notebook_write_sync(tmp.path(), "notes.md", "first").unwrap();
        notebook_write_sync(tmp.path(), "notes.md", "second").unwrap();
        let got = notebook_read_sync(tmp.path(), "notes.md").unwrap();
        assert_eq!(got, "second", "second write must replace, not append");
    }

    #[test]
    fn traversal_names_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["../x.md", "a/b.md", "..\\x.md"] {
            assert!(notebook_path(tmp.path(), bad).is_err(), "expected rejection for {bad:?}");
        }
    }

    #[test]
    fn empty_and_no_extension_names_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["", "notes"] {
            assert!(notebook_path(tmp.path(), bad).is_err(), "expected rejection for {bad:?}");
        }
    }

    #[test]
    fn uppercase_extension_accepted_and_normalized_to_lowercase() {
        let tmp = tempfile::tempdir().unwrap();
        let path = notebook_path(tmp.path(), "a.MD").unwrap();
        assert_eq!(path, tmp.path().join("a.md"));
    }

    #[test]
    fn reserved_device_names_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["con.md", "NUL.md", "com1.md"] {
            assert!(notebook_path(tmp.path(), bad).is_err(), "expected rejection for {bad:?}");
        }
    }

    #[test]
    fn reserved_names_match_js_mirror() {
        // notebookIo.js keeps a hand-copied RESERVED_NAMES set for its
        // client-side pre-check ("mirrors RESERVED_NAMES in commands.rs").
        // Nothing enforced that mirror until now — a name added on one side
        // only would let the JS gate accept what Rust rejects (or vice
        // versa). Parse the JS literal out of the source at compile time and
        // pin set equality. If the literal's shape changes, the expect()s
        // fail loudly — update the marker, don't delete the test.
        let js = include_str!("../../src/features/terminals/notebookIo.js");
        let start = js
            .find("const RESERVED_NAMES = new Set([")
            .expect("RESERVED_NAMES literal not found in notebookIo.js — update this parity test's marker");
        let rest = &js[start..];
        let end = rest.find("]);").expect("unterminated RESERVED_NAMES literal in notebookIo.js");
        let body = &rest[..end];
        // A naive quote scan can't see through comments or single-quoted
        // strings, and both misreads are SILENT: double-quote-only skipped a
        // single-quoted addition, and splitting on both quote styles let a
        // removal explained by a "// removed 'prn' support" comment scoop the
        // apostrophe pair as a fake entry and report parity over real drift
        // (re-review proved that A/B). So: strip line comments first, then
        // accept double-quoted entries ONLY — any single quote left in the
        // stripped body fails loud instead of parsing wrong.
        assert!(
            !body.contains("/*"),
            "block comment inside the RESERVED_NAMES literal — rework this parity parser"
        );
        let stripped: String = body
            .lines()
            .map(|l| l.split("//").next().unwrap_or(l))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !stripped.contains('\''),
            "single-quoted entry (or stray apostrophe) in the RESERVED_NAMES literal — use double quotes so this parser sees every entry"
        );
        let js_names: std::collections::BTreeSet<&str> =
            stripped.split('"').skip(1).step_by(2).collect();
        let rust_names: std::collections::BTreeSet<&str> = RESERVED_NAMES.iter().copied().collect();
        assert_eq!(
            js_names, rust_names,
            "notebookIo.js RESERVED_NAMES drifted from commands.rs RESERVED_NAMES"
        );
    }

    #[test]
    fn reaudit_edge_set_rejected() {
        // Pinned by the plan's five audit rounds: each of these has a stem
        // that is empty/dots/whitespace once the trailing 3 bytes are sliced
        // off, and safe_filename mutates every one of them, so the
        // `clean != stem` check catches all five: "..md" (stem "."),
        // "...md" (stem ".."), bare ".md" (len<4), " .md", "a..md".
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["..md", "...md", ".md", " .md", "a..md"] {
            assert!(notebook_path(tmp.path(), bad).is_err(), "expected rejection for {bad:?}");
        }
    }

    #[test]
    fn console_md_accepted_not_treated_as_reserved_substring() {
        let tmp = tempfile::tempdir().unwrap();
        let path = notebook_path(tmp.path(), "console.md").unwrap();
        assert_eq!(path, tmp.path().join("console.md"));
    }

    #[test]
    fn symlinked_md_file_is_not_listed() {
        // Ports rule_file_tests::symlinked_rule_file_is_skipped's exact
        // pattern: file_type() reports the symlink itself (not its target),
        // so is_file() is false and the entry never reaches the name gate.
        let tmp = tempfile::tempdir().unwrap();
        let secret = tmp.path().join("secret.txt");
        fs::write(&secret, "PRIVATE KEY MATERIAL").unwrap();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&secret, tmp.path().join("linked.md")).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&secret, tmp.path().join("linked.md")).is_ok();
        if !made { return; }
        let got = notebook_list_sync(tmp.path());
        assert!(got.is_empty(), "symlinked .md file must never be listed");
    }

    #[test]
    fn non_canonical_name_on_disk_is_excluded_from_list_and_read() {
        // The quality-review pin: a *.md file placed on disk by something
        // other than notebook_write (here, a space in the stem) must be
        // invisible to BOTH list and read — proving they agree, so a name
        // that comes back from notebook_list is always openable via
        // notebook_read.
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("my notes.md"), "hi").unwrap();
        let got = notebook_list_sync(tmp.path());
        assert!(!got.contains(&"my notes.md".to_string()), "non-canonical name must not be listed");
        assert!(
            notebook_read_sync(tmp.path(), "my notes.md").is_err(),
            "list and read must agree: reject it too"
        );
    }

    #[test]
    fn read_direct_on_symlinked_target_is_err() {
        // Release-audit fix: the list-exclusion alone is not enough — a direct
        // invoke("notebook_read", { name }) bypasses the picker's filter, so
        // the READ path itself must reject a symlinked file instead of
        // following it (same contract as transcript_read_file_lossy).
        let tmp = tempfile::tempdir().unwrap();
        let secret = tmp.path().join("secret.txt");
        fs::write(&secret, "PRIVATE KEY MATERIAL").unwrap();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&secret, tmp.path().join("linked.md")).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&secret, tmp.path().join("linked.md")).is_ok();
        if !made { return; }
        assert!(
            notebook_read_sync(tmp.path(), "linked.md").is_err(),
            "read must reject a symlinked notebook, never follow it"
        );
    }

    #[test]
    fn write_onto_symlinked_target_is_err_and_target_untouched() {
        // Defense-in-depth twin of the read check: writing to a name whose
        // on-disk entry is a symlink is rejected outright (the rename would
        // replace the link, not write through it — but a notebook name that
        // is secretly a link is never a state we accept or mutate).
        let tmp = tempfile::tempdir().unwrap();
        let secret = tmp.path().join("secret.txt");
        fs::write(&secret, "PRIVATE KEY MATERIAL").unwrap();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&secret, tmp.path().join("linked.md")).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&secret, tmp.path().join("linked.md")).is_ok();
        if !made { return; }
        assert!(
            notebook_write_sync(tmp.path(), "linked.md", "overwrite").is_err(),
            "write must reject a symlinked destination"
        );
        assert_eq!(
            fs::read_to_string(&secret).unwrap(),
            "PRIVATE KEY MATERIAL",
            "symlink target must be untouched"
        );
    }
}

#[cfg(test)]
mod scrollback_tail_tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_pair(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir()
            .join("plutos-terminals-tests")
            .join(format!("{}-{}", name, crate::session::new_id("t")));
        let _ = fs::create_dir_all(&dir);
        (dir.join("tab.txt"), dir.join("tab.old.txt"))
    }

    #[test]
    fn small_file_is_byte_identical_including_first_line() {
        // Offset-0 rule (plan-audit F15): align-forward must NOT run when the
        // slice starts at the beginning — the first line survives.
        let (cur, old) = tmp_pair("small");
        fs::write(&cur, "first line\nsecond line\n").unwrap();
        let out = scrollback_tail(&cur, &old, 256 * 1024).unwrap();
        assert_eq!(out, "first line\nsecond line\n");
    }

    #[test]
    fn big_current_returns_newline_aligned_tail_within_cap() {
        let (cur, old) = tmp_pair("big");
        let line = "0123456789012345678901234567890123456789\n"; // 41 bytes
        let data = line.repeat(100);
        fs::write(&cur, &data).unwrap();
        let cap = 500;
        let out = scrollback_tail(&cur, &old, cap).unwrap();
        assert!(out.len() < cap, "cap respected: {}", out.len());
        assert!(out.starts_with('0'), "starts at a line boundary");
        assert!(data.ends_with(&out), "is the exact tail");
    }

    #[test]
    fn stitch_old_then_current_in_chronological_order() {
        let (cur, old) = tmp_pair("stitch");
        fs::write(&old, "older-a\nolder-b\n").unwrap();
        fs::write(&cur, "newer-a\n").unwrap();
        let out = scrollback_tail(&cur, &old, 256 * 1024).unwrap();
        assert_eq!(out, "older-a\nolder-b\nnewer-a\n");
    }

    #[test]
    fn huge_old_tiny_current_fills_budget_from_old_tail() {
        let (cur, old) = tmp_pair("budget");
        let line = "OLDOLDOLDOLDOLDOLDOLD\n"; // 22 bytes
        fs::write(&old, line.repeat(1000)).unwrap(); // 22KB old
        fs::write(&cur, "cur\n").unwrap();
        let cap = 300;
        let out = scrollback_tail(&cur, &old, cap).unwrap();
        assert!(out.len() <= cap, "combined within cap: {}", out.len());
        assert!(out.ends_with("cur\n"), "current is complete and last");
        assert!(out.starts_with("OLD"), "old tail aligned to a line start");
    }

    #[test]
    fn no_newline_blob_keeps_raw_cut() {
        let (cur, old) = tmp_pair("blob");
        fs::write(&cur, "x".repeat(1000)).unwrap();
        let out = scrollback_tail(&cur, &old, 100).unwrap();
        assert_eq!(out.len(), 100, "raw cut rather than losing everything");
    }

    #[test]
    fn missing_both_is_none_missing_old_is_fine() {
        let (cur, old) = tmp_pair("missing");
        assert!(scrollback_tail(&cur, &old, 100).is_none());
        fs::write(&old, "only old\n").unwrap();
        assert_eq!(scrollback_tail(&cur, &old, 100).unwrap(), "only old\n");
    }
}

#[cfg(test)]
mod transcript_pool_tests {
    use super::*;

    fn tmp_base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("plutos-terminals-tests")
            .join(format!("{}-{}", name, crate::session::new_id("t")));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    fn read(base: &std::path::Path, date: &str, name: &str) -> String {
        fs::read_to_string(base.join(date).join(format!("{name}.md"))).unwrap_or_default()
    }

    #[test]
    fn cached_handle_appends_across_calls() {
        let base = tmp_base("pool-reuse");
        let pool = TranscriptHandles::default();
        transcript_write(&pool, &base, "2026-08-12", "2026-08-12", "tab-a", "one\n").unwrap();
        transcript_write(&pool, &base, "2026-08-12", "2026-08-12", "tab-a", "two\n").unwrap();
        assert_eq!(read(&base, "2026-08-12", "tab-a"), "one\ntwo\n");
        assert_eq!(pool.0.lock().unwrap().len(), 1, "one pooled handle");
    }

    #[test]
    fn non_today_is_write_through_and_never_evicts() {
        let base = tmp_base("pool-stale");
        let pool = TranscriptHandles::default();
        transcript_write(&pool, &base, "2026-08-12", "2026-08-12", "tab-a", "today\n").unwrap();
        // A stale-dated append (moved pane's dead interval, midnight flush)
        // interleaves — must not thrash the today-cache (plan-audit F12a).
        transcript_write(&pool, &base, "2026-08-12", "2026-08-10", "tab-b", "stale\n").unwrap();
        assert_eq!(read(&base, "2026-08-10", "tab-b"), "stale\n");
        let map = pool.0.lock().unwrap();
        assert!(
            map.contains_key(&("2026-08-12".into(), "tab-a".into())),
            "today handle survives stale-date traffic"
        );
        assert_eq!(map.len(), 1, "stale date never cached");
    }

    #[test]
    fn date_rollover_evicts_yesterday_lazily() {
        let base = tmp_base("pool-rollover");
        let pool = TranscriptHandles::default();
        transcript_write(&pool, &base, "2026-08-12", "2026-08-12", "tab-a", "d1\n").unwrap();
        // Server date rolls; first today-append under the new date evicts.
        transcript_write(&pool, &base, "2026-08-13", "2026-08-13", "tab-a", "d2\n").unwrap();
        let map = pool.0.lock().unwrap();
        assert_eq!(map.len(), 1);
        assert!(map.contains_key(&("2026-08-13".into(), "tab-a".into())));
        drop(map);
        assert_eq!(read(&base, "2026-08-12", "tab-a"), "d1\n");
        assert_eq!(read(&base, "2026-08-13", "tab-a"), "d2\n");
    }
}
