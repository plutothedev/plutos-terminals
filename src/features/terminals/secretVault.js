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
// Whether `persisted` has been set from a read of the keychain yet. Until it
// has, it holds only what this window's own writes confirmed, so for any other
// key it cannot tell whether another window changed it (see keepUnsaved).
let baselineRead = false;
// What the last read of the keychain returned, less any key a save has changed
// since. Unlike `persisted`, a write does not add to it: on a keychain that
// could not be proven to keep what it is given, a read that returned a key is
// the only proof the key is there (keysReadFromKeychain).
let readBack = { providerKeys: {}, anthropicKey: "" };
let loaded = false;
let keychainOk = false;
let probePromise = null;
// Saves handed out but not yet finished. Counted so a cross-window refresh can
// tell "the keychain is settled" from "the keychain is mid-change and the cache
// holds a value the user typed that is not on disk yet". See reloadOnce.
let pendingSaves = 0;
// How many launch loads (migrateAndLoad) are running; React's StrictMode runs
// App's mount effect twice in development, so it is a count. App merges the
// keychain's keys into its state only once that load succeeds, so until then
// a save carries state that may not hold them: such a save may delete only a
// key this window's state has held since the load began (launchHeld), never
// one App has not merged yet (see saveSecretKeys). A load that fails leaves
// the guard up for the session, since App then shows only what the cache
// holds (showCachedSecretKeys), which need not be every key the keychain has.
let launching = 0;
// What this window's state has held since the launch load began: the keys it
// started with (the plaintext ones App passed in) and every key a save of its
// own has carried. A removal needs the key on screen first, so these are the
// only keys a save made during the load can mean to delete.
let launchHeld = { ids: new Set(), legacy: false };
// What this window's state has dropped during the load: held keys a later save
// no longer carried. That is what a removal looks like; a save from state older
// than a refresh looks the same and is read the same way. The load's own write
// leaves these out and deletes them, so a plaintext key removed while the load
// is still reading the keychain does not come back with the migration.
let launchDropped = { ids: new Set(), legacy: false };
// Whether this window has probed the whole catalog at least once. The first
// load always does, so an install whose index an older build narrowed recovers
// on the next launch rather than staying broken forever.
let rebuiltOnce = false;
// What the keychain held for a key ("" for nothing) when a write of this
// window's for it last failed, as read just before that write. Until a read
// answers for the key again, that is what this window last knew there
// (lastKnown), newer than `persisted`.
const lastTried = { providerKeys: new Map(), anthropicKey: undefined };
// Whether the last read found no pre-v1 blob (v0). Until a read has, an entry
// found empty may still have a value there, which every read merges in
// (readAll), so an empty entry says nothing of what the keychain holds.
let v0Gone = false;
// Values this window holds unsaved that another window has since replaced or
// removed in the keychain (see runOp). Never written, never given a plaintext
// copy, and dropped at the next read that answers for the key: the newer
// write stands, even if it is itself removed later.
const overruled = { providerKeys: new Map(), anthropicKey: undefined };
// The keys every read so far could not answer for (the entry's read threw).
// Once a read has answered for a key, this window has seen it.
let unobserved = { ids: new Set(), legacy: false };
// The keys whose value this window's user typed (a save of this window's,
// not the launch load's merge of a plaintext copy). Only asked of a key no
// read has answered for (knows).
const typedHere = { ids: new Set(), legacy: false };
// The plaintext keys App's state held when the launch load began. A save made
// during the load that carries one of them unchanged is App's state, not the
// user's typing (typedHere).
const launchPlain = { ids: new Map(), legacy: "" };

// A record's entry for a provider id, or for the standalone key when `id` is
// null; setting undefined clears it.
function recorded(rec, id) {
  return id === null ? rec.anthropicKey : rec.providerKeys.get(id);
}
function record(rec, id, value) {
  if (id === null) rec.anthropicKey = value;
  else if (value === undefined) rec.providerKeys.delete(id);
  else rec.providerKeys.set(id, value);
}
function forget(id) {
  record(lastTried, id, undefined);
  record(overruled, id, undefined);
}

