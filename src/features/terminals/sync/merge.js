// (C)
// Pure field-level 3-way merge for cloud sync. No I/O. Scalars resolve by
// per-field timestamp (newest wins); collections union by id (newest item wins
// on collision) with delete tombstones that survive stale copies. Returns
// { merged, changedLocally } so the engine knows whether applying a pulled
// remote changed local state (→ schedule a re-push).
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function idOf(item) { return item.id != null ? item.id : item.name; }

// Deterministic, symmetric tie-break for equal timestamps (audit L6). LWW here
// trusts wall-clock timestamps: a device with a skewed-fast clock can make its
// OLDER edit win a real comparison — a true fix needs hybrid logical clocks and
// is out of scope. But the cheap, important case is an EXACT-timestamp tie:
// without a stable rule each device would keep its OWN value and the two would
// silently diverge forever. Comparing serialized values makes both devices pick
// the same winner, so a tie converges instead of splitting. Returns >0 if a wins.
function stableCmp(a, b) {
  const sa = JSON.stringify(a) ?? "";
  const sb = JSON.stringify(b) ?? "";
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function mergeScalars(local, remote, result) {
  const keys = new Set([...Object.keys(local.fields), ...Object.keys(remote.fields)]);
  let changed = false;
  for (const k of keys) {
    const lt = local.fieldMeta[k] ?? -Infinity;
    const rt = remote.fieldMeta[k] ?? -Infinity;
    // On an exact tie with differing values, break deterministically toward
    // remote when it wins the stable compare (audit L6) — the mirror decision
    // runs on the other device, so both converge on the same value.
    const tieToRemote = rt === lt && (k in remote.fields)
      && (!(k in local.fields) || (local.fields[k] !== remote.fields[k] && stableCmp(remote.fields[k], local.fields[k]) > 0));
    if (rt > lt || tieToRemote) {
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
