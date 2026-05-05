// Tauri commands for Pluto's Terminals.
//
// Lifted from Lyfe with KB / journal commands stripped. Kept everything the
// terminals tab depends on: filesystem store (state persistence), folder
// picker, git status, npm scripts, scrollback save/load/delete, transcripts,
// recent files for the project sidebar.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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
    fs::write(&path, data).map_err(|e| e.to_string())
}

// ── Native folder picker (used by Terminals tab project sidebar) ──

#[tauri::command]
pub fn pick_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

// ── Setup-check helpers (used by SetupChecker for first-run prereq detection) ──
//
// The app expects users to have Node.js + Claude Code CLI on PATH. These
// commands try `<bin> --version` and report the trimmed stdout if it succeeds,
// or None if the binary isn't found / the call fails. Used by the 🚀 setup
// modal to show users a clear "Node ✓ / Claude ✗ / API key ✓" checklist on
// first launch instead of letting them type `claude` and hit "command not
// recognized" as their first impression.

#[tauri::command]
pub fn check_command_version(name: String) -> Option<String> {
    if name.is_empty() || name.contains(['/', '\\', '.', ' ']) {
        // Reject obviously-malformed inputs — only bare command names allowed.
        return None;
    }
    let output = std::process::Command::new(&name)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let combined = if !output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        String::from_utf8_lossy(&output.stderr).into_owned()
    };
    let first_line = combined.lines().next().unwrap_or("").trim().to_string();
    if first_line.is_empty() { None } else { Some(first_line) }
}

// ── Git branch + dirty status for a project's cwd ─────────────────

#[derive(Serialize, Deserialize)]
pub struct GitBranchStatus {
    pub branch: String,
    pub dirty: bool,
}

#[tauri::command]
pub fn git_branch_status(cwd: String) -> Option<GitBranchStatus> {
    let path = std::path::Path::new(&cwd);
    if !path.exists() || !path.is_dir() {
        return None;
    }
    let branch_out = std::process::Command::new("git")
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("HEAD")
        .current_dir(&cwd)
        .output()
        .ok()?;
    if !branch_out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&branch_out.stdout).trim().to_string();
    if branch.is_empty() {
        return None;
    }
    let status_out = std::process::Command::new("git")
        .arg("status")
        .arg("--porcelain")
        .current_dir(&cwd)
        .output()
        .ok()?;
    let dirty = !String::from_utf8_lossy(&status_out.stdout).trim().is_empty();
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

fn safe_filename(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

fn scrollback_path(app: &AppHandle, tab_id: &str) -> PathBuf {
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
    fs::read_to_string(&path).ok()
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
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Recent files for the project sidebar ──────────────────────────
// Pulls from git status (currently modified) + git log (recently committed),
// then a directory walk fallback for non-git folders. Filters lockfiles,
// binaries, build artifacts.

#[tauri::command]
pub fn recent_files(cwd: String) -> Vec<String> {
    let path = std::path::Path::new(&cwd);
    if !path.exists() || !path.is_dir() {
        return vec![];
    }

    let mut files: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let push = |f: String, files: &mut Vec<String>, seen: &mut std::collections::HashSet<String>| {
        if !seen.contains(&f) {
            seen.insert(f.clone());
            files.push(f);
        }
    };

    // 1. git status --porcelain (currently modified files)
    if let Ok(out) = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&cwd)
        .output()
    {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let trimmed = line.trim_start();
                if trimmed.len() < 3 {
                    continue;
                }
                let f = trimmed[3..].trim().to_string();
                if !f.is_empty() {
                    push(f, &mut files, &mut seen);
                }
            }
        }
    }

    // 2. git log --name-only (recently committed)
    if let Ok(out) = std::process::Command::new("git")
        .args(["log", "--all", "--pretty=format:", "--name-only", "-n", "30"])
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
        ".lock", ".log", ".min.js", ".min.css", ".ico", ".png", ".jpg", ".jpeg",
        ".gif", ".svg", ".woff", ".woff2", ".ttf", ".eot", ".map", ".pyc", ".pkl",
        ".db", ".sqlite", ".exe", ".dll", ".so", ".dylib", ".o", ".obj",
    ];
    let bad_files = [".DS_Store", ".gitignore", ".gitattributes", "package-lock.json", "yarn.lock", "bun.lockb"];

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
        ".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".rb",
        ".php", ".html", ".css", ".scss", ".vue", ".svelte", ".cs", ".cpp",
        ".c", ".h", ".hpp", ".swift", ".kt", ".dart", ".sh", ".md", ".json",
        ".yaml", ".yml", ".toml", ".sql", ".lua", ".ex", ".exs", ".clj",
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
