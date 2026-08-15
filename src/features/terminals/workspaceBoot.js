// (C)
// Boot-time workspace parsing that distinguishes a genuinely-absent / first-run
// blob from a CORRUPTED one, so boot can recover from the durable Rust backup
// instead of silently resetting the whole layout to empty (audit C2).
//
// corrupt === true ONLY when `raw` was a non-empty string that failed to parse
// (real corruption). Absent (null/""), or valid-but-non-object JSON like the
// Rust store's "null" sentinel, are treated as ordinary empty state, NOT
// corruption — those must not trigger a scary recovery path.
export function parseWorkspace(raw) {
  if (raw == null || raw === "") return { state: {}, corrupt: false };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return { state: parsed, corrupt: false };
    return { state: {}, corrupt: false };
  } catch {
    return { state: {}, corrupt: true };
  }
}
