# Cloud Sync — Revision 2: Full synced surface (multi-source snapshot-diff) + review fixes

> Follow-on to `2026-06-13-cloud-sync.md`. Execute subagent-driven.

**Why:** The final review + direct verification found the v1 synced surface assumed every field lived in `userSt`, but the real data lives in **3 stores**: `userSt` (shared), the per-window `st` blob (`st.snippets` = workflows, `headerSkin`, `promptEditor`, `promptEditorVim`), and a dedicated localStorage array (`plutos-terminals:macros:v0`). So workflows/macros/skin silently never synced, and collection deletes resurrected (no `_updatedAt`/`_deletedAt` producer). User chose to **wire everything (incl. skin)**.

**Approach — snapshot-diff:** Rather than stamp timestamps at dozens of write sites, the engine reads the unified surface from all 3 stores each sync and **diffs against a stored last-synced snapshot** to derive per-field timestamps and delete tombstones. All logic stays in `syncState.js` + `syncEngine.js`; no writers change; delete-resurrect is fixed for free. Timestamp granularity is per-sync-cycle (fine for newest-wins). Snapshot persists in its own localStorage key `plutos-terminals:syncsnap:v0` (no `userSt` coupling/recursion).

**Namespacing:** surface keys are `"<store>.<name>"` (e.g. `userSt.keybindings`, `st.snippets`, `macros.macros`) so `merge.js` stays generic and unchanged.

---

## Task R1: Rewrite syncState.js (multi-source) + tests

**Files:** Rewrite `src/features/terminals/sync/syncState.js` and `src/features/terminals/sync/syncState.test.js` (TDD: write the new tests first, watch fail, implement, watch pass).

`extractSynced`/`applySynced` are REMOVED (superseded). New API: `SOURCES`, `readSurface`, `writeSurface`, `deriveLocal`. Item identity = `id` if present else `name`. Sync-meta (`_updatedAt`/`_deletedAt`) is stripped from items written to live stores; tombstones are filtered out of live stores.

### New syncState.js (full content):

```js
// (C)
// The synced surface across THREE stores: userSt (shared prefs), st (per-window
// blob: workflows/skin/prompt-editor), and the macros localStorage array.
// Keys are namespaced "<store>.<name>" so merge.js stays generic. Timestamps +
// delete tombstones are DERIVED by diffing the current read against a stored
// snapshot (deriveLocal) — no per-write stamping anywhere in the app.
export const SOURCES = [
  { store: "userSt", fields: ["keybindings", "activeModel", "themeFollowOS", "themeDark", "themeLight"], collections: ["customThemes"] },
  { store: "st", fields: ["headerSkin", "promptEditor", "promptEditorVim"], collections: ["snippets"] },
  { store: "macros", fields: [], collections: ["macros"] },
];

const SYNC_META = ["_updatedAt", "_deletedAt"];
function idOf(item) { return item.id != null ? item.id : item.name; }
function stripMeta(item) { const o = { ...item }; for (const k of SYNC_META) delete o[k]; return o; }
function jsonEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function collArray(stores, store, name, src) {
  if (store === "macros") return Array.isArray(stores.macros) ? stores.macros : [];
  return Array.isArray(src[name]) ? src[name] : [];
}

/** Raw current values from all stores. stores = { userSt:{}, st:{}, macros:[array] }. */
export function readSurface(stores) {
  const fields = {}, collections = {};
  for (const s of SOURCES) {
    const src = s.store === "macros" ? {} : (stores[s.store] || {});
    for (const f of s.fields) { if (f in src) fields[`${s.store}.${f}`] = src[f]; }
    for (const c of s.collections) collections[`${s.store}.${c}`] = collArray(stores, s.store, c, src);
  }
  return { fields, collections };
}

/** A merged surface (with meta + tombstones) -> per-store patches for live persistence.
 *  Returns { userSt:{...}, st:{...}, macros:[...] | null }. Tombstones removed, meta stripped. */
export function writeSurface(merged) {
  const userSt = {}, st = {};
  let macros = null;
  for (const s of SOURCES) {
    for (const f of s.fields) {
      const ns = `${s.store}.${f}`;
      if (ns in merged.fields) {
        if (s.store === "userSt") userSt[f] = merged.fields[ns];
        else if (s.store === "st") st[f] = merged.fields[ns];
      }
    }
    for (const c of s.collections) {
      const ns = `${s.store}.${c}`;
      const arr = (merged.collections[ns] || []).filter((it) => !it._deletedAt).map(stripMeta);
      if (s.store === "userSt") userSt[c] = arr;
      else if (s.store === "st") st[c] = arr;
      else if (s.store === "macros") macros = arr;
    }
  }
  return { userSt, st, macros };
}

/** Derive the local merge surface WITH meta by diffing current read vs the prior snapshot.
 *  snapshot is a previously-merged surface (may contain tombstones). `now` injectable. */
export function deriveLocal(stores, snapshot, now) {
  const current = readSurface(stores);
  const snap = snapshot || { fields: {}, fieldMeta: {}, collections: {} };
  const fieldMeta = {};
  for (const ns of Object.keys(current.fields)) {
    const changed = !(ns in (snap.fields || {})) || !jsonEq(current.fields[ns], snap.fields[ns]);
    fieldMeta[ns] = changed ? now : (snap.fieldMeta?.[ns] ?? now);
  }
  const collections = {};
  for (const ns of Object.keys(current.collections)) {
    const snapArr = snap.collections?.[ns] || [];
    const snapById = new Map(snapArr.map((it) => [idOf(it), it]));
    const out = [], seen = new Set();
    for (const item of current.collections[ns]) {
      const id = idOf(item); seen.add(id);
      const prev = snapById.get(id);
      const changed = !prev || prev._deletedAt || !jsonEq(stripMeta(item), stripMeta(prev));
      out.push({ ...item, _updatedAt: changed ? now : (prev._updatedAt ?? now) });
    }
    for (const it of snapArr) {
      const id = idOf(it);
      if (seen.has(id)) continue;
      if (it._deletedAt) { out.push(it); continue; } // already tombstoned, carry forward
      out.push({ id: it.id ?? id, name: it.name, _updatedAt: now, _deletedAt: now }); // new delete
    }
    collections[ns] = out;
  }
  return { fields: current.fields, fieldMeta, collections };
}
```

