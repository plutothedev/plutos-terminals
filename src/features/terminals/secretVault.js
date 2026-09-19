// (C)
// At-rest storage for LLM provider API keys + the legacy Anthropic key.
//
// These keys are injected as env vars into spawned shells (see envForModel /
// resolveActiveLLM), so they MUST be readable in-memory by the renderer at spawn
// time — but they must NOT sit in plaintext localStorage, where a backup, another
// local process, or an XSS sink could read them. So we persist them in the OS
// keychain (the same store SSH creds use — vault.rs secret_set/get) and keep a
// small in-memory cache that the synchronous spawn paths (readUserSt) read from.
//
// ONE ENTRY PER PROVIDER (v1), not one JSON blob (v0). Two defects came out of
// the single blob, and both ended with the user's key gone while the UI still
// showed it:
//
//   • Windows Credential Manager caps ONE credential at 2560 bytes (~1280
//     chars). Sixteen providers plus the legacy duplicate share that one entry,
//     so a user with a dozen keys, or one long custom-endpoint token, crosses
//     the cap and from then on EVERY key write fails. Per-provider entries put
//     each key three orders of magnitude under the cap.
//
//   • A whole-blob rewrite has no idea which provider actually changed, so an
//     unrelated save (App.jsx calls saveSecretKeys on every user-state write)
//     in a window holding a stale cache reverted another window's rotation.
//     Per-provider entries make a DELTA write natural: only the providers whose
//     value changed are touched, and a save that changes nothing writes nothing.
//
// Safety: localStorage keys are only stripped once the keychain has been PROVEN
// to persist (keychainAvailable(), see probeKeychain below). If the keychain is
// unavailable we keep the local copy rather than lose the user's keys. And
// saveSecretKeys now RETURNS A PROMISE that rejects on a failed write, because
// the old fire-and-forget `.catch(() => {})` could not keep the local fallback
// it claimed to: App.jsx had already stripped the plaintext copy synchronously,
// on the strength of a startup probe that never re-runs. The caller restores
// that copy and tells the user; one failed write is NOT a dead keychain, so
// keychainOk is deliberately left alone (flipping it would keep every later
// secret in plaintext for the rest of the session).
import { invoke } from "../../backend.js";
import { PROVIDERS } from "./providers.js";

// v0: every key in one JSON blob. Still READ (a migration can be interrupted,
// and assuming it succeeded is how you lose a key set). Only ever written to
// SHRINK it: a delete has to reach v0 too, or the next load merges the revoked
// key back in (see pruneV0). Never widened, never recreated.
const V0_ACCOUNT = "llm-provider-keys:v0";
// v1: one entry per provider, plus an index. The keychain has no enumeration
// API — get/set/delete by account only — so the index is the only way to know
// which providers have entries. It holds provider IDS, never key material.
const INDEX_ACCOUNT = "llm-provider-keys:v1:index";
const PROVIDER_PREFIX = "llm-provider-keys:v1:p:";
// The legacy standalone Anthropic key (pre-consolidation userSt.anthropicKey).
// Its own entry, and the `p:` segment above keeps a provider named "anthropic"
// from colliding with it.
const LEGACY_ACCOUNT = "llm-provider-keys:v1:anthropic";
const PROBE_ACCOUNT = "keychain-probe:v0";

const providerAccount = (id) => `${PROVIDER_PREFIX}${id}`;

// The provider catalog is a FIXED, KNOWN set, which makes the index ADVISORY
// rather than authoritative: whatever the index says (or fails to say), these
// accounts can always be probed directly. That is what turns a narrowed or
// corrupt index from "those keys are unreachable forever" into "one extra read
// per provider on the loads that need it". The index is still written and kept
// honest, because a provider dropped from a future catalog would otherwise
// become unenumerable.
const KNOWN_PROVIDER_IDS = PROVIDERS.map((p) => p.id);

