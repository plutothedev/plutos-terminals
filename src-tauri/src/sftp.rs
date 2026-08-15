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

// A per-transfer-unique temp filename. Two independent SFTP workers (different
// sessions/tabs) can target the SAME destination path concurrently — same-named
// file downloaded to the OS default dir from two hosts, same file re-uploaded
// from two tabs — and a purely dest-derived temp name would let them interleave
// writes into one temp and produce a garbled result (review MEDIUM). Process id
// + a monotonic counter makes the temp unique per transfer.
static XFER_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn unique_tmp(dest: &str) -> String {
    let n = XFER_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{dest}.pluto-{}-{n}.tmp~", std::process::id())
}

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

/// Stream `src` into `dest` atomically: write a sibling temp, then rename over
/// `dest`. On ANY read/write error the temp is removed and `dest` is left
/// untouched — a dropped download never truncates an existing local file
/// (audit C3). Mirror of `do_write_text`'s remote-side pattern for the local FS.
fn stream_to_file_atomic(src: &mut impl Read, dest: &str) -> Result<u64, String> {
    let tmp = unique_tmp(dest);
    let mut lf = fs::File::create(&tmp).map_err(|e| format!("create temp: {e}"))?;
    let mut buf = [0u8; XFER_BUF];
    let mut total = 0u64;
    let streamed = (|| -> Result<(), String> {
        loop {
            let n = src.read(&mut buf).map_err(|e| format!("read: {e}"))?;
            if n == 0 {
                break;
            }
            lf.write_all(&buf[..n])
                .map_err(|e| format!("write temp: {e}"))?;
            total += n as u64;
        }
        lf.flush().map_err(|e| format!("flush temp: {e}"))
    })();
    drop(lf); // close the handle before rename/remove
    match streamed {
        Ok(()) => fs::rename(&tmp, dest).map(|_| total).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("rename temp→dest: {e}")
        }),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn do_download(sftp: &ssh2::Sftp, remote: &str, local: &str) -> Result<u64, String> {
    let mut rf = sftp
        .open(Path::new(remote))
        .map_err(|e| format!("open remote: {e}"))?;
    stream_to_file_atomic(&mut rf, local)
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
    let tmp = unique_tmp(remote);
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
    // Atomic upload: stream into a remote sibling temp, then rename over the
    // destination. A plain create(remote) is O_CREAT|O_TRUNC — it zeroes the
    // existing remote file BEFORE the write, so a dropped connection mid-upload
    // would destroy content that existed before the user even tried to update
    // it (audit C3). Temp+rename keeps the original intact until fully staged.
    let mut lf = fs::File::open(local).map_err(|e| format!("open local: {e}"))?;
    let tmp = unique_tmp(remote);
    let mut total = 0u64;
    let streamed = (|| -> Result<(), String> {
        let mut rf = sftp
            .create(Path::new(&tmp))
            .map_err(|e| format!("create remote temp: {e}"))?;
        let mut buf = [0u8; XFER_BUF];
        loop {
            let n = lf.read(&mut buf).map_err(|e| format!("read local: {e}"))?;
            if n == 0 {
                break;
            }
            rf.write_all(&buf[..n])
                .map_err(|e| format!("write remote temp: {e}"))?;
            total += n as u64;
        }
        rf.flush().map_err(|e| format!("flush remote temp: {e}"))
        // rf dropped here → the remote handle closes before the rename
    })();
    if let Err(e) = streamed {
        let _ = sftp.unlink(Path::new(&tmp)); // best-effort cleanup, original untouched
        return Err(e);
    }
    sftp.rename(
        Path::new(&tmp),
        Path::new(remote),
        Some(ssh2::RenameFlags::OVERWRITE | ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::NATIVE),
    )
    .map_err(|e| {
        let _ = sftp.unlink(Path::new(&tmp));
        format!("rename remote temp→dest: {e}")
    })?;
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
/// P3-T5: the old sync dispatch blocked `rx.recv()` on whatever thread the
/// command ran on — a tokio worker for the async commands (a slow remote
/// listing or an 8MB read parked it for the duration), the MAIN thread for
/// the old sync download/upload. The worker Sender is cloned out under a
/// short registry lock on the async side (the State guard can't cross into
/// the 'static closure), then send+recv run on the blocking pool.
async fn dispatch_async<T: Send + 'static>(
    state: &State<'_, SftpRegistry>,
    id: &str,
    make: impl FnOnce(Reply<T>) -> SftpReq + Send + 'static,
) -> Result<T, String> {
    let sender = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "sftp registry poisoned".to_string())?;
        sessions
            .get(id)
            .ok_or("sftp session not found")?
            .req
            .clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel::<Result<T, String>>();
        sender
            .send(make(tx))
            .map_err(|_| "sftp session closed".to_string())?;
        rx.recv()
            .map_err(|_| "sftp worker did not reply".to_string())?
    })
    .await
    .map_err(|e| format!("sftp task failed: {e}"))?
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
    // Full TCP+SSH handshake off the runtime (P3-T5 — it parked a tokio
    // worker for the whole negotiation).
    let sess = tauri::async_runtime::spawn_blocking(move || {
        connect_session(&host, port, &user, &auth, None)
    })
    .await
    .map_err(|e| format!("sftp task failed: {e}"))??;
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
    dispatch_async(&state, &id, |reply| SftpReq::Realpath {
        path: ".".into(),
        reply,
    })
    .await
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, SftpRegistry>,
    id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    dispatch_async(&state, &id, |reply| SftpReq::List { path, reply }).await
}

