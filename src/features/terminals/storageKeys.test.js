// (C)
// Locks allOpenTabIds() — the keep-set builder the scrollback GC hinges on. If a
// future state-shape refactor breaks it, the sweep would regress to deleting a
// live tab's scrollback (the CRITICAL this exists to prevent), so these assert
// the prefix match, the exclusions, and fail-safe resilience to bad blobs.
//
// FIXTURE SHAPE IS LOAD-BEARING: the persisted per-window blob nests the
// workspace under `terminalsState` (TerminalsTab.jsx writes `{ ...prev,
// terminalsState: next }`, boot reads `st?.terminalsState`). These fixtures
// originally used a bare top-level `{ panels: … }`, which no real blob ever has,
// so the suite went green while production returned [] on every window (audit
// RDI-2). Build fixtures the way the app writes them, never the way the function
// under test happens to read them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { allOpenTabIds, harvestKeepList, STATE_KEY_PREFIX, USER_STORAGE_KEY } from "./storageKeys.js";

// The real persisted shape: window-level keys (skin, uiLayout, …) alongside the
// nested workspace tree.
function blob(panels) {
  return JSON.stringify({ uiLayout: "moba", terminalsState: { panels, activePanelId: "p1", gridMode: "auto" } });
}

beforeEach(() => {
  const store = new Map();
  global.window = {}; // make `typeof window !== "undefined"`
  global.localStorage = {
    get length() { return store.size; },
    key(i) { return [...store.keys()][i] ?? null; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
});
afterEach(() => { delete global.window; delete global.localStorage; });

describe("allOpenTabIds", () => {
  it("gathers tab ids across the primary + secondary windows", () => {
    localStorage.setItem(STATE_KEY_PREFIX, blob([{ tabs: [{ id: "t1" }, { id: "t2" }] }]));
    localStorage.setItem(`${STATE_KEY_PREFIX}:w2`, blob([{ tabs: [{ id: "t3" }] }]));
    expect(allOpenTabIds().sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("counts every leaf of a split tab, not just the tab id", () => {
    // A scrollback file is owned by a LEAF, not by a tab: TerminalPanel renders
    // each leaf with `tabId={node.id}`, TerminalPane spawns that leaf's PTY
    // under it, and pty.rs opens `<leaf>.txt`. Leaves arrive two ways and both
    // must be kept: `pane_*` ids minted by splitPane, and a whole tab id grafted
    // in by drag-to-split (moveTabIntoSplit drops the dragged tab from `p.tabs`
    // while its PTY keeps running). Harvesting `t.id` alone swept both.
    localStorage.setItem(STATE_KEY_PREFIX, blob([{ tabs: [{
      id: "t1",
      layout: {
        id: "split_1", dir: "row", ratio: 0.5,
        a: { id: "t1" },
        b: { id: "split_2", dir: "col", ratio: 0.5, a: { id: "pane_9" }, b: { id: "t2" } },
      },
    }] }]));
    expect(allOpenTabIds().sort()).toEqual(["pane_9", "t1", "t2"]);
  });

  it("keeps a legacy top-level {panels} blob out of the way but fail-safe", () => {
    // Nothing in the app writes a top-level `panels`; only detachTab did, before
    // RDI-1 was fixed, and those tabs were destroyed rather than opened (the new
    // window read `st.terminalsState`, found nothing and booted defaultState).
    // The fallback therefore protects orphaned files, not live tabs. It is kept
    // because the keep-set is a safety exclusion: over-keeping costs a stale
    // file, under-keeping unlinks a live tab's history. A blob that has BOTH
    // must read the nested tree, which is the only live one.
    localStorage.setItem(`${STATE_KEY_PREFIX}:legacy`, JSON.stringify({ panels: [{ tabs: [{ id: "orphan" }] }] }));
    localStorage.setItem(`${STATE_KEY_PREFIX}:w2`, JSON.stringify({
      panels: [{ tabs: [{ id: "stale" }] }],
      terminalsState: { panels: [{ tabs: [{ id: "live" }] }] },
    }));
    expect(allOpenTabIds().sort()).toEqual(["live", "orphan"]);
  });

  it("excludes the user blob and other plutos-terminals keys", () => {
    localStorage.setItem(STATE_KEY_PREFIX, blob([{ tabs: [{ id: "t1" }] }]));
    // A panels-shaped user blob must NOT contribute ids (it isn't window state).
    localStorage.setItem(USER_STORAGE_KEY, blob([{ tabs: [{ id: "NOPE" }] }]));
    localStorage.setItem("plutos-terminals:cmdhistory:v0", JSON.stringify(["ls"]));
    localStorage.setItem("plutos-terminals:macros:v0", JSON.stringify([]));
    expect(allOpenTabIds()).toEqual(["t1"]);
  });

  it("a malformed blob in one window doesn't stop the others", () => {
    localStorage.setItem(STATE_KEY_PREFIX, "{bad json");
    localStorage.setItem(`${STATE_KEY_PREFIX}:w2`, blob([{ tabs: [{ id: "ok" }] }]));
    expect(allOpenTabIds()).toEqual(["ok"]);
  });

  it("missing / empty panels or tabs yields no ids and never throws", () => {
    localStorage.setItem(STATE_KEY_PREFIX, JSON.stringify({}));
    localStorage.setItem(`${STATE_KEY_PREFIX}:w2`, blob([]));
    localStorage.setItem(`${STATE_KEY_PREFIX}:w3`, blob([{}]));
    localStorage.setItem(`${STATE_KEY_PREFIX}:w4`, JSON.stringify({ terminalsState: null }));
    expect(allOpenTabIds()).toEqual([]);
  });
});

// The keep-list's OWN completeness (review F2). The empty-list refusal in
// diskGc.js was carrying an unstated assumption: that an unreadable layout shows
// up as an empty harvest. With two windows open it does not. If the PRIMARY's
// blob is lost or corrupt and a secondary window's is intact, the walk skips the
// broken one and still returns ids, so nothing refuses and the sweep unlinks the
// primary's aged scrollback — the panes boot recovery is at that moment
// restoring. Reporting the skip is the whole fix; everything else is plumbing.
describe("harvestKeepList", () => {
  it("reports complete: false when a blob fails to parse, and still returns the good ids", () => {
    localStorage.setItem(STATE_KEY_PREFIX, "{bad json"); // the primary, lost
    localStorage.setItem(`${STATE_KEY_PREFIX}:w2`, blob([{ tabs: [{ id: "ok" }] }]));
    const { ids, complete } = harvestKeepList();
    expect(ids).toEqual(["ok"]); // NON-empty: this is why length was never the signal
    expect(complete).toBe(false);
  });

  it("reports complete: true when every blob parses", () => {
    localStorage.setItem(STATE_KEY_PREFIX, blob([{ tabs: [{ id: "t1" }] }]));
    localStorage.setItem(`${STATE_KEY_PREFIX}:w2`, blob([{ tabs: [{ id: "t2" }] }]));
    expect(harvestKeepList()).toEqual({ ids: ["t1", "t2"], complete: true });
  });

  it("no blobs at all is COMPLETE and empty — there was nothing to fail on", () => {
    // A store read end to end that holds no windows is a different fact from a
    // store that could not be read, and only the second one is a completeness
    // failure. The empty list still refuses the sweep on its own.
    expect(harvestKeepList()).toEqual({ ids: [], complete: true });
    // Non-window keys are not candidates, so they cannot make it incomplete.
    localStorage.setItem(USER_STORAGE_KEY, "{bad json");
    localStorage.setItem("plutos-terminals:cmdhistory:v0", "{bad json");
    expect(harvestKeepList()).toEqual({ ids: [], complete: true });
  });

  it("an unreadable localStorage is incomplete, not merely empty", () => {
    localStorage.setItem(STATE_KEY_PREFIX, blob([{ tabs: [{ id: "t1" }] }]));
    const realKey = localStorage.key.bind(localStorage);
    localStorage.key = () => { throw new Error("storage gone"); };
    try {
      expect(harvestKeepList()).toEqual({ ids: [], complete: false });
    } finally {
      localStorage.key = realKey;
    }
  });

  it("allOpenTabIds still returns a PLAIN ARRAY in every case", () => {
    // Its return type is load-bearing: this suite and
    // hooks/useWorkspaceTree.detach.test.js both assert a bare array on it, so
    // the completeness flag is added ALONGSIDE it, never folded into it.
    expect(Array.isArray(allOpenTabIds())).toBe(true); // empty store
    localStorage.setItem(STATE_KEY_PREFIX, blob([{ tabs: [{ id: "t1" }] }]));
    expect(Array.isArray(allOpenTabIds())).toBe(true); // all good
    expect(allOpenTabIds()).toEqual(["t1"]);
    localStorage.setItem(`${STATE_KEY_PREFIX}:w2`, "{bad json");
    expect(Array.isArray(allOpenTabIds())).toBe(true); // incomplete
    expect(allOpenTabIds()).toEqual(["t1"]);
  });
});
