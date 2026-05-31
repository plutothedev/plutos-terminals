// (C)
// Pure workspace-model factories shared between TerminalsTab and the
// useWorkspaceTree reducer hook. A "default panel" opens to the MobaXterm launch
// screen (a home tab, no PTY until the user picks a session); defaultState wraps
// one in a fresh top-level state; renumberDefaultLabels keeps "Tab N" numbering
// contiguous after a close. Defined once here so both the component init and the
// tree mutations mint identical shapes.

import { freshId } from "./ids.js";

export function defaultPanel() {
  const tabId = freshId("tab");
  // Fresh panels open to the MobaXterm-style launch screen (a "home" tab) rather
  // than spawning a shell immediately — no PTY is created until the user picks a
  // session. Existing users keep their persisted panels untouched.
  return {
    id: freshId("panel"),
    tabs: [{ id: tabId, label: "Home", home: true, cwd: null, startCommands: [], projectId: null }],
    activeTabId: tabId,
  };
}

export function defaultState() {
  const panel = defaultPanel();
  return {
    panels: [panel],
    activePanelId: panel.id,
    gridMode: "auto",
    projects: [],
  };
}

// Re-number tab labels within a panel after a close so we don't end up with
// "Tab 1, Tab 3". Only relabels tabs that still match the default scheme —
// project-named tabs (e.g. "plutos-terminals") are left alone.
export function renumberDefaultLabels(tabs) {
  let n = 0;
  return tabs.map(t => {
    if (/^Tab \d+$/.test(t.label || "")) {
      n += 1;
      return { ...t, label: `Tab ${n}` };
    }
    return t;
  });
}
