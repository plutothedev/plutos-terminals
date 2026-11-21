// (C)
// @vitest-environment happy-dom
// A close that arrives for a tab which is already gone must do nothing. Since
// v0.7.6 confirms queue instead of replacing each other, so two presses of
// Ctrl+Shift+W on a tab with an unsaved remote edit queue two "Discard
// changes?" dialogs for the SAME tab id. Answering the first closes that tab;
// answering the second used to reach closeTab's one-tab branch (the panel now
// holds only the OTHER tab) and close the whole panel, killing a session the
// user never targeted.
import { describe, test, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@backend", () => ({ invoke: () => Promise.resolve() }));

import { useWorkspaceTree } from "./useWorkspaceTree.js";

function stateWith(tabs) {
  return {
    panels: [{ id: "panel-1", activeTabId: tabs[0].id, tabs }],
    activePanelId: "panel-1",
    gridMode: "auto",
    projects: [],
  };
}

function mountTree(state) {
  const persist = vi.fn();
  const toast = { info: vi.fn(), error: vi.fn(), success: vi.fn() };
  const { result } = renderHook(() => useWorkspaceTree({ state, persist, toast }));
  return { api: result.current, persist };
}

describe("closeTab with a tab id that is no longer in the panel", () => {
  test("leaves the panel and its remaining tab alone", () => {
    // The panel after the first close: only Y is left; X is gone.
    const { api, persist } = mountTree(stateWith([{ id: "tab-y", label: "y" }]));
    api.closeTab("panel-1", "tab-x");
    expect(persist).not.toHaveBeenCalled();
  });

  test("a real close of the last tab still closes the panel", () => {
    const { api, persist } = mountTree(stateWith([{ id: "tab-y", label: "y" }]));
    api.closeTab("panel-1", "tab-y");
    expect(persist).toHaveBeenCalled();
  });
});
