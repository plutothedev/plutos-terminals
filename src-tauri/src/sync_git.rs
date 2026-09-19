// (C)
// Cloud-sync git transport. The app keeps a clone in the app-data dir holding
// exactly two opaque files: `salt` (base64) and `state.enc` (JSON {iv,ct}).
// All encryption happens in the renderer; this layer never sees plaintext.
use std::fs;
use std::path::{Path, PathBuf};
use git2::{Cred, FetchOptions, PushOptions, RemoteCallbacks, Repository, Signature};
use serde::Serialize;
use tauri::Manager;

const BRANCH: &str = "main";

#[derive(Serialize)]
pub struct PullResult {
    pub salt: Option<String>,
    pub blob: Option<String>, // raw JSON string of {iv,ct}; None if repo empty
}

fn repo_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("sync-repo"))
}

/// Credentials for the sync remote. The PAT goes to whatever server libgit2 has
/// connected to, so the protection that matters sits upstream of this callback:
/// every options object this module builds sets `follow_redirects` to
/// `git2::RemoteRedirect::None`, so libgit2 talks only to the configured URL's
/// host and refuses any redirect that would leave it.
///
/// It has to be set explicitly, because libgit2 defaults to
/// `GIT_REMOTE_REDIRECT_INITIAL` (`remote.c`), under which the HTTP transport
/// permits the initial service request to redirect anywhere and `net.c` then
/// skips its host comparison entirely. By default, in other words, a redirect
/// can walk the user's token to a host they never configured.
///
/// There is no useful second line of defence to build inside this callback.
/// libgit2 hands it the ORIGINAL configured URL, never the redirect target
/// (`smart.c` sets the transport's `url` once at connect and passes that same
/// pointer to the credentials callback; a redirect rewrites a different field,
/// `server.url`), so a host check here could only ever compare a value with
/// itself. An earlier version of this file did exactly that.
fn callbacks(pat: Option<String>) -> RemoteCallbacks<'static> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |_url, username, allowed| {
        if allowed.is_ssh_key() {
            return Cred::ssh_key_from_agent(username.unwrap_or("git"));
        }
        if let Some(ref token) = pat {
            return Cred::userpass_plaintext(username.unwrap_or("git"), token);
        }
        Cred::default()
    });
    cb
}

/// The only place this module builds fetch options (and `push_options` below
/// the only place it builds push options). Both disable redirect following, for
/// the reason spelled out on `callbacks`. Construction stays funnelled through
/// these two so a new call site cannot quietly ship the permissive default;
/// that funnel is what the source-level test pins, since git2 0.19 exposes a
/// setter for the flag but no getter.
fn fetch_options(pat: Option<String>) -> FetchOptions<'static> {
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks(pat));
    fo.follow_redirects(git2::RemoteRedirect::None);
    fo
}

fn push_options(pat: Option<String>) -> PushOptions<'static> {
    let mut po = PushOptions::new();
    po.remote_callbacks(callbacks(pat));
    po.follow_redirects(git2::RemoteRedirect::None);
    po
}

// ---------------------------------------------------------------------------
// Path-based helpers: the real git logic, decoupled from tauri::AppHandle so it
// can be unit-tested against a local bare repo over file:// URLs (no network).
// The #[tauri::command] fns below are thin wrappers that resolve repo_dir().
// ---------------------------------------------------------------------------

// Normalize local HEAD to our single sync branch regardless of the remote's
// default branch name. An empty remote may hand back HEAD->master (Gitea,
// self-hosted, plain `git init --bare`); without this, push_at would commit
// to refs/heads/master but push refs/heads/main and silently push nothing.
// For a non-empty remote already on main this is a harmless no-op.
fn normalize_head(dir: &Path) {
    if let Ok(repo) = Repository::open(dir) {
        let _ = repo.set_head(&format!("refs/heads/{BRANCH}"));
    }
}

