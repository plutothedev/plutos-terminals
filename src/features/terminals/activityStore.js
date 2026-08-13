// (C)
// Per-pane activity store (P2-T1). Replaces the tabActivities React state
// whose object identity churned on EVERY pane's activity flip and — as a
// direct prop of every TerminalPanel — broke the panel memos app-wide
// (~1.5-3 whole-app re-renders/sec with 8 background agents). Producers and
// consumers now meet here; each consumer subscribes to exactly the slice it
// renders.
//
// Design (audited plan rev 2):
// - Data is paneId → activity ONLY. The pane→project mapping is a separate
//   index OWNED BY THIS STORE but SET by TerminalsTab's layout effect —
//   producer-captured projectIds go stale across moveTabIntoSplit absorption
//   and removeProject detach (plan-audit H1). Index keys are ROOT pane ids
//   (tab.id), preserving today's root-only project rollup semantics.
// - "idle" deletes the key (the old state's normalization).
// - Whole-map/rollup snapshots are CACHED per version — React 18's
//   useSyncExternalStore requires getSnapshot to return a stable reference
//   between changes or it render-loops.
// - The "needs you" (waiting) state flows through the same values; producer
//   seam and clear semantics are untouched (TerminalPane still decides WHEN).

import { useCallback, useSyncExternalStore } from "react";
import { mergeActivity } from "./hooks/useTabTelemetry.js";

const activities = new Map(); // paneId -> 'waiting'|'active'|'done' (idle = absent)
let projectIndex = new Map(); // rootPaneId (tab.id) -> projectId
let version = 0;

const paneListeners = new Map(); // paneId -> Set<cb>
const anyListeners = new Set(); // whole-map subscribers

let mapSnapshot = { version: -1, value: {} };
let rollupSnapshot = { version: -1, value: {} };

function fire(set) {
  if (!set) return;
  for (const cb of [...set]) {
    try { cb(); } catch { /* one bad subscriber must not break the rest */ }
  }
}

function notifyPane(paneId) { fire(paneListeners.get(paneId)); }
function notifyAny() { fire(anyListeners); }

// ── Producers ───────────────────────────────────────────────────────────────

export function setPaneActivity(paneId, state) {
  if (!paneId) return;
  const prev = activities.get(paneId) || "idle";
  const next = state || "idle";
  if (prev === next) return;
  if (next === "idle") activities.delete(paneId);
  else activities.set(paneId, next);
  version++;
  notifyPane(paneId);
  notifyAny(); // rollup consumers (sidebar/home) ride the any-channel
}

/// TerminalsTab's layout effect owns this (rebuilt on [state.panels,
/// projects] — changes that re-render everything anyway). Lives IN the store
/// so the rollup snapshots and per-write routing can reach it. Change-guarded
/// (T1 review): most rebuilds carry an IDENTICAL mapping (tab switches,
/// drag ticks), and an unguarded bump forced every cached snapshot to
/// recompute + notified all listeners for nothing — it also double-notified
/// under StrictMode's dev double-invoke.
export function setProjectIndex(map) {
  if (map.size === projectIndex.size) {
    let same = true;
    for (const [k, v] of map) {
      if (projectIndex.get(k) !== v) {
        same = false;
        break;
      }
    }
    if (same) return;
  }
  projectIndex = map;
  version++;
  notifyAny();
}

/// Prune entries for panes no longer rendered — wired into the SAME registry
/// reconcile sweep that kills dead xterm hosts, covering close, workspace
/// load/reset (fresh ids), and reopenTab id-reuse (plan-audit M1). Bumps the
/// version explicitly: a silent prune is exactly the stale-needs-you class.
export function pruneActivities(liveIds) {
  let changed = false;
  for (const id of [...activities.keys()]) {
    if (!liveIds.has(id)) {
      activities.delete(id);
      changed = true;
    }
  }
  if (changed) {
    version++;
    for (const set of paneListeners.values()) fire(set);
    notifyAny();
  }
}

// ── Imperative reads (used inside version-subscribed renders) ───────────────

export function getPaneActivity(paneId) {
  return activities.get(paneId) || "idle";
}

