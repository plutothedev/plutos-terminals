// (C)
//! Import ~/.ssh/config into connectable host entries + the SSH key manager.
//! Extracted from the commands.rs grab-bag (self-contained SSH-config concern).

use std::fs;
use std::path::PathBuf;
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::Serialize;

use crate::commands::local_home;

// Suppress the console window when spawning ssh-keygen on Windows (matches
// netools.rs / commands.rs). Without this the cfg(windows) `creation_flags`
// call below doesn't compile (CommandExt + the flag must be in scope).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Import ~/.ssh/config ─────────────────────────────────────────────────
// Parse the user's OpenSSH client config into connectable host entries for the
// Sessions tree. Handles `Host` blocks (HostName/User/Port/IdentityFile/
// ProxyJump), skips wildcard patterns (Host * / ?) and stops applying at a
// `Match` block. Tilde in IdentityFile is expanded. Missing file → empty list.
#[derive(Serialize)]
pub struct SshHostEntry {
    pub alias: String,
    pub host_name: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

fn ssh_split_kv(line: &str) -> (String, String) {
    // OpenSSH allows "Key Value" or "Key=Value"; value may be quoted.
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' {
        i += 1;
    }
    let key = line[..i].to_string();
    let rest = line[i..]
        .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
        .trim();
    let val = rest.trim_matches('"').to_string();
    (key, val)
}

// Resolve an `Include` pattern to concrete files. Absolute or ~-anchored paths
// are used as-is; relative patterns are relative to ~/.ssh (OpenSSH semantics).
// A `*` glob (e.g. config.d/*) or a directory expands to every regular file in
// that directory — covering the common drop-in-config layout without a glob dep.
fn ssh_include_files(pattern: &str) -> Vec<PathBuf> {
    let base: PathBuf = if let Some(rest) = pattern.strip_prefix("~/") {
        local_home().join(rest)
    } else if pattern.starts_with('/') {
        PathBuf::from(pattern)
    } else {
        local_home().join(".ssh").join(pattern)
    };
    let s = base.to_string_lossy().to_string();
    let dir = if let Some(star) = s.find('*') {
        // The glob's directory is everything up to the last '/' BEFORE the '*'
        // (e.g. "…/config.d/*" → "…/config.d"). Path::parent() would climb one
        // level too far past the trailing slash and rescan the parent dir.
        let prefix = &s[..star];
        PathBuf::from(prefix.rsplit_once('/').map(|(d, _)| d).unwrap_or("."))
    } else if base.is_dir() {
        base.clone()
    } else {
        return vec![base];
    };
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    files.sort();
    files
}

// Read an ssh_config and inline any `Include` directives, returning trimmed,
// comment-free lines ready to parse. Depth-guarded against include cycles.
fn flatten_ssh_config(path: &std::path::Path, depth: u8, out: &mut Vec<String>) {
    if depth > 16 {
        return;
    }
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, val) = ssh_split_kv(line);
        if key.eq_ignore_ascii_case("include") {
            for pat in val.split_whitespace() {
                for f in ssh_include_files(pat) {
                    flatten_ssh_config(&f, depth + 1, out);
                }
            }
        } else {
            out.push(line.to_string());
        }
    }
}