/// Download a remote file. Prompts for a local save path; returns the chosen
/// path, or None if the user cancelled.
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, SftpRegistry>,
    id: String,
    path: String,
) -> Result<Option<String>, String> {
    // P3-T5: this was a SYNC command — the dialog AND the whole (possibly
    // multi-GB) transfer blocked the MAIN thread. AsyncFileDialog marshals
    // the picker correctly from any thread; the transfer rides the blocking
    // pool via dispatch_async.
    let name = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download")
        .to_string();
    let Some(local) = rfd::AsyncFileDialog::new()
        .set_file_name(&name)
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let local_str = local.path().to_string_lossy().into_owned();
    let local_for_req = local_str.clone();
    dispatch_async(&state, &id, move |reply| SftpReq::Download {
        remote: path,
        local: local_for_req,
        reply,
    })
    .await?;
    Ok(Some(local_str))
}

/// Upload a local file into a remote directory. Prompts for the local file;
/// returns the resulting remote path, or None if cancelled.
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, SftpRegistry>,
    id: String,
    dir: String,
) -> Result<Option<String>, String> {
    // Async for the same reasons as sftp_download above.
    let Some(local) = rfd::AsyncFileDialog::new().pick_file().await else {
        return Ok(None);
    };
    let name = local.file_name();
    let remote = if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    };
    let local_str = local.path().to_string_lossy().into_owned();
    let remote_for_req = remote.clone();
    dispatch_async(&state, &id, move |reply| SftpReq::Upload {
        local: local_str,
        remote: remote_for_req,
        reply,
    })
    .await?;
    Ok(Some(remote))
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, SftpRegistry>, id: String, path: String) -> Result<(), String> {
    dispatch_async(&state, &id, |reply| SftpReq::Mkdir { path, reply }).await
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, SftpRegistry>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    dispatch_async(&state, &id, move |reply| SftpReq::Remove {
        path,
        is_dir,
        reply,
    }).await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SftpRegistry>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    dispatch_async(&state, &id, |reply| SftpReq::Rename { from, to, reply }).await
}

/// Read a remote text file into a string (for the in-app Monaco editor).
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, SftpRegistry>,
    id: String,
    path: String,
) -> Result<String, String> {
    dispatch_async(&state, &id, |reply| SftpReq::ReadText {
        remote: path,
        reply,
    })
    .await
}

/// Write a string back to a remote file (save from the in-app editor).
#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, SftpRegistry>,
    id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    dispatch_async(&state, &id, |reply| SftpReq::WriteText {
        remote: path,
        content,
        reply,
    })
    .await
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Read};

    // A reader that yields `good` bytes, then errors — simulates a dropped
    // transfer mid-stream.
    struct FailingReader {
        remaining: usize,
    }
    impl Read for FailingReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.remaining == 0 {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "link dropped"));
            }
            let n = self.remaining.min(buf.len());
            for b in &mut buf[..n] {
                *b = b'x';
            }
            self.remaining -= n;
            Ok(n)
        }
    }

    fn tmp_path(name: &str) -> String {
        let mut p = std::env::temp_dir();
        p.push(format!("plutosftp-test-{}-{name}", std::process::id()));
        p.to_string_lossy().into_owned()
    }

    // True if any `<dest>.pluto-*` transfer temp was left behind. Scans the
    // sibling dir rather than checking a hardcoded name (unique_tmp embeds a
    // pid + counter, so the old fixed-name assertion was vacuously true).
    fn leftover_temp_exists(dest: &str) -> bool {
        let p = std::path::Path::new(dest);
        let (dir, stem) = (p.parent().unwrap(), p.file_name().unwrap().to_string_lossy());
        let prefix = format!("{stem}.pluto-");
        fs::read_dir(dir)
            .map(|rd| {
                rd.flatten().any(|e| {
                    e.file_name().to_string_lossy().starts_with(prefix.as_str())
                })
            })
            .unwrap_or(false)
    }

    #[test]
    fn atomic_stream_leaves_existing_file_untouched_on_midstream_error() {
        let dest = tmp_path("keepme.txt");
        let _ = fs::remove_file(&dest);
        fs::write(&dest, b"ORIGINAL CONTENT THAT MUST SURVIVE").unwrap();

        // Stream something that errors after 64KB (past the first buffer).
        let mut src = FailingReader { remaining: 64 * 1024 };
        let res = stream_to_file_atomic(&mut src, &dest);

        assert!(res.is_err(), "a mid-stream error must surface as Err");
        // The original file is byte-for-byte intact...
        assert_eq!(fs::read(&dest).unwrap(), b"ORIGINAL CONTENT THAT MUST SURVIVE");
        // ...and no temp turd is left behind.
        assert!(!leftover_temp_exists(&dest), "a .pluto-* transfer temp was left behind");
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn atomic_stream_writes_full_payload_on_success() {
        let dest = tmp_path("newfile.txt");
        let _ = fs::remove_file(&dest);
        let mut src = io::Cursor::new(vec![b'z'; 100 * 1024]);
        let n = stream_to_file_atomic(&mut src, &dest).unwrap();
        assert_eq!(n, 100 * 1024);
        assert_eq!(fs::read(&dest).unwrap().len(), 100 * 1024);
        assert!(!leftover_temp_exists(&dest), "a .pluto-* transfer temp was left behind");
        let _ = fs::remove_file(&dest);
    }
}