// What the renderer reads synchronously (spawn paths cannot await).
let cache = { providerKeys: {}, anthropicKey: "" };
// What we believe the KEYCHAIN holds: the baseline every delta is computed
// against. Distinct from `cache`, which runs ahead of the keychain by design.
let persisted = { providerKeys: {}, anthropicKey: "" };
let loaded = false;
let keychainOk = false;
let probePromise = null;
// Saves handed out but not yet finished. Counted so a cross-window refresh can
// tell "the keychain is settled" from "the keychain is mid-change and the cache
// holds a value the user typed that is not on disk yet". See reloadOnce.
let pendingSaves = 0;
// Whether this window has probed the whole catalog at least once. The first
// load always does, so an install whose index an older build narrowed recovers
// on the next launch rather than staying broken forever.
let rebuiltOnce = false;

function normalize(obj) {
  const src = obj && typeof obj.providerKeys === "object" && obj.providerKeys ? obj.providerKeys : {};
  const providerKeys = {};
  // An empty string is "no key", not a key — every consumer already reads it
  // that way (resolveActiveLLM, resolveEnvFromUserState). Dropping it here is
  // what turns "user cleared the field" into a delete instead of a blank entry.
  for (const id of Object.keys(src)) {
    const v = src[id];
    if (typeof v === "string" && v !== "") providerKeys[id] = v;
  }
  return {
    providerKeys,
    anthropicKey: typeof (obj && obj.anthropicKey) === "string" ? obj.anthropicKey : "",
  };
}

function snapshot(st) {
  return { providerKeys: { ...st.providerKeys }, anthropicKey: st.anthropicKey };
}

function nonce() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Every read and write runs through one chain. `persisted` is a read-modify-
// write baseline, so two overlapping saves (or a save racing the cross-window
// refresh) would otherwise each diff against a state the other is mid-way
// through changing, and the loser's write would be computed from fiction.
let chain = Promise.resolve();
function queue(fn) {
  const run = chain.then(() => fn());
  // A caller's rejection is the caller's to handle; it must never wedge the
  // queue for every later save.
  chain = run.then(() => {}, () => {});
  return run;
}

/** Prove the keychain actually PERSISTS, by writing a sentinel and reading it
 *  back from a fresh entry. Memoized: runs at most once per renderer session.
 *
 *  A bare successful secret_get proves nothing. On any platform where the
 *  keyring crate has no backend compiled in, it falls back to an in-memory mock
 *  whose set AND get both report success while storing nothing, and vault.rs
 *  mints a new entry per call, so even a same-process read comes back empty.
 *  Trusting a successful (empty) get was therefore read as "the keychain works",
 *  which let App.jsx strip the plaintext copy out of localStorage: the keys were
 *  then gone on the next launch, silently and unrecoverably. The cloud-sync
 *  passphrase lives here too, and losing it makes an already-pushed encrypted
 *  sync blob permanently undecryptable.
 *
 *  So anything short of a byte-identical readback (throw, null, mismatch) is
 *  treated as UNAVAILABLE, which keeps the plaintext copy on disk. A plaintext
 *  copy in the user's own localStorage is a far smaller harm than silently
 *  destroying every credential they own, so this check fails safe on purpose.
 *
 *  The probe uses its own per-session account, never a key account: a second
 *  window writing real keys concurrently must not be able to fail (or pass) it. */
function probeKeychain() {
  if (probePromise) return probePromise;
  const account = `${PROBE_ACCOUNT}:${nonce()}`;
  const sentinel = `roundtrip-${nonce()}`;
  probePromise = (async () => {
    try {
      await invoke("secret_set", { account, secret: sentinel });
      const readBack = await invoke("secret_get", { account });
      keychainOk = readBack === sentinel;
    } catch {
      keychainOk = false; // keychain locked, missing, or erroring: keep the local copy
    }
    // Best-effort cleanup, not awaited. A stray probe entry is harmless, and a
    // delete failure must never downgrade a round-trip we already proved.
    invoke("secret_delete", { account }).catch(() => {});
    return keychainOk;
  })();
  return probePromise;
}

/** The in-memory key cache. Empty maps until loadSecretKeys() resolves. */
export function getCachedSecretKeys() {
  return cache;
}

/** True once a written value has been read back intact — gates stripping localStorage. */
export function keychainAvailable() {
  return keychainOk;
}

export function isLoaded() {
  return loaded;
}

// ---------------------------------------------------------------- reads

