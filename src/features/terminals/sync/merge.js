// (C)
// Pure field-level 3-way merge for cloud sync. No I/O. Scalars resolve by
// per-field timestamp (newest wins); collections union by id (newest item wins
// on collision) with delete tombstones that survive stale copies. Returns
// { merged, changedLocally } so the engine knows whether applying a pulled
// remote changed local state (→ schedule a re-push).
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function idOf(item) { return item.id != null ? item.id : item.name; }

function mergeScalars(local, remote, result) {
  const keys = new Set([...Object.keys(local.fields), ...Object.keys(remote.fields)]);
  let changed = false;
  for (const k of keys) {
    const lt = local.fieldMeta[k] ?? -Infinity;
    const rt = remote.fieldMeta[k] ?? -Infinity;
    if (rt > lt) {
      result.fields[k] = remote.fields[k];
      result.fieldMeta[k] = rt;
      changed = true;
    } else {
      if (k in local.fields) result.fields[k] = local.fields[k];
      result.fieldMeta[k] = Math.max(lt === -Infinity ? rt : lt, -Infinity);
      if (result.fieldMeta[k] === -Infinity) delete result.fieldMeta[k];
    }
  }
  return changed;
}

function mergeCollection(localArr, remoteArr, now) {
  const byId = new Map();
  let changed = false;
  for (const item of localArr || []) byId.set(idOf(item), item);
  for (const item of remoteArr || []) {
    const existing = byId.get(idOf(item));
    if (!existing) {
      byId.set(idOf(item), item);
      changed = true;
    } else if ((item._updatedAt ?? 0) > (existing._updatedAt ?? 0)) {
      byId.set(idOf(item), item);
      changed = true;
    }
  }
  const out = [];
  for (const item of byId.values()) {
    // GC a tombstone past its TTL.
    if (item._deletedAt && now - item._deletedAt > TOMBSTONE_TTL_MS) continue; // GC
    out.push(item);
  }
  return { out, changed };
}

/** Merge local and remote normalized surfaces. `now` is injectable for tests. */
export function merge(local, remote, now = Date.now()) {
  const result = { fields: {}, fieldMeta: {}, collections: {} };
  let changedLocally = mergeScalars(local, remote, result);

  const names = new Set([
    ...Object.keys(local.collections || {}),
    ...Object.keys(remote.collections || {}),
  ]);
  for (const name of names) {
    const { out, changed } = mergeCollection(
      local.collections?.[name],
      remote.collections?.[name],
      now
    );
    result.collections[name] = out;
    if (changed) changedLocally = true;
  }
  return { merged: result, changedLocally };
}
