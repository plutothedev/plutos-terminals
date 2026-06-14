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

// ---------------------------------------------------------------------------
// Path-based helpers: the real git logic, decoupled from tauri::AppHandle so it
// can be unit-tested against a local bare repo over file:// URLs (no network).
// The #[tauri::command] fns below are thin wrappers that resolve repo_dir().
// ---------------------------------------------------------------------------

fn clone_or_open_at(dir: &Path, repo_url: &str, pat: Option<String>) -> Result<(), String> {
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

    if dir.join(".git").exists() {
        Repository::open(dir).map_err(|e| e.to_string())?;
        normalize_head(dir);
        return Ok(());
    }
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks(pat));
    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fo);
    match builder.clone(repo_url, dir) {
        Ok(_) => {
            normalize_head(dir);
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
        let mut fo = FetchOptions::new();
        fo.remote_callbacks(callbacks(pat));
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
    let salt = fs::read_to_string(dir.join("salt")).ok();
    let blob = fs::read_to_string(dir.join("state.enc")).ok();
    Ok(PullResult { salt, blob })
}

fn push_at(dir: &Path, salt: String, blob: String, pat: Option<String>) -> Result<(), String> {
    let repo = Repository::open(dir).map_err(|e| e.to_string())?;
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
    let mut po = PushOptions::new();
    po.remote_callbacks(callbacks(pat));
    remote
        .push(&[&format!("refs/heads/{BRANCH}:refs/heads/{BRANCH}")], Some(&mut po))
        .map_err(|e| format!("push failed (pull first?): {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn sync_clone_or_open(
    app: tauri::AppHandle,
    repo_url: String,
    pat: Option<String>,
) -> Result<(), String> {
    clone_or_open_at(&repo_dir(&app)?, &repo_url, pat)
}

#[tauri::command]
pub async fn sync_pull(
    app: tauri::AppHandle,
    pat: Option<String>,
) -> Result<PullResult, String> {
    pull_at(&repo_dir(&app)?, pat)
}

#[tauri::command]
pub async fn sync_push(
    app: tauri::AppHandle,
    salt: String,
    blob: String,
    pat: Option<String>,
) -> Result<(), String> {
    push_at(&repo_dir(&app)?, salt, blob, pat)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // libgit2 on Windows wants file:///C:/... (three slashes) for absolute paths.
        let url = format!("file:///{}", bare.to_string_lossy().replace('\\', "/"));

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
}
