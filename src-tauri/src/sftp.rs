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

// ───────────────────── staged (temp + rename) file writes ─────────────────────

/// The permission bits of a mode word, with the file-type bits stripped.
///
/// `stat` answers with the full mode (`0o100644` for a regular file, `0o120777`
/// for a symlink) and those high bits are not a valid CREATION mode: handed back
/// to `open_mode` some servers reject the open outright. Only the low 12 bits
/// mean anything to a staged write, and all 12 matter, since setuid/setgid/
/// sticky are part of leaving the file as strict as we found it.
///
/// Shared rather than re-derived per backend, so it is one decision with one
/// test instead of a rule living inside adapters no test can reach.
const fn perm_bits(mode: u32) -> u32 {
    mode & 0o7777
}

/// What a file gets when the destination did not exist yet: nothing to carry
/// over, so it must behave exactly as it did before staging existed, which is
/// `Sftp::create`'s hardcoded value narrowed by the server's umask. Shared with
/// the test double so a test asserting on it is asserting on the value
/// production uses rather than on a second copy of it.
const DEFAULT_CREATE_MODE: u32 = 0o644;

/// The filesystem operations a staged write needs, so the rules in
/// `staged_write` are reachable without a live SFTP server. Implemented for
/// `ssh2::Sftp` (remote saves + uploads) and `LocalFs` (downloads); the tests
/// drive an in-memory fake that models the three things that actually bite
/// here: permission bits, symlinks, and SFTP-v3 rename semantics.
trait StagedFs {
    /// The fully resolved target when `path` is a symlink, `Ok(None)` when it is
    /// not one, and `Err` when it IS one whose target cannot be resolved.
    ///
    /// That last case must not degrade to `None`. `None` means "a regular
    /// file", which stages beside the LINK and renames onto it, replacing the
    /// link with a regular file: exactly the clobbering the resolution exists to
    /// prevent, reached silently (review LOW).
    fn link_target(&self, path: &str) -> Result<Option<String>, String>;
    /// Permission bits of an existing path, else None. A stat that fails for any
    /// other reason also reads as None: the fallback is the server default,
    /// which is what this code did before, never a hard failure on a save.
    fn stat_mode(&self, path: &str) -> Option<u32>;
    fn path_exists(&self, path: &str) -> bool;
    /// Create the staging temp. EXCLUSIVE: the name is predictable, so an
    /// existing path there is refused rather than written through (it could be
    /// a symlink somebody planted). See `truncate_at` for the one caller that
    /// wants to empty a path it KNOWS exists.
    fn create_at(&self, path: &str, mode: Option<u32>) -> Result<Box<dyn Write + '_>, String>;
    /// Empty an existing file in place, mode untouched. Used only by
    /// `discard_staged_copy` when the unlink of a redundant temp was refused:
    /// `create_at` cannot do it any more, because its EXCLUSIVE open fails on
    /// exactly the path this needs to open.
    fn truncate_at(&self, path: &str) -> Result<(), String>;
    fn chmod(&self, path: &str, mode: u32) -> Result<(), String>;
    fn move_onto(&self, from: &str, to: &str) -> Result<(), String>;
    fn remove(&self, path: &str) -> Result<(), String>;
    /// True when a failed rename onto an existing path may be nothing worse than
    /// the SFTP-v3 missing-overwrite limitation, so clearing the destination and
    /// retrying is warranted. False for a local filesystem, where rename really
    /// does replace and a failure means something real (a read-only or locked
    /// destination) that must never be papered over by deleting the user's file.
    fn rename_may_refuse_existing(&self) -> bool;
    /// Whether two paths hold identical bytes, or None when either cannot be
    /// read. Only ever called on the one path where a rename reported success
    /// and left the staged temp behind, which is rare enough that reading a
    /// destination back is affordable and the only thing that can settle what
    /// happened. Never on a normal save.
    fn contents_match(&self, a: &str, b: &str) -> Option<bool>;
}

