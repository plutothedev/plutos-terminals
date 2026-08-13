// (C)
// Cloud-sync orchestrator. Reads the unified surface from all 3 stores, derives
// per-field timestamps + delete tombstones by diffing against a stored snapshot,
// merges with the decrypted remote, applies back to the stores, and pushes the
// re-encrypted blob. Primary-window gated by the caller.
import { invoke } from "@backend";
import { encrypt, decrypt, newSalt, CorruptBlobError } from "./crypto.js";
import { merge } from "./merge.js";
import { writeSurface, readSurface, deriveLocal, surfaceValueKey } from "./syncState.js";
import { pushWithRePull } from "./pushRetry.js";
import { getPassphrase, getPat } from "./syncSecrets.js";

const PUSH_DEBOUNCE_MS = 4000;
const POLL_MS = 5 * 60 * 1000;
const SNAP_KEY = "plutos-terminals:syncsnap:v0";

let timer = null, poll = null, busy = false;
// P3-T4: pendingResync = a change arrived mid-sync (re-run once on finish);
// lastSyncedKey = surface key of the last SUCCESSFUL sync, gating notifyChange.
let pendingResync = false;
let lastSyncedKey = null;
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

/** Map a thrown sync error to a status object. A corrupt/truncated remote blob is
 *  surfaced distinctly from a wrong passphrase (different fix: re-push from a good
 *  machine, not "retype the passphrase") and from a generic network/git error.
 *  Deferred-item #3 from docs/autonomous-session-2026-06-19.md. */
export function classifyError(e) {
  if (e instanceof BadPassphraseError) return { state: "bad-passphrase" };
  if (e instanceof CorruptBlobError) return { state: "corrupt" };
  return { state: "error", msg: String(e) };
}

export async function decryptRemote(res, pass) {
  if (!res.salt || !res.blob) return { fields: {}, fieldMeta: {}, collections: {} };
  // A truncated/garbage remote blob fails the OUTER JSON.parse with a SyntaxError
  // before decrypt() ever runs — that is the most common "corrupt repo" case, so
  // classify it as corrupt here rather than letting it fall to the generic error
  // (which would wrongly tell the user to check their passphrase).
  let blobParsed;
  try { blobParsed = JSON.parse(res.blob); }
  catch { throw new CorruptBlobError("corrupt sync blob: invalid JSON"); }
  try {
    return JSON.parse(await decrypt(blobParsed, pass, res.salt));
  } catch (e) {
    if (e instanceof CorruptBlobError) throw e;
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
  const localNewer = surfaceValueKey(merged) !== surfaceValueKey(remoteSurface);
  return { merged, salt: res.salt || newSalt(), localNewer };
}

async function doPush(pass, pat, merged, salt) {
  const blob = await encrypt(JSON.stringify(merged), pass, salt);
  await invoke("sync_push", { salt, blob: JSON.stringify(blob), pat });
}

export async function syncNow() {
  if (busy) {
    // A change during an in-flight sync used to wait for the 5-min poll
    // (audit: busy-drop). Flag it; the finally block re-runs once.
    pendingResync = true;
    return;
  }
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
      // Push, re-pulling + re-merging on a non-fast-forward. Bounded retry so a
      // concurrent push from a third machine can't leave our edits silently
      // unpushed (the old code retried exactly once, then threw uncaught).
      await pushWithRePull(
        () => doPush(pass, pat, merged, salt),
        async () => { ({ merged, salt } = await pullMerge(pass, pat, Date.now())); },
      );
    }
    status({ state: "ok", at: Date.now() });
    // Record the surface key of what ACTUALLY synced — recorded here, on
    // success, never at notify time (audit M8: a busy-dropped debounce would
    // otherwise leave changed-but-recorded state stuck until the poll).
    lastSyncedKey = surfaceValueKey(merged);
  } catch (e) {
    status(classifyError(e));
  } finally {
    busy = false;
    if (pendingResync) {
      pendingResync = false;
      // Re-run once for the change that arrived mid-sync. Clear any debounce
      // notifyChange scheduled while we were busy (stream audit W4) —
      // reassigning `timer` without clearing would orphan that live timeout
      // into a redundant second fetch cycle.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { syncNow(); }, 250);
    }
  }
}

export function notifyChange() {
  // Gate (P3-T4): EVERY persist called this — pane focus, splits, closes —
  // scheduling a full git fetch after the debounce, though only the small
  // synced surface (skin/editor flags/snippets/prompts/macros/themes)
  // matters. Early-return when that surface is unchanged since the last
  // SUCCESSFUL sync. The 5-min poll stays ungated (remote-inbound changes).
  try {
    if (lastSyncedKey !== null && cfg?.getStores) {
      const key = surfaceValueKey(readSurface(cfg.getStores()));
      if (key === lastSyncedKey) return;
    }
  } catch { /* fall through to a normal sync on any read error */ }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { syncNow(); }, PUSH_DEBOUNCE_MS);
}

export function start() {
  syncNow();
  poll = setInterval(() => { syncNow(); }, POLL_MS);
  return () => { if (poll) clearInterval(poll); if (timer) clearTimeout(timer); };
}
