// (C)
// At-rest storage for LLM provider API keys + the legacy Anthropic key.
//
// These keys are injected as env vars into spawned shells (see envForModel /
// resolveActiveLLM), so they MUST be readable in-memory by the renderer at spawn
// time — but they must NOT sit in plaintext localStorage, where a backup, another
// local process, or an XSS sink could read them. So we persist them in the OS
// keychain (the same store SSH creds use — vault.rs secret_set/get) under one
// JSON entry, and keep a small in-memory cache that the synchronous spawn paths
// (readUserSt) read from.
//
// Safety: localStorage keys are only stripped once the keychain has been PROVEN
// to persist (keychainAvailable(), see probeKeychain below). If the keychain is
// unavailable we keep the local copy rather than lose the user's keys.
import { invoke } from "../../backend.js";

const ACCOUNT = "llm-provider-keys:v0";
const PROBE_ACCOUNT = "keychain-probe:v0";

let cache = { providerKeys: {}, anthropicKey: "" };
let loaded = false;
let keychainOk = false;
let probePromise = null;

function normalize(obj) {
  return {
    providerKeys: obj && typeof obj.providerKeys === "object" && obj.providerKeys ? { ...obj.providerKeys } : {},
    anthropicKey: typeof (obj && obj.anthropicKey) === "string" ? obj.anthropicKey : "",
  };
}

function nonce() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
 *  The probe uses its own per-session account, never ACCOUNT: a second window
 *  writing real keys concurrently must not be able to fail (or pass) the probe. */
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

/** Load keys from the keychain into the cache. Best-effort; on failure the cache
 *  is left as-is and keychainAvailable() stays false (callers keep their copy). */
export async function loadSecretKeys() {
  // Awaited first: keychainAvailable() must be settled before any caller acts on
  // the result of this load by stripping its plaintext copy.
  await probeKeychain();
  try {
    const raw = await invoke("secret_get", { account: ACCOUNT });
    if (raw) cache = normalize(JSON.parse(raw));
  } catch {
    /* keychain unavailable — leave cache + keychainOk as-is */
  }
  loaded = true;
  return cache;
}

/** Merge any legacy/in-memory keys with the keychain's, persist the union back to
 *  the keychain (AWAITED so the caller can safely strip plaintext only after this
 *  resolves), and update the cache. Throws if the keychain write fails. */
export async function migrateAndLoad(legacyProviderKeys, legacyAnthropicKey) {
  const fromChain = await loadSecretKeys();
  const merged = {
    // keychain wins on overlap (source of truth post-migration); legacy fills gaps.
    providerKeys: { ...(legacyProviderKeys || {}), ...fromChain.providerKeys },
    anthropicKey: fromChain.anthropicKey || (typeof legacyAnthropicKey === "string" ? legacyAnthropicKey : "") || "",
  };
  await invoke("secret_set", { account: ACCOUNT, secret: JSON.stringify(merged) });
  // NOTE: a successful write is deliberately NOT proof of persistence (the mock
  // store "succeeds" too) — keychainOk comes only from probeKeychain's readback.
  cache = merged;
  loaded = true;
  return cache;
}

/** Mirror keys to the keychain (fire-and-forget for synchronous callers) and
 *  update the in-memory cache synchronously so spawn paths see the latest value. */
export function saveSecretKeys(providerKeys, anthropicKey) {
  cache = normalize({ providerKeys, anthropicKey });
  // Covers the path where a save lands before any load: until the readback
  // proves persistence, keychainAvailable() stays false and the caller keeps its
  // plaintext copy. Erring toward a redundant local copy, never toward key loss.
  probeKeychain();
  invoke("secret_set", { account: ACCOUNT, secret: JSON.stringify(cache) })
    .catch(() => { /* leave keychainOk so localStorage keeps the fallback copy */ });
}