/// Compare two streams byte for byte.
fn readers_match(a: &mut dyn Read, b: &mut dyn Read) -> std::io::Result<bool> {
    let mut ba = vec![0u8; XFER_BUF];
    let mut bb = vec![0u8; XFER_BUF];
    loop {
        let (na, nb) = (fill(a, &mut ba)?, fill(b, &mut bb)?);
        if na != nb || ba[..na] != bb[..nb] {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
    }
}

/// Read until the buffer is full or the source really has ended. A short read
/// is not EOF, and treating it as one would report two identical files as
/// different the moment a chunk boundary landed differently on each.
fn fill(r: &mut dyn Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

/// Write `dest` by staging the payload into a sibling temp and renaming it over
/// the destination, so `dest` is never opened until the whole payload is
/// durably written. `fill` returns the byte count it wrote.
///
/// That much is the C3 fix and it is correct. What the plain temp+rename got
/// wrong is everything a rename DESTROYS, which only bites an existing
/// destination (audit R3 / R-C3-1 / RDI-4):
///
/// 1. The rename swaps in a brand-new inode, so the destination inherits the
///    temp's mode rather than its own. `Sftp::create` hardcodes 0o644, so
///    saving over a 0600 `.pgpass` / `.netrc` / private key published it, with
///    a success toast. We stat first and create the temp with the destination's
///    own mode, so the payload is never even briefly world-readable, then
///    re-apply it: a create mode is only ever narrowed by the server's umask,
///    which would otherwise leave a 0644 file at 0600.
/// 2. A symlinked destination was REPLACED by a regular file. The old in-place
///    create() followed the link; we resolve it and stage beside its target.
/// 3. libssh2 pins SFTP at version 3 and only serialises `RenameFlags` at
///    version >= 5 (sftp.c:2925), so OVERWRITE never reaches the wire and
///    OpenSSH's sftp-server refuses a rename onto an existing path. The flags
///    stay (a v5+ server honours them) with an unlink+rename fallback behind
///    them. That fallback has a one-instant window where `dest` is missing,
///    which is still far better than the pre-C3 O_TRUNC that zeroed the file
///    before the first byte was even sent.
fn staged_write(
    fs: &impl StagedFs,
    dest: &str,
    fill: impl FnOnce(&mut dyn Write) -> Result<u64, String>,
) -> Result<u64, String> {
    // Resolve a symlinked destination BEFORE picking where to stage: the temp
    // has to be a sibling of the file the rename will actually replace.
    let dest = fs.link_target(dest)?.unwrap_or_else(|| dest.to_string());
    let dest = dest.as_str();
    let mode = fs.stat_mode(dest); // None when the destination does not exist yet
    let tmp = unique_tmp(dest);
    let staged = (|| -> Result<u64, String> {
        let mut w = fs.create_at(&tmp, mode)?;
        let n = fill(&mut *w)?;
        w.flush().map_err(|e| format!("flush temp: {e}"))?;
        Ok(n)
        // w dropped here → the handle closes before the rename
    })();
    let total = match staged {
        Ok(n) => n,
        Err(e) => {
            let _ = fs.remove(&tmp); // best-effort cleanup, dest untouched
            return Err(e);
        }
    };
    // Best effort: the create mode already got us here, and some servers refuse
    // setstat outright. Losing the umask correction must not fail a good save.
    if let Some(m) = mode {
        let _ = fs.chmod(&tmp, m);
    }
    replace_via_rename(fs, &tmp, dest)?;
    Ok(total)
}

/// Rename `tmp` over `dest`, coping with a server that cannot overwrite. Owns
/// the temp's cleanup on every path, because exactly one of them must NOT clean
/// it up.
fn replace_via_rename(fs: &impl StagedFs, tmp: &str, dest: &str) -> Result<(), String> {
    // Whether the v3 fallback below has already unlinked `dest`. Once it has,
    // the staged temp may be the ONLY copy of the payload in existence, so
    // nothing downstream may delete it without first confirming the destination
    // came back, however the retry reported itself.
    let mut dest_removed = false;
    if let Err(first) = fs.move_onto(tmp, dest) {
        if !fs.rename_may_refuse_existing() || !fs.path_exists(dest) {
            // Either nothing was in the way, or this filesystem really does
            // overwrite, so the rename failed for a real reason and the
            // destination stays exactly where it is.
            let _ = fs.remove(tmp);
            return Err(format!("rename temp→dest: {first}"));
        }
        // SFTP v3 has no overwrite flag and OpenSSH's sftp-server link()s then
        // unlink()s, so an existing destination comes back as FAILURE. Clear it
        // and retry rather than leaving the save silently un-applied.
        if let Err(e) = fs.remove(dest) {
            let _ = fs.remove(tmp);
            return Err(format!(
                "rename temp→dest: {first}; and removing the old file failed: {e}"
            ));
        }
        dest_removed = true;
        if let Err(e) = fs.move_onto(tmp, dest) {
            // `dest` is gone and the staged copy is now the ONLY copy of the
            // payload, so it stays on disk and the message says where.
            return Err(format!(
                "rename temp→dest failed after removing the old file ({e}); \
                 the uploaded copy is at {tmp}"
            ));
        }
    }
    // A rename that reports success but leaves the temp in place may not have
    // moved it, and a save that did not land must never be reported as one that
    // did. But the temp surviving does not prove that on its own: a
    // copy-then-delete gateway lands the payload and unlinks the source lazily,
    // or never. Both branches below therefore go and look rather than inferring
    // from the temp alone.
    if fs.path_exists(tmp) {
        if dest_removed {
            // The fallback unlinked `dest` itself, so whatever sits at that path
            // NOW can only have been put there by the retry. That makes a
            // surviving temp mean two opposite things here:
            //
            //   dest back  the rename COPIED. Copy-then-delete gateways land the
            //              payload and unlink the source lazily, or never. The
            //              save succeeded; the temp is the leftover source.
            //   dest gone  the rename moved nothing, and the old file is already
            //              unlinked, so the temp is the ONLY copy of the payload
            //              left in existence.
            //
            // The temp alone cannot tell them apart, and reporting the first as
            // the second announces a landed upload as destroyed data. So re-stat
            // the destination and only cry loss when it is genuinely absent
            // (review MEDIUM). The reverse mistake is the one that must stay
            // caught: treating the second as the first would remove the temp as a
            // stale turd and destroy BOTH copies while reporting "nothing was
            // replaced".
            if fs.path_exists(dest) {
                // The payload is where the user asked for it.
                discard_staged_copy(fs, tmp);
                return Ok(());
            }
            // Nothing at `dest`, so the staged copy stays on disk however the
            // server reported itself, and the message says where to find it.
            return Err(format!(
                "the server reported the rename onto {dest} as successful but the file was not \
                 replaced; the old file was already removed, so the uploaded copy at {tmp} is \
                 the only copy left"
            ));
        }
        // Nothing was unlinked on this path, so `dest` existing proves nothing:
        // it may still hold its ORIGINAL contents. The one thing that separates
        // a copy that landed from a rename that moved nothing is what is in the
        // destination now, so read it back and compare. That would be far too
        // expensive per upload, and it is not: it runs only here, on a rename
        // that already behaved oddly. A size check would not do (an edit that
        // keeps the byte count is exactly the case that has to stay caught) and
        // neither would `dest` existing.
        //
        // Equal contents means the destination holds what the user asked to
        // save, which is a save that succeeded however the server got there. It
        // also covers the harmless corner where a rename moved nothing but the
        // payload happened to equal what was already at `dest`: the file still
        // holds the intended bytes, so success is the honest answer.
        if fs.contents_match(tmp, dest) == Some(true) {
            discard_staged_copy(fs, tmp);
            return Ok(());
        }
        // Either the destination still holds something else, or it could not be
        // read back and we will not guess. `dest` was never unlinked here, so
        // the user's original file is intact and the temp really is a leftover.
        discard_staged_copy(fs, tmp);
        return Err(format!(
            "the server reported the rename onto {dest} as successful but the file was not replaced"
        ));
    }
    Ok(())
}

/// Drop the staged copy once it is known to be redundant: either `dest` holds
/// the payload, or `dest` was never touched and still holds the user's original.
///
/// Best effort by design: failing to clear a now-redundant file must never turn
/// a save that landed into an error. But an unlink that quietly fails leaves a
/// second, complete copy of whatever was just written sitting on the server
/// under a name the user never chose, and a staged save over `.pgpass` or a
/// private key is a copy of a secret (review LOW). So when the unlink is
/// refused, empty the file instead: what is left behind is then a stray name
/// rather than a stray copy.
fn discard_staged_copy(fs: &impl StagedFs, tmp: &str) {
    if fs.remove(tmp).is_ok() || !fs.path_exists(tmp) {
        return;
    }
    // Truncating an EXISTING file leaves its mode alone. Not `create_at`: its
    // open is EXCLUSIVE since 2026-09-17 and fails on a path that exists, which
    // is the only kind of path this ever sees (the first re-review caught that
    // swap turning this fallback into a silent no-op, with the fake filesystem
    // hiding it because it did not honour EXCL).
    let _ = fs.truncate_at(tmp);
}

/// `StagedFs` over the real filesystem, for the download side.
struct LocalFs;

impl StagedFs for LocalFs {
    fn link_target(&self, path: &str) -> Result<Option<String>, String> {
        resolve_local_link(path)
    }
    fn stat_mode(&self, path: &str) -> Option<u32> {
        local_mode(path)
    }
    fn path_exists(&self, path: &str) -> bool {
        fs::symlink_metadata(path).is_ok()
    }
    fn create_at(&self, path: &str, mode: Option<u32>) -> Result<Box<dyn Write + '_>, String> {
        local_create(path, mode).map_err(|e| format!("create temp: {e}"))
    }
    fn truncate_at(&self, path: &str) -> Result<(), String> {
        fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    fn chmod(&self, path: &str, mode: u32) -> Result<(), String> {
        local_chmod(path, mode)
    }
    fn move_onto(&self, from: &str, to: &str) -> Result<(), String> {
        fs::rename(from, to).map_err(|e| e.to_string())
    }
    fn remove(&self, path: &str) -> Result<(), String> {
        fs::remove_file(path).map_err(|e| e.to_string())
    }
    fn rename_may_refuse_existing(&self) -> bool {
        // POSIX rename and MoveFileEx with MOVEFILE_REPLACE_EXISTING both
        // genuinely replace, so a local failure here is real (Windows refuses a
        // read-only target) and the destination must be left where it is.
        false
    }
    fn contents_match(&self, a: &str, b: &str) -> Option<bool> {
        let (mut fa, mut fb) = (fs::File::open(a).ok()?, fs::File::open(b).ok()?);
        readers_match(&mut fa, &mut fb).ok()
    }
}

/// Follow a symlinked destination to the file it points at, so a write goes
/// THROUGH the link rather than replacing it. Bounded so a link loop cannot spin.
///
/// A chain we cannot follow is an Err, not a `None`. `None` says "a regular
/// file", and acting on that renames over the link and destroys it, which is
/// the one outcome this function exists to prevent.
fn resolve_local_link(path: &str) -> Result<Option<String>, String> {
    let mut cur = std::path::PathBuf::from(path);
    let mut hops = 0;
    let mut followed = false;
    while fs::symlink_metadata(&cur)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        if hops >= 8 {
            return Err(format!(
                "resolve symlink {path}: more than 8 hops, so it is a loop or a chain too \
                 deep to be intentional"
            ));
        }
        hops += 1;
        let target =
            fs::read_link(&cur).map_err(|e| format!("resolve symlink {path}: {e}"))?;
        cur = if target.is_absolute() {
            target
        } else {
            cur.parent().map(|d| d.join(&target)).unwrap_or(target)
        };
        followed = true;
    }
    Ok(followed.then(|| cur.to_string_lossy().into_owned()))
}

#[cfg(unix)]
fn local_mode(path: &str) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).ok().map(|m| perm_bits(m.permissions().mode()))
}

