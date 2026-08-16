// (C)
// Per-field last-write-wins merge for the cross-window user-state sync (audit
// M10). Two windows editing DIFFERENT userSt fields near-simultaneously used to
// clobber each other: the `storage` event handler replaced this window's whole
// userSt with the other window's blob. Now each field carries a last-write
// timestamp in `_fieldMeta`, and a cross-window update merges field-by-field —
// the newer write of each field wins, so independent edits both survive.
//
// Mirrors the LWW-by-timestamp shape already used for cloud sync in
// sync/merge.js (mergeScalars), specialized to userSt's flat shape.
//
// Keychain fields are NEVER merged by timestamp: they're mirrored to the OS
// keychain and stripped from the localStorage blob, so the cross-window handler
// re-overlays them from the in-memory keychain cache AFTER this merge. ONE
// canonical list, shared with App.jsx's writeUserState (review M10 #3).
import { SECRET_FIELDS as KEYCHAIN_FIELDS } from "./storageKeys.js";
export { KEYCHAIN_FIELDS };

// Deterministic, symmetric tie-break for equal timestamps (same rationale as
// sync/merge.js L6): without it, two windows that wrote the same field at the
// same millisecond would each keep their own value and diverge forever.
function stableCmp(a, b) {
  const sa = JSON.stringify(a) ?? "";
  const sb = JSON.stringify(b) ?? "";
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function changed(a, b) {
  // Shallow value identity via JSON — userSt fields are primitives or small
  // plain objects (sync config), so this is exact and cheap.
  return (JSON.stringify(a) ?? "") !== (JSON.stringify(b) ?? "");
}

// Stamp `_fieldMeta[k] = now` for every NON-keychain field whose value changed
// between prev and next. Returns a new object; never mutates its inputs.
export function stampFieldMeta(prev, next, now) {
  const p = prev || {};
  const n = next || {};
  // p (userStRef.current, always fresh) wins for unchanged fields' timestamps;
  // n only fills fields p lacks. Spreading p LAST stops a stale-closure save
  // (next captured off an old render) from rolling a field's stamp BACKWARD and
  // letting an already-lost edit win the next cross-window merge (review M10 #4).
  const meta = { ...(n._fieldMeta || {}), ...(p._fieldMeta || {}) };
  const keys = new Set([...Object.keys(p), ...Object.keys(n)]);
  keys.delete("_fieldMeta");
  for (const k of keys) {
    if (KEYCHAIN_FIELDS.includes(k)) continue; // keychain-backed, not user-timestamped
    if (changed(p[k], n[k])) meta[k] = now;
  }
  return { ...n, _fieldMeta: meta };
}

// Merge a REMOTE userSt blob (from another window's storage event) onto LOCAL,
// field-by-field, newer `_fieldMeta` timestamp winning. Keychain fields are
// carried from LOCAL untouched (the caller overlays the keychain cache after).
// Missing timestamps read as 0 (oldest), so a pre-M10 blob with no _fieldMeta
// loses every contested field to a stamped local edit — the safe direction.
export function mergeUserState(local, remote) {
  const l = local || {};
  const r = remote || {};
  const lMeta = l._fieldMeta || {};
  const rMeta = r._fieldMeta || {};
  const out = {};
  const meta = {};
  const keys = new Set([...Object.keys(l), ...Object.keys(r)]);
  keys.delete("_fieldMeta");
  for (const k of keys) {
    if (KEYCHAIN_FIELDS.includes(k)) {
      // Never timestamp-merge a secret. Normally (keychain available) the blob
      // is stripped so remote carries nothing and this is just "keep local".
      // But when the keychain is UNAVAILABLE the blob keeps plaintext secrets
      // (writeUserState only strips when keychainAvailable()), and a key added
      // in another window arrives via remote — so UNION rather than discard it,
      // local winning conflicts, remote filling gaps (review M10 #1, restoring
      // the pre-M10 handler's union). The caller re-overlays the keychain cache
      // on top of this in the keychain-available path.
      const lv = l[k];
      const rv = r[k];
      const lObj = lv && typeof lv === "object" && !Array.isArray(lv);
      const rObj = rv && typeof rv === "object" && !Array.isArray(rv);
      if (lObj || rObj) {
        out[k] = { ...(rObj ? rv : {}), ...(lObj ? lv : {}) };
      } else if (lv !== undefined || rv !== undefined) {
        out[k] = lv || rv; // scalar secret: local preferred, remote fallback
      }
      continue;
    }
    const lt = lMeta[k] ?? 0;
    const rt = rMeta[k] ?? 0;
    // Remote wins if strictly newer, or on an exact tie where its value wins the
    // stable compare (the mirror decision runs on the other window → both
    // converge on the same value).
    const tieToRemote = rt === lt && k in r
      && (!(k in l) || (changed(l[k], r[k]) && stableCmp(r[k], l[k]) > 0));
    if (rt > lt || tieToRemote) {
      if (k in r) out[k] = r[k];
      meta[k] = rt;
    } else {
      if (k in l) out[k] = l[k];
      const m = Math.max(lt, rt);
      if (m > 0) meta[k] = m;
    }
  }
  out._fieldMeta = meta;
  return out;
}
