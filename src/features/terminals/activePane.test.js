// (C)
// Locks the pane-id resolution behind audit FE-1: every chrome action that
// "acts on the active terminal" addresses a PANE, and the two structural ways
// a tab id stops being a valid pane id.
//
// The last describe deliberately composes the resolver with the REAL ptyBridge
// rather than asserting on ids alone: the whole finding is that a plausible-
// looking id reached a keyed registry and silently missed, so the test has to
// show the write landing (or not) in an actual registered writer.
import { describe, it, expect, afterEach } from "vitest";
import { resolveActivePaneId, allPaneTargets, findPaneOwner } from "./activePane.js";
import { splitLeaf, removeLeaf, getLayout, leafIds } from "./splitTree.js";
import { registerPtyWriter, unregisterPty, writeToTab } from "./ptyBridge.js";

// A tab exactly as useWorkspaceTree stores it after Ctrl+Shift+D: splitLeaf
// keeps the EXISTING leaf's id (= tab.id) and adds the new leaf as the b-side,
// and focus moves to the new leaf.
function splitTab() {
  const tab = { id: "tab1", label: "shell", cwd: null };
  return {
    ...tab,
    layout: splitLeaf(getLayout(tab), "tab1", "row", { id: "pane2", cwd: null }, "split1"),
    activePaneId: "pane2",
  };
}

describe("resolveActivePaneId", () => {
  it("returns the tab id for a plain unsplit tab", () => {
    expect(resolveActivePaneId({ id: "tab1" })).toBe("tab1");
  });

  it("returns the FOCUSED pane on a split tab, not the tab id", () => {
    const tab = splitTab();
    // The bug: tab.id is still a live leaf here, so a tab-id lookup succeeds and
    // types into the pane the user just split away from.
    expect(tab.id).toBe("tab1");
    expect(resolveActivePaneId(tab)).toBe("pane2");
  });

  it("follows focus back to the original pane", () => {
    expect(resolveActivePaneId({ ...splitTab(), activePaneId: "tab1" })).toBe("tab1");
  });

  it("resolves to a live leaf after the ORIGINAL pane is closed", () => {
    // removeLeaf collapses the two-leaf tree to the sibling, so no leaf id
    // equals tab.id any more. That is the state in which every tab-id lookup returned
    // undefined for the life of the tab.
    const tab = splitTab();
    const collapsed = { ...tab, layout: removeLeaf(tab.layout, "tab1") };
    expect(resolveActivePaneId(collapsed)).toBe("pane2");
    // …and it must still hold when activePaneId itself is the dead id.
    expect(resolveActivePaneId({ ...collapsed, activePaneId: "tab1" })).toBe("pane2");
    // …and when there is no activePaneId at all (older persisted blobs).
    const noFocus = { ...collapsed };
    delete noFocus.activePaneId;
    expect(resolveActivePaneId(noFocus)).toBe("pane2");
  });

  it("falls back to the FIRST leaf, not merely to some leaf", () => {
    // The fallback choice is load-bearing, not arbitrary. leafIds walks a then
    // b, so on a tab that still owns its root the first leaf IS tab.id: the one
    // leaf TerminalPanel hands the tab's connection, serial, cwd, startCommands
    // and project name to (`isRoot ? … : null`). Landing on the last leaf
    // instead would address a plain local shell on an SSH tab.
    //
    // Every fixture above is two-leaf, where "first" and "last" coincide in the
    // cases that reach the fallback, so nothing pinned this. Three leaves
    // separate them.
    const two = splitTab(); // [tab1, pane2]
    const three = {
      ...two,
      layout: splitLeaf(two.layout, "pane2", "col", { id: "pane3", cwd: null }, "split2"),
    };
    expect(leafIds(getLayout(three))).toEqual(["tab1", "pane2", "pane3"]);

    // stored focus pointing at a leaf that no longer exists
    expect(resolveActivePaneId({ ...three, activePaneId: "ghost" })).toBe("tab1");
    // no stored focus at all (blobs persisted before activePaneId existed)
    const noFocus = { ...three };
    delete noFocus.activePaneId;
    expect(resolveActivePaneId(noFocus)).toBe("tab1");
    // …and with the root closed, the first SURVIVOR wins, not the last.
    const rootless = { ...three, layout: removeLeaf(three.layout, "tab1"), activePaneId: "ghost" };
    expect(leafIds(getLayout(rootless))).toEqual(["pane2", "pane3"]);
    expect(resolveActivePaneId(rootless)).toBe("pane2");
  });

  it("never invents an id for a missing tab", () => {
    expect(resolveActivePaneId(null)).toBeNull();
    expect(resolveActivePaneId(undefined)).toBeNull();
  });
});

describe("allPaneTargets / findPaneOwner", () => {
  const panels = [
    { id: "p1", tabs: [splitTab(), { id: "home1", home: true }] },
    { id: "p2", tabs: [{ id: "tab9" }] },
  ];

  it("collects every leaf across every panel, special tabs included", () => {
    // Special tabs mount no TerminalPane, but they can still hold a recording
    // keyed on their own id, and dropping them from the live set would prune it
    // out from under a live "● rec" indicator.
    expect(allPaneTargets(panels)).toEqual(new Set(["tab1", "pane2", "home1", "tab9"]));
  });

  it("finds the owning tab of a pane whose id matches no tab", () => {
    const owner = findPaneOwner(panels, "pane2");
    expect(owner?.panel.id).toBe("p1");
    expect(owner?.tab.id).toBe("tab1");
    expect(findPaneOwner(panels, "nope")).toBeNull();
  });
});

describe("resolution against the real ptyBridge registry", () => {
  const ids = [];
  const register = (id, sink) => { ids.push(id); registerPtyWriter(id, sink); };
  afterEach(() => { while (ids.length) unregisterPty(ids.pop()); });

  it("routes a write to the focused pane of a split tab", () => {
    const tab = splitTab();
    const left = [];
    const right = [];
    // TerminalPane registers under its LEAF id (TerminalPanel: tabId={node.id}).
    register("tab1", (d) => left.push(d));
    register("pane2", (d) => right.push(d));

    expect(writeToTab(resolveActivePaneId(tab), "echo hi")).toBe(true);
    expect(right).toEqual(["echo hi"]);
    expect(left).toEqual([]); // the pane the tab id would have hit
  });

  it("still reaches a live shell after the original pane closed", () => {
    const tab = splitTab();
    const collapsed = { ...tab, layout: removeLeaf(tab.layout, "tab1") };
    const out = [];
    register("pane2", (d) => out.push(d));

    // The regression this pins: the surviving pane is registered and writable,
    // but nothing is registered under the tab id, so the tab-id form fails.
    expect(writeToTab(collapsed.id, "echo hi")).toBe(false);
    expect(writeToTab(resolveActivePaneId(collapsed), "echo hi")).toBe(true);
    expect(out).toEqual(["echo hi"]);
  });
});