### New syncState.test.js (full content):

```js
import { test, expect } from "vitest";
import { readSurface, writeSurface, deriveLocal, SOURCES } from "./syncState.js";

const stores = () => ({
  userSt: { keybindings: { a: "x" }, activeModel: "m1", customThemes: [{ id: "t1", name: "T" }], providerKeys: { anthropic: "sk-xxx" } },
  st: { headerSkin: "oled", snippets: [{ id: "s1", cmd: "ls" }] },
  macros: [{ id: "mac1", name: "M", data: "abc" }],
});

test("readSurface namespaces across stores and excludes keys", () => {
  const surf = readSurface(stores());
  expect(surf.fields["userSt.activeModel"]).toBe("m1");
  expect(surf.fields["st.headerSkin"]).toBe("oled");
  expect(surf.collections["macros.macros"][0].id).toBe("mac1");
  expect(surf.collections["st.snippets"][0].cmd).toBe("ls");
  expect(JSON.stringify(surf)).not.toContain("sk-xxx");
});

test("writeSurface routes to stores, strips meta, drops tombstones", () => {
  const merged = {
    fields: { "userSt.activeModel": "m2", "st.headerSkin": "light" }, fieldMeta: {},
    collections: {
      "userSt.customThemes": [{ id: "t1", name: "T", _updatedAt: 5 }],
      "st.snippets": [{ id: "s1", cmd: "ls", _updatedAt: 5 }, { id: "s2", _updatedAt: 9, _deletedAt: 9 }],
      "macros.macros": [{ id: "mac1", name: "M", _updatedAt: 5 }],
    },
  };
  const out = writeSurface(merged);
  expect(out.userSt.activeModel).toBe("m2");
  expect(out.st.headerSkin).toBe("light");
  expect(out.st.snippets).toEqual([{ id: "s1", cmd: "ls" }]); // s2 tombstone dropped, meta stripped
  expect(out.macros).toEqual([{ id: "mac1", name: "M" }]);
});

test("deriveLocal stamps changed field now, keeps unchanged ts", () => {
  const snap = { fields: { "userSt.activeModel": "m1", "st.headerSkin": "oled" }, fieldMeta: { "userSt.activeModel": 100, "st.headerSkin": 100 }, collections: {} };
  const s = stores(); s.userSt.activeModel = "m2"; // changed
  const local = deriveLocal(s, snap, 500);
  expect(local.fieldMeta["userSt.activeModel"]).toBe(500); // changed -> now
  expect(local.fieldMeta["st.headerSkin"]).toBe(100);      // unchanged -> kept
});

test("deriveLocal emits tombstone for a removed collection item", () => {
  const snap = { fields: {}, fieldMeta: {}, collections: { "st.snippets": [{ id: "s1", cmd: "ls", _updatedAt: 100 }, { id: "sGone", cmd: "old", _updatedAt: 100 }] } };
  const s = stores(); // snippets has only s1 now; sGone removed
  const local = deriveLocal(s, snap, 500);
  const snips = local.collections["st.snippets"];
  expect(snips.find((x) => x.id === "s1")._updatedAt).toBe(100); // unchanged kept
  const tomb = snips.find((x) => x.id === "sGone");
  expect(tomb._deletedAt).toBe(500); // removed -> tombstone now
});

test("SOURCES never lists key fields", () => {
  const all = SOURCES.flatMap((s) => [...s.fields, ...s.collections]);
  expect(all).not.toContain("providerKeys");
  expect(all).not.toContain("anthropicKey");
});
```

