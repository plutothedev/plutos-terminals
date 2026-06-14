// (C)
// Pure field-level 3-way merge for cloud sync. No I/O. Scalars resolve by
// per-field timestamp (newest wins); collections union by id (newest item wins
// on collision) with delete tombstones that survive stale copies. Returns
// { merged, changedLocally } so the engine knows whether applying a pulled
// remote changed local state (→ schedule a re-push).
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

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
  // Build a set of ids that appear on the remote side (for GC eligibility check)
  const remoteIds = new Set((remoteArr || []).map((item) => item.id));
  for (const item of localArr || []) byId.set(item.id, item);
  for (const item of remoteArr || []) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      changed = true;
    } else if ((item._updatedAt ?? 0) > (existing._updatedAt ?? 0)) {
      byId.set(item.id, item);
      changed = true;
    }
  }
  const out = [];
  for (const item of byId.values()) {
    // GC a tombstone only when the remote has no record of this id (it has
    // already forgotten the item) AND the tombstone is past TTL. If the remote
    // still carries a (stale) live copy the tombstone must survive to prevent
    // resurrection on a future sync that might not have this local state.
    if (item._deletedAt && !remoteIds.has(item.id) && now - item._deletedAt > TOMBSTONE_TTL_MS) continue;
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