// What this window last knew the keychain held for a key: what its last
// failed write of it found there, or else its baseline. undefined for a
// provider it knows nothing of.
function lastKnown(id) {
  const tried = recorded(lastTried, id);
  if (tried !== undefined) return tried;
  return id === null ? persisted.anthropicKey : persisted.providerKeys[id];
}

// Whether this window has seen what the keychain holds for a key: a read
// answered for it, or a write of its own landed there or looked first. Where
// it has not, it knows nothing to compare with: what the keychain holds may
// be an older copy it never saw, and its own value is the newer.
function observed(id) {
  if (recorded(lastTried, id) !== undefined) return true;
  if (id === null) return persisted.anthropicKey !== "" || (baselineRead && !unobserved.legacy);
  return persisted.providerKeys[id] !== undefined || (baselineRead && !unobserved.ids.has(id));
}

// Whether what the keychain holds for a key can overrule the value this
// window holds for it: the window has seen the key (observed), or its value
// is a plaintext copy the launch load merged in rather than one its user
// typed here, which gives way to the keychain as the launch merge itself
// does. Only a value typed here, for a key never seen, stays over what this
// window cannot place in time.
function knows(id) {
  if (observed(id)) return true;
  return baselineRead && !(id === null ? typedHere.legacy : typedHere.ids.has(id));
}

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
      const echo = await invoke("secret_get", { account });
      keychainOk = echo === sentinel;
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

// Settles when the first read of the keychain has FINISHED, keys or not (an
// unavailable keychain settles it too). isLoaded() turns true when that read
// starts, not when the keys are in. Until it finishes, the cache is empty even
// for a user with saved keys, because localStorage no longer holds them once
// the keychain does: a pane restored at launch used to start its shell before
// the read finished, and so without the user's keys. Such a pane waits here
// (keysReady), bounded so a slow keychain cannot hold shells back: every pane
// shares one deadline, set by the first to ask, so the shells restored at
// launch wait that long at most in all, and none waits once it has passed.
let firstReadSettled = false;
let firstReadDone = () => {};
const firstRead = new Promise((resolve) => {
  firstReadDone = resolve;
});
let launchDeadline = null;

/** True once the first keychain read has finished. */
export function keysSettled() {
  return firstReadSettled;
}

/** Resolves when the first keychain read has finished, or at the launch
 *  deadline (`timeoutMs` after the first call); never rejects. */
