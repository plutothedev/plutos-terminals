// (C)
// SFTP file transfer over SSH.
//
// The interactive shell's ssh2::Session is owned by its reader thread (!Sync),
// so SFTP can't borrow it — it opens its own dedicated connection. The Session
// + Sftp are !Sync, so they live solely on a worker thread; each Tauri command
// sends a request down an mpsc channel and blocks on the reply. Transfers run
// fully in Rust (no bytes through JS); local paths come from rfd dialogs.

use crate::session::new_id;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::State;

use crate::pty::{connect_session, SshAuth};

const XFER_BUF: usize = 32 * 1024;

/// One remote directory entry, serialized to the file-browser UI.
#[derive(Serialize, Clone)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: Option<u64>,
}

type Reply<T> = mpsc::Sender<Result<T, String>>;

/// Requests handled by an SFTP session's worker thread.
enum SftpReq {
    Realpath {
        path: String,
        reply: Reply<String>,
    },
    List {
        path: String,
        reply: Reply<Vec<SftpEntry>>,
    },
    Download {
        remote: String,
        local: String,
        reply: Reply<u64>,
    },
    Upload {
        local: String,
        remote: String,
        reply: Reply<u64>,
    },
    Mkdir {
        path: String,
        reply: Reply<()>,
    },
    Remove {
        path: String,
        is_dir: bool,
        reply: Reply<()>,
    },
    Rename {
        from: String,
        to: String,
        reply: Reply<()>,
    },
    // Read/write a remote file as text — backs the in-app Monaco remote editor.
    ReadText {
        remote: String,
        reply: Reply<String>,
    },
    WriteText {
        remote: String,
        content: String,
        reply: Reply<()>,
    },
}

// Cap remote-edit reads so a giant/binary file can't blow up the editor.
const MAX_EDIT_BYTES: u64 = 8 * 1024 * 1024;

pub struct SftpHandle {
    req: mpsc::Sender<SftpReq>,
}

#[derive(Default)]
pub struct SftpRegistry {
    sessions: Mutex<HashMap<String, SftpHandle>>,
}

fn to_entry(path: &Path, stat: &ssh2::FileStat) -> SftpEntry {
    SftpEntry {
        name: path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string(),
        path: path.to_string_lossy().into_owned(),
        is_dir: stat.is_dir(),
        size: stat.size.unwrap_or(0),
        mtime: stat.mtime,
    }
}

fn do_download(sftp: &ssh2::Sftp, remote: &str, local: &str) -> Result<u64, String> {
    let mut rf = sftp
        .open(Path::new(remote))
        .map_err(|e| format!("open remote: {e}"))?;
    let mut lf = fs::File::create(local).map_err(|e| format!("create local: {e}"))?;
    let mut buf = [0u8; XFER_BUF];
    let mut total = 0u64;
    loop {
        let n = rf.read(&mut buf).map_err(|e| format!("read remote: {e}"))?;
        if n == 0 {
            break;
        }
        lf.write_all(&buf[..n])
            .map_err(|e| format!("write local: {e}"))?;
        total += n as u64;
    }
    Ok(total)
}

fn do_read_text(sftp: &ssh2::Sftp, remote: &str) -> Result<String, String> {
    let p = Path::new(remote);
    if let Ok(stat) = sftp.stat(p) {
        if stat.size.unwrap_or(0) > MAX_EDIT_BYTES {
            return Err("file is larger than 8 MB — open it with a remote editor instead".into());
        }
    }
    let mut rf = sftp.open(p).map_err(|e| format!("open remote: {e}"))?;
    let mut bytes = Vec::new();
    rf.read_to_end(&mut bytes)
        .map_err(|e| format!("read remote: {e}"))?;
    if bytes.contains(&0) {
        return Err("file looks binary (contains NUL bytes)".into());
    }
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8 text".to_string())
}

