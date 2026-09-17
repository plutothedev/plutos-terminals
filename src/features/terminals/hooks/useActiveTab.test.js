// (C)
// The shared active-panel / active-tab derivation.
//
// Two things are pinned here. The first is the derivation itself. The second is
// the SHAPE of what it returns, which is a real contract rather than a style
// preference: this hook used to also return a tab-keyed `activeTabRecording`,
// and recordings are keyed by PANE id (audit FE-1: TerminalPane pushes output
// under its LEAF id), so on any split tab that value was the wrong answer. It
// was left behind, unread, next to the pane-keyed derivation that replaced it in
// TerminalsTab, in the one file whose entire job is to be the single shared
// source of these names. A second copy of a superseded expression sitting beside
// the fix is exactly how the tab-vs-pane drift started, so the key set is
// asserted exhaustively: reintroducing one fails this file.
//
// Called as a plain function on purpose. Despite the name it invokes no React
// hooks. It is a per-render derivation, deliberately un-memoized so the
// reference identity of activeTab/activePanel keeps behaving the way the many
// downstream useCallback dep arrays expect.
import { describe, it, expect } from "vitest";
import { useActiveTab } from "./useActiveTab.js";

const state = {
  activePanelId: "p2",
  panels: [
    { id: "p1", activeTabId: "t1", tabs: [{ id: "t1", label: "one" }] },
    { id: "p2", activeTabId: "t3", tabs: [{ id: "t2", label: "two" }, { id: "t3", label: "three" }] },
  ],
};

describe("useActiveTab", () => {
  it("resolves the active tab through the ACTIVE panel, not the first one", () => {
    const { activePanel, activeTabId, activeTab } = useActiveTab(state);
    expect(activePanel.id).toBe("p2");
    expect(activeTabId).toBe("t3");
    expect(activeTab.label).toBe("three");
  });

  it("returns undefined rather than a wrong tab when the ids do not resolve", () => {
    // A panel id with no panel, and a tab id with no tab, both happen mid-close.
    // Falling back to panels[0] / tabs[0] here would silently address a live
    // terminal the user is not looking at.
    expect(useActiveTab({ ...state, activePanelId: "gone" })).toEqual({
      activePanel: undefined,
      activeTabId: undefined,
      activeTab: undefined,
    });
    const stale = { ...state, panels: [{ id: "p2", activeTabId: "ghost", tabs: [{ id: "t2" }] }] };
    const out = useActiveTab(stale);
    expect(out.activeTabId).toBe("ghost");
    expect(out.activeTab).toBeUndefined();
  });

  it("exposes tab identity ONLY, no recording state, which is pane-keyed", () => {
    expect(Object.keys(useActiveTab(state)).sort()).toEqual(["activePanel", "activeTab", "activeTabId"]);
    // The specific regression: a tab-keyed recording flag reappearing here.
    expect("activeTabRecording" in useActiveTab(state)).toBe(false);
    // …and it must not silently take a second argument to compute one from.
    expect(useActiveTab.length).toBe(1);
  });
});
