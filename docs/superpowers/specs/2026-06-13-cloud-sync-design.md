# Cloud Sync — BYO git, end-to-end encrypted

**Status:** Design approved 2026-06-13. Branch `001-remote-sessions-parity`.
**Goal:** Sync portable config (workflows, themes, keybindings, settings, macros)
across a user's machines via a git repo they control, end-to-end encrypted, with
no backend for us to host. Closes the last open Warp-Drive item (Milestone 3,
"Settings/sync across machines").

## Decisions (locked during brainstorming)

1. **Transport model:** BYO git repo. User points the app at a private repo they
   already control (GitHub/GitLab/Gitea/self-hosted). The app is the only client.
   No managed service, no accounts, no hosting cost.
2. **Encryption:** End-to-end. The synced blob is AES-256-GCM encrypted on-device
   before it is committed. The repo host only ever sees ciphertext + a salt.
3. **Conflict resolution:** Field-level merge on decrypted plaintext, newest-wins
   per field via per-field `updatedAt`. Never destructive, never prompts.
4. **Passphrase:** A dedicated sync passphrase (separate from the app-lock master
   password), entered once per machine, cached in the OS keychain. PBKDF2-600k.
5. **Git library:** Embedded `git2`/libgit2 (vendored-libgit2, reusing the
   existing `ssh2` vendored-openssl stack). No dependency on `git` being on PATH.
6. **Cadence:** Auto (boot pull + debounced push + periodic pull) plus a manual
   "Sync now" button. Background work is primary-window gated.

## What syncs / what does not

**Synced (portable config):**
- Workflows / snippets (Warp Drive)
- Custom themes + active skin + OS-sync slots (`customThemes`, `headerSkin`,
  `themeFollowOS`, `themeDark`, `themeLight`)
- Keybindings (`keybindings`)
- Settings / preferences (`welcomeDone`, AI prefs, feature toggles, `promptEditor`)
- Active / default model selection (`activeModel`)
- Macros

**Never synced:**
- **API keys / provider keys** — keychain only; the hard rule that keys never
  leave the desktop (see companion security model). Not negotiable.
- **Per-window workspace layout** — tabs/panels/splits are tied to one machine's
  session (the per-window state blob, not the shared user-prefs blob).
- **Command history** — large, noisy, machine-specific. May become opt-in later.

The synced surface is the shared user-prefs blob (`USER_STORAGE_KEY`) minus
`providerKeys`/`anthropicKey`, not the per-window state blob.

## Architecture

Three layers, each independently testable.

### 1. Sync core (JS) — `src/features/terminals/sync/`

- **`syncState.js`** — single source of truth for the synced surface. Exports:
  - `SYNCED_FIELDS` — the scalar pref keys that participate.
  - `SYNCED_COLLECTIONS` — id-keyed collections (workflows, customThemes,
    keybindings, macros) and how to identify/version each item.
  - `extractSynced(userSt) -> { fields, collections, meta }` — pulls the synced
    surface out of the live user-prefs object, attaching the per-field
    `updatedAt` map (`meta`).
  - `applySynced(userSt, merged) -> userSt'` — writes a merged surface back into
    a user-prefs object without touching non-synced fields (keys, layout).

  The `updatedAt` map (`meta`) is itself persisted in the user-prefs blob under a
  reserved key (e.g. `_syncMeta`) and is stamped whenever a synced field changes.
  Stamping happens at the `saveUser` choke point so callers don't have to know
  about sync.

- **`merge.js`** — pure field-level 3-way merge on plaintext. No I/O.
  - Scalars: newest `updatedAt` wins; missing timestamp treated as oldest.
  - Collections: union by id; on id collision the newer item wins; deletes are
    represented as tombstones (id + `deletedAt`) so a delete on machine A is not
    resurrected by machine B's stale copy. Tombstones older than a TTL
    (e.g. 90 days) are garbage-collected on merge.
  - Returns `{ merged, changedLocally }` so the engine knows whether a re-push is
    needed after applying a pull.

- **`crypto.js`** — `deriveKey(passphrase, salt)` via PBKDF2-600k (reuse the
  primitives in `masterPassword.js`), `encrypt(plaintext) -> { iv, ct }` with a
  random 96-bit IV per push, `decrypt({ iv, ct }) -> plaintext` that throws on
  GCM auth-tag failure. AES-256-GCM via WebCrypto (`crypto.subtle`).

- **`syncEngine.js`** — orchestrator. Owns the state machine:
  - `enable({ repoUrl, auth, passphrase })` — store config, derive+verify key,
    first pull-or-initialize, first push.
  - `pull()` — `sync_pull` → read `state.enc` + `salt` → decrypt → `merge` with
    local → `applySynced` → `saveUser`. If `changedLocally`, schedule a push.
  - `pushDebounced()` — 3–5s debounce after any synced change; coalesces bursts.
  - `push()` — pull-merge-encrypt-commit-push to avoid non-fast-forward; on
    push rejection (remote moved), re-pull-merge and retry once.
  - `periodicPull()` — every few minutes while enabled and online.
  - `syncNow()` — manual pull+push, surfaces result.
  - Primary-window gated (`isPrimaryWindow()`); secondary windows are no-ops.
  - Offline/error → mark status, queue, retry with backoff. Never destructive.