/// The two files this layer consumes must be regular files the app itself
/// wrote. A remote can commit ANYTHING into the tree, including a symlink,
/// and checkout materialises it (libgit2 writes mode-120000 entries as real
/// links wherever core.symlinks is true, which is every macOS/Linux install).
/// fs::write follows links, so without this an attacker with write access to
/// the sync repo can truncate and overwrite any file the user can write.
/// Missing is fine (first run); anything that exists and is not a plain file
/// is refused before it is read or written.
fn reject_non_regular(dir: &Path, name: &str) -> Result<(), String> {
    match fs::symlink_metadata(dir.join(name)) {
        // `is_symlink()` is redundant under `symlink_metadata` (a link is never
        // `is_file()` there) and is kept only to name the threat at the point of
        // the check. Nothing depends on it, so deleting it is safe; what is NOT
        // safe is reading it as a fallback that would survive swapping
        // `symlink_metadata` for `metadata`. It would not: under `metadata` the
        // link is resolved and `is_symlink()` is always false.
        Ok(m) if m.file_type().is_symlink() || !m.is_file() => {
            Err(format!("sync repo: {name} is not a regular file"))
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Both sync paths, checked together — the attack needs only one of them, and
/// the absent-`salt` half is what makes the client believe the remote is empty.
fn reject_non_regular_pair(dir: &Path) -> Result<(), String> {
    reject_non_regular(dir, "salt")?;
    reject_non_regular(dir, "state.enc")
}

/// `origin`'s URL, or None if the directory will not open as a repository or
/// has no origin. Everything it touches is dropped before it returns, which
/// matters on Windows: `discard_clone` renames this directory, and a rename
/// fails while any odb file under it is still open.
fn origin_url_of(dir: &Path) -> Option<String> {
    let repo = Repository::open(dir).ok()?;
    let remote = repo.find_remote("origin").ok()?;
    remote.url().map(|u| u.to_string())
}

/// Throw away a clone that no longer matches the configured remote. Renamed
/// aside FIRST, then removed: after the rename either `dir` is gone (and the
/// caller clones fresh into it) or the rename failed and the original is
/// untouched, so a half-removed tree can never be mistaken for a live clone.
/// The removal itself is best-effort, since leftovers beside the clone cost
/// disk rather than correctness.
///
/// `<dir>.stale` is only the FIRST candidate, not the only one. If something
/// already occupies that path and will not go away (another process holding a
/// handle under it, which is routine on Windows, or a stray file where a
/// directory was expected), the pre-removal fails and the rename onto the
/// occupied path fails with it, and the old single-path version then returned
/// the same error on every sync forever with no way to self-heal. Uniquely
/// suffixed fallbacks turn that permanent wedge into wasted disk. The
/// rename-before-remove ordering holds on every attempt, so a crash between the
/// two still leaves `dir` absent and the next run clones fresh.
fn discard_clone(dir: &Path) -> Result<(), String> {
    let parent = dir.parent().ok_or_else(|| "sync repo has no parent dir".to_string())?;
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "bad sync repo dir name".to_string())?;
    // Distinct per process and per call, so two app instances racing here
    // cannot pick the same fallback path.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let pid = std::process::id();

    let mut last = String::from("no attempt was made");
    for attempt in 0..4u32 {
        let stale = if attempt == 0 {
            parent.join(format!("{name}.stale"))
        } else {
            parent.join(format!("{name}.stale.{pid:x}-{nonce:x}-{attempt}"))
        };
        let _ = fs::remove_dir_all(&stale);
        match fs::rename(dir, &stale) {
            Ok(()) => {
                let _ = fs::remove_dir_all(&stale);
                return Ok(());
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("could not replace stale sync repo clone: {last}"))
}

fn clone_or_open_at(dir: &Path, repo_url: &str, pat: Option<String>) -> Result<(), String> {
    if dir.join(".git").exists() {
        // The clone is a CACHE of the configured remote, never a source of
        // truth (pull_at force-moves the branch to FETCH_HEAD, and gc already
        // discards and re-clones), so a cache that disagrees with settings is
        // simply thrown away. Keeping it is not merely stale: every later sync
        // fetches and pushes the OLD repository, and presents the newly entered
        // token to that old host — which is exactly the host a user moving away
        // from a shared or compromised repo must not be handed a new token.
        // Repointing `origin` in place is not an option either: the history
        // under it belongs to the old remote.
        //
        // Unopenable, and openable-but-origin-less, are treated as mismatches
        // rather than errors: an unusable cache should self-heal instead of
        // wedging sync until the user deletes app-data by hand.
        if origin_url_of(dir).is_some_and(|u| u.trim() == repo_url.trim()) {
            normalize_head(dir);
            return Ok(());
        }
        discard_clone(dir)?;
    }
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fetch_options(pat));
    match builder.clone(repo_url, dir) {
        Ok(_) => {
            normalize_head(dir);
            // A hostile clone is refused here, before anything reads or writes
            // the checked-out tree. Covers the first run AND the replacement
            // clone above, which reaches this same code path.
            reject_non_regular_pair(dir)?;
            Ok(())
        }
        Err(e) if e.code() == git2::ErrorCode::NotFound => {
            let repo = Repository::init(dir).map_err(|x| x.to_string())?;
            repo.remote("origin", repo_url).map_err(|x| x.to_string())?;
            normalize_head(dir);
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn pull_at(dir: &Path, pat: Option<String>) -> Result<PullResult, String> {
    let repo = Repository::open(dir).map_err(|e| e.to_string())?;
    {
        let mut remote = repo.find_remote("origin").map_err(|e| e.to_string())?;
        let mut fo = fetch_options(pat);
        if let Err(e) = remote.fetch(&[BRANCH], Some(&mut fo), None) {
            // Empty remote / missing branch is fine on first run; auth/transport is not.
            use git2::ErrorClass::*;
            match e.class() {
                Net | Ssh | Http | Callback => {
                    return Err(format!("repo fetch failed (check credentials/URL): {e}"));
                }
                _ => { /* empty repo or no such branch yet — tolerate */ }
            }
        }
    }
    if let Ok(fetch_head) = repo.find_reference("FETCH_HEAD") {
        if let Ok(commit) = fetch_head.peel_to_commit() {
            let mut main = repo
                .reference(&format!("refs/heads/{BRANCH}"), commit.id(), true, "ff")
                .map_err(|e| e.to_string())?;
            main.set_target(commit.id(), "ff").map_err(|e| e.to_string())?;
            repo.set_head(&format!("refs/heads/{BRANCH}")).map_err(|e| e.to_string())?;
            repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
                .map_err(|e| e.to_string())?;
        }
    }
    // The checkout above just materialised whatever the remote's tree said, so
    // the guard runs here — after it, before either read follows a link.
    reject_non_regular_pair(dir)?;
    let salt = fs::read_to_string(dir.join("salt")).ok();
    let blob = fs::read_to_string(dir.join("state.enc")).ok();
    Ok(PullResult { salt, blob })
}

fn push_at(dir: &Path, salt: String, blob: String, pat: Option<String>) -> Result<(), String> {
    let repo = Repository::open(dir).map_err(|e| e.to_string())?;
    // The destructive half: fs::write follows a symlink, so an unchecked write
    // here truncates and overwrites the link's target with ciphertext.
    reject_non_regular_pair(dir)?;
    fs::write(dir.join("salt"), salt).map_err(|e| e.to_string())?;
    fs::write(dir.join("state.enc"), blob).map_err(|e| e.to_string())?;

    let mut index = repo.index().map_err(|e| e.to_string())?;
    index.add_path(std::path::Path::new("salt")).map_err(|e| e.to_string())?;
    index.add_path(std::path::Path::new("state.enc")).map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let sig = Signature::now("Pluto Sync", "sync@plutos-terminals").map_err(|e| e.to_string())?;

    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, "sync", &tree, &parents)
        .map_err(|e| e.to_string())?;

    let mut remote = repo.find_remote("origin").map_err(|e| e.to_string())?;
    let mut po = push_options(pat);
    remote
        .push(&[&format!("refs/heads/{BRANCH}:refs/heads/{BRANCH}")], Some(&mut po))
        .map_err(|e| format!("push failed (pull first?): {e}"))?;
    Ok(())
}

// ── Compaction ("git gc") ───────────────────────────────────────────────────
// Every push_at writes a commit + tree + blob(s) as loose objects and libgit2
// never repacks, so an auto-syncing install grows `.git/objects` forever —
// the item the 2026-08-03 forward-risk review deferred. Compaction is a fresh
// clone swapped in atomically: the remote is the source of truth and gc runs
// only right after a successful push, so the local clone carries no state the
// remote doesn't already have.

/// ~21 pushes' worth (3 loose objects per push). Crossing it triggers one
/// re-clone, which resets the count to ~0.
const GC_LOOSE_OBJECT_THRESHOLD: usize = 64;

/// Count of loose objects (files under `.git/objects/<2-hex-chars>/`). Packs
/// (`objects/pack`) and `objects/info` are excluded by the 2-hex-dir filter.
fn loose_object_count(dir: &Path) -> usize {
    let objects = dir.join(".git").join("objects");
    let Ok(entries) = fs::read_dir(&objects) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name.len() == 2 && name.chars().all(|c| c.is_ascii_hexdigit())
        })
        .map(|e| fs::read_dir(e.path()).map(|d| d.flatten().count()).unwrap_or(0))
        .sum()
}

/// Replace the working clone with a fresh clone of origin. Shallow (depth 1)
/// is tried first to also bound history size; a transport that rejects shallow
/// (e.g. libgit2's local transport in tests) falls back to a full clone, which
/// still packs the remote's objects into packfiles — the loose-object sprawl
/// is the growth problem either way. DESTRUCTIVE to local-only state (anything
/// committed but not pushed is discarded) — callers must only run this when
/// local == remote, i.e. immediately after a successful push.
///
/// Swap order keeps the original recoverable at every step: clone to
/// `<dir>.gc-tmp`, rename dir → `<dir>.gc-old`, rename tmp → dir (restoring
/// old on failure), then delete old. Nothing here can lose synced state — the
/// worst failure mode leaves the original clone in place.
fn gc_at(dir: &Path, pat: Option<String>) -> Result<(), String> {
    // Scoped so the repo handle is dropped before the dir swap (Windows holds
    // the odb files open otherwise, which would fail the rename).
    let url = {
        let repo = Repository::open(dir).map_err(|e| e.to_string())?;
        let remote = repo.find_remote("origin").map_err(|e| e.to_string())?;
        remote
            .url()
            .ok_or_else(|| "origin URL is not valid UTF-8".to_string())?
            .to_string()
    };

    let parent = dir.parent().ok_or_else(|| "sync repo has no parent dir".to_string())?;
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "bad sync repo dir name".to_string())?;
    let tmp = parent.join(format!("{name}.gc-tmp"));
    let old = parent.join(format!("{name}.gc-old"));
    let _ = fs::remove_dir_all(&tmp);
    let _ = fs::remove_dir_all(&old);

    let clone_into_tmp = |depth: Option<i32>| -> Result<(), git2::Error> {
        let mut fo = fetch_options(pat.clone());
        if let Some(d) = depth {
            fo.depth(d);
        }
        let mut builder = git2::build::RepoBuilder::new();
        builder.fetch_options(fo);
        builder.clone(&url, &tmp).map(|_| ())
    };
    if clone_into_tmp(Some(1)).is_err() {
        let _ = fs::remove_dir_all(&tmp);
        clone_into_tmp(None).map_err(|e| e.to_string())?;
    }
    normalize_head(&tmp);
    // Guard the gc clone too: this is another point where a remote tree becomes
    // files on disk, so refuse BEFORE the swap and leave the existing clone in
    // place. Defence in depth rather than a live hole — gc only runs right
    // after a successful push, so the tree it pulls back is the one we just
    // wrote, and the next pull_at/push_at would refuse a hostile one before any
    // read or write regardless. The guard belongs at every such point anyway,
    // because "unreachable today" is a property of the callers, not of this fn.
    if let Err(e) = reject_non_regular_pair(&tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }

    fs::rename(dir, &old).map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&tmp, dir) {
        let _ = fs::rename(&old, dir);
        let _ = fs::remove_dir_all(&tmp);
        return Err(e.to_string());
    }
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

/// Compact iff the loose-object count has reached `threshold`. Returns whether
/// a compaction ran and succeeded. Failure is deliberately swallowed into
/// `false`: gc is opportunistic maintenance and must never surface an error to
/// a sync operation that already succeeded.
fn maybe_gc_at(dir: &Path, pat: Option<String>, threshold: usize) -> bool {
    loose_object_count(dir) >= threshold && gc_at(dir, pat).is_ok()
}

// ── Repo-op serialization + off-runtime execution (P3-T4) ───────────────────
// The three command bodies are blocking git2 network I/O; as bare async fns
// they parked tokio workers for seconds (a slow remote stalled unrelated
// IPC). Each now runs in spawn_blocking, and ALL repo operations — including
// the detached gc below — serialize on one static mutex: unserialized, gc's
// clone-and-swap on POSIX renames the live dir under a concurrent push's open
// handles and the push can commit the OLD workdir (silent settings revert).
// The lock is taken via blocking_lock() as the FIRST statement INSIDE each
// blocking closure (legal on the blocking pool; the guard-across-await
// alternative releases early if the outer future is dropped).
static REPO_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tauri::command]
pub async fn sync_clone_or_open(
    app: tauri::AppHandle,
    repo_url: String,
    pat: Option<String>,
) -> Result<(), String> {
    let dir = repo_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _repo = REPO_LOCK.blocking_lock();
        clone_or_open_at(&dir, &repo_url, pat)
    })
    .await
    .map_err(|e| format!("sync task failed: {e}"))?
}

