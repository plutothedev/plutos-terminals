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

/** A meta-insensitive key for "does this surface hold different DATA than that
 *  one?" — used by the engine to decide whether to push. Ignores sync-meta
 *  timestamps (_updatedAt, fieldMeta) and collection order so two machines that
 *  hold identical user-visible data with different stamp histories don't push to
 *  each other forever. Tombstone PRESENCE still counts (a deleted item differs
 *  from a live one); its exact _deletedAt does not. */
export function surfaceValueKey(surface) {
  const sortedFields = {};
  for (const k of Object.keys(surface.fields || {}).sort()) sortedFields[k] = surface.fields[k];
  const collections = {};
  for (const k of Object.keys(surface.collections || {})) {
    collections[k] = (surface.collections[k] || [])
      .map((it) => ({ ...stripMeta(it), _deleted: it._deletedAt ? 1 : 0 }))
      .sort((a, b) => String(idOf(a)).localeCompare(String(idOf(b))));
  }
  return JSON.stringify({ fields: sortedFields, collections });
}

// Does this store look UNLOADED (vs a collection the user legitimately emptied)?
// A corrupt-parse loader returns {} for userSt/st (App.jsx catches and returns
// {}), so a store with zero keys is the corrupt/unloaded signal. The macros
// store IS its array, so we can't separate a failed load from a real clear-all
// — treat empty as suspicious there (safe bias toward keeping data).
function storeUnloaded(stores, store) {
  if (store === "macros") return !Array.isArray(stores.macros) || stores.macros.length === 0;
  const o = stores[store];
  return !o || Object.keys(o).length === 0;
}

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
  // FIRST SYNC (no snapshot): there is no baseline, so we cannot claim local
  // values are "new". Stamp them at 0 so a genuinely-newer remote wins scalar
  // ties (a fresh machine adopts the established fleet settings). Collections
  // still UNION by id (mergeCollection), so local-unique items are never lost.
  // Without this, local defaults stamped `now` clobbered the user's real
  // settings on every other machine.
  const stamp = snapshot ? now : 0;
  const fieldMeta = {};
  for (const ns of Object.keys(current.fields)) {
    const changed = !(ns in (snap.fields || {})) || !jsonEq(current.fields[ns], snap.fields[ns]);
    fieldMeta[ns] = changed ? stamp : (snap.fieldMeta?.[ns] ?? stamp);
  }
  const collections = {};
  for (const ns of Object.keys(current.collections)) {
    const snapArr = snap.collections?.[ns] || [];
    // SAFETY (mass-delete guard): a store that failed to load or whose
    // localStorage blob corrupt-parsed reads back as {} → empty collections.
    // If the current read is empty, the snapshot held live items, AND the owning
    // store looks UNLOADED, do NOT manufacture a fresh delete-tombstone for every
    // item — those would win the merge (fresh _updatedAt) and propagate a
    // fleet-wide wipe of the user's snippets/themes/macros. Carry the snapshot
    // forward unchanged instead. The storeUnloaded() gate means a legitimate
    // clear-to-empty (store still loaded, e.g. headerSkin present) still syncs;
    // only a genuinely unreadable store is protected.
    const store = ns.slice(0, ns.indexOf("."));
    if (current.collections[ns].length === 0 && snapArr.some((it) => !it._deletedAt) && storeUnloaded(stores, store)) {
      collections[ns] = snapArr.map((it) => ({ ...it }));
      continue;
    }
    const snapById = new Map(snapArr.map((it) => [idOf(it), it]));
    const out = [], seen = new Set();
    for (const item of current.collections[ns]) {
      const id = idOf(item); seen.add(id);
      const prev = snapById.get(id);
      const changed = !prev || prev._deletedAt || !jsonEq(stripMeta(item), stripMeta(prev));
      out.push({ ...item, _updatedAt: changed ? stamp : (prev._updatedAt ?? stamp) });
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