### 2. Git transport (Rust) — `src-tauri/src/sync_git.rs`

Tauri commands (async, per the v0.4.0 async-command convention):

- `sync_clone_or_open(repo_url, auth) -> ()` — ensure a clone exists in the
  app-data dir (`<app_data>/sync-repo/`); clone if absent, open if present.
- `sync_pull() -> { salt: Option<String>, blob: Option<{iv,ct}>, head: String }`
  — fetch + fast-forward; return the two repo files' contents (or `None` if the
  repo is empty / first run).
- `sync_push(salt, blob, message) -> { head: String }` — write `salt` +
  `state.enc`, commit, push. Returns the new head. Non-fast-forward surfaces as a
  typed error the engine catches to re-pull.
- `sync_status() -> { ahead, behind, last_commit, clean }`.

Implementation notes:
- `git2` with `features = ["vendored-libgit2", "ssh"]`, reusing the vendored
  openssl already pulled by `ssh2`.
- Auth via libgit2 `RemoteCallbacks::credentials`: HTTPS → `Cred::userpass_plaintext`
  with the PAT read from the keychain; `ssh://`/`git@` → `Cred::ssh_key_from_agent`
  then fall back to default key paths.
- The repo holds exactly two files: `salt` (base64) and `state.enc` (JSON
  `{iv,ct}`). No plaintext, ever. A `.gitattributes`/README seed is optional.
- App-data path via Tauri's path API; never the project dir.

### 3. UI — `src/features/terminals/SyncSection.jsx`

New section in `SettingsModal`:
- Repo URL field; auth picker (HTTPS PAT paste → keychain, or SSH "use agent").
- Sync passphrase entry (with a confirm field on first enable).
- **Enable sync** toggle; **Sync now** button.
- Status line: last-synced time, ahead/behind, current error (if any).
- Wrong-passphrase / auth-fail / offline states rendered inline, non-alarming.

## Data flow

```
boot (primary window, sync enabled)
  -> sync_clone_or_open
  -> sync_pull -> decrypt(remote) -> merge(local, remote)
  -> applySynced -> saveUser
  -> if changedLocally: push()

on synced-field change
  -> saveUser stamps _syncMeta[field] = now
  -> pushDebounced (3-5s)
  -> push(): pull -> merge -> encrypt -> commit -> push
       (on non-fast-forward: re-pull -> merge -> retry once)

periodic (every few min)
  -> pull()
```

## Security model

- **Passphrase** lives in the OS keychain only; never localStorage, never the
  repo. Account e.g. `sync-passphrase:v0`.
- **PAT** lives in the OS keychain only. Account e.g. `sync-git-pat:v0`.
- **Salt** is per-repo, stored in the repo; PBKDF2-600k makes offline brute force
  of the ciphertext expensive even with the salt.
- The synced blob is AES-256-GCM encrypted before leaving the box. The git host
  sees ciphertext + salt + commit metadata (timestamps, the user's git identity).
- **Wrong passphrase** → GCM auth-tag failure → `crypto.decrypt` throws → engine
  surfaces "passphrase doesn't match this sync repo," makes no local changes, and
  does not push.
- **API keys are excluded at the source** (`extractSynced` never reads
  `providerKeys`/`anthropicKey`), not merely filtered later — defense in depth.
- Background sync is primary-window gated so multi-window can't double-push.

## Error handling

| Condition | Behavior |
|-----------|----------|
| Offline | Mark status "offline", queue push, retry with backoff. Non-destructive. |
| Auth failure (PAT/SSH) | Surface "check repo credentials"; pause auto-sync until re-entered. |
| Non-fast-forward push | Re-pull, merge, retry once; if still rejected, surface and queue. |
| Wrong passphrase | Surface mismatch; no local change, no push. |
| Empty/first-run repo | Treat as no remote state; push local as the initial commit. |
| Merge | Always silent field-merge; never a data-loss prompt. |

## Testing

- **`merge.js` (unit):** scalar newest-wins (both directions, missing timestamps),
  collection union, id-collision newest-wins, delete tombstone not resurrected,
  tombstone GC past TTL, `changedLocally` flag correctness.
- **`crypto.js` (unit):** encrypt→decrypt round-trip; wrong-passphrase rejection;
  IV uniqueness across pushes.
- **`syncState.js` (unit):** `extractSynced` excludes keys + layout; `applySynced`
  preserves non-synced fields.
- **Rust (`sync_git.rs`):** clone/pull/push against a local bare-repo fixture;
  non-fast-forward path; empty-repo first-run path.

## Out of scope (YAGNI)

- Managed accounts / hosted backend.
- Real-time / live multi-viewer sync.
- Command-history sync (may be revisited as opt-in).
- Per-device key revocation (rotate the passphrase to invalidate old machines).
- Conflict-resolution UI (field-merge is invisible by design).

## Build / verify notes

- Add `git2` to `src-tauri/Cargo.toml` with vendored-libgit2 + ssh; confirm it
  links against the already-vendored openssl from `ssh2` (watch for a duplicate
  openssl-sys build). Build env per the perl/vcvars gotchas in the build notes.
- New keychain accounts: `sync-passphrase:v0`, `sync-git-pat:v0`.
- Verify in a dev instance first (two windows / two app-data dirs to simulate two
  machines), MSI only at the milestone.
