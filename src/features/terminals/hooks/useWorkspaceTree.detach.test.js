// (C)
// @vitest-environment happy-dom
// Locks the NESTING LEVEL detachTab seeds into the new window's blob. The
// per-window blob nests the workspace one level down under `terminalsState`:
// TerminalsTab's persist writes `save(prev => ({ ...prev, terminalsState: next }))`
// and boot reads it back as `st?.terminalsState || defaultState()`. detachTab
// wrote the bare INNER shape as the whole blob, so the detached window booted
// to defaultState() while closeTab had already dropped the tab from the source
// window: the session's label, cwd, connection binding and start commands were
// destroyed (audit RDI-1). Every assertion here reads the seed back through the
// SAME `st?.terminalsState` expression TerminalsTab uses, so the writer and the
// reader can never drift apart again.
import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const invoke = vi.fn(() => Promise.resolve());
vi.mock("@backend", () => ({ invoke: (...a) => invoke(...a) }));

import { useWorkspaceTree } from "./useWorkspaceTree.js";
import { allOpenTabIds, STATE_KEY_PREFIX } from "../storageKeys.js";

// One panel holding the tab to detach plus a sibling, so closeTab takes the
// ordinary remove path rather than closePanel's last-tab path.
function fixtureState() {
  return {
    panels: [{
      id: "panel-1",
      activeTabId: "tab-ssh",
      tabs: [
        { id: "tab-ssh", label: "prod-db", cwd: "/srv/app", connection: "conn-1", startCommands: ["tmux attach"] },
        { id: "tab-2", label: "shell", cwd: null, startCommands: [] },
      ],
    }],
    activePanelId: "panel-1",
    gridMode: "auto",
    projects: [{ id: "p1", name: "infra" }],
  };
}

function mountTree(state) {
  const persist = vi.fn();
  const toast = { info: vi.fn(), error: vi.fn(), success: vi.fn() };
  const { result } = renderHook(() => useWorkspaceTree({ state, persist, toast }));
  return { api: result.current, persist, toast };
}

// The one localStorage key detachTab minted (`…:state:v0:<winId>`).
function detachedKey() {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(`${STATE_KEY_PREFIX}:`)) return k;
  }
  return null;
}

// The EXACT read the new window performs on boot (TerminalsTab.jsx:72). Returns
// null where TerminalsTab would fall through to defaultState() and lose the tab.
function bootRead(key) {
  const st = JSON.parse(localStorage.getItem(key) || "{}");
  return st?.terminalsState || null;
}

beforeEach(() => {
  localStorage.clear();
  invoke.mockClear();
  invoke.mockImplementation(() => Promise.resolve());
});

describe("detachTab seed (audit RDI-1)", () => {
  test("the new window boots the detached tab through st.terminalsState", async () => {
    const { api, toast } = mountTree(fixtureState());
    await act(async () => { await api.detachTab("panel-1", "tab-ssh"); });

    expect(invoke).toHaveBeenCalledWith("spawn_new_window", { windowId: expect.any(String) });
    const key = detachedKey();
    expect(key).not.toBeNull();

    // Round-trip: the seed read back the way the new window actually reads it.
    const booted = bootRead(key);
    expect(booted).not.toBeNull();
    expect(booted.panels).toHaveLength(1);
    expect(booted.panels[0].tabs).toHaveLength(1);
    const tab = booted.panels[0].tabs[0];
    expect(tab.label).toBe("prod-db");
    expect(tab.cwd).toBe("/srv/app");
    expect(tab.connection).toBe("conn-1");
    expect(tab.startCommands).toEqual(["tmux attach"]);
    expect(booted.activePanelId).toBe(booted.panels[0].id);
    expect(booted.panels[0].activeTabId).toBe(tab.id);
    expect(booted.gridMode).toBe("auto");
    expect(booted.projects).toEqual([{ id: "p1", name: "infra" }]);
    expect(toast.success).toHaveBeenCalled();
  });

  test("the detached tab is in the scrollback GC keep-set", async () => {
    const { api } = mountTree(fixtureState());
    await act(async () => { await api.detachTab("panel-1", "tab-ssh"); });
    // Same shape the GC reads: a detached session's scrollback must not be
    // reaped while its window is open.
    expect(allOpenTabIds()).toEqual([bootRead(detachedKey()).panels[0].tabs[0].id]);
  });

  test("the source tab is only closed after spawn_new_window resolves", async () => {
    const { api, persist, toast } = mountTree(fixtureState());
    invoke.mockImplementation(() => Promise.reject(new Error("no window")));
    await act(async () => { await api.detachTab("panel-1", "tab-ssh"); });
    // Spawn failed: the seed is rolled back and the tab stays put, so the
    // session is never lost to a half-completed detach.
    expect(detachedKey()).toBeNull();
    expect(persist).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  test("a home tab is refused rather than detached into an empty window", async () => {
    const state = fixtureState();
    state.panels[0].tabs[0] = { id: "tab-ssh", label: "Home", home: true, cwd: null, startCommands: [] };
    const { api, toast } = mountTree(state);
    await act(async () => { await api.detachTab("panel-1", "tab-ssh"); });
    expect(detachedKey()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();
  });
});

// A detached tab did not close, it MOVED, and it keeps its id in the new window.
// Stashing it for Ctrl+Shift+Z left one tab id resurrectable while another
// window still owned it: two ScrollbackWriters appending to one `<id>.txt` and
// rotating over each other, a scrollback_load that replays the other window's
// live session, and (on a worktree/notebook tab) the same two-owners-one-file
// break duplicateTab strips those fields to avoid. Only reachable once the
// RDI-1 fix made the detached window actually mount the tab.
describe("detachTab does not stash the moved tab for reopen", () => {
  test("reopen after a detach is a no-op in the source window", async () => {
    const { api, persist } = mountTree(fixtureState());
    await act(async () => { await api.detachTab("panel-1", "tab-ssh"); });
    // Same id, now live in the new window: a reopen here would duplicate it.
    expect(bootRead(detachedKey()).panels[0].tabs[0].id).toBe("tab-ssh");
    persist.mockClear();
    act(() => { api.reopenTab(); });
    expect(persist).not.toHaveBeenCalled();
  });

  test("an ordinary close still stashes, so Ctrl+Shift+Z keeps working", () => {
    const { api, persist } = mountTree(fixtureState());
    act(() => { api.closeTab("panel-1", "tab-ssh"); });
    persist.mockClear();
    act(() => { api.reopenTab(); });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0].panels[0].tabs.map((t) => t.id)).toContain("tab-ssh");
  });
});
