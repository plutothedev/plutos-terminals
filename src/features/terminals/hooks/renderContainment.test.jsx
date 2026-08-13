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
import { useSessionDispatch } from "./useSessionDispatch.js";
import { useProjects } from "./useProjects.js";
import {
  setPaneActivity,
  setProjectIndex,
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
  it("switchTab persist keeps tabAutoApprove/tabProjectNames/paneTitles identities", () => {
    const { result, rerender } = renderHook(
      ({ state }) => useTabTelemetry({ state, projects }),
      { initialProps: { state: stateA } }
    );
    const ap1 = result.current.tabAutoApprove;
    const names1 = result.current.tabProjectNames;
    const titles1 = result.current.paneTitles;
    // A REAL switchTab persist shape (T2 review: the first draft reused the
    // same panels reference, which the plain pre-T2 useMemo also survived —
    // vacuous). useWorkspaceTree's reducers return NEW panel/array references
    // with equal content; that is exactly what useStableMap must collapse.
    const stateB = {
      ...stateA,
      activePanelId: "panel_2",
      panels: stateA.panels.map((p) => ({ ...p, tabs: p.tabs.map((t) => ({ ...t })) })),
    };
    rerender({ state: stateB });
    expect(result.current.tabAutoApprove).toBe(ap1);
    expect(result.current.tabProjectNames).toBe(names1);
    // paneTitles rides the same contract (copy-sweep review WARNING: it feeds
    // the memo'd TerminalPanel — a fresh object per persist would bust the
    // pane-tree memo on every tab switch).
    expect(result.current.paneTitles).toBe(titles1);
  });

  it("a REAL tab rename produces a fresh paneTitles identity with the new label", () => {
    const { result, rerender } = renderHook(
      ({ state }) => useTabTelemetry({ state, projects }),
      { initialProps: { state: stateA } }
    );
    const titles1 = result.current.paneTitles;
    expect(titles1.tab_a).toBe("Terminal 1"); // untitled fallback
    const renamed = {
      ...stateA,
      panels: stateA.panels.map((p, i) =>
        i === 0 ? { ...p, tabs: [{ ...p.tabs[0], label: "api-server" }] } : p
      ),
    };
    rerender({ state: renamed });
    expect(result.current.paneTitles).not.toBe(titles1);
    expect(result.current.paneTitles.tab_a).toBe("api-server");
  });

  it("H3: dispatch/project handlers keep identity across persists", () => {
    // The plan-mandated assertion the first harness draft dropped — and the
    // gap that let the sidebarClickProject wrapper regression slip through.
    // Mocks are STABLE consts — mirroring the app, where toast/spawn/etc.
    // keep identity across renders (a fresh mock per rerender would re-mint
    // the handlers through their own deps and test nothing).
    const noop = () => {};
    const stableToast = { error: noop, info: noop, success: noop };
    const stableGetPassword = () => undefined;
    const dispatchProps = (state) => ({
      state,
      persist: noop,
      projects: state.projects || [],
      toast: stableToast,
      spawnSessionTab: noop,
      getSessionPassword: stableGetPassword,
      setSshPrompt: noop,
      setVncLaunch: noop,
      setRdpLaunch: noop,
    });
    const d = renderHook(({ state }) => useSessionDispatch(dispatchProps(state)), {
      initialProps: { state: { ...stateA, projects } },
    });
    const open1 = d.result.current.openProjectInPanel;
    const run1 = d.result.current.runProjectScript;
    const wt1 = d.result.current.openAgentWorktree;
    d.rerender({ state: { ...stateA, projects, activePanelId: "panel_2" } });
    expect(d.result.current.openProjectInPanel).toBe(open1);
    expect(d.result.current.runProjectScript).toBe(run1);
    expect(d.result.current.openAgentWorktree).toBe(wt1);

    const stableToast2 = { error: noop, info: noop, success: noop };
    const stableRibbonRef = { current: noop };
    const pr = renderHook(
      ({ state }) =>
        useProjects({
          state,
          persist: noop,
          projects: state.projects || [],
          toast: stableToast2,
          selectRibbonRef: stableRibbonRef,
        }),
      { initialProps: { state: { ...stateA, projects } } }
    );
    const remove1 = pr.result.current.removeProject;
    const upsert1 = pr.result.current.upsertProject;
    pr.rerender({ state: { ...stateA, projects: [...projects], activePanelId: "panel_2" } });
    expect(pr.result.current.removeProject).toBe(remove1);
    expect(pr.result.current.upsertProject).toBe(upsert1);
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

  it("a NON-indexed (split-child) pane flip keeps rollup identity", () => {
    // Stream-audit W3: split children never feed project rollups, so their
    // flips must not re-render rollup consumers.
    act(() => setProjectIndex(new Map([["tab_a", "proj_1"]])));
    act(() => setPaneActivity("tab_a", "active"));
    const { result, rerender } = renderHook(() => useProjectRollups());
    const snap1 = result.current;
    act(() => setPaneActivity("pane_split_child", "waiting")); // not in index
    rerender();
    expect(result.current).toBe(snap1);
  });

  it("re-setting an IDENTICAL project index is a no-op for snapshots", () => {
    // 16ccc15's change-guard: tab switches rebuild an equal mapping — the
    // cached snapshots must keep identity through it.
    act(() => setPaneActivity("tab_a", "active"));
    act(() => setProjectIndex(new Map([["tab_a", "proj_1"]])));
    const { result, rerender } = renderHook(() => useProjectRollups());
    const snap1 = result.current;
    act(() => setProjectIndex(new Map([["tab_a", "proj_1"]]))); // equal rebuild
    rerender();
    expect(result.current).toBe(snap1);
  });
});