export function keysReady(timeoutMs) {
  if (firstReadSettled) return Promise.resolve();
  if (!launchDeadline) launchDeadline = new Promise((resolve) => setTimeout(resolve, timeoutMs));
  return Promise.race([firstRead, launchDeadline]);
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
 *  cost the user that one provider, not all of them. An entry that could not be
 *  read is not one that is absent, so the ones whose read threw are named
 *  (`unanswered`, and `legacyUnanswered` for the standalone key): a refresh
 *  keeps what this window knew of them (reloadOnce), and readAll does not take
 *  the keychain for empty. */
async function readV1(ids) {
  const out = { providerKeys: {}, anthropicKey: "", unanswered: [], legacyUnanswered: false };
  const got = await Promise.all(
    ids.map(async (id) => {
      try {
        return [id, await invoke("secret_get", { account: providerAccount(id) })];
      } catch {
        out.unanswered.push(id);
        return [id, null];
      }
    }),
  );
  for (const [id, v] of got) if (typeof v === "string" && v) out.providerKeys[id] = v;
  try {
    const legacy = await invoke("secret_get", { account: LEGACY_ACCOUNT });
    if (typeof legacy === "string") out.anthropicKey = legacy;
  } catch {
    out.legacyUnanswered = true; // one unreadable entry, not a failed load
  }
  return out;
}

/** Read the pre-v1 blob. Kept for one release: a migration that was interrupted
 *  (or whose readback did not verify) leaves v0 in place on purpose, and the
 *  next launch has to find it. null when there is none (or none that parses),
 *  undefined when the read itself failed. */
async function readV0() {
  let raw;
  try {
    raw = await invoke("secret_get", { account: V0_ACCOUNT });
  } catch {
    return undefined;
  }
  try {
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
  v0Gone = legacy === null;
  if (legacy) {
    // v1 is the newer store, so it wins per key; v0 fills the gaps left by an
    // interrupted split. Then re-run the split so v0 finally goes away (which
    // rewrites the index itself, so no repair pass is needed here).
    const split = await splitToV1({
      providerKeys: { ...legacy.providerKeys, ...fromV1.providerKeys },
      anthropicKey: fromV1.anthropicKey || legacy.anthropicKey || "",
    });
    // The merge no longer says which entries could not be read: name them,
    // or this read would count as having seen them (reloadOnce).
    return { ...split, unobservedIds: fromV1.unanswered, unobservedLegacy: fromV1.legacyUnanswered };
  }
  await repairIndex(idx, found);
  // "Something is stored" is now a question about the ENTRIES, not the index: a
  // readable index says yes even when empty, and entries found without one say
  // yes as well. So does a keychain that answered every read with nothing: no
  // index, no entry, no v0, and no read that failed. That is a fresh install,
  // and an empty set is the truth about it, which this window needs as its
  // baseline (keepUnsaved), whether or not the self-test passed (a keychain
  // that keeps nothing holds nothing). Not once this window knows of a key
  // there (a read returned it, or a write of its own landed), though: an empty
  // answer then contradicts it, and the cache keeps what it has, as it always
  // did. Anything else is "nothing readable", and the caller leaves the cache
  // alone rather than showing the user an empty key list.
  const holdsLanded = Object.keys(persisted.providerKeys).length > 0 || persisted.anthropicKey !== "";
  const provenEmpty = !holdsLanded && idx.state === "absent"
    && !fromV1.unanswered.length && !fromV1.legacyUnanswered && legacy === null;
  return idx.state === "ok" || found.length || fromV1.anthropicKey || provenEmpty ? fromV1 : null;
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

/** What a read leaves in the cache: the keychain's keys, except where this
 *  window holds a value the keychain refused or never got (a write that
 *  failed), which the read cannot have. Dropping that value is how a refused
 *  key used to vanish: off the screen at the next refresh, out of every new
 *  shell, and out of plaintext at the next save, with nothing left to put it
 *  back.
 *
 *  Another window's write still wins: when this window has seen what the
 *  keychain held for that key (observed: a read answered for it, a write of
 *  its own landed, or a write of its own that failed looked first) and the
 *  keychain now holds something else, someone else has written it since.
 *  Where it has not (no read has answered for that key, and it never saved
 *  it), its own unsaved value stays: the user typed it after the keychain's
 *  copy was written. A value already overruled (see runOp) goes whatever the
 *  read holds. A delete that failed is not kept: the key is still in the
 *  keychain, and showing it again is the truth.
 *
 *  The cost, which this cannot avoid without a record of removals shared by
 *  the windows: a key the keychain refused, held unsaved by two windows and
 *  removed in one, stays in the other, which keeps showing it and putting its
 *  plaintext copy back. Dropping it at every refresh instead lost a refused
 *  key whenever any other window saved anything, which is the commoner case. */
function keepUnsaved(read) {
  const next = { providerKeys: { ...read.providerKeys }, anthropicKey: read.anthropicKey };
  // A saved value needs no case of its own: it is known, and the read either
  // still holds it or holds another window's newer write, which wins.
  for (const [id, value] of Object.entries(cache.providerKeys)) {
    if (overruled.providerKeys.get(id) === value) continue;
    if (knows(id) && (read.providerKeys[id] || "") !== (lastKnown(id) || "")) continue; // another window has written it since
    next.providerKeys[id] = value;
  }
  if (cache.anthropicKey && overruled.anthropicKey !== cache.anthropicKey
    && (!knows(null) || read.anthropicKey === lastKnown(null))) next.anthropicKey = cache.anthropicKey;
  return next;
}

/** Puts back in `after`, for the entries a read could not read (readV1: their
 *  read threw), what this window knew of them before the read (`before`). An
 *  unread entry is not an absent one; taken as absent, a saved key left the
 *  screen and every new shell, as if another window had removed it, until
 *  some later read happened to answer for it. (`after` never holds an unread
 *  entry of its own: the read skipped it.) */
function keepUnread(got, before, after) {
  for (const id of got.unanswered || []) {
    if (before.providerKeys[id] !== undefined) after.providerKeys[id] = before.providerKeys[id];
  }
  if (got.legacyUnanswered) after.anthropicKey = before.anthropicKey;
  return after;
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
      const read = normalize(got);
      cache = keepUnread(got, cache, keepUnsaved(read));
      // Only from what was actually READ. Baselining off the cache instead
      // recorded a FAILED write as persisted (cache runs ahead of the keychain
      // by design), and the retry the next save owed the user never happened.
      persisted = keepUnread(got, persisted, snapshot(read));
      readBack = keepUnread(got, readBack, snapshot(read));
      const wasRead = baselineRead;
      baselineRead = true;
      // What this read answered is what this window knows of those keys now,
      // so what an earlier failed write recorded of them is spent. A key an
      // earlier read answered for stays seen.
      const unread = new Set(got.unobservedIds || got.unanswered || []);
      const legacyUnread = !!(got.unobservedLegacy ?? got.legacyUnanswered);
      unobserved = {
        ids: new Set([...unread].filter((id) => !wasRead || unobserved.ids.has(id))),
        legacy: legacyUnread && (!wasRead || unobserved.legacy),
      };
      for (const rec of [lastTried, overruled]) {
        for (const id of [...rec.providerKeys.keys()]) if (!unread.has(id)) rec.providerKeys.delete(id);
        if (!legacyUnread) rec.anthropicKey = undefined;
      }
    }
  } catch {
    /* keychain unavailable — leave cache + keychainOk as-is */
  }
  return true;
}

// One refresh of the cache from the keychain; true when a pass actually read
// it (an unavailable keychain counts: reloadOnce then keeps the local copy).
// Bounded retry, not a loop: a window saving continuously must not trap a
// refresh here. The cache keeps the user's own newest values either way, and
// the next storage event or launch reconciles what this pass could not. Only
// a pass that read settles the first-read signal (keysReady): when a save
// deferred every pass, the cache has not seen the keychain and may hold none
// of the keys there.
async function reloadPasses() {
  await probeKeychain();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await queue(() => reloadOnce())) {
      if (!firstReadSettled) {
        firstReadSettled = true;
        firstReadDone();
      }
      return true;
    }
  }
  return false;
}
async function reload() {
  await reloadPasses();
  return cache;
}

