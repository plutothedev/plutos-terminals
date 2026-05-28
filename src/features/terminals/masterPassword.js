// (C)
// Optional master-password app lock. The password is never stored — only its
// SHA-256 hash (in user-state), and an "unlocked this session" flag lives in
// sessionStorage so it's asked once per app launch, not per render. This gates
// the UI only; SSH/API secrets remain in the OS keychain regardless.
const UNLOCK_KEY = "plutos-terminals:unlocked";

export async function hashPassword(pw) {
  const data = new TextEncoder().encode(pw);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
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