Run `npm test -- syncState` → 5 pass. Commit: `feat(sync): multi-source surface (snapshot-diff, 3 stores)`.

---

## Task R2: Rewrite syncEngine.js (multi-source + snapshot + fixes)

**Files:** Rewrite `src/features/terminals/sync/syncEngine.js`. Build-verify (`npm run build`); engine I/O not unit-tested.

Changes vs v1: (a) config takes `getStores`/`applyStores` (not getUserSt/saveUser); (b) snapshot in localStorage `plutos-terminals:syncsnap:v0`; (c) local via `deriveLocal`; (d) apply via `writeSurface`→`applyStores`; (e) skip push when local surface equals remote (nothing local-new); (f) passphrase detection via `err.name === "OperationError"`; (g) `busy` set synchronously at entry.

### New syncEngine.js (full content):

```js
// (C)
// Cloud-sync orchestrator. Reads the unified surface from all 3 stores, derives
// per-field timestamps + delete tombstones by diffing against a stored snapshot,
// merges with the decrypted remote, applies back to the stores, and pushes the
// re-encrypted blob. Primary-window gated by the caller.
import { invoke } from "@backend";
import { encrypt, decrypt, newSalt } from "./crypto.js";
import { merge } from "./merge.js";
import { readSurface, writeSurface, deriveLocal } from "./syncState.js";
import { getPassphrase, getPat } from "./syncSecrets.js";

const PUSH_DEBOUNCE_MS = 4000;
const POLL_MS = 5 * 60 * 1000;
const SNAP_KEY = "plutos-terminals:syncsnap:v0";

let timer = null, poll = null, busy = false;
const listeners = new Set();
let cfg = { getStores: null, applyStores: null, getRepoUrl: null, setStatus: () => {} };

export function configure(opts) { cfg = { ...cfg, ...opts }; }
function status(s) { cfg.setStatus(s); for (const l of listeners) l(s); }
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function loadSnapshot() {
  try { const r = localStorage.getItem(SNAP_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}
function saveSnapshot(surface) {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(surface)); } catch { /* ignore */ }
}

class BadPassphraseError extends Error {}

async function decryptRemote(res, pass) {
  if (!res.salt || !res.blob) return { fields: {}, fieldMeta: {}, collections: {} };
  try {
    return JSON.parse(await decrypt(JSON.parse(res.blob), pass, res.salt));
  } catch (e) {
    if (e && e.name === "OperationError") throw new BadPassphraseError("passphrase mismatch");
    throw e;
  }
}

// Pull remote, derive local (snapshot diff), merge, apply to stores, persist snapshot.
async function pullMerge(pass, pat, now) {
  const res = await invoke("sync_pull", { pat });
  const remoteSurface = await decryptRemote(res, pass);
  const localSurface = deriveLocal(cfg.getStores(), loadSnapshot(), now);
  const { merged, changedLocally } = merge(localSurface, remoteSurface);
  if (changedLocally) cfg.applyStores(writeSurface(merged));
  saveSnapshot(merged);
  const localNewer = JSON.stringify(merged) !== JSON.stringify(remoteSurface);
  return { merged, salt: res.salt || newSalt(), localNewer };
}

async function doPush(pass, pat, merged, salt) {
  const blob = await encrypt(JSON.stringify(merged), pass, salt);
  await invoke("sync_push", { salt, blob: JSON.stringify(blob), pat });
}

export async function syncNow() {
  if (busy) return;
  busy = true; // set synchronously before any await
  try {
    const repoUrl = cfg.getRepoUrl();
    const pass = await getPassphrase();
    if (!repoUrl || !pass) { status({ state: "disabled" }); return; }
    const pat = await getPat();
    status({ state: "syncing" });
    const now = Date.now();
    await invoke("sync_clone_or_open", { repoUrl, pat });
    let { merged, salt, localNewer } = await pullMerge(pass, pat, now);
    if (localNewer) {
      try { await doPush(pass, pat, merged, salt); }
      catch {
        ({ merged, salt, localNewer } = await pullMerge(pass, pat, Date.now())); // re-pull on non-ff
        await doPush(pass, pat, merged, salt);
      }
    }
    status({ state: "ok", at: Date.now() });
  } catch (e) {
    if (e instanceof BadPassphraseError) status({ state: "bad-passphrase" });
    else status({ state: "error", msg: String(e) });
  } finally {
    busy = false;
  }
}

export function notifyChange() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { syncNow(); }, PUSH_DEBOUNCE_MS);
}

export function start() {
  syncNow();
  poll = setInterval(() => { syncNow(); }, POLL_MS);
  return () => { if (poll) clearInterval(poll); if (timer) clearTimeout(timer); };
}
```