// ── Hooks ───────────────────────────────────────────────────────────────────

function subscribeKeyed(map, key, cb) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) map.delete(key);
  };
}

/// Per-pane/tab activity as a string primitive. tabId may be null (no active
/// tab) → "idle".
export function useTabActivity(tabId) {
  const subscribe = useCallback(
    (cb) => (tabId ? subscribeKeyed(paneListeners, tabId, cb) : () => {}),
    [tabId]
  );
  return useSyncExternalStore(subscribe, () =>
    tabId ? activities.get(tabId) || "idle" : "idle"
  );
}

// NOTE deliberately NO per-project hook here (T1 review): both project
// consumers render projects inside .map(), where a per-row hook would violate
// the Rules of Hooks — they use the cached useProjectRollups() object and
// index into it per row. If a dedicated per-project component ever exists,
// add the hook back with a per-project subscription then.

function subscribeAny(cb) {
  anyListeners.add(cb);
  return () => anyListeners.delete(cb);
}

function getMapSnapshot() {
  if (mapSnapshot.version !== version) {
    mapSnapshot = { version, value: Object.fromEntries(activities) };
  }
  return mapSnapshot.value;
}

/// Whole map ({paneId: state}), cached per version. For the conditionally-
/// mounted fleet surfaces (DockMonitor, AgentDashboard) and the sidebar's
/// shake transition effect.
export function useActivitiesSnapshot() {
  return useSyncExternalStore(subscribeAny, getMapSnapshot);
}

function getRollupSnapshot() {
  if (rollupSnapshot.version !== version) {
    const value = {};
    for (const [paneId, pid] of projectIndex) {
      value[pid] = mergeActivity(value[pid] || "idle", activities.get(paneId) || "idle");
    }
    // Content-diff (stream audit W3): a NON-indexed pane's flip (split
    // children never feed rollups) bumps version but can't change any
    // project's value — keep the previous identity so useProjectRollups
    // consumers (sidebar, home cards) bail instead of re-rendering.
    const prev = rollupSnapshot.value;
    const vk = Object.keys(value);
    const same =
      Object.keys(prev).length === vk.length && vk.every((k) => prev[k] === value[k]);
    rollupSnapshot = { version, value: same ? prev : value };
  }
  return rollupSnapshot.value;
}

/// {projectId: rollup}, cached per version — for consumers that read many
/// projects in one render (ProjectSidebar rows today, MobaHomeScreen cards).
export function useProjectRollups() {
  return useSyncExternalStore(subscribeAny, getRollupSnapshot);
}

/// Per-panel strip subscription (plan-audit H2: there is no per-tab row
/// component — the panel subscribes to its own leaf set). Snapshot is a
/// PRIMITIVE join of the set's states, so the panel re-renders exactly when
/// one of ITS panes changes; dots/borders then read getPaneActivity
/// imperatively in that render.
export function usePanelActivityStamp(leafIdsKey) {
  // leafIdsKey: pre-joined "id1,id2,…" string — a primitive dep so the
  // subscribe callback is stable across renders with an unchanged set.
  const subscribe = useCallback(
    (cb) => {
      const ids = leafIdsKey ? leafIdsKey.split(",") : [];
      const unsubs = ids.map((id) => subscribeKeyed(paneListeners, id, cb));
      return () => unsubs.forEach((u) => u());
    },
    [leafIdsKey]
  );
  return useSyncExternalStore(subscribe, () => {
    if (!leafIdsKey) return "";
    return leafIdsKey
      .split(",")
      .map((id) => activities.get(id) || "i")
      .join("|");
  });
}

// Test-only accessors for the cached snapshot paths (the hooks close over
// them; tests exercise the caching contract without a React renderer).
export function __testGetMapSnapshot() {
  return getMapSnapshot();
}
export function __testGetRollups() {
  return getRollupSnapshot();
}

// Test-only reset (module-level maps persist across vitest cases).
export function __resetActivityStore() {
  activities.clear();
  projectIndex = new Map();
  version = 0;
  paneListeners.clear();
  anyListeners.clear();
  mapSnapshot = { version: -1, value: {} };
  rollupSnapshot = { version: -1, value: {} };
}