/** Read the v1 index. The four outcomes are DIFFERENT, and collapsing them into
 *  one null is how a key on disk becomes a key nobody can find:
 *
 *    ok      — v1 exists; `ids` is what it holds. `[]` is meaningful and NOT the
 *              same as absent: v1 exists and holds no providers (e.g. only the
 *              legacy key).
 *    absent  — the read SUCCEEDED and there is no index: v1 never written.
 *    error   — the read THREW. We know nothing at all. Treating this as "empty"
 *              is what let ONE transient failure rewrite the index down to the
 *              single provider a save happened to be touching, stranding every
 *              other entry on disk with nothing left to enumerate it.
 *    corrupt — the read succeeded and the value is not a JSON id array. It holds
 *              no ids to lose, so it is safe (and necessary — otherwise saves
 *              refuse forever) to rebuild from the catalog and overwrite. */
async function readIndex() {
  let raw;
  try {
    raw = await invoke("secret_get", { account: INDEX_ACCOUNT });
  } catch {
    return { state: "error", ids: [] };
  }
  if (!raw) return { state: "absent", ids: [] };
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return { state: "corrupt", ids: [] };
  }
  if (!Array.isArray(arr)) return { state: "corrupt", ids: [] };
  // Deduped on read so the size comparisons in applyOps stay exact.
  return { state: "ok", ids: [...new Set(arr.filter((x) => typeof x === "string" && x))] };
}

async function writeIndex(ids) {
  await invoke("secret_set", { account: INDEX_ACCOUNT, secret: JSON.stringify([...ids]) });
}

/** Which provider entries actually EXIST on disk, found by probing the catalog.
 *  The keychain offers no enumeration (get/set/delete by account only), so this
 *  is the ONLY enumeration that does not depend on the index being intact. */
async function probeStoredIds() {
  const found = await Promise.all(
    KNOWN_PROVIDER_IDS.map(async (id) => {
      try {
        const v = await invoke("secret_get", { account: providerAccount(id) });
        return typeof v === "string" && v ? id : null;
      } catch {
        return null; // unreadable right now, not proof of absence
      }
    }),
  );
  return found.filter(Boolean);
}

/** Write an index that names every entry we just read off disk. UNION only: an
 *  id whose entry we could not read this time stays, because dropping it is
 *  exactly how a key becomes unreachable. Never runs on an `error` index, where
 *  we cannot prove the set we would write is a superset of the truth, and never
 *  narrows — deletes narrow the index explicitly, in applyOps. Best-effort: the
 *  index is advisory, so failing to tidy it must not fail the load. */
async function repairIndex(idx, found) {
  if (idx.state === "error" || !found.length) return;
  if (idx.state === "ok" && found.every((id) => idx.ids.includes(id))) return;
  try {
    await writeIndex(new Set([...idx.ids, ...found]));
  } catch {
    /* advisory: every load can still probe the catalog */
  }
}

/** Read the per-provider entries named by the index. One unreadable entry is
 *  skipped rather than failing the whole load: a locked or missing entry must
 *  cost the user that one provider, not all of them. A skipped provider is also
 *  absent from `persisted`, so a later save can never mistake it for a delete. */
async function readV1(ids) {
  const out = { providerKeys: {}, anthropicKey: "" };
  const got = await Promise.all(
    ids.map(async (id) => {
      try {
        return [id, await invoke("secret_get", { account: providerAccount(id) })];
      } catch {
        return [id, null];
      }
    }),
  );
  for (const [id, v] of got) if (typeof v === "string" && v) out.providerKeys[id] = v;
  try {
    const legacy = await invoke("secret_get", { account: LEGACY_ACCOUNT });
    if (typeof legacy === "string") out.anthropicKey = legacy;
  } catch {
    /* one unreadable entry, not a failed load */
  }
  return out;
}

/** Read the pre-v1 blob. Kept for one release: a migration that was interrupted
 *  (or whose readback did not verify) leaves v0 in place on purpose, and the
 *  next launch has to find it. */
