# Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync portable config (workflows, themes, keybindings, settings, macros) across a user's machines through a BYO private git repo, end-to-end encrypted, with field-level merge — no backend to host.

**Architecture:** Three layers. JS sync core (`src/features/terminals/sync/`) owns the synced surface, plaintext field-merge, AES-GCM crypto, and the orchestration state machine. Rust transport (`src-tauri/src/sync_git.rs`) wraps git2/libgit2 and moves two opaque files (`salt`, `state.enc`). UI (`SyncSection.jsx`) lives in SettingsModal. Secrets (passphrase, PAT) go to the OS keychain via the existing `vault::secret_*` commands; API keys are excluded at the source and never sync.

**Tech Stack:** React/Vite frontend, Tauri v2 / Rust backend, WebCrypto (AES-256-GCM, PBKDF2-600k), git2 (vendored-libgit2 + ssh, reusing the `ssh2` vendored-openssl), vitest for JS unit tests.

**Spec:** `docs/superpowers/specs/2026-06-13-cloud-sync-design.md`

---

## File Structure

**Create:**
- `src/features/terminals/sync/crypto.js` — PBKDF2→AES-GCM encrypt/decrypt.
- `src/features/terminals/sync/merge.js` — pure field-level 3-way merge.
- `src/features/terminals/sync/syncState.js` — synced-surface extract/apply + field list.
- `src/features/terminals/sync/syncEngine.js` — orchestration state machine.
- `src/features/terminals/sync/syncSecrets.js` — keychain helpers for passphrase + PAT.
- `src/features/terminals/SyncSection.jsx` — Settings UI.
- `src-tauri/src/sync_git.rs` — git2 transport + Tauri commands.
- Test files: `crypto.test.js`, `merge.test.js`, `syncState.test.js` beside their modules; `vitest.config.js` at repo root.

**Modify:**
- `package.json` — add vitest devDep + `test` script.
- `src/App.jsx:184` — stamp `_syncMeta` in `saveUser`; boot the engine in the primary window.
- `src/components/SettingsModal.jsx` — render `SyncSection`.
- `src-tauri/Cargo.toml` — add `git2`.
- `src-tauri/src/lib.rs` — `mod sync_git;` + register commands in `generate_handler!`.

---

### Task 0: Test runner (vitest)

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`

- [ ] **Step 1: Add vitest + script**

Run:
```bash
npm install -D vitest@^2
```

Then edit `package.json` `"scripts"` to add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Create vitest config**

Create `vitest.config.js`:
```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.js"],
  },
});
```

- [ ] **Step 3: Smoke test it runs**

Create `src/features/terminals/sync/smoke.test.js`:
```js
import { test, expect } from "vitest";
test("vitest runs", () => { expect(1 + 1).toBe(2); });
```

Run: `npm test`
Expected: 1 passing test.

- [ ] **Step 4: Delete smoke test, commit**

```bash
rm src/features/terminals/sync/smoke.test.js
git add package.json package-lock.json vitest.config.js
git commit -m "test: add vitest runner"
```

---

### Task 1: crypto.js (PBKDF2 → AES-256-GCM)

**Files:**
- Create: `src/features/terminals/sync/crypto.js`
- Test: `src/features/terminals/sync/crypto.test.js`

The renderer's WebCrypto needs a real `crypto.subtle`; Node 20+ provides `globalThis.crypto`. Tests run in the `node` environment configured in Task 0.

- [ ] **Step 1: Write the failing test**

Create `src/features/terminals/sync/crypto.test.js`:
```js
import { test, expect } from "vitest";
import { newSalt, encrypt, decrypt } from "./crypto.js";

test("round-trips plaintext", async () => {
  const salt = newSalt();
  const blob = await encrypt("hello world", "passphrase", salt);
  expect(blob.iv).toBeTruthy();
  expect(blob.ct).toBeTruthy();
  const out = await decrypt(blob, "passphrase", salt);
  expect(out).toBe("hello world");
});

test("rejects wrong passphrase", async () => {
  const salt = newSalt();
  const blob = await encrypt("secret", "right", salt);
  await expect(decrypt(blob, "wrong", salt)).rejects.toThrow();
});

