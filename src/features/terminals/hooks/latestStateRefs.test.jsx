// @vitest-environment happy-dom
// (C)
// The "latest state behind a ref" contract shared by the workspace hooks
// (useWorkspaceTree, useSessionSpawn, useSshConnect, useProjects,
// useSessionDispatch): a handler captured on an EARLIER render, or held across
// an await, must act on the state of the LATEST committed render, never the
// snapshot it was created with (the lost-update class). Pinned before the
// ref writes moved from the render body into layout effects (v0.7.6 lint
// cleanup): the handlers here are deliberately taken from the first render
// and called after a re-render with new state.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, render, act } from "@testing-library/react";
import { useEffect } from "react";

let secret = null;
vi.mock("@backend", () => ({
  invoke: (cmd) => (cmd === "secret_get" ? Promise.resolve(secret) : Promise.resolve(null)),
}));
// Reset after every test so a failing assertion cannot leak a secret into
// the next one.
afterEach(() => { secret = null; });

import { useWorkspaceTree } from "./useWorkspaceTree.js";
import { useSessionSpawn } from "./useSessionSpawn.js";
import { useSshConnect } from "./useSshConnect.js";
import { useProjects } from "./useProjects.js";
import { useSessionDispatch } from "./useSessionDispatch.js";

const noop = () => {};
const toast = { error: noop, info: noop, success: noop };

const s1 = {
  activePanelId: "panel_1",
  panels: [
    { id: "panel_1", activeTabId: "tab_a", tabs: [{ id: "tab_a", label: "a" }] },
    { id: "panel_2", activeTabId: "tab_b", tabs: [{ id: "tab_b", label: "b" }] },
  ],
  projects: [],
};
// The newer state: focus moved to panel_2 and panel_2 gained a tab.
const s2 = {
  ...s1,
  activePanelId: "panel_2",
  panels: [
    s1.panels[0],
    { id: "panel_2", activeTabId: "tab_c", tabs: [...s1.panels[1].tabs, { id: "tab_c", label: "c" }] },
  ],
};

describe("handlers read the latest committed state", () => {
  it("useWorkspaceTree: a first-render handler sees the re-rendered state", () => {
    const persist = vi.fn();
    const { result, rerender } = renderHook(({ state }) => useWorkspaceTree({ state, persist, toast }), {
      initialProps: { state: s1 },
    });
    const { renameTab } = result.current;
    rerender({ state: s2 });
    act(() => renameTab("tab_c", "renamed"));
    const next = persist.mock.calls.at(-1)[0];
    const p2 = next.panels.find((p) => p.id === "panel_2");
    expect(p2.tabs.map((t) => t.id)).toEqual(["tab_b", "tab_c"]);
    expect(p2.tabs[1].label).toBe("renamed");
    expect(next.activePanelId).toBe("panel_2");
  });

  it("useSessionSpawn: spawnSessionTab appends to the latest panels", () => {
    const persist = vi.fn();
    const { result, rerender } = renderHook(({ state }) => useSessionSpawn({ state, persist }), {
      initialProps: { state: s1 },
    });
    const { spawnSessionTab } = result.current;
    rerender({ state: s2 });
    act(() => spawnSessionTab("panel_2", { id: "tab_new" }));
    const next = persist.mock.calls.at(-1)[0];
    expect(next.panels.find((p) => p.id === "panel_2").tabs.map((t) => t.id)).toEqual(["tab_b", "tab_c", "tab_new"]);
  });

  it("useSshConnect: quickConnect resolves the active panel after its await", async () => {
    secret = "pw";
    const spawnSessionTab = vi.fn();
    const { result, rerender } = renderHook(({ state }) => useSshConnect({ state, spawnSessionTab, toast }), {
      initialProps: { state: s1 },
    });
    const { quickConnect } = result.current;
    rerender({ state: s2 });
    await act(async () => { quickConnect("me@host"); await Promise.resolve(); await Promise.resolve(); });
    expect(spawnSessionTab).toHaveBeenCalledTimes(1);
    expect(spawnSessionTab.mock.calls[0][0]).toBe("panel_2");
  });

  it("useProjects: upsertProject writes onto the latest state and project list", () => {
    const persist = vi.fn();
    const p1 = [{ id: "proj_1", name: "one" }];
    const p2 = [...p1, { id: "proj_2", name: "two" }];
    const ribbon = { current: noop };
    const { result, rerender } = renderHook(
      ({ state, projects }) => useProjects({ state, persist, projects, toast, selectRibbonRef: ribbon }),
      { initialProps: { state: s1, projects: p1 } }
    );
    const { upsertProject } = result.current;
    rerender({ state: s2, projects: p2 });
    act(() => { upsertProject({ name: "edited" }, "proj_2"); });
    const next = persist.mock.calls.at(-1)[0];
    expect(next.activePanelId).toBe("panel_2");
    expect(next.projects.map((p) => p.name)).toEqual(["one", "edited"]);
  });

  it("useSessionDispatch: runProjectScript targets the latest active panel and project list", () => {
    const spawnSessionTab = vi.fn();
    const p1 = [];
    const p2 = [{ id: "proj_1", name: "web", path: "/srv/web", startCommands: [] }];
    const getSessionPassword = () => undefined;
    const { result, rerender } = renderHook(
      ({ state, projects }) => useSessionDispatch({
        state, persist: noop, projects, toast, spawnSessionTab, getSessionPassword,
        setSshPrompt: noop, setVncLaunch: noop, setRdpLaunch: noop,
      }),
      { initialProps: { state: s1, projects: p1 } }
    );
    const { runProjectScript } = result.current;
    rerender({ state: s2, projects: p2 });
    act(() => runProjectScript("proj_1", "dev"));
    expect(spawnSessionTab).toHaveBeenCalledTimes(1);
    expect(spawnSessionTab.mock.calls[0][0]).toBe("panel_2");
    expect(spawnSessionTab.mock.calls[0][1].startCommands).toEqual(["npm run dev"]);
  });

  // The ref write must be a LAYOUT effect, not a passive one. A child's
  // passive effects run before its parent's, so if useWorkspaceTree wrote
  // stateRef in useEffect, a child's useEffect reacting to the new state would
  // call the handler while the ref still held the previous state.
  it("useWorkspaceTree: a child's passive effect sees the parent's new state", () => {
    const persist = vi.fn();
    function Child({ activePanelId, renameTab }) {
      useEffect(() => {
        if (activePanelId === "panel_2") renameTab("tab_c", "renamed");
      }, [activePanelId, renameTab]);
      return null;
    }
    function Parent({ state }) {
      const { renameTab } = useWorkspaceTree({ state, persist, toast });
      return <Child activePanelId={state.activePanelId} renameTab={renameTab} />;
    }
    const { rerender } = render(<Parent state={s1} />);
    expect(persist).not.toHaveBeenCalled();
    rerender(<Parent state={s2} />);
    expect(persist).toHaveBeenCalledTimes(1);
    const next = persist.mock.calls[0][0];
    expect(next.activePanelId).toBe("panel_2");
    const p2 = next.panels.find((p) => p.id === "panel_2");
    expect(p2.tabs.map((t) => [t.id, t.label])).toEqual([["tab_b", "b"], ["tab_c", "renamed"]]);
  });
});