/** Load keys from the keychain into the cache. Best-effort; on failure the cache
 *  is left as-is and keychainAvailable() stays false (callers keep their copy). */
export function loadSecretKeys() {
  return reload();
}

// While the launch guard is up, keys App puts on screen count as held: the
// user can see them, so a save without one of them is a removal.
function markShown(keys) {
  if (launching <= 0) return;
  for (const id of Object.keys(keys.providerKeys)) {
    launchHeld.ids.add(id);
    launchDropped.ids.delete(id);
  }
  if (keys.anthropicKey) {
    launchHeld.legacy = true;
    launchDropped.legacy = false;
  }
}

/** Re-read the keychain because ANOTHER WINDOW changed it. The cross-window
 *  storage handler used to overlay its own module cache, which is exactly the
 *  copy that is stale in that moment: window B would keep showing (and then
 *  re-writing) the key window A had just rotated away. Async on purpose — the
 *  caller must not block a DOM event handler on a keychain round-trip. */
export async function refreshSecretKeys() {
  const keys = await reload();
  // App's storage handler puts what a refresh read on screen.
  markShown(cache);
  return keys;
}

/** A copy of the cache, for App to show when the launch load failed. Every
 *  new shell already gets these keys (readUserSt overlays the cache), so
 *  Models and the menu bar have to show the same ones, or the user is routed
 *  with keys they can neither see nor remove. The guard stays up after a
 *  failed load, and these keys count as held under it, so they can be removed. */
export function showCachedSecretKeys() {
  markShown(cache);
  return { providerKeys: { ...cache.providerKeys }, anthropicKey: cache.anthropicKey };
}

/** Which of these keys the keychain does not hold, as far as this window
 *  knows: a write it refused (Windows Credential Manager caps a credential at
 *  2560 bytes) or never got to (an index it could not read). For those, a
 *  plaintext copy is the only copy there is; for every other key it is a leak.
 *  A key counts only while this window still holds it with that value, so one
 *  a later save removed or replaced is not brought back, and not once another
 *  window's newer write has overruled it (see runOp). Ids only: the caller
 *  has the values. */