#[tauri::command]
pub async fn sync_pull(
    app: tauri::AppHandle,
    pat: Option<String>,
) -> Result<PullResult, String> {
    let dir = repo_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _repo = REPO_LOCK.blocking_lock();
        pull_at(&dir, pat)
    })
    .await
    .map_err(|e| format!("sync task failed: {e}"))?
}

#[tauri::command]
pub async fn sync_push(
    app: tauri::AppHandle,
    salt: String,
    blob: String,
    pat: Option<String>,
) -> Result<(), String> {
    let dir = repo_dir(&app)?;
    let gc_dir = dir.clone();
    let gc_pat = pat.clone();
    let pushed = tauri::async_runtime::spawn_blocking(move || {
        let _repo = REPO_LOCK.blocking_lock();
        push_at(&dir, salt, blob, pat)
    })
    .await
    .map_err(|e| format!("sync task failed: {e}"))?;
    pushed?;
    // gc runs DETACHED so the caller's latency never pays the ~every-21st-push
    // full re-clone, but still under REPO_LOCK: right after a successful push
    // local == remote (gc_at's lossless precondition), and any sync that
    // sneaks in before the gc acquires the lock re-establishes that same
    // equality — the lock only has to prevent MID-SWAP concurrency, and does.
    // Best-effort by design: the push already succeeded.
    tauri::async_runtime::spawn_blocking(move || {
        let _repo = REPO_LOCK.blocking_lock();
        let _ = maybe_gc_at(&gc_dir, gc_pat, GC_LOOSE_OBJECT_THRESHOLD);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // libgit2 wants `file:///C:/...` for Windows absolute paths (three slashes
    // before the drive letter) but `file:///var/...` on Unix — naively gluing
    // `file:///` onto a Unix path yields four slashes, which its local
    // transport rejects as "not a valid local file URI".
    fn file_url(path: &std::path::Path) -> String {
        let p = path.to_string_lossy().replace('\\', "/");
        if p.starts_with('/') {
            format!("file://{p}")
        } else {
            format!("file:///{p}")
        }
    }

    fn bare_repo(dir: &std::path::Path) {
        // Default `init_bare` HEAD is `master` (or local init.defaultBranch) — i.e.
        // a non-GitHub-style empty remote. We deliberately do NOT set it to `main`,
        // so the round-trip proves clone_or_open_at normalizes local HEAD to `main`.
        let repo = git2::Repository::init_bare(dir).unwrap();
        repo.set_head("refs/heads/master").unwrap();
    }

    #[test]
    fn round_trips_two_files_through_a_bare_repo() {
        let base = std::env::temp_dir().join(format!("pluto-sync-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let bare = base.join("origin.git");
        let work = base.join("clone");
        std::fs::create_dir_all(&bare).unwrap();
        bare_repo(&bare);
        let url = file_url(&bare);

        // clone empty, push two files, then re-clone into a SECOND workdir and read them back.
        // No manual HEAD fixup here: clone_or_open_at normalizes local HEAD to `main`,
        // so the round-trip must work purely via the helpers even though this bare
        // remote's default branch is `master`.
        clone_or_open_at(&work, &url, None).unwrap();
        push_at(
            &work,
            "SALT123".into(),
            "{\"iv\":\"a\",\"ct\":\"b\"}".into(),
            None,
        )
        .unwrap();

        let work2 = base.join("clone2");
        clone_or_open_at(&work2, &url, None).unwrap();
        let got = pull_at(&work2, None).unwrap();
        assert_eq!(got.salt.as_deref(), Some("SALT123"));
        assert_eq!(got.blob.as_deref(), Some("{\"iv\":\"a\",\"ct\":\"b\"}"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn gc_compacts_loose_objects_and_preserves_round_trip() {
        let base = std::env::temp_dir().join(format!("pluto-sync-gc-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let bare = base.join("origin.git");
        let work = base.join("clone");
        std::fs::create_dir_all(&bare).unwrap();
        bare_repo(&bare);
        let url = file_url(&bare);

        clone_or_open_at(&work, &url, None).unwrap();
        for i in 0..12 {
            push_at(
                &work,
                "SALT123".into(),
                format!("{{\"iv\":\"a\",\"ct\":\"{i}\"}}"),
                None,
            )
            .unwrap();
        }
        // Every push writes at least commit+tree loose objects; none are packed.
        let before = loose_object_count(&work);
        assert!(before >= 12, "expected loose objects to accumulate, got {before}");

        // Below threshold → no-op, nothing touched.
        assert!(!maybe_gc_at(&work, None, before + 1));
        assert_eq!(loose_object_count(&work), before);

        // At threshold → compacts (fresh clone receives packfiles, not loose).
        assert!(maybe_gc_at(&work, None, before));
        let after = loose_object_count(&work);
        assert!(after < before, "gc did not shrink loose objects: {before} -> {after}");

        // The swapped-in clone is fully functional: reads the latest state,
        // pushes on top of it, and a second fresh clone sees the post-gc push.
        let got = pull_at(&work, None).unwrap();
        assert_eq!(got.salt.as_deref(), Some("SALT123"));
        assert_eq!(got.blob.as_deref(), Some("{\"iv\":\"a\",\"ct\":\"11\"}"));
        push_at(
            &work,
            "SALT123".into(),
            "{\"iv\":\"a\",\"ct\":\"post-gc\"}".into(),
            None,
        )
        .unwrap();

        let work2 = base.join("clone2");
        clone_or_open_at(&work2, &url, None).unwrap();
        let got2 = pull_at(&work2, None).unwrap();
        assert_eq!(got2.blob.as_deref(), Some("{\"iv\":\"a\",\"ct\":\"post-gc\"}"));

        let _ = std::fs::remove_dir_all(&base);
    }

    // ── Hostile-remote guard (reject_non_regular) ───────────────────────────
    // The remote is the attacker here: it can commit any tree it likes, and
    // checkout materialises it. Each vector below is tested in the two-half
    // pattern commands.rs established — a SYMLINK half that is the only real
    // coverage of the escape (and only runs where the OS will make a link) and
    // a privilege-free DIRECTORY half that runs on every platform, so no box
    // runs a vacuous suite. See .github/workflows/test.yml: macos-latest
    // exists to execute the symlink halves Windows can never reach.

    const VICTIM: &str = "VICTIM BYTES - MUST SURVIVE\n";

    // (C) Copied verbatim from commands.rs (it is private to that module, so
    // it cannot be called from here). Windows refuses symlink creation without
    // Developer Mode or elevation, so a refusal there disables the symlink
    // half by the OS's choice; off Windows a refusal means the test was
    // disabled by accident instead, so it fails loudly.
    fn try_make_symlink(target: &std::path::Path, link: &std::path::Path) -> bool {
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(target, link).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(target, link).is_ok();
        #[cfg(not(windows))]
        assert!(
            made,
            "symlink creation must succeed off Windows: a silent skip leaves this test asserting nothing"
        );
        made
    }

    // Second gate, and not redundant with the first: the OS allowing a link
    // does not mean libgit2 WROTE one. libgit2 honours `core.symlinks`, which
    // it leaves off on Windows even under Developer Mode, and there a
    // mode-120000 entry lands as a plain file holding the target path — no
    // escape vector, nothing for the guard to prove. Off Windows the checkout
    // always links, so a miss is a broken test rather than a skipped one.
    fn checked_out_as_symlink(path: &std::path::Path) -> bool {
        let is_link = std::fs::symlink_metadata(path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        #[cfg(not(windows))]
        assert!(
            is_link,
            "checkout must materialise a mode-120000 entry as a real symlink off Windows"
        );
        is_link
    }

    /// Commit the hostile tree: `state.enc` as a mode-120000 blob whose content
    /// is `target`, and NO `salt`. The missing salt is load-bearing — it is what
    /// makes the client read the remote as empty, mint a fresh salt, encrypt the
    /// local settings and write the ciphertext straight through the link.
    fn hostile_symlink_repo(bare: &std::path::Path, target: &std::path::Path) {
        let repo = git2::Repository::init_bare(bare).unwrap();
        let blob = repo.blob(target.to_string_lossy().as_bytes()).unwrap();
        let mut tb = repo.treebuilder(None).unwrap();
        tb.insert("state.enc", blob, 0o120000).unwrap();
        let tree_id = tb.write().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = git2::Signature::now("Hostile Remote", "attacker@example.invalid").unwrap();
        repo.commit(Some("refs/heads/main"), &sig, &sig, "hostile", &tree, &[])
            .unwrap();
        repo.set_head("refs/heads/main").unwrap();
    }

    #[test]
    fn hostile_tree_with_a_symlinked_state_file_is_refused_on_pull() {
        let tmp = tempfile::tempdir().unwrap();
        let victim = tmp.path().join("victim.txt");
        std::fs::write(&victim, VICTIM).unwrap();
        let bare = tmp.path().join("origin.git");
        let work = tmp.path().join("clone");
        hostile_symlink_repo(&bare, &victim);

        // The clone itself must already refuse (guard call site 3), but the
        // checkout has happened by then, so the workdir is hostile either way.
        // The setup deliberately runs BEFORE the skip gates so that Windows,
        // which can never reach the assertions, still proves the hostile tree
        // commits and checks out — otherwise a broken fixture would only ever
        // surface on the macOS CI leg.
        let cloned = clone_or_open_at(&work, &file_url(&bare), None);
        assert!(work.join("state.enc").exists(), "hostile fixture did not check out");
        if !try_make_symlink(&victim, &tmp.path().join("probe.link"))
            || !checked_out_as_symlink(&work.join("state.enc"))
        {
            return; // Windows without symlink privilege: no escape vector exists.
        }
        assert!(cloned.is_err(), "a hostile first clone must be refused at once");

        let pulled = pull_at(&work, None);
        assert!(
            pulled.is_err(),
            "pull read through a symlink: {:?}",
            pulled.map(|p| p.blob)
        );
        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            VICTIM,
            "the victim file outside the workdir was touched"
        );
    }

    #[test]
    fn hostile_tree_with_a_symlinked_state_file_is_refused_on_push() {
        let tmp = tempfile::tempdir().unwrap();
        let victim = tmp.path().join("victim.txt");
        std::fs::write(&victim, VICTIM).unwrap();
        let bare = tmp.path().join("origin.git");
        let work = tmp.path().join("clone");
        hostile_symlink_repo(&bare, &victim);

        // Ignore the clone's own refusal so push_at is reached directly: this
        // is the same state a client reaches when the remote turns hostile
        // AFTER a healthy first clone.
        let _ = clone_or_open_at(&work, &file_url(&bare), None);
        assert!(work.join("state.enc").exists(), "hostile fixture did not check out");
        if !try_make_symlink(&victim, &tmp.path().join("probe.link"))
            || !checked_out_as_symlink(&work.join("state.enc"))
        {
            return;
        }

        let pushed = push_at(&work, "FRESH-SALT".into(), "CIPHERTEXT".into(), None);
        assert!(pushed.is_err(), "push wrote through a symlink");
        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            VICTIM,
            "the victim file was truncated and overwritten with ciphertext"
        );
    }

    /// Commit a hostile tree whose `state.enc` is a SUBTREE. Unlike the symlink
    /// fixture this needs no privilege and checks out as a real directory on
    /// every platform, so it is the one hostile shape every box can execute.
    fn hostile_dir_repo(bare: &std::path::Path) {
        let repo = git2::Repository::init_bare(bare).unwrap();
        let blob = repo.blob(b"x").unwrap();
        let mut inner = repo.treebuilder(None).unwrap();
        inner.insert("keep", blob, 0o100644).unwrap();
        let inner_id = inner.write().unwrap();
        let mut tb = repo.treebuilder(None).unwrap();
        tb.insert("state.enc", inner_id, 0o040000).unwrap();
        let tree_id = tb.write().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = git2::Signature::now("Hostile Remote", "attacker@example.invalid").unwrap();
        repo.commit(Some("refs/heads/main"), &sig, &sig, "hostile dir", &tree, &[])
            .unwrap();
        repo.set_head("refs/heads/main").unwrap();
    }

    #[test]
    fn hostile_tree_with_a_directory_at_state_enc_is_refused_at_clone() {
        // The clone-time guard's only coverage that does not skip: a SUBTREE
        // named `state.enc` checks out as a real directory on every platform,
        // Windows included, so the hostile-remote path is proven end to end
        // (commit -> clone -> refusal) even where no symlink can exist.
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        let work = tmp.path().join("clone");
        hostile_dir_repo(&bare);

        let cloned = clone_or_open_at(&work, &file_url(&bare), None);
        assert!(work.join("state.enc").is_dir(), "hostile fixture did not check out");
        assert_eq!(
            cloned.unwrap_err(),
            "sync repo: state.enc is not a regular file"
        );
    }

    #[test]
    fn a_directory_at_a_sync_path_is_refused() {
        // The privilege-free half, and it runs everywhere. It pins the guard's
        // OWN error string rather than a bare is_err, because reading or
        // writing over a directory fails at the OS anyway — is_err alone would
        // survive deleting the guard entirely. It cannot catch the FOLLOW-the-
        // link regression (swapping symlink_metadata for metadata); that is the
        // symlink halves' job alone.
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        let work = tmp.path().join("clone");
        std::fs::create_dir_all(&bare).unwrap();
        bare_repo(&bare);
        clone_or_open_at(&work, &file_url(&bare), None).unwrap();

        for name in ["state.enc", "salt"] {
            let path = work.join(name);
            let _ = std::fs::remove_file(&path);
            std::fs::create_dir_all(&path).unwrap();

            let pushed = push_at(&work, "S".into(), "B".into(), None);
            assert_eq!(
                pushed.unwrap_err(),
                format!("sync repo: {name} is not a regular file")
            );
            let pulled = pull_at(&work, None);
            assert_eq!(
                pulled.map(|p| (p.salt, p.blob)).unwrap_err(),
                format!("sync repo: {name} is not a regular file")
            );
            std::fs::remove_dir_all(&path).unwrap();
        }
    }

    #[test]
    fn a_healthy_tree_still_round_trips_with_the_guard_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        let work = tmp.path().join("clone");
        std::fs::create_dir_all(&bare).unwrap();
        bare_repo(&bare);
        let url = file_url(&bare);

        clone_or_open_at(&work, &url, None).unwrap();
        push_at(&work, "SALT123".into(), "{\"iv\":\"a\",\"ct\":\"b\"}".into(), None).unwrap();

        let work2 = tmp.path().join("clone2");
        clone_or_open_at(&work2, &url, None).unwrap();
        let got = pull_at(&work2, None).unwrap();
        assert_eq!(got.salt.as_deref(), Some("SALT123"));
        assert_eq!(got.blob.as_deref(), Some("{\"iv\":\"a\",\"ct\":\"b\"}"));
        for name in ["salt", "state.enc"] {
            assert!(std::fs::symlink_metadata(work2.join(name)).unwrap().is_file());
        }
        // And a second push on top of a checked-out healthy pair still works.
        push_at(&work2, "SALT123".into(), "{\"iv\":\"a\",\"ct\":\"c\"}".into(), None).unwrap();
    }

    // ── Stale-clone replacement (changing the configured repo URL) ──────────
    // The clone in app-data is a CACHE of the configured remote. When the two
    // disagree the cache is wrong, and keeping it is not merely stale: every
    // later sync fetches and pushes the old repository, and presents the newly
    // entered token to that old host.

    /// Read `origin` straight from disk with git2, deliberately NOT through the
    /// production helper: the assertions below must be able to fail on their own
    /// terms rather than compile-fail if the implementation is missing.
    fn origin_url(dir: &std::path::Path) -> Option<String> {
        let repo = git2::Repository::open(dir).ok()?;
        let remote = repo.find_remote("origin").ok()?;
        remote.url().map(|u| u.to_string())
    }

    #[test]
    fn switching_the_configured_repo_url_replaces_the_clone() {
        let tmp = tempfile::tempdir().unwrap();
        let bare_a = tmp.path().join("a.git");
        let bare_b = tmp.path().join("b.git");
        std::fs::create_dir_all(&bare_a).unwrap();
        std::fs::create_dir_all(&bare_b).unwrap();
        bare_repo(&bare_a);
        bare_repo(&bare_b);
        let url_a = file_url(&bare_a);
        let url_b = file_url(&bare_b);
        let work = tmp.path().join("clone");

        clone_or_open_at(&work, &url_a, None).unwrap();
        push_at(&work, "SALT-A".into(), "{\"iv\":\"a\",\"ct\":\"A\"}".into(), None).unwrap();

        // The user points sync at a different repository.
        clone_or_open_at(&work, &url_b, None).unwrap();
        assert_eq!(
            origin_url(&work).as_deref(),
            Some(url_b.as_str()),
            "the working clone still points at the OLD repository"
        );

        // B is empty, so a pull must report no state at all. Reading A's salt
        // here would mean the old clone is still the one being fetched.
        let got = pull_at(&work, None).unwrap();
        assert_eq!(got.salt, None, "pull still read the old repository's state");
        assert_eq!(got.blob, None);

        push_at(&work, "SALT-B".into(), "{\"iv\":\"b\",\"ct\":\"B\"}".into(), None).unwrap();

        // Nothing may have been written to the repository the user left.
        let check_a = tmp.path().join("check-a");
        clone_or_open_at(&check_a, &url_a, None).unwrap();
        let a = pull_at(&check_a, None).unwrap();
        assert_eq!(a.salt.as_deref(), Some("SALT-A"), "the old repo was written to");
        assert_eq!(a.blob.as_deref(), Some("{\"iv\":\"a\",\"ct\":\"A\"}"));

        // And the new repository really did receive the push.
        let check_b = tmp.path().join("check-b");
        clone_or_open_at(&check_b, &url_b, None).unwrap();
        let b = pull_at(&check_b, None).unwrap();
        assert_eq!(b.salt.as_deref(), Some("SALT-B"));
        assert_eq!(b.blob.as_deref(), Some("{\"iv\":\"b\",\"ct\":\"B\"}"));
    }

    #[test]
    fn an_unopenable_clone_directory_is_replaced_rather_than_failing() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        bare_repo(&bare);
        let url = file_url(&bare);
        let work = tmp.path().join("clone");

        // A `.git` that is not a repository: an interrupted first clone, a
        // half-restored backup, a cloud-drive copy. Propagating the open error
        // wedges sync until the user deletes app-data by hand.
        std::fs::create_dir_all(work.join(".git")).unwrap();
        std::fs::write(work.join(".git").join("junk"), b"not a repository").unwrap();

        clone_or_open_at(&work, &url, None).unwrap();
        assert_eq!(
            origin_url(&work).as_deref(),
            Some(url.as_str()),
            "an unopenable clone dir must be replaced with a working clone"
        );
        push_at(&work, "SALT".into(), "{\"iv\":\"a\",\"ct\":\"b\"}".into(), None).unwrap();
    }

    #[test]
    fn a_clone_with_no_origin_is_replaced() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        bare_repo(&bare);
        let url = file_url(&bare);
        let work = tmp.path().join("clone");

        // Opens fine, but has nothing to fetch from or push to, so every later
        // sync would die on find_remote("origin").
        git2::Repository::init(&work).unwrap();
        assert!(work.join(".git").exists());

        clone_or_open_at(&work, &url, None).unwrap();
        assert_eq!(origin_url(&work).as_deref(), Some(url.as_str()));
        push_at(&work, "SALT".into(), "{\"iv\":\"a\",\"ct\":\"b\"}".into(), None).unwrap();
    }

    #[test]
    fn an_unchanged_repo_url_does_not_re_clone() {
        // The other half of the fix: a URL that still matches must take the
        // fast path. Re-cloning on every sync would be a silent, expensive
        // regression, so a marker file inside the workdir is the witness.
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        bare_repo(&bare);
        let url = file_url(&bare);
        let work = tmp.path().join("clone");

        clone_or_open_at(&work, &url, None).unwrap();
        let marker = work.join("MARKER");
        std::fs::write(&marker, b"survivor").unwrap();

        clone_or_open_at(&work, &url, None).unwrap();
        assert!(marker.exists(), "an unchanged repo URL re-cloned the whole repo");
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "survivor");
    }

    // ── Redirect following (credential exfiltration via a hostile redirect) ──

    #[test]
    fn every_remote_options_object_disables_redirect_following() {
        // libgit2 follows an off-site redirect on the initial request by
        // default, and would present the user's PAT wherever that lands. git2
        // 0.19 gives `FetchOptions`/`PushOptions` a `follow_redirects` SETTER
        // and no getter, and the flag is only observable by running a real
        // redirecting server, so there is nothing a unit test can read back at
        // runtime. Pin it at the source level instead, the way
        // src/releaseWorkflow.test.js reads its own workflow file as text.
        //
        // What is actually pinned: this module builds its remote options in
        // exactly two places, and both disable redirects. A new call site that
        // reaches for the constructor directly, or a constructor that loses its
        // setting, breaks a count here.
        //
        // The needles are assembled at runtime from fragments so this test's own
        // text cannot satisfy the counts it is asserting.
        let src = include_str!("sync_git.rs");
        assert!(src.len() > 10_000, "the source pin read nothing useful");

        let fetch_new = format!("Fetch{}::new()", "Options");
        let push_new = format!("Push{}::new()", "Options");
        let no_redirect = format!("follow_redirects(git2::Remote{}::None)", "Redirect");

        assert_eq!(
            src.matches(&fetch_new).count(),
            1,
            "fetch options must be built in exactly one place, the constructor that disables redirects"
        );
        assert_eq!(
            src.matches(&push_new).count(),
            1,
            "push options must be built in exactly one place, the constructor that disables redirects"
        );
        assert_eq!(
            src.matches(&no_redirect).count(),
            2,
            "both option constructors must disable redirect following, and nothing else should need to"
        );
    }

    /// Make `<dir>.stale` a directory that genuinely cannot be emptied, which is
    /// what makes a rename onto it fail as well. Windows: a file inside it held
    /// open with share mode 0, so any delete hits a sharing violation (a plain
    /// `File::open` would NOT wedge anything, because std asks for
    /// FILE_SHARE_DELETE). Off Windows: a subdirectory with its write permission
    /// removed, so the file under it cannot be unlinked. The returned handle
    /// must be held for the duration.
    #[must_use]
    fn wedge_stale_dir(stale: &std::path::Path) -> Option<std::fs::File> {
        let held = stale.join("held");
        std::fs::create_dir_all(&held).unwrap();
        std::fs::write(held.join("handle"), b"x").unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            Some(
                std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0)
                    .open(held.join("handle"))
                    .unwrap(),
            )
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&held, std::fs::Permissions::from_mode(0o500)).unwrap();
            None
        }
    }

    /// Undo the wedge so the tempdir can clean itself up.
    fn unwedge_stale_dir(stale: &std::path::Path) {
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                std::fs::set_permissions(stale.join("held"), std::fs::Permissions::from_mode(0o700));
        }
        #[cfg(windows)]
        let _ = stale;
    }

    #[test]
    fn an_occupied_stale_path_does_not_wedge_discard_forever() {
        // discard_clone removes `<dir>.stale`, renames the live clone onto it,
        // then removes it. When that first removal cannot succeed, the rename
        // onto the still-occupied path cannot either, and the single-path
        // version then returned "could not replace stale sync repo clone" on
        // every later sync with no way for the app to recover.
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        bare_repo(&bare);
        let url = file_url(&bare);
        let work = tmp.path().join("clone");

        clone_or_open_at(&work, &url, None).unwrap();
        let stale = tmp.path().join("clone.stale");
        let held = wedge_stale_dir(&stale);

        // The wedge has to be real or nothing below proves anything, so it is
        // asserted rather than assumed: a platform where this stops failing
        // should break the test loudly instead of passing vacuously.
        assert!(
            std::fs::remove_dir_all(&stale).is_err(),
            "the fixture did not actually wedge the stale path"
        );
        assert!(stale.is_dir(), "the fixture's stale directory went away");

        discard_clone(&work).unwrap();
        assert!(
            !work.exists(),
            "a discarded clone must be gone, so an interrupted run clones fresh rather than trusting a half-removed tree"
        );
        assert!(
            stale.is_dir(),
            "the primary stale path was never freed, so the clone can only have moved to a fallback path"
        );

        // And the caller that drives it still self-heals end to end.
        clone_or_open_at(&work, &url, None).unwrap();
        push_at(&work, "SALT".into(), "{\"iv\":\"a\",\"ct\":\"b\"}".into(), None).unwrap();

        drop(held);
        unwedge_stale_dir(&stale);
    }

    #[test]
    fn gc_refuses_to_swap_in_a_hostile_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        let work = tmp.path().join("clone");
        hostile_dir_repo(&bare);

        // Ignore the clone-time refusal and keep the workdir it left behind:
        // that is the state an install is in when the remote turns hostile.
        let _ = clone_or_open_at(&work, &file_url(&bare), None);
        assert!(work.join("state.enc").is_dir(), "hostile fixture did not check out");

        // gc re-clones the same origin, so the hostile tree comes back with it.
        assert_eq!(
            gc_at(&work, None).unwrap_err(),
            "sync repo: state.enc is not a regular file"
        );
        assert!(work.join(".git").exists(), "a refused gc must leave the clone in place");
        assert!(
            !tmp.path().join("clone.gc-tmp").exists(),
            "a refused gc left its hostile tmp clone on disk"
        );
    }
}
