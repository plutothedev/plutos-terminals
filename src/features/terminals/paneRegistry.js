// (C)
// Pane registry: owns each terminal pane's create-once objects (xterm instance
// + addons, host DOM element, PTY session, counters, one-shot flags, and a
// per-mount-repointed `ui` pointer table) independently of React's mount
// lifecycle for that pane's component. Keyed by pane id (the LEAF id of the
// split tree TerminalPanel renders — see paneIds.js, Task 2).
//
// Ownership inversion: normally a component's effect creates a resource and
// its cleanup destroys it, 1:1 with the fiber. Here the resource (the entry)
// outlives any single mount of TerminalPane. The component calls
// ensureEntry/attachHost on mount and detachHost on cleanup ("park") — it does
// NOT destroy anything itself in the common case. The entry is a durable
// object living in this module's Map until something explicitly destroys it.
//
// Sweep-as-lifecycle-truth: no close path (closeTab, closeOtherTabs,
// closePanel, closePane, reset-workspace, loadWorkspace, discardWorktree, ...)
// marks an entry for death. Instead, a single reconcile(liveIds) call — run
// from a tree-level effect after every render of the pane tree — is the ONLY
// source of truth for what should still exist: any registry id absent from
// liveIds is destroyed. One mechanism covers every current and future close
// path with no per-path bookkeeping and no stale-mark races.
//
// Park vs destroy: a mount's cleanup normally parks (detachHost) — the entry,
// its xterm instance, its PTY id, and its counters all survive so a later
// re-attach (e.g. after a drag-move re-renders the pane under a new slot)
// picks up exactly where it left off. Only destroyEntry/reconcile/destroyAll
// ever tear down the underlying xterm/PTY and delete the entry.
//
// StrictMode / mid-spawn semantics: React 18 dev StrictMode mounts, unmounts,
// and remounts synchronously before the first real commit. This module
// exposes `spawnState` ("starting" | "live" | "dead") precisely so a caller's
// cleanup can tell the two cases apart: if cleanup runs while the entry is
// still "starting" (the PTY hasn't finished spawning), there is nothing live
// to hand off to a next mount, so the caller destroys the entry outright
// instead of parking it; the in-flight spawn callback then checks
// getEntry(id) on arrival and kills the orphaned PTY if the entry is already
// gone. Once spawnState is "live" (or "dead"), cleanup parks — only the sweep
// or destroyAll ever destroys a live entry. This module provides the
// primitives (spawnState, destroyEntry, detachHost); TerminalPane (Task 3)
// is what actually branches on them.
//
// Lock screen / crash recovery / destroyAll: this module has no notion of
// "locked" or "crashed" — App.jsx's lock-transition effect and
// ErrorBoundary.componentDidCatch call destroyAll() directly. That's
// deliberate: a parked (invisible) session behind the lock screen would keep
// running unsupervised (e.g. auto-approve still acting with the window out
// of focus), so locking must kill every session, not park them; and a
// crashed render tree can't supervise live sessions either, so the boundary
// kills everything rather than leaving orphaned PTYs behind the fallback UI.
//
// `ui` pointer table (repointed every mount, decision 4): entry.ui is opaque
// storage owned by TerminalPane — a plain object of the CURRENT mount's
// setters/getters (setFailedBlock, isVisible, onCost, ...). It starts null and
// is overwritten wholesale on every mount (first mount and every re-attach).
// Long-lived handlers (OSC parsers, onData, onScroll, ...) close over `entry`
// itself, never over `ui`'s contents, so they always read `entry.ui.xxx` at
// call time and transparently pick up whichever fiber is currently attached.
// This module never reads or shapes `ui` — it is just a slot.

const registry = new Map();

function makeHost() {
  const host = document.createElement("div");
  host.className = "phn-pane-host";
  host.style.width = "100%";
  host.style.height = "100%";
  return host;
}

function makeEntry() {
  return {
    host: makeHost(),
    currentSlot: null,
    term: null,
    fit: null,
    search: null,
    ptyId: null,
    jumpFwdId: null,
    spawnState: "starting", // "starting" | "live" | "dead"
    setupDone: false,
    onDestroy: [],
    ui: null, // per-mount pointer table; repointed on EVERY mount (decision 4)
    counters: {
      lastCost: { tokens: 0, cost: 0 },
      family: null,
      scrollbackChunks: [],
      scrollbackBytes: 0,
      userHasTyped: false,
      recentOut: "",
    },
    blocks: { list: [], current: null, decorations: [] },
  };
}

export function ensureEntry(paneId) {
  let entry = registry.get(paneId);
  if (!entry) {
    entry = makeEntry();
    registry.set(paneId, entry);
  }
  return entry;
}

export function getEntry(paneId) {
  return registry.get(paneId) ?? null;
}

export function attachHost(paneId, slotEl) {
  const entry = registry.get(paneId);
  if (!entry) return;
  slotEl.appendChild(entry.host); // re-parents implicitly if already attached elsewhere
  entry.currentSlot = slotEl;
}

export function detachHost(paneId) {
  const entry = registry.get(paneId);
  if (!entry) return;
  entry.host.remove();
  entry.currentSlot = null;
}

export function registerDestroyHook(paneId, fn) {
  if (!paneId || typeof fn !== "function") return;
  const entry = registry.get(paneId);
  if (!entry) return;
  entry.onDestroy.push(fn);
}

export function destroyEntry(paneId) {
  const entry = registry.get(paneId);
  if (!entry) return;
  // Newest-first (LIFO): the last hook registered is torn down first, mirroring
  // normal stack unwind order. Each hook is isolated in its own try/catch so a
  // throwing hook can never block the rest of teardown.
  for (let i = entry.onDestroy.length - 1; i >= 0; i--) {
    try {
      entry.onDestroy[i]();
    } catch (err) {
      console.error(`[paneRegistry] destroy hook threw for pane "${paneId}":`, err);
    }
  }
  entry.host.remove();
  // A destroy hook could itself call ensureEntry(paneId) and mint a fresh
  // entry under the same id mid-teardown — only delete the Map slot if it
  // still points at the entry we just tore down, so a hook's replacement
  // entry is never deleted out from under it.
  if (registry.get(paneId) === entry) registry.delete(paneId);
}

export function reconcile(liveIds) {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
  const destroyed = [];
  for (const paneId of Array.from(registry.keys())) {
    if (!live.has(paneId)) {
      destroyEntry(paneId);
      destroyed.push(paneId);
    }
  }
  return destroyed;
}

export function destroyAll() {
  for (const paneId of Array.from(registry.keys())) {
    destroyEntry(paneId);
  }
}

export function listEntries() {
  return Array.from(registry.keys());
}