export function keysNotInKeychain(providerKeys, anthropicKey) {
  const want = normalize({ providerKeys, anthropicKey });
  const ids = Object.keys(want.providerKeys).filter(
    (id) => persisted.providerKeys[id] !== want.providerKeys[id] && cache.providerKeys[id] === want.providerKeys[id]
      && overruled.providerKeys.get(id) !== want.providerKeys[id],
  );
  const legacy = want.anthropicKey !== ""
    && persisted.anthropicKey !== want.anthropicKey
    && cache.anthropicKey === want.anthropicKey
    && overruled.anthropicKey !== want.anthropicKey;
  return { ids, legacy };
}

/** Which of these keys the keychain holds with exactly this value, as far as
 *  this window knows (its reads, and its own writes that landed): a plaintext
 *  copy of one of them is a leak, whoever wrote it. Ids only. */
export function keysInKeychain(providerKeys, anthropicKey) {
  const have = normalize({ providerKeys, anthropicKey });
  return {
    ids: Object.keys(have.providerKeys).filter((id) => persisted.providerKeys[id] === have.providerKeys[id]),
    legacy: have.anthropicKey !== "" && persisted.anthropicKey === have.anthropicKey,
  };
}

/** Which of these keys the last read of the keychain returned with exactly
 *  this value. A write that "succeeded" does not count: a keychain that could
 *  not be proven to keep what it is given (keychainAvailable() false) may have
 *  kept nothing, and only a read that returned the key shows it is there.
 *  Ids only. */
export function keysReadFromKeychain(providerKeys, anthropicKey) {
  const have = normalize({ providerKeys, anthropicKey });
  return {
    ids: Object.keys(have.providerKeys).filter((id) => readBack.providerKeys[id] === have.providerKeys[id]),
    legacy: have.anthropicKey !== "" && readBack.anthropicKey === have.anthropicKey,
  };
}

// ---------------------------------------------------------------- writes

/** The per-provider operations that take `base` to `next`. Empty when nothing
 *  changed, which is the whole point: an unrelated user-state save must not
 *  touch the keychain at all. `deletable` is a launch-time save's limit (see
 *  saveSecretKeys): the ids it may delete, and whether it may delete the
 *  standalone key; null means anything. `typed` names the keys the save
 *  changed; any other value it writes is `carried`, held over from a write
 *  that failed (see runOp), and an overruled one is not written at all. */
function diffOps(base, next, deletable, typed) {
  const ops = [];
  const ids = new Set([...Object.keys(base.providerKeys), ...Object.keys(next.providerKeys)]);
  for (const id of ids) {
    const before = base.providerKeys[id];
    const after = next.providerKeys[id];
    if (before === after) continue;
    // Note a delete comes from "in the BASELINE and not in next", never from
    // "stored and not in next": a stale window cannot delete a provider another
    // window added, because it never knew about it.
    if (after === undefined) {
      if (!deletable || deletable.ids.has(id)) ops.push({ kind: "delete", id });
    }
    else if (typed.ids.has(id)) ops.push({ kind: "set", id, value: after, carried: false });
    else if (overruled.providerKeys.get(id) !== after) ops.push({ kind: "set", id, value: after, carried: true });
  }
  if (base.anthropicKey !== next.anthropicKey) {
    if (!next.anthropicKey) {
      if (!deletable || deletable.legacy) ops.push({ kind: "legacy-delete" });
    }
    else if (typed.legacy) ops.push({ kind: "legacy-set", value: next.anthropicKey, carried: false });
    else if (overruled.anthropicKey !== next.anthropicKey) ops.push({ kind: "legacy-set", value: next.anthropicKey, carried: true });
  }
  return ops;
}