fn do_write_text(sftp: &ssh2::Sftp, remote: &str, content: &str) -> Result<(), String> {
    // Atomic save: write to a sibling temp file, then rename it over the original.
    // A plain create() is O_CREAT|O_TRUNC — it zeroes the existing file BEFORE the
    // write, so a mid-write failure (dropped link, full disk, libssh2 timeout) would
    // leave the user's file empty/half-written. Temp+rename keeps the original intact
    // until the full payload is durably written.
    let tmp = format!("{remote}.plutotmp~");
    {
        let mut rf = sftp
            .create(Path::new(&tmp))
            .map_err(|e| format!("create temp: {e}"))?;
        rf.write_all(content.as_bytes())
            .map_err(|e| format!("write temp: {e}"))?;
        rf.flush().map_err(|e| format!("flush temp: {e}"))?;
    } // rf dropped here → the remote handle is closed before the rename
    sftp.rename(
        Path::new(&tmp),
        Path::new(remote),
        Some(ssh2::RenameFlags::OVERWRITE | ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::NATIVE),
    )
    .map_err(|e| {
        let _ = sftp.unlink(Path::new(&tmp)); // best-effort cleanup
        format!("rename temp→remote: {e}")
    })?;
    Ok(())
}

fn do_upload(sftp: &ssh2::Sftp, local: &str, remote: &str) -> Result<u64, String> {
    let mut lf = fs::File::open(local).map_err(|e| format!("open local: {e}"))?;
    let mut rf = sftp
        .create(Path::new(remote))
        .map_err(|e| format!("create remote: {e}"))?;
    let mut buf = [0u8; XFER_BUF];
    let mut total = 0u64;
    loop {
        let n = lf.read(&mut buf).map_err(|e| format!("read local: {e}"))?;
        if n == 0 {
            break;
        }
        rf.write_all(&buf[..n])
            .map_err(|e| format!("write remote: {e}"))?;
        total += n as u64;
    }
    Ok(total)
}

/// Worker thread: owns the Session for its lifetime and creates the SFTP
/// subsystem locally (so no !Sync handle escapes the thread). Serves requests
/// until the request channel closes (handle dropped / disconnect).
fn worker(sess: ssh2::Session, rx: mpsc::Receiver<SftpReq>) {
    let sftp = match sess.sftp() {
        Ok(s) => s,
        Err(_) => return,
    };
    while let Ok(req) = rx.recv() {
        match req {
            SftpReq::Realpath { path, reply } => {
                let r = sftp
                    .realpath(Path::new(&path))
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string());
                let _ = reply.send(r);
            }
            SftpReq::List { path, reply } => {
                let r = sftp.readdir(Path::new(&path)).map(|entries| {
                    let mut out: Vec<SftpEntry> =
                        entries.iter().map(|(p, st)| to_entry(p, st)).collect();
                    // Dirs first, then case-insensitive by name.
                    out.sort_by(|a, b| {
                        b.is_dir
                            .cmp(&a.is_dir)
                            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                    });
                    out
                });
                let _ = reply.send(r.map_err(|e| e.to_string()));
            }
            SftpReq::Download {
                remote,
                local,
                reply,
            } => {
                let _ = reply.send(do_download(&sftp, &remote, &local));
            }
            SftpReq::Upload {
                local,
                remote,
                reply,
            } => {
                let _ = reply.send(do_upload(&sftp, &local, &remote));
            }
            SftpReq::Mkdir { path, reply } => {
                let _ = reply.send(
                    sftp.mkdir(Path::new(&path), 0o755)
                        .map_err(|e| e.to_string()),
                );
            }
            SftpReq::Remove {
                path,
                is_dir,
                reply,
            } => {
                let p = Path::new(&path);
                let r = if is_dir {
                    sftp.rmdir(p)
                } else {
                    sftp.unlink(p)
                };
                let _ = reply.send(r.map_err(|e| e.to_string()));
            }
            SftpReq::Rename { from, to, reply } => {
                let _ = reply.send(
                    sftp.rename(Path::new(&from), Path::new(&to), None)
                        .map_err(|e| e.to_string()),
                );
            }
            SftpReq::ReadText { remote, reply } => {
                let _ = reply.send(do_read_text(&sftp, &remote));
            }
            SftpReq::WriteText {
                remote,
                content,
                reply,
            } => {
                let _ = reply.send(do_write_text(&sftp, &remote, &content));
            }
        }
    }
}

