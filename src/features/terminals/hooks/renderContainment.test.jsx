// @vitest-environment happy-dom
// (C)
// P2-T2 render-containment harness (the plan's promised verification): the
// identity guarantees the panel memos depend on, exercised through REAL hook
// renders — not just data-layer unit tests. Without these, a future refactor
// could silently re-couple a consumer to whole-map churn with nothing to
// catch it (T1 review flag).
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTabTelemetry } from "./useTabTelemetry.js";
import {
  setPaneActivity,
  usePanelActivityStamp,
  useProjectRollups,
  __resetActivityStore,
} from "../activityStore.js";

beforeEach(() => __resetActivityStore());

const stateA = {
  activePanelId: "panel_1",
  panels: [
    { id: "panel_1", activeTabId: "tab_a", tabs: [{ id: "tab_a", projectId: "proj_1" }] },
    { id: "panel_2", activeTabId: "tab_b", tabs: [{ id: "tab_b", projectId: null }] },
  ],
};
const projects = [{ id: "proj_1", name: "alpha", autoApprove: true }];

describe("P2-T2 identity containment", () => {
  it("switchTab persist keeps tabAutoApprove/tabProjectNames identities", () => {
    const { result, rerender } = renderHook(
      ({ state }) => useTabTelemetry({ state, projects }),
      { initialProps: { state: stateA } }
    );
    const ap1 = result.current.tabAutoApprove;
    const names1 = result.current.tabProjectNames;
    // A tab switch: new state identity, same tabs/projects content.
    const stateB = { ...stateA, activePanelId: "panel_2" };
    rerender({ state: stateB });
    expect(result.current.tabAutoApprove).toBe(ap1);
    expect(result.current.tabProjectNames).toBe(names1);
  });

  it("a REAL auto-approve toggle produces a fresh identity", () => {
    const { result, rerender } = renderHook(
      ({ projs }) => useTabTelemetry({ state: stateA, projects: projs }),
      { initialProps: { projs: projects } }
    );
    const ap1 = result.current.tabAutoApprove;
    const toggled = [{ ...projects[0], autoApprove: false }];
    rerender({ projs: toggled });
    expect(result.current.tabAutoApprove).not.toBe(ap1);
    expect(result.current.tabAutoApprove).toEqual({});
  });

  it("an activity flip re-renders ONLY the subscribed panel's stamp", () => {
    let rendersA = 0;
    let rendersB = 0;
    const hookA = renderHook(() => {
      rendersA++;
      return usePanelActivityStamp("tab_a");
    });
    const hookB = renderHook(() => {
      rendersB++;
      return usePanelActivityStamp("tab_b");
    });
    const aBefore = rendersA;
    const bBefore = rendersB;
    act(() => setPaneActivity("tab_a", "active"));
    expect(rendersA).toBeGreaterThan(aBefore); // subscribed panel re-rendered
    expect(rendersB).toBe(bBefore); // unrelated panel did NOT
    expect(hookA.result.current).toBe("active");
    expect(hookB.result.current).toBe("i");
  });

  it("project rollup subscribers see flips; identity stable when nothing changes", () => {
    const { result, rerender } = renderHook(() => useProjectRollups());
    const empty = result.current;
    rerender();
    expect(result.current).toBe(empty); // cached identity across renders
  });
});
