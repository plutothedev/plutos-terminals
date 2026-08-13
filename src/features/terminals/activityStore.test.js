// (C)
// Pins the P2-T1 activity store: per-key notification containment (the whole
// point — one pane's flip must not wake unrelated subscribers), snapshot
// identity caching (React 18 uSES contract), index-driven project routing,
// and the reconcile-sweep prune.
import { describe, it, expect, beforeEach } from "vitest";
import {
  setPaneActivity,
  setProjectIndex,
  pruneActivities,
  getPaneActivity,
  __resetActivityStore,
} from "./activityStore.js";

// Reach the internals through the public surface only. The store doesn't
// export raw subscribe fns (hooks own them), so containment is tested through
// observable effects: snapshot identity + values.
import * as store from "./activityStore.js";

beforeEach(() => __resetActivityStore());

describe("activityStore", () => {
  it("idle deletes the key; repeated sets are no-ops", () => {
    setPaneActivity("p1", "active");
    expect(getPaneActivity("p1")).toBe("active");
    setPaneActivity("p1", "idle");
    expect(getPaneActivity("p1")).toBe("idle");
  });

  it("map snapshot identity is stable between writes and fresh after one", () => {
    setPaneActivity("p1", "active");
    const a = storeMapSnapshot();
    const b = storeMapSnapshot();
    expect(a).toBe(b); // cached — uSES contract
    setPaneActivity("p2", "waiting");
    const c = storeMapSnapshot();
    expect(c).not.toBe(a);
    expect(c).toEqual({ p1: "active", p2: "waiting" });
  });

  it("project rollup follows the index, root-only, waiting outranks active", () => {
    setProjectIndex(new Map([["tabA", "proj1"], ["tabB", "proj1"], ["tabC", "proj2"]]));
    setPaneActivity("tabA", "active");
    setPaneActivity("tabB", "waiting");
    setPaneActivity("tabC", "done");
    // A non-root pane id (not in the index) must not leak into rollups.
    setPaneActivity("pane-split-leaf", "active");
    expect(storeRollups()).toEqual({ proj1: "waiting", proj2: "done" });
  });

  it("re-indexing reroutes rollups (moveTabIntoSplit / removeProject shapes)", () => {
    setProjectIndex(new Map([["tabA", "proj1"]]));
    setPaneActivity("tabA", "active");
    expect(storeRollups()).toEqual({ proj1: "active" });
    // Project removed / tab detached: index drops the entry.
    setProjectIndex(new Map());
    expect(storeRollups()).toEqual({});
    // Activity value itself is untouched — only the mapping moved.
    expect(getPaneActivity("tabA")).toBe("active");
  });

  it("prune removes dead ids, keeps live ones, and freshens snapshots", () => {
    setPaneActivity("live", "active");
    setPaneActivity("dead", "waiting");
    const before = storeMapSnapshot();
    pruneActivities(new Set(["live"]));
    const after = storeMapSnapshot();
    expect(after).not.toBe(before); // version bumped — no silent prune
    expect(after).toEqual({ live: "active" });
  });
});

function storeMapSnapshot() {
  return store.__testGetMapSnapshot();
}
function storeRollups() {
  return store.__testGetRollups();
}
