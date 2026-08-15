// (C)
// Shared JSON.parse guard for localStorage-backed state (audit L2). Several
// call sites hand-rolled `try { JSON.parse(raw) } catch { fallback }`; this
// centralizes it so corrupt-blob handling is one behavior, and gives an
// optional onCorrupt hook for the sites that want to react (log, flag, recover)
// rather than swallow silently. The specialized corrupt-aware workspace parser
// (parseWorkspace, audit C2) stays separate — it also drives backup recovery.
export function safeParse(raw, { fallback = null, onCorrupt } = {}) {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    try { onCorrupt?.(e, raw); } catch { /* onCorrupt must never throw */ }
    return fallback;
  }
}

// Read + parse a localStorage key in one guarded step. Guards the ACCESS too
// (localStorage is undefined under node/tests, and can throw in locked-down
// webviews), which the bare safeParse above does not — callers that read at
// module load (e.g. ptyBridge history) would otherwise ReferenceError on import.
export function loadJSON(key, { fallback = null, onCorrupt } = {}) {
  let raw = null;
  try {
    if (typeof localStorage !== "undefined") raw = localStorage.getItem(key);
  } catch { /* no storage / access denied — treat as absent */ }
  return safeParse(raw, { fallback, onCorrupt });
}
