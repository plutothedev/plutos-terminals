// (C)
// Optional master-password app lock. The password is never stored — only a
// salted PBKDF2-HMAC-SHA256 verifier (in user-state), and an "unlocked this
// session" flag lives in sessionStorage so it's asked once per launch.
//
// This gates the UI only; it is defense-in-depth, NOT a hard secret boundary —
// a local attacker with devtools/filesystem access can still bypass the
// client-side gate, and provider API keys now live in the OS keychain
// (secretVault) rather than behind this lock. The KDF here exists so the stored
// verifier can't be cheaply brute-forced if the localStorage blob is read.
const UNLOCK_KEY = "plutos-terminals:unlocked";
const PBKDF2_ITERS = 600000;

function toHex(u8) {
  return Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(h) {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
}
// Constant-time string compare — avoids leaking how many leading chars matched.
function ctEqHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2Hex(pw, salt, iterations) {
  const keyMat = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, keyMat, 256);
  return toHex(new Uint8Array(bits));
}
async function legacySha256Hex(pw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
  return toHex(new Uint8Array(buf));
}

// Produce a NEW verifier string: "pbkdf2$<iters>$<saltHex>$<hashHex>".
export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2Hex(pw, salt, PBKDF2_ITERS);
  return `pbkdf2$${PBKDF2_ITERS}$${toHex(salt)}$${hash}`;
}

// Verify a password against a stored verifier. Supports the new salted PBKDF2
// format AND the legacy unsalted-SHA-256 hex (so existing locks keep working;
// they upgrade to PBKDF2 the next time the password is set/changed).
export async function verifyPassword(pw, stored) {
  if (typeof stored !== "string" || !stored) return false;
  if (stored.startsWith("pbkdf2$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const iters = parseInt(parts[1], 10) || PBKDF2_ITERS;
    const derived = await pbkdf2Hex(pw, fromHex(parts[2]), iters);
    return ctEqHex(derived, parts[3]);
  }
  return ctEqHex(await legacySha256Hex(pw), stored); // legacy lock
}

export function isUnlockedThisSession() {
  try { return sessionStorage.getItem(UNLOCK_KEY) === "1"; } catch { return false; }
}

export function markUnlocked() {
  try { sessionStorage.setItem(UNLOCK_KEY, "1"); } catch { /* ignore */ }
}

export function clearUnlocked() {
  try { sessionStorage.removeItem(UNLOCK_KEY); } catch { /* ignore */ }
}
