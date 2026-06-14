// (C)
// The synced surface: the single source of truth for WHAT cloud-sync touches.
// Portable config only. API keys (providerKeys/anthropicKey) and per-window
// workspace layout are excluded AT THE SOURCE — extractSynced never reads them,
// so a leak can't happen by a later filter being forgotten. The per-field
// timestamp map lives in userSt._syncMeta (stamped in App.saveUser).

// Scalar preference fields that participate in sync.
export const SYNCED_FIELDS = [
  "headerSkin",
  "themeFollowOS",
  "themeDark",
  "themeLight",
  "keybindings",
  "activeModel",
  "welcomeDone",
  "promptEditor",
];

// Id-keyed collections. Each maps userSt key -> array of {id, _updatedAt, ...}.
export const SYNCED_COLLECTIONS = ["workflows", "customThemes", "macros"];

const META_KEY = "_syncMeta";

/** Read the synced surface out of a live user-prefs object into merge shape. */
export function extractSynced(userSt = {}) {
  const meta = userSt[META_KEY] || {};
  const fields = {};
  const fieldMeta = {};
  for (const k of SYNCED_FIELDS) {
    if (k in userSt) {
      fields[k] = userSt[k];
      if (k in meta) fieldMeta[k] = meta[k];
    }
  }
  const collections = {};
  for (const name of SYNCED_COLLECTIONS) {
    const arr = userSt[name];
    if (Array.isArray(arr)) collections[name] = arr;
  }
  return { fields, fieldMeta, collections };
}

/** Write a merged surface back, preserving every non-synced field. */
export function applySynced(userSt = {}, merged) {
  const next = { ...userSt };
  for (const k of Object.keys(merged.fields)) next[k] = merged.fields[k];
  for (const name of SYNCED_COLLECTIONS) {
    if (merged.collections[name]) next[name] = merged.collections[name];
  }
  next[META_KEY] = { ...(userSt[META_KEY] || {}), ...merged.fieldMeta };
  return next;
}