#[tauri::command]
pub fn parse_ssh_config() -> Result<Vec<SshHostEntry>, String> {
    let path = local_home().join(".ssh").join("config");
    let mut lines: Vec<String> = Vec::new();
    flatten_ssh_config(&path, 0, &mut lines);
    if lines.is_empty() {
        return Ok(vec![]);
    }
    let expand = |v: &str| -> String {
        if let Some(rest) = v.strip_prefix("~/") {
            local_home().join(rest).to_string_lossy().to_string()
        } else {
            v.to_string()
        }
    };
    let mut out: Vec<SshHostEntry> = Vec::new();
    let mut cur: Option<SshHostEntry> = None;
    let flush = |out: &mut Vec<SshHostEntry>, c: Option<SshHostEntry>| {
        if let Some(e) = c {
            if !e.host_name.is_empty() {
                out.push(e);
            }
        }
    };
    for line in &lines {
        let (key, val) = ssh_split_kv(line);
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                flush(&mut out, cur.take());
                let alias = val
                    .split_whitespace()
                    .find(|a| !a.contains('*') && !a.contains('?'));
                cur = alias.map(|a| SshHostEntry {
                    alias: a.to_string(),
                    host_name: a.to_string(),
                    user: None,
                    port: None,
                    identity_file: None,
                    proxy_jump: None,
                });
            }
            "match" => {
                flush(&mut out, cur.take());
            }
            "hostname" => {
                if let Some(c) = cur.as_mut() {
                    c.host_name = val;
                }
            }
            "user" => {
                if let Some(c) = cur.as_mut() {
                    c.user = Some(val);
                }
            }
            "port" => {
                if let Some(c) = cur.as_mut() {
                    c.port = val.parse().ok();
                }
            }
            "identityfile" => {
                if let Some(c) = cur.as_mut() {
                    if c.identity_file.is_none() {
                        c.identity_file = Some(expand(&val));
                    }
                }
            }
            "proxyjump" => {
                if let Some(c) = cur.as_mut() {
                    c.proxy_jump = Some(val);
                }
            }
            _ => {}
        }
    }
    flush(&mut out, cur.take());
    Ok(out)
}

// ── SSH key manager ──────────────────────────────────────────────────────
// List / generate SSH keypairs in ~/.ssh (Termius/MobaXterm parity). We treat
// every `*.pub` as the marker of a keypair and read its public side for easy
// copy-to-server; generation shells out to ssh-keygen (present on macOS/Linux
// and Windows OpenSSH). Private key material is never read or returned.
#[derive(Serialize)]
pub struct SshKey {
    pub name: String,
    pub private_path: String,
    pub public_key: String,
    pub key_type: String,
    pub comment: String,
}

#[tauri::command]
pub fn ssh_keys_list() -> Result<Vec<SshKey>, String> {
    let dir = local_home().join(".ssh");
    let rd = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };
    let mut keys = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("pub") {
            continue;
        }
        let pubtext = fs::read_to_string(&path).unwrap_or_default();
        let priv_path = path.with_extension("");
        // "ssh-ed25519 AAAA... comment"
        let mut parts = pubtext.split_whitespace();
        let key_type = parts.next().unwrap_or("").to_string();
        let _blob = parts.next();
        let comment = parts.collect::<Vec<_>>().join(" ");
        keys.push(SshKey {
            name: priv_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string(),
            private_path: priv_path.to_string_lossy().to_string(),
            public_key: pubtext.trim().to_string(),
            key_type,
            comment,
        });
    }
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(keys)
}

#[tauri::command]
pub fn ssh_key_generate(
    name: String,
    key_type: String,
    comment: String,
    passphrase: String,
) -> Result<SshKey, String> {
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    if safe.is_empty() {
        return Err("invalid key name".into());
    }
    let dir = local_home().join(".ssh");
    fs::create_dir_all(&dir).map_err(|e| format!("can't create ~/.ssh: {e}"))?;
    let path = dir.join(&safe);
    if path.exists() {
        return Err(format!("a key named '{safe}' already exists"));
    }
    let kt = match key_type.as_str() {
        "rsa" => "rsa",
        _ => "ed25519",
    };
    let mut cmd = Command::new("ssh-keygen");
    cmd.arg("-t").arg(kt);
    if kt == "rsa" {
        cmd.arg("-b").arg("4096");
    }
    cmd.arg("-f")
        .arg(&path)
        .arg("-N")
        .arg(&passphrase)
        .arg("-C")
        .arg(if comment.is_empty() { &safe } else { &comment });
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .output()
        .map_err(|e| format!("ssh-keygen failed to run: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ssh-keygen: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let pubtext = fs::read_to_string(path.with_extension("pub")).unwrap_or_default();
    Ok(SshKey {
        name: safe,
        private_path: path.to_string_lossy().to_string(),
        public_key: pubtext.trim().to_string(),
        key_type: format!("ssh-{kt}"),
        comment,
    })
}