async function readV0() {
  try {
    const raw = await invoke("secret_get", { account: V0_ACCOUNT });
    return raw ? normalize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** One-time v0 -> v1 split. Safe to interrupt at ANY point, and safe to re-run:
 *
 *   1. Index first. A crash before the entry lands leaves an id pointing at
 *      nothing, which readV1 skips — a dangling id, never a lost key.
 *   2. Entries next. A crash here leaves some entries written and v0 intact.
 *   3. Read EVERY entry back and compare byte-for-byte. Only a fully verified
 *      split earns step 4 — a successful set is not proof of persistence (the
 *      mock keyring backend "succeeds" while storing nothing).
 *   4. Delete v0, the last step and the only destructive one.
 *
 *  So the worst interruption leaves both copies, and the next load merges them
 *  (v1 wins per key, v0 fills the gaps) and retries. There is no ordering here
 *  that produces an empty key set. */
async function splitToV1(merged) {
  const ids = Object.keys(merged.providerKeys);
  const writes = ids.map((id) => ({ account: providerAccount(id), secret: merged.providerKeys[id] }));
  if (merged.anthropicKey) writes.push({ account: LEGACY_ACCOUNT, secret: merged.anthropicKey });

  let verified = true;
  try {
    // Unioned with a fresh read, never a bare overwrite: another window may have
    // widened the index for a provider this split never knew about.
    const fresh = await readIndex();
    await writeIndex(new Set([...fresh.ids, ...ids]));
  } catch {
    verified = false;
  }
  const wrote = await Promise.allSettled(writes.map((w) => invoke("secret_set", w)));
  if (wrote.some((r) => r.status === "rejected")) verified = false;

  if (verified) {
    const back = await Promise.allSettled(writes.map((w) => invoke("secret_get", { account: w.account })));
    verified = back.every((r, i) => r.status === "fulfilled" && r.value === writes[i].secret);
  }
  if (verified) {
    try {
      await invoke("secret_delete", { account: V0_ACCOUNT });
    } catch {
      /* v0 survives; the next load reconciles it and retries the delete */
    }
  }
  return merged;
}

/** Everything the keychain holds, migrating v0 forward on the way. Returns null
 *  when nothing is stored at all (distinct from "stored and empty").
 *
 *  The enumeration is deliberately NOT the index alone. An index that was
 *  narrowed by a transient read failure, corrupted, or lost a race between two
 *  windows would otherwise make perfectly good entries unreachable forever, and
 *  no amount of care at write time can undo damage an older build already did.
 *  So the catalog is probed too, and the index is repaired from what is found. */
async function readAll() {
  const idx = await readIndex();
  // Probe the whole catalog on this window's FIRST load (the recovery path for
  // an already-damaged index) and on any load where the index is not readable.
  // Later refreshes trust a readable index, which the repair below keeps honest,
  // so a storage event does not cost a read per provider.
  const ids = new Set(idx.ids);
  if (!rebuiltOnce || idx.state !== "ok") {
    for (const id of KNOWN_PROVIDER_IDS) ids.add(id);
    rebuiltOnce = true; // set with the decision, not after the await
  }
  // Providers this window already knows about are re-read whatever the index
  // says, so a refresh can never drop one it is currently holding.
  for (const id of Object.keys(cache.providerKeys)) ids.add(id);
  for (const id of Object.keys(persisted.providerKeys)) ids.add(id);

  const fromV1 = await readV1([...ids]);
  const found = Object.keys(fromV1.providerKeys);

  const legacy = await readV0();
  if (legacy) {
    // v1 is the newer store, so it wins per key; v0 fills the gaps left by an
    // interrupted split. Then re-run the split so v0 finally goes away (which
    // rewrites the index itself, so no repair pass is needed here).
    return splitToV1({
      providerKeys: { ...legacy.providerKeys, ...fromV1.providerKeys },
      anthropicKey: fromV1.anthropicKey || legacy.anthropicKey || "",
    });
  }
  await repairIndex(idx, found);
  // "Something is stored" is now a question about the ENTRIES, not the index: a
  // readable index says yes even when empty, and entries found without one say
  // yes as well. Anything else is "nothing readable", and the caller leaves the
  // cache alone rather than showing the user an empty key list.
  return idx.state === "ok" || found.length || fromV1.anthropicKey ? fromV1 : null;
}

/** Take a provider (or the legacy key) out of a v0 blob that is still on disk.
 *
 *  v0 only survives when a migration's readback did not verify, and every load
 *  merges it back in. That merge RESURRECTED a key the user had deliberately
 *  revoked, and injected it into every shell spawned afterwards. v0 is only ever
 *  SHRUNK here and only after the v1 delete succeeded, so an incomplete v1 side
 *  can still be filled from it: no path here can lose a key. */
async function pruneV0(removedIds, dropLegacy) {
  if (!removedIds.size && !dropLegacy) return;
  let raw;
  try {
    raw = await invoke("secret_get", { account: V0_ACCOUNT });
  } catch {
    return; // unreadable: leave it. A later verified split deletes it outright.
  }
  if (!raw) return;
  let blob;
  try {
    blob = normalize(JSON.parse(raw));
  } catch {
    return; // unparseable v0 cannot resurrect anything — readV0 skips it too
  }
  let touched = false;
  for (const id of removedIds) {
    if (blob.providerKeys[id] !== undefined) {
      delete blob.providerKeys[id];
      touched = true;
    }
  }
  if (dropLegacy && blob.anthropicKey) {
    blob.anthropicKey = "";
    touched = true;
  }
  if (!touched) return;
  try {
    if (!Object.keys(blob.providerKeys).length && !blob.anthropicKey) {
      await invoke("secret_delete", { account: V0_ACCOUNT });
    } else {
      await invoke("secret_set", { account: V0_ACCOUNT, secret: JSON.stringify(blob) });
    }
  } catch {
    // Best-effort on purpose. The key is already gone from v1, and every load
    // re-runs the split, which retires v0 outright once it verifies. Failing the
    // save here would restore the plaintext copy and warn the user about a write
    // that actually succeeded.
  }
}

/** One reconciliation pass. Returns false when it declined to reconcile because
 *  a save was in flight, so the caller can try again once the queue drains. */
async function reloadOnce() {
  // Set whatever this pass decides: the cache is usable either way, and on the
  // deferred path it is usable BECAUSE it is the copy holding the user's newest
  // values.
  loaded = true;
  try {
    const got = await readAll();
    if (got) {
      if (pendingSaves) {
        // A save is in flight, so this read is a snapshot of a moving target and
        // TWO things must not happen here:
        //
        //  • `cache` must not be assigned: it holds the key the user just typed,
        //    which the keychain does not have YET. Overwriting it took the key
        //    out of the UI, and then the next save diffed it straight back off
        //    the disk — the pasted key was gone, entry and all.
        //
        //  • `persisted` must not be assigned either. It is the baseline the
        //    in-flight save diffs against, and folding another window's changes
        //    into it turns this window's unrelated save into a REVERT of that
        //    window's rotation, or into a DELETE of a provider it just added
        //    (the other window's id is suddenly in the baseline and not in this
        //    window's `next`, which is precisely the shape of a delete).
        //
        // So reconcile after the queue drains instead — see reload.
        return false;
      }
      cache = normalize(got);
      // Only from what was actually READ. Baselining off the cache instead
      // recorded a FAILED write as persisted (cache runs ahead of the keychain
      // by design), and the retry the next save owed the user never happened.
      persisted = snapshot(cache);
    }
  } catch {
    /* keychain unavailable — leave cache + keychainOk as-is */
  }
  return true;
}

async function reload() {
  await probeKeychain();
  // Bounded retry, not a loop: a window saving continuously must not trap a
  // refresh here. The cache keeps the user's own newest values either way, and
  // the next storage event or launch reconciles what this pass could not.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await queue(() => reloadOnce())) break;
  }
  return cache;
}

/** Load keys from the keychain into the cache. Best-effort; on failure the cache
 *  is left as-is and keychainAvailable() stays false (callers keep their copy). */
export function loadSecretKeys() {
  return reload();
}

/** Re-read the keychain because ANOTHER WINDOW changed it. The cross-window
 *  storage handler used to overlay its own module cache, which is exactly the
 *  copy that is stale in that moment: window B would keep showing (and then
 *  re-writing) the key window A had just rotated away. Async on purpose — the
 *  caller must not block a DOM event handler on a keychain round-trip. */
export function refreshSecretKeys() {
  return reload();
}

// ---------------------------------------------------------------- writes

/** The per-provider operations that take `base` to `next`. Empty when nothing
 *  changed, which is the whole point: an unrelated user-state save must not
 *  touch the keychain at all. */
function diffOps(base, next) {
  const ops = [];
  const ids = new Set([...Object.keys(base.providerKeys), ...Object.keys(next.providerKeys)]);
  for (const id of ids) {
    const before = base.providerKeys[id];
    const after = next.providerKeys[id];
    if (before === after) continue;
    // Note a delete comes from "in the BASELINE and not in next", never from
    // "stored and not in next": a stale window cannot delete a provider another
    // window added, because it never knew about it.
    if (after === undefined) ops.push({ kind: "delete", id });
    else ops.push({ kind: "set", id, value: after });
  }
  if (base.anthropicKey !== next.anthropicKey) {
    ops.push(next.anthropicKey ? { kind: "legacy-set", value: next.anthropicKey } : { kind: "legacy-delete" });
  }
  return ops;
}

async function runOp(op) {
  if (op.kind === "set" || op.kind === "legacy-set") {
    const account = op.kind === "set" ? providerAccount(op.id) : LEGACY_ACCOUNT;
    // Reconcile per provider before writing. Another window may already have
    // written this exact value, in which case the write is pure risk (it can
    // fail, and a failure is surfaced to the user) for no change.
    let current;
    try {
      current = await invoke("secret_get", { account });
    } catch {
      current = undefined; // unreadable: fall through and write
    }
    if (current === op.value) return;
    await invoke("secret_set", { account, secret: op.value });
    return;
  }
  const account = op.kind === "delete" ? providerAccount(op.id) : LEGACY_ACCOUNT;
  // Another window may have deleted this entry already. A delete that finds
  // nothing there has achieved exactly what it was asked to do, and reporting it
  // as a failed write would put the plaintext copy back and tell the user their
  // key could not be saved. Only a READ that succeeds and returns nothing counts
  // as absent; an unreadable entry falls through to the delete.
  try {
    const current = await invoke("secret_get", { account });
    if (current === null || current === undefined || current === "") return;
  } catch {
    /* unreadable: attempt the delete anyway */
  }
  await invoke("secret_delete", { account });
}

function applyOpToBaseline(op) {
  if (op.kind === "set") persisted.providerKeys[op.id] = op.value;
  else if (op.kind === "delete") delete persisted.providerKeys[op.id];
  else if (op.kind === "legacy-set") persisted.anthropicKey = op.value;
  else if (op.kind === "legacy-delete") persisted.anthropicKey = "";
}

async function applyOps(ops) {
  const addIds = ops.filter((o) => o.kind === "set").map((o) => o.id);
  const idx = await readIndex();
  if (idx.state === "error") {
    // REFUSE. We cannot see the index, so we cannot widen it without also
    // narrowing it, and a narrowed index is a set of keys still sitting in the
    // credential store with nothing left to enumerate them. One transient read
    // here used to rewrite the index down to whatever this save was touching:
    // openai and groq became unreachable because the user added mistral. The
    // cost of refusing is one retry; the cost of proceeding was every other key.
    throw new Error("keychain index unreadable; nothing written (try again in a moment)");
  }
  // A corrupt index holds no ids to lose, so rebuild it from what is actually on
  // disk. Refusing here instead would leave the user permanently unable to save,
  // because corruption, unlike a transient read failure, does not heal itself.
  const stored = idx.state === "corrupt" ? await probeStoredIds() : idx.ids;
  const base = new Set(stored);

  // Widen the index BEFORE writing entries: a crash in between leaves a
  // dangling id (readV1 skips it, and the catalog probe finds the entry anyway)
  // rather than a key on disk that nothing knows to read. Narrowing happens
  // after, for the same reason in reverse.
  const widened = new Set([...base, ...addIds]);
  if (widened.size !== base.size || idx.state === "corrupt") await writeIndex(widened);

  // allSettled, not a sequential loop: one provider hitting the Credential
  // Manager size cap must not strand the providers queued behind it. Each op
  // that lands updates the baseline, so the ones that did NOT land stay pending
  // and the next save retries them.
  const results = await Promise.allSettled(ops.map((op) => runOp(op)));
  const failed = [];
  const added = new Set();
  const removed = new Set();
  let legacyRemoved = false;
  results.forEach((r, i) => {
    const op = ops[i];
    if (r.status !== "fulfilled") {
      failed.push(op.kind === "set" || op.kind === "delete" ? op.id : "anthropic");
      return;
    }
    applyOpToBaseline(op);
    if (op.kind === "set") added.add(op.id);
    else if (op.kind === "delete") removed.add(op.id);
    else if (op.kind === "legacy-delete") legacyRemoved = true;
  });

  if (added.size || removed.size) {
    // Re-read IMMEDIATELY before the final write and union, instead of seeding
    // from the read at the top of this function: between the two, another window
    // can widen the index for a provider this one has never heard of, and
    // seeding from the stale copy dropped that window's id and orphaned its key.
    const fresh = await readIndex();
    if (fresh.state === "ok" || fresh.state === "absent") {
      const final = new Set([...fresh.ids, ...added]);
      for (const id of removed) final.delete(id);
      const changed = final.size !== fresh.ids.length || fresh.ids.some((id) => !final.has(id));
      try {
        if (changed) await writeIndex(final);
      } catch {
        // The entries themselves are already written. A dangling id is harmless
        // and a missing one is recoverable by the catalog probe on the next
        // load, so failing the save over the tidy-up would restore plaintext and
        // warn about writes that succeeded.
      }
    }
    // error/corrupt: leave the index alone rather than write a set we cannot
    // prove is a superset of the truth. The next load rebuilds it.
  }

  // Only after the v1 delete actually landed, so an incomplete v1 side can still
  // be filled from v0 (finding 4).
  await pruneV0(removed, legacyRemoved);

  if (failed.length) {
    // Ids only, never key material — this string reaches a toast and the console.
    throw new Error(`keychain write failed for: ${failed.join(", ")}`);
  }
}

/** Mirror keys to the keychain and update the in-memory cache SYNCHRONOUSLY so
 *  spawn paths see the latest value immediately.
 *
 *  Returns a promise that RESOLVES when the delta is persisted and REJECTS when
 *  any provider's write failed. The caller (App.jsx/writeUserState) strips the
 *  plaintext copy on the synchronous happy path and restores it on rejection;
 *  swallowing the rejection, as this used to, meant a key the user could see in
 *  the UI existed nowhere on disk. keychainOk is NOT touched here: the keychain
 *  still works for smaller payloads, and flipping it globally would keep every
 *  later secret in plaintext. */
export function saveSecretKeys(providerKeys, anthropicKey) {
  const next = normalize({ providerKeys, anthropicKey });
  cache = next;
  // Covers the path where a save lands before any load: until the readback
  // proves persistence, keychainAvailable() stays false and the caller keeps its
  // plaintext copy. Erring toward a redundant local copy, never toward key loss.
  probeKeychain();
  // Counted SYNCHRONOUSLY, before the queue: a cross-window refresh whose read
  // is in flight right now has to see that the keychain is about to change, or
  // it reconciles against a snapshot that is already out of date and wipes the
  // key being typed. Decremented inside the queued body so it is settled before
  // anything else in the chain (including a deferred reload) runs.
  pendingSaves += 1;
  return queue(async () => {
    try {
      const ops = diffOps(persisted, next);
      if (!ops.length) return; // nothing changed: do not touch the keychain
      await applyOps(ops);
    } finally {
      pendingSaves -= 1;
    }
  });
}

/** Merge any legacy/in-memory keys with the keychain's, persist the delta back
 *  (AWAITED so the caller can safely strip plaintext only after this resolves),
 *  and update the cache. Throws if a keychain write fails. */
export async function migrateAndLoad(legacyProviderKeys, legacyAnthropicKey) {
  const fromChain = await reload();
  const merged = normalize({
    // keychain wins on overlap (source of truth post-migration); legacy fills gaps.
    providerKeys: { ...(legacyProviderKeys || {}), ...fromChain.providerKeys },
    anthropicKey: fromChain.anthropicKey || (typeof legacyAnthropicKey === "string" ? legacyAnthropicKey : "") || "",
  });
  await saveSecretKeys(merged.providerKeys, merged.anthropicKey);
  // NOTE: a successful write is deliberately NOT proof of persistence (the mock
  // store "succeeds" too) — keychainOk comes only from probeKeychain's readback.
  loaded = true;
  return cache;
}
