// (C)
// Cloud-sync orchestrator. Reads the unified surface from all 3 stores, derives
// per-field timestamps + delete tombstones by diffing against a stored snapshot,
// merges with the decrypted remote, applies back to the stores, and pushes the
// re-encrypted blob. Primary-window gated by the caller.
import { invoke } from "@backend";
import { encrypt, decrypt, newSalt } from "./crypto.js";
import { merge } from "./merge.js";
import { writeSurface, deriveLocal, surfaceValueKey } from "./syncState.js";
import { pushWithRePull } from "./pushRetry.js";
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
  const localNewer = surfaceValueKey(merged) !== surfaceValueKey(remoteSurface);
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
      // Push, re-pulling + re-merging on a non-fast-forward. Bounded retry so a
      // concurrent push from a third machine can't leave our edits silently
      // unpushed (the old code retried exactly once, then threw uncaught).
      await pushWithRePull(
        () => doPush(pass, pat, merged, salt),
        async () => { ({ merged, salt } = await pullMerge(pass, pat, Date.now())); },
      );
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