Note: `readSurface` import is retained for potential reuse; if the linter flags it unused, remove it from the import (keep `writeSurface, deriveLocal`). Run `npm run build` → succeeds. Commit: `feat(sync): snapshot-diff engine, 3-store apply, passphrase+race fixes`.

---

## Task R3: Rust sync_pull — surface fetch/auth errors

**Files:** Modify `src-tauri/src/sync_git.rs` (the `sync_pull` fetch block). Build env + `cargo check` (git2 cached → fast).

v1 did `let _ = remote.fetch(...)`, swallowing auth/network failures so a pull looked successful against stale refs. Replace `let _ = remote.fetch(&[BRANCH], Some(&mut fo), None);` with:

```rust
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
```

Verify with the build-env preamble (Strawberry Perl + vcvars64) then `cargo check` (compiles, no warnings). Commit: `fix(sync): surface git fetch auth/network errors`.

---

## Task R4: Rewire App.jsx for 3 stores + remove superseded stamping

**Files:** Modify `src/App.jsx`. Build-verify.

1. **Remove the Task-4 `_syncMeta` stamping** inside `saveUser` (superseded by snapshot-diff). Restore `saveUser` to its simple body but add a `notifyChange` trigger:
```js
  const saveUser = useCallback((next) => {
    const resolved = typeof next === "function" ? next(userStRef.current) : next;
    userStRef.current = resolved;
    setUserSt(resolved);
    writeUserState(resolved);
    if (isPrimaryWindow() && resolved?.sync?.enabled) notifyChange();
  }, []);
```
2. **Remove the now-unused `SYNCED_FIELDS` import** (`import { SYNCED_FIELDS } ...`). Keep `isPrimaryWindow` import.
3. **Add** `import { loadMacros, saveMacros } from "./features/terminals/macros.js";` — VERIFY the exact export names in macros.js first (they may be e.g. `getMacros`/`persistMacros`/a default). Use the real names; if macros.js has no exported load/save, add minimal ones that read/write the `plutos-terminals:macros:v0` key (the `KEY` constant already in macros.js) and export them.
4. **Update the engine-boot effect's `configure`** to the 3-store accessors:
```js
    configureSync({
      getStores: () => ({ userSt: userStRef.current, st: stRef.current, macros: loadMacros() }),
      applyStores: ({ userSt, st, macros }) => {
        if (userSt && Object.keys(userSt).length) saveUser((prev) => ({ ...prev, ...userSt }));
        if (st && Object.keys(st).length) save((prev) => ({ ...prev, ...st }));
        if (macros) saveMacros(macros);
      },
      getRepoUrl: () => userStRef.current?.sync?.repoUrl,
      setStatus: () => {},
    });
```
   (`stRef` already exists in App — used by existing migrations. `save` is the per-window persist callback ~line 146. The `notifyChange`/`startSync`/`configureSync` imports from syncEngine.js already exist from v1 Task 9.)
5. **Fire `notifyChange()` from `save` too** (the per-window persist callback), gated `isPrimaryWindow() && <new st>?.sync?.enabled`? NOTE: `sync.enabled` lives in `userSt`, not `st`. So in `save`, gate on `isPrimaryWindow() && userStRef.current?.sync?.enabled`. Add right after `save` writes its state.

Build with `npm run build` → succeeds. Commit: `feat(sync): wire engine across userSt + st + macros stores`.

---

## R-Self-Review checklist
- Surface covers workflows (`st.snippets`), macros, headerSkin, promptEditor(+Vim), customThemes, theme slots, keybindings, model — the full set chosen. ✓
- Deletes produce tombstones via `deriveLocal` diff (no writer changes). ✓
- Keys excluded at source (SOURCES lists no provider-key fields; `readSurface` reads only listed names). ✓
- Correctness fixes: passphrase `OperationError`; git fetch-error surfacing; `busy` synchronous; push skipped when nothing local-new. ✓
- Snapshot in its own localStorage key — no `userSt` recursion. ✓
- `applyStores` writes `st` via per-window `save` (primary window) — per-window skin/workflows become effectively shared via sync, as the user chose. ✓