// Windows has no POSIX mode to carry across a rename, and renaming onto a
// read-only file is refused outright, so there is nothing to preserve.
#[cfg(not(unix))]
fn local_mode(_path: &str) -> Option<u32> {
    None
}

#[cfg(unix)]
fn local_chmod(path: &str, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(perm_bits(mode)))
        .map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn local_chmod(_path: &str, _mode: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn local_create(path: &str, mode: Option<u32>) -> std::io::Result<Box<dyn Write>> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut opts = fs::OpenOptions::new();
    // create_new = O_CREAT | O_EXCL: the local staging name is as predictable
    // as the remote one, and a pre-planted symlink in the download directory
    // would otherwise carry the payload elsewhere.
    opts.write(true).create_new(true);
    if let Some(m) = mode {
        opts.mode(perm_bits(m));
    }
    Ok(Box::new(opts.open(path)?))
}

#[cfg(not(unix))]
fn local_create(path: &str, _mode: Option<u32>) -> std::io::Result<Box<dyn Write>> {
    // Same exclusivity as the unix arm; see the comment there.
    Ok(Box::new(fs::OpenOptions::new().write(true).create_new(true).open(path)?))
}

/// Stream `src` into `dest` atomically: write a sibling temp, then rename over
/// `dest`. On ANY read/write error the temp is removed and `dest` is left
/// untouched — a dropped download never truncates an existing local file
/// (audit C3). Same `staged_write` rules the remote side uses.
fn stream_to_file_atomic(src: &mut impl Read, dest: &str) -> Result<u64, String> {
    staged_write(&LocalFs, dest, |w| {
        let mut buf = [0u8; XFER_BUF];
        let mut total = 0u64;
        loop {
            let n = src.read(&mut buf).map_err(|e| format!("read: {e}"))?;
            if n == 0 {
                break;
            }
            w.write_all(&buf[..n])
                .map_err(|e| format!("write temp: {e}"))?;
            total += n as u64;
        }
        Ok(total)
    })
}