test("uses a fresh IV per encrypt", async () => {
  const salt = newSalt();
  const a = await encrypt("x", "p", salt);
  const b = await encrypt("x", "p", salt);
  expect(a.iv).not.toBe(b.iv);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- crypto`
Expected: FAIL — cannot resolve `./crypto.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/features/terminals/sync/crypto.js`:
```js
// (C)
// End-to-end encryption for the cloud-sync blob. PBKDF2-600k derives an
// AES-256-GCM key from the user's dedicated sync passphrase; a random 96-bit IV
// is generated per encrypt. The GCM auth tag makes a wrong passphrase fail
// closed (decrypt throws) rather than returning garbage. Mirrors the PBKDF2
// parameters used by masterPassword.js.
const PBKDF2_ITERS = 600000;
const subtle = globalThis.crypto.subtle;

function toB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A fresh random 16-byte salt, base64. Stored per-repo alongside the blob. */
export function newSalt() {
  return toB64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

async function deriveKey(passphrase, saltB64) {
  const keyMat = await subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return subtle.deriveKey(
    { name: "PBKDF2", salt: fromB64(saltB64), iterations: PBKDF2_ITERS, hash: "SHA-256" },
    keyMat,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt a UTF-8 string. Returns { iv, ct } (both base64). */
export async function encrypt(plaintext, passphrase, saltB64) {
  const key = await deriveKey(passphrase, saltB64);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** Decrypt a { iv, ct } blob. Throws if the passphrase/salt are wrong. */
export async function decrypt(blob, passphrase, saltB64) {
  const key = await deriveKey(passphrase, saltB64);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(blob.iv) },
    key,
    fromB64(blob.ct)
  );
  return new TextDecoder().decode(pt);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- crypto`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/terminals/sync/crypto.js src/features/terminals/sync/crypto.test.js
git commit -m "feat(sync): AES-GCM crypto core"
```

---

### Task 2: merge.js (field-level 3-way merge)

**Files:**
- Create: `src/features/terminals/sync/merge.js`
- Test: `src/features/terminals/sync/merge.test.js`

Merge operates on a normalized shape: `{ fields: {k:v}, fieldMeta: {k:ts}, collections: { name: [{id, _updatedAt, _deletedAt?}] } }`. `_deletedAt` marks a tombstone. TTL for tombstone GC = 90 days in ms.

- [ ] **Step 1: Write the failing test**

Create `src/features/terminals/sync/merge.test.js`:
```js
import { test, expect } from "vitest";
import { merge, TOMBSTONE_TTL_MS } from "./merge.js";

const base = () => ({ fields: {}, fieldMeta: {}, collections: {} });

test("scalar: newer timestamp wins", () => {
  const local = { ...base(), fields: { skin: "oled" }, fieldMeta: { skin: 200 } };
  const remote = { ...base(), fields: { skin: "light" }, fieldMeta: { skin: 100 } };
  const { merged } = merge(local, remote);
  expect(merged.fields.skin).toBe("oled");
});

test("scalar: remote newer wins and flags changedLocally", () => {
  const local = { ...base(), fields: { skin: "oled" }, fieldMeta: { skin: 100 } };
  const remote = { ...base(), fields: { skin: "light" }, fieldMeta: { skin: 200 } };
  const { merged, changedLocally } = merge(local, remote);
  expect(merged.fields.skin).toBe("light");
  expect(changedLocally).toBe(true);
});

test("collection: union by id, newer item wins on collision", () => {
  const local = { ...base(), collections: { workflows: [{ id: "a", _updatedAt: 50, name: "L" }] } };
  const remote = { ...base(), collections: { workflows: [
    { id: "a", _updatedAt: 99, name: "R" },
    { id: "b", _updatedAt: 10, name: "B" },
  ] } };
  const { merged } = merge(local, remote);
  const wf = merged.collections.workflows;
  expect(wf.find((x) => x.id === "a").name).toBe("R");
  expect(wf.find((x) => x.id === "b")).toBeTruthy();
});

test("collection: tombstone is not resurrected by a stale copy", () => {
  const local = { ...base(), collections: { workflows: [{ id: "a", _updatedAt: 200, _deletedAt: 200 }] } };
  const remote = { ...base(), collections: { workflows: [{ id: "a", _updatedAt: 50, name: "stale" }] } };
  const { merged } = merge(local, remote);
  expect(merged.collections.workflows.find((x) => x.id === "a")._deletedAt).toBe(200);
});

test("collection: tombstone past TTL is garbage-collected", () => {
  const now = 1_000_000_000_000;
  const old = now - TOMBSTONE_TTL_MS - 1;
  const local = { ...base(), collections: { workflows: [{ id: "a", _updatedAt: old, _deletedAt: old }] } };
  const remote = base();
  const { merged } = merge(local, remote, now);
  expect(merged.collections.workflows.find((x) => x.id === "a")).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- merge`
Expected: FAIL — cannot resolve `./merge.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/features/terminals/sync/merge.js`:
```js
// (C)
// Pure field-level 3-way merge for cloud sync. No I/O. Scalars resolve by
// per-field timestamp (newest wins); collections union by id (newest item wins
// on collision) with delete tombstones that survive stale copies. Returns
// { merged, changedLocally } so the engine knows whether applying a pulled
// remote changed local state (→ schedule a re-push).
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function mergeScalars(local, remote, result) {
  const keys = new Set([...Object.keys(local.fields), ...Object.keys(remote.fields)]);
  let changed = false;
  for (const k of keys) {
    const lt = local.fieldMeta[k] ?? -Infinity;
    const rt = remote.fieldMeta[k] ?? -Infinity;
    if (rt > lt) {
      result.fields[k] = remote.fields[k];
      result.fieldMeta[k] = rt;
      changed = true;
    } else {
      if (k in local.fields) result.fields[k] = local.fields[k];
      result.fieldMeta[k] = Math.max(lt === -Infinity ? rt : lt, -Infinity);
      if (result.fieldMeta[k] === -Infinity) delete result.fieldMeta[k];
    }
  }
  return changed;
}

function mergeCollection(localArr, remoteArr, now) {
  const byId = new Map();
  let changed = false;
  for (const item of localArr || []) byId.set(item.id, item);
  for (const item of remoteArr || []) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      changed = true;
    } else if ((item._updatedAt ?? 0) > (existing._updatedAt ?? 0)) {
      byId.set(item.id, item);
      changed = true;
    }
  }
  const out = [];
  for (const item of byId.values()) {
    if (item._deletedAt && now - item._deletedAt > TOMBSTONE_TTL_MS) continue; // GC
    out.push(item);
  }
  return { out, changed };
}

/** Merge local and remote normalized surfaces. `now` is injectable for tests. */
export function merge(local, remote, now = Date.now()) {
  const result = { fields: {}, fieldMeta: {}, collections: {} };
  let changedLocally = mergeScalars(local, remote, result);

  const names = new Set([
    ...Object.keys(local.collections || {}),
    ...Object.keys(remote.collections || {}),
  ]);
  for (const name of names) {
    const { out, changed } = mergeCollection(
      local.collections?.[name],
      remote.collections?.[name],
      now
    );
    result.collections[name] = out;
    if (changed) changedLocally = true;
  }
  return { merged: result, changedLocally };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- merge`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/terminals/sync/merge.js src/features/terminals/sync/merge.test.js
git commit -m "feat(sync): field-level merge with tombstones"
```

---

### Task 3: syncState.js (synced-surface extract/apply)

**Files:**
- Create: `src/features/terminals/sync/syncState.js`
- Test: `src/features/terminals/sync/syncState.test.js`

Defines exactly what syncs. Scalars listed in `SYNCED_FIELDS`; id-keyed collections in `SYNCED_COLLECTIONS`. `extractSynced` reads the live user-prefs object + its `_syncMeta` map into the normalized merge shape, **never reading `providerKeys`/`anthropicKey`**. `applySynced` writes a merged surface back, preserving all non-synced fields.

- [ ] **Step 1: Write the failing test**

Create `src/features/terminals/sync/syncState.test.js`:
```js
import { test, expect } from "vitest";
import { extractSynced, applySynced, SYNCED_FIELDS } from "./syncState.js";

test("extract excludes provider keys", () => {
  const userSt = {
    headerSkin: "oled",
    providerKeys: { anthropic: "sk-xxx" },
    anthropicKey: "sk-yyy",
    _syncMeta: { headerSkin: 123 },
  };
  const surface = extractSynced(userSt);
  expect(JSON.stringify(surface)).not.toContain("sk-xxx");
  expect(JSON.stringify(surface)).not.toContain("sk-yyy");
  expect(surface.fields.headerSkin).toBe("oled");
  expect(surface.fieldMeta.headerSkin).toBe(123);
});

test("apply preserves non-synced fields", () => {
  const userSt = { headerSkin: "oled", providerKeys: { anthropic: "k" }, _syncMeta: {} };
  const merged = { fields: { headerSkin: "light" }, fieldMeta: { headerSkin: 9 }, collections: {} };
  const next = applySynced(userSt, merged);
  expect(next.headerSkin).toBe("light");
  expect(next.providerKeys.anthropic).toBe("k"); // untouched
  expect(next._syncMeta.headerSkin).toBe(9);
});

test("SYNCED_FIELDS never includes key fields", () => {
  expect(SYNCED_FIELDS).not.toContain("providerKeys");
  expect(SYNCED_FIELDS).not.toContain("anthropicKey");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- syncState`
Expected: FAIL — cannot resolve `./syncState.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/features/terminals/sync/syncState.js`:
```js
// (C)
// The synced surface: the single source of truth for WHAT cloud-sync touches.
// Portable config only. API keys (providerKeys/anthropicKey) and per-window
// workspace layout are excluded AT THE SOURCE — extractSynced never reads them,
// so a leak can't happen by a later filter being forgotten. The per-field
// timestamp map lives in userSt._syncMeta (stamped in App.saveUser).

// Scalar preference fields that participate in sync.
export const SYNCED_FIELDS = [
  "headerSkin",
  "themeFollowOS",
  "themeDark",
  "themeLight",
  "keybindings",
  "activeModel",
  "welcomeDone",
  "promptEditor",
];

// Id-keyed collections. Each maps userSt key -> array of {id, _updatedAt, ...}.
export const SYNCED_COLLECTIONS = ["workflows", "customThemes", "macros"];

const META_KEY = "_syncMeta";

/** Read the synced surface out of a live user-prefs object into merge shape. */
export function extractSynced(userSt = {}) {
  const meta = userSt[META_KEY] || {};
  const fields = {};
  const fieldMeta = {};
  for (const k of SYNCED_FIELDS) {
    if (k in userSt) {
      fields[k] = userSt[k];
      if (k in meta) fieldMeta[k] = meta[k];
    }
  }
  const collections = {};
  for (const name of SYNCED_COLLECTIONS) {
    const arr = userSt[name];
    if (Array.isArray(arr)) collections[name] = arr;
  }
  return { fields, fieldMeta, collections };
}

/** Write a merged surface back, preserving every non-synced field. */
export function applySynced(userSt = {}, merged) {
  const next = { ...userSt };
  for (const k of Object.keys(merged.fields)) next[k] = merged.fields[k];
  for (const name of SYNCED_COLLECTIONS) {
    if (merged.collections[name]) next[name] = merged.collections[name];
  }
  next[META_KEY] = { ...(userSt[META_KEY] || {}), ...merged.fieldMeta };
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- syncState`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/terminals/sync/syncState.js src/features/terminals/sync/syncState.test.js
git commit -m "feat(sync): synced-surface extract/apply"
```

---

### Task 4: Stamp `_syncMeta` in saveUser

**Files:**
- Modify: `src/App.jsx:184` (the `saveUser` callback)

When a synced scalar field changes, stamp its `updatedAt` so merges resolve correctly. Done at the `saveUser` choke-point so no caller needs sync awareness. Collections carry their own per-item `_updatedAt` (added when items are created/edited — out of scope here; existing collection writers stamp on save in a follow-up, but new items default to `Date.now()` via the engine's normalize step in Task 7).

- [ ] **Step 1: Add the stamping helper import**

At the top of `src/App.jsx`, add to the existing imports:
```js
import { SYNCED_FIELDS } from "./features/terminals/sync/syncState.js";
```

- [ ] **Step 2: Stamp changed synced fields in saveUser**

Replace the `saveUser` callback body (currently `App.jsx:184`):
```js
  const saveUser = useCallback((next) => {
    const prev = userStRef.current;
    const resolved = typeof next === "function" ? next(prev) : next;
    // Stamp _syncMeta for any synced scalar field whose value changed, so cloud
    // sync can resolve cross-machine conflicts by newest-wins per field.
    const meta = { ...(resolved._syncMeta || {}) };
    let stamped = false;
    for (const k of SYNCED_FIELDS) {
      if (resolved[k] !== prev?.[k]) { meta[k] = Date.now(); stamped = true; }
    }
    const final = stamped ? { ...resolved, _syncMeta: meta } : resolved;
    userStRef.current = final;
    setUserSt(final);
    writeUserState(final);
  }, []);
```

- [ ] **Step 3: Verify the app still builds**

Run: `npm run build`
Expected: build succeeds, no import errors.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "feat(sync): stamp _syncMeta on synced-field changes"
```

---

### Task 5: Rust git transport (sync_git.rs)

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/sync_git.rs`

Wraps git2/libgit2. The repo holds exactly two files: `salt` and `state.enc`. Auth via credential callback: HTTPS PAT (passed from JS, read from keychain) or SSH agent.

- [ ] **Step 1: Add the git2 dependency**

In `src-tauri/Cargo.toml`, under `[dependencies]`, add:
```toml
git2 = { version = "0.19", default-features = false, features = ["vendored-libgit2", "vendored-openssl", "ssh"] }
```

- [ ] **Step 2: Write sync_git.rs**

Create `src-tauri/src/sync_git.rs`:
```rust
// (C)
// Cloud-sync git transport. The app keeps a clone in the app-data dir holding
// exactly two opaque files: `salt` (base64) and `state.enc` (JSON {iv,ct}).
// All encryption happens in the renderer; this layer never sees plaintext.
use std::fs;
use std::path::PathBuf;
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
            // GitHub/GitLab PAT: username can be the token or anything non-empty.
            return Cred::userpass_plaintext(username.unwrap_or("git"), token);
        }
        Cred::default()
    });
    cb
}

#[tauri::command]
pub async fn sync_clone_or_open(
    app: tauri::AppHandle,
    repo_url: String,
    pat: Option<String>,
) -> Result<(), String> {
    let dir = repo_dir(&app)?;
    if dir.join(".git").exists() {
        Repository::open(&dir).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks(pat));
    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fo);
    // Empty remote → clone yields a repo with no commits; that's fine.
    match builder.clone(&repo_url, &dir) {
        Ok(_) => Ok(()),
        Err(e) if e.code() == git2::ErrorCode::NotFound => {
            // Bare/empty remote with no branches: init locally + set remote.
            let repo = Repository::init(&dir).map_err(|x| x.to_string())?;
            repo.remote("origin", &repo_url).map_err(|x| x.to_string())?;
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn sync_pull(
    app: tauri::AppHandle,
    pat: Option<String>,
) -> Result<PullResult, String> {
    let dir = repo_dir(&app)?;
    let repo = Repository::open(&dir).map_err(|e| e.to_string())?;
    {
        let mut remote = repo.find_remote("origin").map_err(|e| e.to_string())?;
        let mut fo = FetchOptions::new();
        fo.remote_callbacks(callbacks(pat));
        // Ignore fetch error when remote has no branches yet.
        let _ = remote.fetch(&[BRANCH], Some(&mut fo), None);
    }
    // Fast-forward main to origin/main if it exists.
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

#[tauri::command]
pub async fn sync_push(
    app: tauri::AppHandle,
    salt: String,
    blob: String,
    pat: Option<String>,
) -> Result<(), String> {
    let dir = repo_dir(&app)?;
    let repo = Repository::open(&dir).map_err(|e| e.to_string())?;
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
```

- [ ] **Step 3: Verify it compiles**

Set the build env first (Strawberry Perl + vcvars64 — see `docs` build notes / the build memory), then:
Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles. If openssl-sys double-builds, drop `vendored-openssl` from the git2 features (ssh2 already vendors it).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/sync_git.rs
git commit -m "feat(sync): git2 transport (clone/pull/push)"
```

---

### Task 6: Register the Rust commands

**Files:**
- Modify: `src-tauri/src/lib.rs` (the `mod` block and `generate_handler!` at `lib.rs:204`)

- [ ] **Step 1: Declare the module**

Near the other `mod` declarations at the top of `src-tauri/src/lib.rs`, add:
```rust
mod sync_git;
```

- [ ] **Step 2: Register the three commands**

In `generate_handler![ ... ]` (starts `lib.rs:204`), after the `vault::secret_delete` line, add:
```rust
            sync_git::sync_clone_or_open,
            sync_git::sync_pull,
            sync_git::sync_push,
```

- [ ] **Step 3: Verify it compiles**

Run (with build env): `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles, no "command not found in handler" warnings.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(sync): register git transport commands"
```

---

### Task 7: syncSecrets.js + syncEngine.js (orchestrator)

**Files:**
- Create: `src/features/terminals/sync/syncSecrets.js`
- Create: `src/features/terminals/sync/syncEngine.js`

`syncSecrets.js` stores the passphrase + PAT in the keychain (accounts `sync-passphrase:v0`, `sync-git-pat:v0`) via the existing `vault::secret_*` commands. The engine config (repo URL, enabled flag — non-secret) lives in `userSt.sync`.

- [ ] **Step 1: Write syncSecrets.js**

Create `src/features/terminals/sync/syncSecrets.js`:
```js
// (C)
// Keychain-backed secrets for cloud sync. The passphrase and the git PAT NEVER
// touch localStorage or the repo — only the OS keychain, via the same vault
// commands SSH creds use. Non-secret config (repo URL, enabled) lives in
// userSt.sync.
import { invoke } from "../../backend.js";

const PASS_ACCOUNT = "sync-passphrase:v0";
const PAT_ACCOUNT = "sync-git-pat:v0";

export async function setPassphrase(p) {
  await invoke("secret_set", { account: PASS_ACCOUNT, secret: p });
}
export async function getPassphrase() {
  return (await invoke("secret_get", { account: PASS_ACCOUNT })) || null;
}
export async function setPat(p) {
  await invoke("secret_set", { account: PAT_ACCOUNT, secret: p || "" });
}
export async function getPat() {
  return (await invoke("secret_get", { account: PAT_ACCOUNT })) || null;
}
```

- [ ] **Step 2: Write syncEngine.js**

Create `src/features/terminals/sync/syncEngine.js`:
```js
// (C)
// Cloud-sync orchestrator. Owns the pull/merge/push state machine. Pure-ish:
// all I/O goes through injected backend invoke + getUserSt/saveUser callbacks so
// it can be reasoned about and (later) tested. Primary-window gated by the
// caller. See docs/superpowers/specs/2026-06-13-cloud-sync-design.md.
import { invoke } from "../../backend.js";
import { encrypt, decrypt, newSalt } from "./crypto.js";
import { merge } from "./merge.js";
import { extractSynced, applySynced } from "./syncState.js";
import { getPassphrase, getPat } from "./syncSecrets.js";

const PUSH_DEBOUNCE_MS = 4000;
const POLL_MS = 5 * 60 * 1000;

let timer = null;
let poll = null;
let busy = false;
let listeners = new Set();

let cfg = { getUserSt: null, saveUser: null, getRepoUrl: null, setStatus: () => {} };

export function configure(opts) {
  cfg = { ...cfg, ...opts };
}

function status(s) {
  cfg.setStatus(s);
  for (const l of listeners) l(s);
}
export function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Read remote, decrypt, merge into local, apply, and re-push if local was newer.
async function pullMerge(pass, pat) {
  const res = await invoke("sync_pull", { pat });
  const localSurface = extractSynced(cfg.getUserSt());
  let remoteSurface = { fields: {}, fieldMeta: {}, collections: {} };
  let salt = res.salt;
  if (res.salt && res.blob) {
    const plain = await decrypt(JSON.parse(res.blob), pass, res.salt); // throws on wrong pass
    remoteSurface = JSON.parse(plain);
  }
  const { merged, changedLocally } = merge(localSurface, remoteSurface);
  if (changedLocally) {
    cfg.saveUser((prev) => applySynced(prev, merged));
  }
  return { merged, salt: salt || newSalt() };
}

async function doPush(pass, pat, merged, salt) {
  const plain = JSON.stringify(merged);
  const blob = await encrypt(plain, pass, salt);
  await invoke("sync_push", { salt, blob: JSON.stringify(blob), pat });
}

/** Full sync: clone-or-open, pull-merge, push. Safe to call repeatedly. */
export async function syncNow() {
  if (busy) return;
  const repoUrl = cfg.getRepoUrl();
  const pass = await getPassphrase();
  if (!repoUrl || !pass) { status({ state: "disabled" }); return; }
  const pat = await getPat();
  busy = true;
  status({ state: "syncing" });
  try {
    await invoke("sync_clone_or_open", { repoUrl, pat });
    let { merged, salt } = await pullMerge(pass, pat);
    try {
      await doPush(pass, pat, merged, salt);
    } catch (e) {
      // Non-fast-forward → remote moved. Re-pull-merge once, retry.
      ({ merged, salt } = await pullMerge(pass, pat));
      await doPush(pass, pat, merged, salt);
    }
    status({ state: "ok", at: Date.now() });
  } catch (e) {
    const msg = String(e);
    const wrongPass = msg.includes("operation-specific") || msg.toLowerCase().includes("decrypt");
    status({ state: wrongPass ? "bad-passphrase" : "error", msg });
  } finally {
    busy = false;
  }
}

/** Debounced push after a local change. */
export function notifyChange() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { syncNow(); }, PUSH_DEBOUNCE_MS);
}

/** Boot: pull immediately, then poll periodically. Returns a stop fn. */
export function start() {
  syncNow();
  poll = setInterval(() => { syncNow(); }, POLL_MS);
  return () => { if (poll) clearInterval(poll); if (timer) clearTimeout(timer); };
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: succeeds (no missing imports).

- [ ] **Step 4: Commit**

```bash
git add src/features/terminals/sync/syncSecrets.js src/features/terminals/sync/syncEngine.js
git commit -m "feat(sync): keychain secrets + orchestration engine"
```

---

### Task 8: SyncSection.jsx (Settings UI)

**Files:**
- Create: `src/features/terminals/SyncSection.jsx`
- Modify: `src/components/SettingsModal.jsx`

Follows the existing section pattern (`KeybindingsSection.jsx` / `ThemesSection.jsx`: default-export component taking `userSt, saveUser`).

- [ ] **Step 1: Write SyncSection.jsx**

Create `src/features/terminals/SyncSection.jsx`:
```jsx
// (C)
// Cloud Sync settings: repo URL + auth (PAT/SSH), dedicated passphrase, enable
// toggle, Sync now, status. Secrets go to the keychain via syncSecrets; only the
// repo URL + enabled flag persist in userSt.sync.
import { useEffect, useState } from "react";
import { setPassphrase, setPat, getPassphrase } from "./sync/syncSecrets.js";
import { syncNow, onStatus } from "./sync/syncEngine.js";

export default function SyncSection({ userSt, saveUser }) {
  const sync = userSt.sync || {};
  const [repoUrl, setRepoUrl] = useState(sync.repoUrl || "");
  const [pass, setPass] = useState("");
  const [pat, setPatVal] = useState("");
  const [status, setStatus] = useState({ state: "idle" });
  const [hasPass, setHasPass] = useState(false);

  useEffect(() => onStatus(setStatus), []);
  useEffect(() => { getPassphrase().then((p) => setHasPass(!!p)); }, []);

  async function enable() {
    if (pass) await setPassphrase(pass);
    if (pat) await setPat(pat);
    saveUser((prev) => ({ ...prev, sync: { ...prev.sync, repoUrl, enabled: true } }));
    setPass(""); setPatVal("");
    setHasPass(true);
    syncNow();
  }
  function disable() {
    saveUser((prev) => ({ ...prev, sync: { ...prev.sync, enabled: false } }));
  }

  const label = {
    idle: "Not synced", disabled: "Disabled", syncing: "Syncing…",
    ok: "Synced", error: "Error", "bad-passphrase": "Passphrase mismatch",
  }[status.state] || status.state;

  return (
    <div className="settings-section">
      <h3>Cloud Sync</h3>
      <p className="muted">
        End-to-end encrypted. Syncs workflows, themes, keybindings, settings, and
        macros across your machines via a private git repo you control. API keys
        never sync.
      </p>
      <label>Repo URL
        <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)}
               placeholder="https://github.com/you/pluto-sync.git" />
      </label>
      <label>Sync passphrase {hasPass && <span className="muted">(saved)</span>}
        <input type="password" value={pass} onChange={(e) => setPass(e.target.value)}
               placeholder={hasPass ? "•••••• (enter to change)" : "choose a passphrase"} />
      </label>
      <label>Access token (HTTPS) — leave blank for SSH
        <input type="password" value={pat} onChange={(e) => setPatVal(e.target.value)}
               placeholder="ghp_… (stored in keychain)" />
      </label>
      <div className="row">
        {sync.enabled
          ? <button onClick={disable}>Disable sync</button>
          : <button onClick={enable} disabled={!repoUrl || (!pass && !hasPass)}>Enable sync</button>}
        <button onClick={() => syncNow()} disabled={!sync.enabled}>Sync now</button>
        <span className="muted">{label}{status.at ? ` · ${new Date(status.at).toLocaleTimeString()}` : ""}</span>
      </div>
      {status.state === "bad-passphrase" &&
        <p className="error">That passphrase doesn't match this sync repo.</p>}
      {status.state === "error" && <p className="error">{status.msg}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Render it in SettingsModal**

In `src/components/SettingsModal.jsx`, add the import at the top:
```js
import SyncSection from "../features/terminals/SyncSection.jsx";
```
Then render it alongside the other sections (e.g. after the keybindings/themes sections), passing the props the modal already receives:
```jsx
<SyncSection userSt={userSt} saveUser={saveUser} />
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/features/terminals/SyncSection.jsx src/components/SettingsModal.jsx
git commit -m "feat(sync): settings UI section"
```

---

### Task 9: Boot the engine in the primary window

**Files:**
- Modify: `src/App.jsx`

Wire the engine: configure it with live getters/setters and start it on boot when sync is enabled, primary-window only.

- [ ] **Step 1: Add imports**

In `src/App.jsx`, add:
```js
import { configure as configureSync, start as startSync, notifyChange } from "./features/terminals/sync/syncEngine.js";
import { isPrimaryWindow } from "./features/terminals/storageKeys.js";
```

- [ ] **Step 2: Configure + start on boot**

Add an effect in the `App` component (after `saveUser` is defined):
```js
  useEffect(() => {
    if (!isPrimaryWindow()) return;            // background sync = primary only
    configureSync({
      getUserSt: () => userStRef.current,
      saveUser,
      getRepoUrl: () => userStRef.current?.sync?.repoUrl,
      setStatus: () => {},
    });
    if (userStRef.current?.sync?.enabled) {
      const stop = startSync();
      return stop;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 3: Trigger debounced push on synced changes**

In the `saveUser` callback (modified in Task 4), after `writeUserState(final);`, add the change notification when a synced field was stamped:
```js
    if (stamped && isPrimaryWindow() && final?.sync?.enabled) notifyChange();
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat(sync): boot engine + push on change (primary window)"
```

---

### Task 10: Live dev verification

**Files:** none (manual verification in a dev instance).

- [ ] **Step 1: Create a test sync repo**

Create an empty private repo on GitHub (e.g. `pluto-sync`) and a PAT with `repo` scope, OR a local bare repo for offline testing:
```bash
git init --bare /tmp/pluto-sync.git
```

- [ ] **Step 2: Run two dev instances against the same repo**

Start the app (build env per build notes): `npm run tauri dev`.
Open Settings → Cloud Sync. Enter the repo URL, a passphrase, (PAT if HTTPS). Enable. Confirm status reaches "Synced".

- [ ] **Step 3: Verify round-trip**

On instance A: change a keybinding or add a workflow. Within ~5s + a poll, on instance B (second app-data dir / second machine): confirm the change appears after a Sync now.

- [ ] **Step 4: Verify the negatives**

- Inspect the repo: it contains only `salt` + `state.enc`; `state.enc` is ciphertext (no plaintext config, no API keys).
- Enter a wrong passphrase on a fresh machine → status "Passphrase mismatch", local config untouched.
- Confirm `providerKeys` did NOT sync (keys differ per machine, stay in keychain).

- [ ] **Step 5: Commit notes / bump if shipping an MSI**

If shipping at a milestone, bump version in `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `package.json`, update CHANGELOG, build `--bundles msi`.

---

## Self-Review

**Spec coverage:**
- BYO git transport → Task 5/6. ✓
- E2E AES-GCM + PBKDF2-600k → Task 1. ✓
- Field-level merge + tombstones + GC → Task 2. ✓
- Synced/never-synced split (keys excluded at source) → Task 3. ✓
- Dedicated passphrase + PAT in keychain → Task 7 (syncSecrets). ✓
- Auto (boot pull + debounced push + periodic poll) + manual → Task 7/9. ✓
- Primary-window gating → Task 9. ✓
- Wrong-passphrase fail-closed → Task 1 test + Task 7 status. ✓
- UI status/errors → Task 8. ✓
- Non-fast-forward retry → Task 7 (`doPush` catch → re-pull → retry). ✓
- Tests for crypto/merge/syncState → Tasks 1/2/3. ✓

**Known limitations (acceptable for v1, noted for the implementer):**
- Collection items need a per-item `_updatedAt`; existing writers of `workflows`/`customThemes`/`macros` don't stamp it yet. New/edited items should set `_updatedAt: Date.now()` at their save sites — a small follow-up per writer, or default-stamp in `extractSynced` on first sync. Deletes need an `_deletedAt` tombstone rather than array removal; until writers emit tombstones, a delete on one machine can be resurrected by another. Flag this to the user as a fast-follow if delete-sync matters day one.
- Rust transport has no automated test in this plan (git2 against a fixture is verified manually in Task 10); a `#[cfg(test)]` against a temp bare repo is a reasonable hardening follow-up.

**Type consistency:** `extractSynced`/`applySynced`/`merge` shapes (`{fields, fieldMeta, collections}`) are consistent across Tasks 2/3/7. `sync_pull` returns `{salt, blob}`; `sync_push` takes `{salt, blob, pat}` — matches the engine calls. `syncSecrets` account names match the spec.
