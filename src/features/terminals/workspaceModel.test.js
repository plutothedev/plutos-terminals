// (C)
import { describe, it, expect } from "vitest";
import { removeTabsFromWorkspace } from "./workspaceModel.js";

// Batch tab removal — the pure core behind useWorkspaceTree's closeTabs.
// Motivating bug (found during B1, chipped): discardWorktree looped
// closeTab() per owner, but every same-tick call read the same stateRef
// snapshot, so each persist resurrected the tabs the previous call removed —
// only the LAST owner actually closed (multi-owner lost update). The batch
// form computes the whole removal from ONE snapshot.

const tab = (id, extra = {}) => ({ id, label: `Tab ${id.slice(-1)}`, ...extra });
const panel = (id, tabs, activeTabId = tabs[0]?.id ?? null) => ({ id, tabs, activeTabId });

describe("removeTabsFromWorkspace", () => {
  it("removes owners across multiple panels in one pass (the lost-update repro)", () => {
    const st = {
      panels: [
        panel("p1", [tab("t1"), tab("t2")]),
        panel("p2", [tab("t3"), tab("t4")]),
      ],
      activePanelId: "p1",
    };
    const out = removeTabsFromWorkspace(st, [
      { panelId: "p1", tabId: "t1" },
      { panelId: "p2", tabId: "t3" },
    ]);
    expect(out.panels.map(p => p.tabs.map(t => t.id))).toEqual([["t2"], ["t4"]]);
    expect(out.removedTabIds.sort()).toEqual(["t1", "t3"]);
    expect(out.activePanelId).toBe("p1");
  });

  it("closes a panel whose only tab is removed and moves activePanelId off it", () => {
    const st = {
      panels: [panel("p1", [tab("t1")]), panel("p2", [tab("t3"), tab("t4")])],
      activePanelId: "p1",
    };
    const out = removeTabsFromWorkspace(st, [{ panelId: "p1", tabId: "t1" }]);
    expect(out.panels.map(p => p.id)).toEqual(["p2"]);
    expect(out.activePanelId).toBe("p2");
    expect(out.removedTabIds).toEqual(["t1"]);
  });

  it("resets to one fresh home panel when every panel empties", () => {
    const st = { panels: [panel("p1", [tab("t1")])], activePanelId: "p1" };
    const out = removeTabsFromWorkspace(st, [{ panelId: "p1", tabId: "t1" }]);
    expect(out.panels).toHaveLength(1);
    expect(out.panels[0].tabs).toHaveLength(1);
    expect(out.panels[0].tabs[0].home).toBe(true);
    expect(out.activePanelId).toBe(out.panels[0].id);
  });

  it("moves a removed active tab to the nearest survivor and renumbers default labels", () => {
    const st = {
      panels: [panel("p1", [
        { id: "a", label: "Tab 1" },
        { id: "b", label: "Tab 2" },
        { id: "c", label: "Tab 3" },
      ], "b")],
      activePanelId: "p1",
    };
    const out = removeTabsFromWorkspace(st, [{ panelId: "p1", tabId: "b" }]);
    const p = out.panels[0];
    expect(p.tabs.map(t => t.id)).toEqual(["a", "c"]);
    // survivor at the closed tab's old position (clamped) becomes active
    expect(p.activeTabId).toBe("c");
    expect(p.tabs.map(t => t.label)).toEqual(["Tab 1", "Tab 2"]);
  });

  it("returns null when nothing matches (unknown panel or tab ids)", () => {
    const st = { panels: [panel("p1", [tab("t1")])], activePanelId: "p1" };
    expect(removeTabsFromWorkspace(st, [{ panelId: "nope", tabId: "t1" }])).toBeNull();
    expect(removeTabsFromWorkspace(st, [{ panelId: "p1", tabId: "nope" }])).toBeNull();
    expect(removeTabsFromWorkspace(st, [])).toBeNull();
  });

  it("leaves untouched panels and non-workspace keys of the input alone", () => {
    const st = {
      panels: [panel("p1", [tab("t1"), tab("t2")]), panel("p2", [tab("t3")])],
      activePanelId: "p2",
    };
    const out = removeTabsFromWorkspace(st, [{ panelId: "p1", tabId: "t1" }]);
    // p2 object is reused untouched, active panel stays p2
    expect(out.panels[1]).toBe(st.panels[1]);
    expect(out.activePanelId).toBe("p2");
    // input not mutated
    expect(st.panels[0].tabs).toHaveLength(2);
  });
});