impl StagedFs for ssh2::Sftp {
    fn link_target(&self, path: &str) -> Result<Option<String>, String> {
        let p = Path::new(path);
        if !self
            .lstat(p)
            .map(|s| s.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Ok(None);
        }
        // realpath follows the whole chain and resolves a relative target,
        // which readlink alone would not. It IS a link, so a realpath that
        // refuses (a target in a directory the account cannot traverse, a
        // dangling link, a server without the extension) is a failure, not a
        // regular file.
        self.realpath(p)
            .map(|t| Some(t.to_string_lossy().into_owned()))
            .map_err(|e| format!("resolve symlink {path}: {e}"))
    }
    fn stat_mode(&self, path: &str) -> Option<u32> {
        // Mask off the S_IFMT type bits: only the permission bits are meaningful
        // as a creation mode, and a server handed S_IFREG in that field may
        // reject the open.
        self.stat(Path::new(path))
            .ok()
            .and_then(|s| s.perm)
            .map(perm_bits)
    }
    fn path_exists(&self, path: &str) -> bool {
        self.lstat(Path::new(path)).is_ok()
    }
    fn create_at(&self, path: &str, mode: Option<u32>) -> Result<Box<dyn Write + '_>, String> {
        // open_mode rather than create(): `Sftp::create` hardcodes 0o644, which
        // is how a staged save used to publish a 0600 credential file.
        // EXCLUSIVE too: the temp name is predictable (dest + pid + counter), so
        // without it anyone with write access to the remote directory could
        // pre-plant a symlink at that name, have the payload written through it,
        // and then watch the rename move the link over dest. A collision is
        // impossible in practice (same pid AND same counter) and would surface as
        // a plain create error the user retries with a fresh counter.
        let f = self
            .open_mode(
                Path::new(path),
                ssh2::OpenFlags::WRITE | ssh2::OpenFlags::TRUNCATE | ssh2::OpenFlags::EXCLUSIVE,
                perm_bits(mode.unwrap_or(DEFAULT_CREATE_MODE)) as i32,
                ssh2::OpenType::File,
            )
            .map_err(|e| format!("create remote temp: {e}"))?;
        Ok(Box::new(f))
    }
    fn truncate_at(&self, path: &str) -> Result<(), String> {
        // WRITE|TRUNCATE without EXCLUSIVE: the point is to empty a file that
        // is known to exist. TRUNCATE implies CREATE in ssh2, so a temp that
        // vanished between the refused unlink and here comes back as an empty
        // file: a stray name, never a stray copy.
        self.open_mode(
            Path::new(path),
            ssh2::OpenFlags::WRITE | ssh2::OpenFlags::TRUNCATE,
            perm_bits(DEFAULT_CREATE_MODE) as i32,
            ssh2::OpenType::File,
        )
        .map(|_| ())
        .map_err(|e| format!("truncate remote temp: {e}"))
    }
    fn chmod(&self, path: &str, mode: u32) -> Result<(), String> {
        self.setstat(
            Path::new(path),
            ssh2::FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: Some(perm_bits(mode)),
                atime: None,
                mtime: None,
            },
        )
        .map_err(|e| e.to_string())
    }
    fn move_onto(&self, from: &str, to: &str) -> Result<(), String> {
        self.rename(
            Path::new(from),
            Path::new(to),
            Some(
                ssh2::RenameFlags::OVERWRITE
                    | ssh2::RenameFlags::ATOMIC
                    | ssh2::RenameFlags::NATIVE,
            ),
        )
        .map_err(|e| e.to_string())
    }
    fn remove(&self, path: &str) -> Result<(), String> {
        self.unlink(Path::new(path)).map_err(|e| e.to_string())
    }
    fn rename_may_refuse_existing(&self) -> bool {
        true
    }
    fn contents_match(&self, a: &str, b: &str) -> Option<bool> {
        let mut fa = self.open(Path::new(a)).ok()?;
        let mut fb = self.open(Path::new(b)).ok()?;
        readers_match(&mut fa, &mut fb).ok()
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
    // Atomic save: stage into a sibling temp, then rename it over the original.
    // A plain create() is O_CREAT|O_TRUNC — it zeroes the existing file BEFORE the
    // write, so a mid-write failure (dropped link, full disk, libssh2 timeout) would
    // leave the user's file empty/half-written (audit C3).
    staged_write(sftp, remote, |w| {
        w.write_all(content.as_bytes())
            .map_err(|e| format!("write remote temp: {e}"))?;
        Ok(content.len() as u64)
    })
    .map(|_| ())
}

