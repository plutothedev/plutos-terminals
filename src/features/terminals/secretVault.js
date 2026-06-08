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
// Safety: localStorage keys are only stripped once a keychain write has been
// CONFIRMED to succeed (keychainAvailable()). If the keychain is unavailable we
// keep the local copy rather than lose the user's keys.
import { invoke } from "../../backend.js";

const ACCOUNT = "llm-provider-keys:v0";

let cache = { providerKeys: {}, anthropicKey: "" };
let loaded = false;
let keychainOk = false;

function normalize(obj) {
  return {
    providerKeys: obj && typeof obj.providerKeys === "object" && obj.providerKeys ? { ...obj.providerKeys } : {},
    anthropicKey: typeof (obj && obj.anthropicKey) === "string" ? obj.anthropicKey : "",
  };
}

/** The in-memory key cache. Empty maps until loadSecretKeys() resolves. */
export function getCachedSecretKeys() {
  return cache;
}

/** True once any keychain read/write has succeeded — gates stripping localStorage. */
export function keychainAvailable() {
  return keychainOk;
}

export function isLoaded() {
  return loaded;
}

/** Load keys from the keychain into the cache. Best-effort; on failure the cache
 *  is left as-is and keychainAvailable() stays false (callers keep their copy). */
export async function loadSecretKeys() {
  try {
    const raw = await invoke("secret_get", { account: ACCOUNT });
    keychainOk = true; // a successful get (even empty) means the keychain works
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
  keychainOk = true;
  cache = merged;
  loaded = true;
  return cache;
}

/** Mirror keys to the keychain (fire-and-forget for synchronous callers) and
 *  update the in-memory cache synchronously so spawn paths see the latest value. */
export function saveSecretKeys(providerKeys, anthropicKey) {
  cache = normalize({ providerKeys, anthropicKey });
  invoke("secret_set", { account: ACCOUNT, secret: JSON.stringify(cache) })
    .then(() => { keychainOk = true; })
    .catch(() => { /* leave keychainOk so localStorage keeps the fallback copy */ });
}
