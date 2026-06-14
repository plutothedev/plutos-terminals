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

/** Decrypt a { iv, ct } blob. Throws CorruptBlobError on a malformed blob (the
 *  repo is user-controlled, so a truncated/garbage state.enc is plausible) and a
 *  WebCrypto OperationError on a wrong passphrase/salt — distinct so callers can
 *  tell "corrupt repo" from "wrong passphrase". */
export class CorruptBlobError extends Error {}

export async function decrypt(blob, passphrase, saltB64) {
  if (!blob || typeof blob.iv !== "string" || typeof blob.ct !== "string") {
    throw new CorruptBlobError("corrupt sync blob: missing iv/ct");
  }
  const key = await deriveKey(passphrase, saltB64);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(blob.iv) },
    key,
    fromB64(blob.ct)
  );
  return new TextDecoder().decode(pt);
}