fn do_upload(sftp: &ssh2::Sftp, local: &str, remote: &str) -> Result<u64, String> {
    // Same staging rules as a save: the destination is not opened until the whole
    // payload is on the far side, so a dropped connection mid-upload cannot
    // destroy content that existed before the user even tried to update it.
    let mut lf = fs::File::open(local).map_err(|e| format!("open local: {e}"))?;
    staged_write(sftp, remote, |w| {
        let mut buf = [0u8; XFER_BUF];
        let mut total = 0u64;
        loop {
            let n = lf.read(&mut buf).map_err(|e| format!("read local: {e}"))?;
            if n == 0 {
                break;
            }
            w.write_all(&buf[..n])
                .map_err(|e| format!("write remote temp: {e}"))?;
            total += n as u64;
        }
        Ok(total)
    })
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
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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

    #[test]
    fn a_plain_local_destination_resolves_to_itself() {
        // Only a symlink should ever redirect where the payload lands; a regular
        // file and a path that does not exist yet must be left exactly as given.
        let dest = tmp_path("plain.txt");
        let _ = fs::remove_file(&dest);
        assert_eq!(resolve_local_link(&dest), Ok(None), "a missing path must not redirect");
        fs::write(&dest, b"x").unwrap();
        assert_eq!(resolve_local_link(&dest), Ok(None), "a regular file must not redirect");
        let _ = fs::remove_file(&dest);
    }

    // The local side's mode + symlink handling only exists on POSIX (Windows has
    // no mode bits to carry and refuses a rename onto a read-only file), so
    // these two compile out on the primary target rather than passing vacuously.
    #[cfg(unix)]
    #[test]
    fn local_download_over_a_restricted_file_keeps_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dest = tmp_path("secret.env");
        let _ = fs::remove_file(&dest);
        fs::write(&dest, b"old").unwrap();
        fs::set_permissions(&dest, fs::Permissions::from_mode(0o600)).unwrap();

        let mut src = io::Cursor::new(b"new".to_vec());
        stream_to_file_atomic(&mut src, &dest).unwrap();

        let mode = fs::metadata(&dest).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o600, "the downloaded file must not widen to 0644");
        assert_eq!(fs::read(&dest).unwrap(), b"new");
        let _ = fs::remove_file(&dest);
    }

    #[cfg(unix)]
    #[test]
    fn local_symlinked_destination_is_written_through_not_replaced() {
        let target = tmp_path("real-target.txt");
        let link = tmp_path("link-to-target.txt");
        let _ = fs::remove_file(&target);
        let _ = fs::remove_file(&link);
        fs::write(&target, b"old").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let mut src = io::Cursor::new(b"new".to_vec());
        stream_to_file_atomic(&mut src, &link).unwrap();

        assert!(
            fs::symlink_metadata(&link).unwrap().file_type().is_symlink(),
            "the symlink must survive"
        );
        assert_eq!(fs::read(&target).unwrap(), b"new");
        let _ = fs::remove_file(&link);
        let _ = fs::remove_file(&target);
    }

    // ── An in-memory stand-in for an SFTP server ────────────────────────────
    //
    // Audit R3 / R-C3-1 / RDI-4. The staged-write rules turn on three things a
    // real server does and a live connection is the only other way to observe:
    // permission bits, symlinks, and SFTP-v3 rename semantics. libssh2 pins
    // LIBSSH2_SFTP_VERSION at 3 and only serialises RenameFlags at version >= 5
    // (sftp.c:2925), so OVERWRITE never reaches the wire and OpenSSH's
    // sftp-server, which link()s then unlink()s, answers a rename onto an
    // existing path with FAILURE. `rename_overwrites: false` is that server.

    #[derive(Clone, Default)]
    struct FakeFile {
        data: Vec<u8>,
        mode: u32,
        link_to: Option<String>,
    }

    struct FakeFs {
        files: std::cell::RefCell<HashMap<String, FakeFile>>,
        /// Bits the server strips off a create mode.
        umask: u32,
        /// false = SFTP v3: a rename onto an existing path is refused.
        rename_overwrites: bool,
        /// A server that answers OK to a rename it did not actually perform.
        rename_lies: bool,
        /// Stands in for a local filesystem, where rename genuinely replaces.
        local_semantics: bool,
        /// Every rename fails, so the v3 fallback's retry can be made to fail.
        rename_always_fails: bool,
        /// A server whose rename COPIES rather than moves: the destination
        /// really does end up holding the payload, and the source is still
        /// sitting there when the call returns. Copy-then-delete gateways and
        /// cross-filesystem staging proxies behave this way, and their unlink
        /// of the source can lag or never happen at all.
        rename_copies: bool,
        /// lstat says symlink and the resolve refuses: a server that answers
        /// realpath with a permission error on a link whose target sits in a
        /// directory the account cannot traverse.
        link_unresolvable: bool,
        /// Every unlink is refused, so the cleanup of a redundant staged copy
        /// can be made to fail.
        remove_fails: bool,
    }

    impl FakeFs {
        fn v3() -> Self {
            FakeFs {
                files: std::cell::RefCell::new(HashMap::new()),
                umask: 0,
                rename_overwrites: false,
                rename_lies: false,
                local_semantics: false,
                rename_always_fails: false,
                rename_copies: false,
                link_unresolvable: false,
                remove_fails: false,
            }
        }
        /// A server that honours OVERWRITE, so a test can isolate mode/symlink
        /// behaviour from the v3 rename problem.
        fn v5() -> Self {
            FakeFs { rename_overwrites: true, ..FakeFs::v3() }
        }
        fn with_file(self, path: &str, data: &str, mode: u32) -> Self {
            self.files.borrow_mut().insert(
                path.into(),
                FakeFile { data: data.into(), mode, link_to: None },
            );
            self
        }
        fn with_symlink(self, path: &str, target: &str) -> Self {
            self.files.borrow_mut().insert(
                path.into(),
                FakeFile { link_to: Some(target.into()), ..Default::default() },
            );
            self
        }
        /// Resolve a symlink chain the way the server's stat/setstat would.
        fn resolve(&self, path: &str) -> String {
            let mut cur = path.to_string();
            for _ in 0..8 {
                match self.files.borrow().get(&cur).and_then(|f| f.link_to.clone()) {
                    Some(t) => cur = t,
                    None => break,
                }
            }
            cur
        }
        fn content(&self, path: &str) -> Option<String> {
            let p = self.resolve(path);
            self.files
                .borrow()
                .get(&p)
                .map(|f| String::from_utf8_lossy(&f.data).into_owned())
        }
        fn mode(&self, path: &str) -> Option<u32> {
            let p = self.resolve(path);
            self.files.borrow().get(&p).map(|f| f.mode)
        }
        fn is_link(&self, path: &str) -> bool {
            self.files.borrow().get(path).is_some_and(|f| f.link_to.is_some())
        }
        fn leftover_temps(&self) -> Vec<String> {
            self.files
                .borrow()
                .keys()
                .filter(|k| k.contains(".pluto-"))
                .cloned()
                .collect()
        }
    }

    struct FakeWriter<'a> {
        fs: &'a FakeFs,
        path: String,
    }
    impl Write for FakeWriter<'_> {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let mut files = self.fs.files.borrow_mut();
            let f = files
                .get_mut(&self.path)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "temp vanished"))?;
            f.data.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl StagedFs for FakeFs {
        fn link_target(&self, path: &str) -> Result<Option<String>, String> {
            if self.files.borrow().get(path).and_then(|f| f.link_to.clone()).is_none() {
                return Ok(None);
            }
            if self.link_unresolvable {
                return Err(format!("resolve symlink {path}: permission denied"));
            }
            Ok(Some(self.resolve(path)))
        }
        fn stat_mode(&self, path: &str) -> Option<u32> {
            self.mode(path)
        }
        fn path_exists(&self, path: &str) -> bool {
            self.files.borrow().contains_key(path)
        }
        fn create_at(&self, path: &str, mode: Option<u32>) -> Result<Box<dyn Write + '_>, String> {
            // EXCL, like the real implementations: a fake that silently
            // replaced an existing file is how the discard fallback's break
            // stayed green for a whole review round.
            if self.files.borrow().contains_key(path) {
                return Err(format!("create remote temp: {path} already exists (EXCL)"));
            }
            self.files.borrow_mut().insert(
                path.into(),
                FakeFile {
                    data: Vec::new(),
                    mode: mode.unwrap_or(DEFAULT_CREATE_MODE) & !self.umask,
                    link_to: None,
                },
            );
            Ok(Box::new(FakeWriter { fs: self, path: path.into() }))
        }
        fn truncate_at(&self, path: &str) -> Result<(), String> {
            let mut files = self.files.borrow_mut();
            match files.get_mut(path) {
                Some(f) => f.data.clear(),
                None => {
                    files.insert(
                        path.into(),
                        FakeFile { data: Vec::new(), mode: DEFAULT_CREATE_MODE & !self.umask, link_to: None },
                    );
                }
            }
            Ok(())
        }
        fn chmod(&self, path: &str, mode: u32) -> Result<(), String> {
            let p = self.resolve(path);
            match self.files.borrow_mut().get_mut(&p) {
                Some(f) => {
                    f.mode = perm_bits(mode);
                    Ok(())
                }
                None => Err("no such file".into()),
            }
        }
        fn move_onto(&self, from: &str, to: &str) -> Result<(), String> {
            let mut files = self.files.borrow_mut();
            if !files.contains_key(from) {
                return Err("no such file".into());
            }
            if self.rename_always_fails {
                return Err("permission denied".into());
            }
            if files.contains_key(to) && !self.rename_overwrites {
                return Err("failure".into());
            }
            if self.rename_copies {
                // The payload LANDS; only the source is left behind.
                let v = files.get(from).cloned().unwrap();
                files.insert(to.into(), v);
                return Ok(());
            }
            if self.rename_lies {
                return Ok(()); // reports success, moves nothing
            }
            let v = files.remove(from).unwrap();
            files.insert(to.into(), v);
            Ok(())
        }
        fn remove(&self, path: &str) -> Result<(), String> {
            if self.remove_fails {
                return Err("permission denied".into());
            }
            match self.files.borrow_mut().remove(path) {
                Some(_) => Ok(()),
                None => Err("no such file".into()),
            }
        }
        fn rename_may_refuse_existing(&self) -> bool {
            !self.local_semantics
        }
        fn contents_match(&self, a: &str, b: &str) -> Option<bool> {
            let (ra, rb) = (self.resolve(a), self.resolve(b));
            let files = self.files.borrow();
            Some(files.get(&ra)?.data == files.get(&rb)?.data)
        }
    }

    fn write_str(fs: &FakeFs, dest: &str, body: &str) -> Result<u64, String> {
        staged_write(fs, dest, |w| {
            w.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
            Ok(body.len() as u64)
        })
    }

    #[test]
    fn only_the_permission_bits_survive_a_stat() {
        // Both backends stat the destination to carry its mode across the
        // rename, and both get a full mode word back: 0o100644 for a regular
        // file, not 0o644. Feeding that straight back as a creation mode is
        // rejected outright by servers that validate it, so the type bits have
        // to come off, and only the type bits: dropping setuid/setgid/sticky
        // would quietly loosen a file the write was meant to leave alone.
        assert_eq!(perm_bits(0o100_644), 0o644, "S_IFREG must come off");
        assert_eq!(perm_bits(0o120_777), 0o777, "S_IFLNK must come off");
        assert_eq!(perm_bits(0o104_755), 0o4755, "setuid must NOT come off");
        assert_eq!(perm_bits(0o100_600), 0o600);
        assert_eq!(perm_bits(0o600), 0o600, "an already-clean mode is unchanged");
    }

    #[test]
    fn overwriting_a_restricted_remote_file_keeps_its_mode() {
        // The C3 fix swapped a fresh 0644 inode into place, so saving over a
        // 0600 credential file published it to every account on the host.
        let fs = FakeFs::v5().with_file("/home/u/.pgpass", "old", 0o600);

        write_str(&fs, "/home/u/.pgpass", "new secret").unwrap();

        assert_eq!(fs.mode("/home/u/.pgpass"), Some(0o600), "mode must survive the rename");
        assert_eq!(fs.content("/home/u/.pgpass").as_deref(), Some("new secret"));
        assert!(fs.leftover_temps().is_empty());
    }

    #[test]
    fn umask_cannot_leave_a_replaced_file_stricter_than_it_was() {
        // Creating with the captured mode is not enough on its own: the server's
        // umask can only clear bits, so a 0644 file on a umask-077 host would
        // come back 0600 and break whatever was reading it.
        let fs = FakeFs { umask: 0o077, ..FakeFs::v5() }.with_file("/srv/app.conf", "old", 0o644);

        write_str(&fs, "/srv/app.conf", "new").unwrap();

        assert_eq!(fs.mode("/srv/app.conf"), Some(0o644));
    }

    #[test]
    fn a_new_remote_file_still_gets_the_server_default_mode() {
        // Nothing to carry over: a fresh file must behave exactly as before.
        let fs = FakeFs::v5();
        write_str(&fs, "/home/u/notes.txt", "hello").unwrap();
        assert_eq!(fs.mode("/home/u/notes.txt"), Some(0o644));
        assert_eq!(DEFAULT_CREATE_MODE, 0o644, "the value both backends create with");
        assert_eq!(fs.content("/home/u/notes.txt").as_deref(), Some("hello"));
    }

    #[test]
    fn a_symlinked_destination_is_written_through_not_replaced() {
        // The old in-place create() followed the link. Renaming over it replaces
        // the link with a regular file, which silently detaches config trees
        // like /etc/nginx/sites-enabled/* from the file they point at.
        let fs = FakeFs::v5()
            .with_file("/etc/nginx/sites-available/site", "old", 0o640)
            .with_symlink("/etc/nginx/sites-enabled/site", "/etc/nginx/sites-available/site");

        write_str(&fs, "/etc/nginx/sites-enabled/site", "new").unwrap();

        assert!(fs.is_link("/etc/nginx/sites-enabled/site"), "the symlink must survive");
        assert_eq!(fs.content("/etc/nginx/sites-available/site").as_deref(), Some("new"));
        assert_eq!(fs.mode("/etc/nginx/sites-available/site"), Some(0o640));
        assert!(fs.leftover_temps().is_empty());
    }

    #[test]
    fn overwrite_works_on_a_v3_server_that_refuses_rename_onto_an_existing_path() {
        // libssh2 never sends the OVERWRITE flag, so this is EVERY real OpenSSH
        // host: without a fallback, an upload can only ever create new names.
        let fs = FakeFs::v3().with_file("/etc/nginx/nginx.conf", "old", 0o644);

        write_str(&fs, "/etc/nginx/nginx.conf", "new").unwrap();

        assert_eq!(fs.content("/etc/nginx/nginx.conf").as_deref(), Some("new"));
        assert!(fs.leftover_temps().is_empty());
    }

    #[test]
    fn a_rename_that_reports_success_without_moving_anything_is_an_error() {
        // Never report a save that did not land. The temp still being there is
        // the tell.
        let fs = FakeFs { rename_lies: true, ..FakeFs::v5() }
            .with_file("/home/u/report.txt", "old", 0o644);

        let err = write_str(&fs, "/home/u/report.txt", "new").unwrap_err();

        assert!(err.contains("not replaced"), "unhelpful error: {err}");
        assert_eq!(fs.content("/home/u/report.txt").as_deref(), Some("old"));
        assert!(fs.leftover_temps().is_empty(), "the stale temp must be cleaned up");
    }

    #[test]
    fn a_failed_retry_keeps_the_staged_copy_rather_than_losing_the_payload() {
        // The v3 fallback unlinks the destination before retrying. If the retry
        // also fails, the staged temp is the only copy of the payload left, so
        // it must survive and the error must say where it is.
        let fs = FakeFs { rename_always_fails: true, ..FakeFs::v3() }
            .with_file("/etc/nginx/nginx.conf", "old", 0o644);

        let err = write_str(&fs, "/etc/nginx/nginx.conf", "new").unwrap_err();

        let temps = fs.leftover_temps();
        assert_eq!(temps.len(), 1, "the staged copy must not be deleted too");
        assert!(err.contains(&temps[0]), "the error must name the staged copy: {err}");
        assert_eq!(fs.content(&temps[0]).as_deref(), Some("new"));
    }

    #[test]
    fn a_lying_rename_after_the_fallback_keeps_the_only_copy_of_the_payload() {
        // The same state as the failed retry above, reached the other way. On a
        // v3 server the fallback has ALREADY unlinked `dest` before it retries,
        // so if that retry reports success without moving anything (copy-then-
        // delete gateways answer OK and unlink the source lazily), the staged
        // temp is again the only copy in existence. Treating it as a stale turd
        // destroys the old file and the new one in the same breath, and says
        // "the file was not replaced" while doing it, which reads as "nothing
        // happened" rather than "your file is gone".
        let fs = FakeFs { rename_lies: true, ..FakeFs::v3() }
            .with_file("/etc/nginx/nginx.conf", "ORIGINAL", 0o644);

        let err = write_str(&fs, "/etc/nginx/nginx.conf", "new").unwrap_err();

        let temps = fs.leftover_temps();
        assert_eq!(temps.len(), 1, "the staged copy is the last copy; it must survive");
        assert_eq!(fs.content(&temps[0]).as_deref(), Some("new"));
        assert!(err.contains(&temps[0]), "the error must name the surviving copy: {err}");
        assert!(
            err.contains("already removed"),
            "the error must say the old file is gone, not that nothing happened: {err}"
        );
    }

    #[test]
    fn a_copying_rename_after_the_fallback_is_a_saved_file_not_a_lost_one() {
        // The mirror image of the test above, and the reason the temp being
        // present cannot be read as loss on its own. Same v3 fallback, same
        // already-unlinked destination, same temp still sitting there when the
        // retry returns OK, but here the server COPIED: the payload is at
        // `dest`. That is a successful upload, and announcing it as "your file
        // is gone" is its own kind of data-loss report.
        let fs = FakeFs { rename_copies: true, ..FakeFs::v3() }
            .with_file("/etc/nginx/nginx.conf", "ORIGINAL", 0o644);

        write_str(&fs, "/etc/nginx/nginx.conf", "new").unwrap();

        assert_eq!(fs.content("/etc/nginx/nginx.conf").as_deref(), Some("new"));
        assert!(
            fs.leftover_temps().is_empty(),
            "once dest holds the payload the staged copy is a leftover, not the last copy"
        );
    }

    #[test]
    fn a_copying_rename_on_the_first_attempt_is_a_saved_file_not_a_failure() {
        // The same server as the test above, reached without the v3 fallback.
        // A v5 host honours OVERWRITE, so the FIRST rename is the one that
        // copies, and the temp is sitting there when it returns. `dest` was
        // never unlinked on this path, so its existence proves nothing and the
        // temp surviving was being read as "the file was not replaced" on a
        // save that had in fact replaced it.
        let fs = FakeFs { rename_copies: true, ..FakeFs::v5() }
            .with_file("/etc/nginx/nginx.conf", "ORIGINAL", 0o644);

        write_str(&fs, "/etc/nginx/nginx.conf", "new").unwrap();

        assert_eq!(fs.content("/etc/nginx/nginx.conf").as_deref(), Some("new"));
        assert!(
            fs.leftover_temps().is_empty(),
            "once dest holds the payload the staged copy is a leftover, not a failure"
        );
    }

    #[test]
    fn a_lying_rename_is_still_told_from_a_copying_one_by_what_is_in_the_destination() {
        // The pair that keeps the read-back honest. Same lying v5 server as
        // `a_rename_that_reports_success_without_moving_anything_is_an_error`,
        // but the payload happens to equal what is already at `dest`. Nothing
        // moved there either, yet the file holds exactly the bytes the user
        // asked to save, so success is the honest answer.
        //
        // Read the two together: one demands Err when the contents differ, this
        // one demands Ok when they do not. A comparison stubbed to a constant
        // breaks one or the other, so neither test can quietly go vacuous.
        let fs = FakeFs { rename_lies: true, ..FakeFs::v5() }
            .with_file("/home/u/report.txt", "same", 0o644);

        write_str(&fs, "/home/u/report.txt", "same").unwrap();

        assert_eq!(fs.content("/home/u/report.txt").as_deref(), Some("same"));
        assert!(fs.leftover_temps().is_empty(), "the redundant temp must be cleaned up");
    }

    #[test]
    fn comparing_two_streams_survives_short_reads() {
        // `contents_match` is what separates a landed save from a lost one, and
        // it reads two independent streams. A short read is not EOF: treating it
        // as one would call two identical files different the moment a chunk
        // boundary landed differently on each, which on the fallback path is a
        // landed upload announced as destroyed data.
        struct Dribble<'a>(&'a [u8]);
        impl Read for Dribble<'_> {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                // Never more than 7 bytes at a time, whatever was asked for.
                let n = self.0.len().min(buf.len()).min(7);
                buf[..n].copy_from_slice(&self.0[..n]);
                self.0 = &self.0[n..];
                Ok(n)
            }
        }
        let payload = vec![b'q'; 100 * 1024];

        let mut whole = io::Cursor::new(payload.clone());
        assert!(
            readers_match(&mut Dribble(&payload), &mut whole).unwrap(),
            "identical bytes must compare equal however they arrive"
        );

        let mut longer = io::Cursor::new([payload.clone(), vec![b'q']].concat());
        assert!(
            !readers_match(&mut Dribble(&payload), &mut longer).unwrap(),
            "one extra byte is a difference"
        );

        let mut edited = payload.clone();
        edited[90 * 1024] = b'z';
        assert!(
            !readers_match(&mut Dribble(&payload), &mut io::Cursor::new(edited)).unwrap(),
            "an edit that keeps the byte count is exactly the case that has to stay caught"
        );
    }

    #[test]
    fn a_symlink_that_cannot_be_resolved_fails_the_save_rather_than_replacing_the_link() {
        // lstat says symlink and realpath refuses (a target in a directory the
        // account cannot traverse). Reading that as "not a link" stages beside
        // the LINK and renames onto it, which replaces the link with a regular
        // file: exactly the clobbering the resolution exists to prevent, now
        // reached silently.
        let fs = FakeFs { link_unresolvable: true, ..FakeFs::v5() }
            .with_file("/etc/nginx/sites-available/site", "old", 0o640)
            .with_symlink("/etc/nginx/sites-enabled/site", "/etc/nginx/sites-available/site");

        let err = write_str(&fs, "/etc/nginx/sites-enabled/site", "new").unwrap_err();

        assert!(err.contains("symlink"), "the error must name the real problem: {err}");
        assert!(fs.is_link("/etc/nginx/sites-enabled/site"), "the symlink must survive");
        assert_eq!(fs.content("/etc/nginx/sites-available/site").as_deref(), Some("old"));
        assert!(fs.leftover_temps().is_empty());
    }

    #[test]
    fn a_staged_copy_that_cannot_be_unlinked_is_emptied_not_left_holding_the_payload() {
        // Once `dest` holds the payload the staged copy is redundant, and on a
        // save over a credential file it is a second copy of a secret the user
        // never asked to create. Clearing it is best effort and must not turn a
        // save that landed into an error, so when the unlink is refused the next
        // best thing is to leave nothing in it worth reading.
        let fs = FakeFs { rename_copies: true, remove_fails: true, ..FakeFs::v5() }
            .with_file("/home/u/.pgpass", "ORIGINAL", 0o600);

        write_str(&fs, "/home/u/.pgpass", "new secret").unwrap();

        assert_eq!(fs.content("/home/u/.pgpass").as_deref(), Some("new secret"));
        let temps = fs.leftover_temps();
        assert_eq!(temps.len(), 1, "the unlink was refused, so the name is still there");
        assert_eq!(
            fs.content(&temps[0]).as_deref(),
            Some(""),
            "the leftover must not still hold a copy of the payload"
        );
    }

    #[test]
    fn the_staging_temp_is_opened_exclusive_so_a_pre_planted_path_is_refused() {
        // The temp name is predictable (dest + pid + counter). Whatever sits at
        // that name before the save (a planted symlink, a stale copy) must be
        // refused, not written through. The fake enforces EXCL for the same
        // reason the real opens do, so the discard test above is meaningful:
        // revert discard_staged_copy to create_at and it fails here.
        let fs = FakeFs::v5().with_file("/home/u/planted", "ATTACKER", 0o644);
        assert!(fs.create_at("/home/u/planted", None).is_err());
        assert_eq!(fs.content("/home/u/planted").as_deref(), Some("ATTACKER"), "untouched");
    }

    #[test]
    fn truncate_at_empties_an_existing_file_and_keeps_its_mode() {
        let fs = FakeFs::v5().with_file("/home/u/leftover", "copy of a secret", 0o600);
        fs.truncate_at("/home/u/leftover").unwrap();
        assert_eq!(fs.content("/home/u/leftover").as_deref(), Some(""));
        assert_eq!(fs.stat_mode("/home/u/leftover"), Some(0o600));
    }

    #[test]
    fn a_local_rename_failure_never_deletes_the_destination_to_retry() {
        // The v3 fallback must stay scoped to SFTP. A local rename really does
        // replace, so a failure there is real (Windows refuses a read-only
        // target) and unlinking the file to force the retry through would
        // destroy exactly what the download was not allowed to touch.
        let fs = FakeFs { local_semantics: true, ..FakeFs::v3() }
            .with_file("/downloads/report.pdf", "ORIGINAL", 0o444);

        let err = write_str(&fs, "/downloads/report.pdf", "new").unwrap_err();

        assert!(err.starts_with("rename temp→dest:"), "unhelpful error: {err}");
        assert_eq!(fs.content("/downloads/report.pdf").as_deref(), Some("ORIGINAL"));
        assert!(fs.leftover_temps().is_empty());
    }

    #[test]
    fn a_midstream_failure_leaves_the_remote_file_and_its_mode_untouched() {
        // The C3 cure itself: the destination is not opened until the whole
        // payload is staged, so a dropped link cannot truncate it.
        let fs = FakeFs::v3().with_file("/home/u/.pgpass", "ORIGINAL", 0o600);

        let err = staged_write(&fs, "/home/u/.pgpass", |w| {
            w.write_all(b"partial").map_err(|e| e.to_string())?;
            Err("link dropped".into())
        })
        .unwrap_err();

        assert_eq!(err, "link dropped");
        assert_eq!(fs.content("/home/u/.pgpass").as_deref(), Some("ORIGINAL"));
        assert_eq!(fs.mode("/home/u/.pgpass"), Some(0o600));
        assert!(fs.leftover_temps().is_empty());
    }
}
