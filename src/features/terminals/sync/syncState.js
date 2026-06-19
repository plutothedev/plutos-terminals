// (C)
// The synced surface across THREE stores: userSt (shared prefs), st (per-window
// blob: workflows/skin/prompt-editor), and the macros localStorage array.
// Keys are namespaced "<store>.<name>" so merge.js stays generic. Timestamps +
// delete tombstones are DERIVED by diffing the current read against a stored
// snapshot (deriveLocal) — no per-write stamping anywhere in the app.
export const SOURCES = [
  { store: "userSt", fields: ["keybindings", "activeModel", "themeFollowOS", "themeDark", "themeLight"], collections: ["customThemes"] },
  { store: "st", fields: ["headerSkin", "promptEditor", "promptEditorVim"], collections: ["snippets"] },
  { store: "macros", fields: [], collections: ["macros"] },
];

const SYNC_META = ["_updatedAt", "_deletedAt"];
function idOf(item) { return item.id != null ? item.id : item.name; }
function stripMeta(item) { const o = { ...item }; for (const k of SYNC_META) delete o[k]; return o; }
function jsonEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function collArray(stores, store, name, src) {
  if (store === "macros") return Array.isArray(stores.macros) ? stores.macros : [];
  return Array.isArray(src[name]) ? src[name] : [];
}

/** Raw current values from all stores. stores = { userSt:{}, st:{}, macros:[array] }. */
export function readSurface(stores) {
  const fields = {}, collections = {};
  for (const s of SOURCES) {
    const src = s.store === "macros" ? {} : (stores[s.store] || {});
    for (const f of s.fields) { if (f in src) fields[`${s.store}.${f}`] = src[f]; }
    for (const c of s.collections) collections[`${s.store}.${c}`] = collArray(stores, s.store, c, src);
  }
  return { fields, collections };
}

/** A merged surface (with meta + tombstones) -> per-store patches for live persistence.
 *  Returns { userSt:{...}, st:{...}, macros:[...] | null }. Tombstones removed, meta stripped. */
export function writeSurface(merged) {
  const userSt = {}, st = {};
  let macros = null;
  for (const s of SOURCES) {
    for (const f of s.fields) {
      const ns = `${s.store}.${f}`;
      if (ns in merged.fields) {
        if (s.store === "userSt") userSt[f] = merged.fields[ns];
        else if (s.store === "st") st[f] = merged.fields[ns];
      }
    }
    for (const c of s.collections) {
      const ns = `${s.store}.${c}`;
      const arr = (merged.collections[ns] || []).filter((it) => !it._deletedAt).map(stripMeta);
      if (s.store === "userSt") userSt[c] = arr;
      else if (s.store === "st") st[c] = arr;
      else if (s.store === "macros") macros = arr;
    }
  }
  return { userSt, st, macros };
}

/** Derive the local merge surface WITH meta by diffing current read vs the prior snapshot.
 *  snapshot is a previously-merged surface (may contain tombstones). `now` injectable. */
export function deriveLocal(stores, snapshot, now) {
  const current = readSurface(stores);
  const snap = snapshot || { fields: {}, fieldMeta: {}, collections: {} };
  const fieldMeta = {};
  for (const ns of Object.keys(current.fields)) {
    const changed = !(ns in (snap.fields || {})) || !jsonEq(current.fields[ns], snap.fields[ns]);
    fieldMeta[ns] = changed ? now : (snap.fieldMeta?.[ns] ?? now);
  }
  const collections = {};
  for (const ns of Object.keys(current.collections)) {
    const snapArr = snap.collections?.[ns] || [];
    // SAFETY (mass-delete guard): a store that failed to load or whose
    // localStorage blob corrupt-parsed reads back as {} → an empty collection.
    // If the current read is empty but the snapshot held live items, do NOT
    // manufacture a fresh delete-tombstone for every item — those would win the
    // merge (fresh _updatedAt) and propagate a fleet-wide wipe of the user's
    // snippets/themes/macros. Carry the snapshot forward unchanged instead.
    // Safe bias: clearing an ENTIRE collection in one action won't sync the
    // clear, but a transient empty read can never delete everyone's data.
    if (current.collections[ns].length === 0 && snapArr.some((it) => !it._deletedAt)) {
      collections[ns] = snapArr.map((it) => ({ ...it }));
      continue;
    }
    const snapById = new Map(snapArr.map((it) => [idOf(it), it]));
    const out = [], seen = new Set();
    for (const item of current.collections[ns]) {
      const id = idOf(item); seen.add(id);
      const prev = snapById.get(id);
      const changed = !prev || prev._deletedAt || !jsonEq(stripMeta(item), stripMeta(prev));
      out.push({ ...item, _updatedAt: changed ? now : (prev._updatedAt ?? now) });
    }
    for (const it of snapArr) {
      const id = idOf(it);
      if (seen.has(id)) continue;
      if (it._deletedAt) { out.push(it); continue; } // already tombstoned, carry forward
      out.push({ id: it.id ?? id, name: it.name, _updatedAt: now, _deletedAt: now }); // new delete
    }
    collections[ns] = out;
  }
  return { fields: current.fields, fieldMeta, collections };
}