/// Send a request to a session's worker and block on the reply. The registry
/// lock is held only long enough to enqueue — never across the (possibly slow)
/// transfer — so concurrent commands don't serialize on the mutex.
fn dispatch<T>(
    state: &State<'_, SftpRegistry>,
    id: &str,
    make: impl FnOnce(Reply<T>) -> SftpReq,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel::<Result<T, String>>();
    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "sftp registry poisoned".to_string())?;
        let h = sessions.get(id).ok_or("sftp session not found")?;
        h.req
            .send(make(tx))
            .map_err(|_| "sftp session closed".to_string())?;
    }
    rx.recv()
        .map_err(|_| "sftp worker did not reply".to_string())?
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Open a dedicated SFTP connection (separate from any shell session) and
/// return its id. Reuses the same auth + host-key path as the shell.
#[tauri::command]
pub async fn sftp_connect(
    state: State<'_, SftpRegistry>,
    host: String,
    port: u16,
    user: String,
    auth: SshAuth,
) -> Result<String, String> {
    let sess = connect_session(&host, port, &user, &auth, None)?;
    let (tx, rx) = mpsc::channel::<SftpReq>();
    thread::spawn(move || worker(sess, rx));
    let id = new_id("sftp");
    state
        .sessions
        .lock()
        .map_err(|_| "sftp registry poisoned".to_string())?
        .insert(id.clone(), SftpHandle { req: tx });
    Ok(id)
}

/// Absolute path of the login home directory (resolve ".").
#[tauri::command]
pub async fn sftp_home(state: State<'_, SftpRegistry>, id: String) -> Result<String, String> {
    dispatch(&state, &id, |reply| SftpReq::Realpath {
        path: ".".into(),
        reply,
    })
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, SftpRegistry>,
    id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    dispatch(&state, &id, |reply| SftpReq::List { path, reply })
}

/// Download a remote file. Prompts for a local save path; returns the chosen
/// path, or None if the user cancelled.
#[tauri::command]
pub fn sftp_download(
    state: State<'_, SftpRegistry>,
    id: String,
    path: String,
) -> Result<Option<String>, String> {
    let name = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download")
        .to_string();
    let Some(local) = rfd::FileDialog::new().set_file_name(&name).save_file() else {
        return Ok(None);
    };
    let local_str = local.to_string_lossy().into_owned();
    dispatch(&state, &id, |reply| SftpReq::Download {
        remote: path,
        local: local_str.clone(),
        reply,
    })?;
    Ok(Some(local_str))
}

/// Upload a local file into a remote directory. Prompts for the local file;
/// returns the resulting remote path, or None if cancelled.
#[tauri::command]
pub fn sftp_upload(
    state: State<'_, SftpRegistry>,
    id: String,
    dir: String,
) -> Result<Option<String>, String> {
    let Some(local) = rfd::FileDialog::new().pick_file() else {
        return Ok(None);
    };
    let name = local
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload")
        .to_string();
    let remote = if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    };
    let local_str = local.to_string_lossy().into_owned();
    dispatch(&state, &id, |reply| SftpReq::Upload {
        local: local_str,
        remote: remote.clone(),
        reply,
    })?;
    Ok(Some(remote))
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, SftpRegistry>, id: String, path: String) -> Result<(), String> {
    dispatch(&state, &id, |reply| SftpReq::Mkdir { path, reply })
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, SftpRegistry>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    dispatch(&state, &id, |reply| SftpReq::Remove {
        path,
        is_dir,
        reply,
    })
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SftpRegistry>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    dispatch(&state, &id, |reply| SftpReq::Rename { from, to, reply })
}

/// Read a remote text file into a string (for the in-app Monaco editor).
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, SftpRegistry>,
    id: String,
    path: String,
) -> Result<String, String> {
    dispatch(&state, &id, |reply| SftpReq::ReadText {
        remote: path,
        reply,
    })
}

/// Write a string back to a remote file (save from the in-app editor).
#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, SftpRegistry>,
    id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    dispatch(&state, &id, |reply| SftpReq::WriteText {
        remote: path,
        content,
        reply,
    })
}

/// Tear down an SFTP session: dropping the handle closes the request channel,
/// the worker's recv() ends, the thread exits, and the connection drops.
#[tauri::command]
pub fn sftp_disconnect(state: State<'_, SftpRegistry>, id: String) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|_| "sftp registry poisoned".to_string())?
        .remove(&id);
    Ok(())
}