async function runOp(op) {
  if (op.kind === "set" || op.kind === "legacy-set") {
    const account = op.kind === "set" ? providerAccount(op.id) : LEGACY_ACCOUNT;
    const id = op.kind === "set" ? op.id : null;
    // A value the user just typed is their newest, whatever an older one ran into.
    if (!op.carried) record(overruled, id, undefined);
    // Reconcile per provider before writing. Another window may already have
    // written this exact value, in which case the write is pure risk (it can
    // fail, and a failure is surfaced to the user) for no change.
    let current;
    let seen; // what the keychain holds ("" for nothing); undefined when the read cannot tell
    try {
      current = await invoke("secret_get", { account });
      seen = typeof current === "string" && current !== "" ? current : v0Gone ? "" : undefined;
    } catch {
      current = undefined; // unreadable: fall through and write
    }
    if (current === op.value) {
      forget(id);
      return;
    }
    // A carried value goes in only over what this window last knew was there.
    // Anything else was written since, by another window, which may never have
    // told this one (a save of keys alone fires no storage event): it is the
    // newer, and this value is overruled. It used to go in over it at the next
    // save of anything at all. Where the read cannot tell, or the value was
    // typed here for a key this window has never seen (knows), the write goes
    // ahead, as it always did.
    if (op.carried && seen !== undefined && knows(id) && seen !== (lastKnown(id) || "")) {
      record(overruled, id, op.value);
      record(lastTried, id, seen); // what the keychain holds now: a value typed after this compares with it
      return "overruled";
    }
    try {
      await invoke("secret_set", { account, secret: op.value });
    } catch (err) {
      // A read that could not tell leaves what an earlier failure saw.
      if (seen !== undefined) record(lastTried, id, seen);
      throw err;
    }
    forget(id);
    return;
  }
  const account = op.kind === "delete" ? providerAccount(op.id) : LEGACY_ACCOUNT;
  const id = op.kind === "delete" ? op.id : null;
  // Another window may have deleted this entry already. A delete that finds
  // nothing there has achieved exactly what it was asked to do, and reporting it
  // as a failed write would put the plaintext copy back and tell the user their
  // key could not be saved. Only a READ that succeeds and returns nothing counts
  // as absent; an unreadable entry falls through to the delete. Either way the
  // key is gone, so what an earlier failed write saw there no longer holds.
  try {
    const current = await invoke("secret_get", { account });
    if (current === null || current === undefined || current === "") {
      forget(id);
      return;
    }
  } catch {
    /* unreadable: attempt the delete anyway */
  }
  await invoke("secret_delete", { account });
  forget(id);
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
    if (r.value === "overruled") return; // not written, and not a failure: the newer write stands
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
  // Decided when the save is made, not when its turn in the queue comes: a
  // save made during the launch load may delete only what this window's state
  // held before it, even when it runs after the load has finished.
  let deletable = null;
  if (launching > 0) {
    deletable = { ids: new Set(launchHeld.ids), legacy: launchHeld.legacy };
    for (const id of deletable.ids) if (next.providerKeys[id] === undefined) launchDropped.ids.add(id);
    for (const id of Object.keys(next.providerKeys)) {
      launchHeld.ids.add(id);
      launchDropped.ids.delete(id);
    }
    if (deletable.legacy && !next.anthropicKey) launchDropped.legacy = true;
    if (next.anthropicKey) {
      launchHeld.legacy = true;
      launchDropped.legacy = false;
    }
  }
  return saveKeys(next, deletable);
}

