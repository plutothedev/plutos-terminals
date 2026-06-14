// (C)
// Cloud-sync orchestrator. Owns the pull/merge/push state machine. Pure-ish:
// all I/O goes through injected backend invoke + getUserSt/saveUser callbacks so
// it can be reasoned about and (later) tested. Primary-window gated by the
// caller. See docs/superpowers/specs/2026-06-13-cloud-sync-design.md.
import { invoke } from "@backend";
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