// The save itself. A key a launch-time save may not delete stays in the cache
// as well as the keychain, so the cache always shows what the keychain will
// hold, and App's merge cannot drop it.
function saveKeys(next, deletable) {
  if (deletable) {
    for (const [id, value] of Object.entries(cache.providerKeys)) {
      if (next.providerKeys[id] === undefined && !deletable.ids.has(id)) next.providerKeys[id] = value;
    }
    if (!next.anthropicKey && !deletable.legacy && cache.anthropicKey) next.anthropicKey = cache.anthropicKey;
  }
  // A key this save changes or removes is no longer what the last read saw, so
  // that read stops vouching for it (keysReadFromKeychain) until another read
  // does. Here, when the save is made, because App decides the plaintext copy
  // in the same tick: a key removed and pasted straight back still counted as
  // read, so on a keychain that could not be proven its copy was left out, and
  // when the keychain refused the paste the key was in memory only. The cost
  // runs the safe way: a key changed and then changed back to the value the
  // read saw keeps a plaintext copy until the next read, as every key there
  // did before reads could vouch for any. Such a key is also the one the
  // user typed (`typed`); any other value this save writes is carried over
  // from a write that failed (see runOp). A save made while the launch load
  // runs (its own merge included) that carries a plaintext key App started
  // with changes keys too, but its user typed none of them here (`typedHere`,
  // see knows).
  const typed = { ids: new Set(), legacy: false };
  for (const id of new Set([...Object.keys(cache.providerKeys), ...Object.keys(next.providerKeys)])) {
    if (cache.providerKeys[id] === next.providerKeys[id]) continue;
    delete readBack.providerKeys[id];
    typed.ids.add(id);
    if (next.providerKeys[id] === undefined
      || (deletable && launchPlain.ids.get(id) === next.providerKeys[id])) typedHere.ids.delete(id);
    else typedHere.ids.add(id);
  }
  if (cache.anthropicKey !== next.anthropicKey) {
    readBack.anthropicKey = "";
    typed.legacy = true;
    typedHere.legacy = next.anthropicKey !== ""
      && !(deletable && launchPlain.legacy === next.anthropicKey);
  }
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
      const ops = diffOps(persisted, next, deletable, typed);
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
  const atMount = normalize({ providerKeys: legacyProviderKeys, anthropicKey: legacyAnthropicKey });
  if (launching === 0) {
    launchHeld = { ids: new Set(), legacy: false };
    launchDropped = { ids: new Set(), legacy: false };
  }
  for (const id of Object.keys(atMount.providerKeys)) {
    launchHeld.ids.add(id);
    if (!launchPlain.ids.has(id)) launchPlain.ids.set(id, atMount.providerKeys[id]);
  }
  if (atMount.anthropicKey) {
    launchHeld.legacy = true;
    if (!launchPlain.legacy) launchPlain.legacy = atMount.anthropicKey;
    // App's mount effect copies the standalone key into providerKeys.anthropic.
    if (atMount.providerKeys.anthropic === undefined && !launchPlain.ids.has("anthropic")) launchPlain.ids.set("anthropic", atMount.anthropicKey);
  }
  launching += 1;
  // No finally: a load that fails leaves the guard up (see `launching`).
  const result = await launchLoad(legacyProviderKeys, legacyAnthropicKey);
  launching -= 1;
  return result;
}
async function launchLoad(legacyProviderKeys, legacyAnthropicKey) {
  // App merges the keys this returns into its own state once, when it
  // resolves, so this first load has to read the keychain: a save landing in each of a
  // refresh's passes defers them all (reloadOnce), and the keys there would
  // stay out of this window for the whole session. Try again a few times,
  // backing off (1.5 s in all), then carry on with what the saves left.
  let read = await reloadPasses();
  for (let retry = 1; !read && retry <= 4; retry++) {
    await new Promise((resolve) => setTimeout(resolve, 150 * retry));
    read = await reloadPasses();
  }
  const fromChain = cache;
  const merged = normalize({
    // keychain wins on overlap (source of truth post-migration); legacy fills gaps.
    providerKeys: { ...(legacyProviderKeys || {}), ...fromChain.providerKeys },
    anthropicKey: fromChain.anthropicKey || (typeof legacyAnthropicKey === "string" ? legacyAnthropicKey : "") || "",
  });
  // Its own save, not one of App's: it records nothing as held, and it
  // leaves out and deletes only keys a save made while it ran no longer
  // carried (launchDropped; a read can have put such a key back in the cache).
  for (const id of launchDropped.ids) delete merged.providerKeys[id];
  if (launchDropped.legacy) merged.anthropicKey = "";
  await saveKeys(merged, { ids: new Set(launchDropped.ids), legacy: launchDropped.legacy });
  // NOTE: a successful write is deliberately NOT proof of persistence (the mock
  // store "succeeds" too) — keychainOk comes only from probeKeychain's readback.
  loaded = true;
  // A copy of the cache, which a save made during the load can only have
  // added to or changed (a key rotated meanwhile comes back rotated), never
  // emptied of a key App has not merged yet.
  return { providerKeys: { ...cache.providerKeys }, anthropicKey: cache.anthropicKey };
}
