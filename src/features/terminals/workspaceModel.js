// (C)
// Pure workspace-model factories shared between TerminalsTab and the
// useWorkspaceTree reducer hook. A "default panel" opens to the MobaXterm launch
// screen (a home tab, no PTY until the user picks a session); defaultState wraps
// one in a fresh top-level state; renumberDefaultLabels keeps "Tab N" numbering
// contiguous after a close. Defined once here so both the component init and the
// tree mutations mint identical shapes.

import { freshId } from "./ids.js";
import { leafIds } from "./splitTree";

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

// Deep-clone a saved workspace with fresh ids for every panel/tab/pane so a
// loaded layout is a clean instance (no scrollback-file or React-key collisions
// with the layout it replaces). Maps old pane ids → new so activePaneId follows.
function regenLayout(node, map) {
  if (!node) return node;
  const newId = node.dir ? freshId("split") : freshId("pane");
  map[node.id] = newId;
  if (!node.dir) return { ...node, id: newId };
  return { ...node, id: newId, a: regenLayout(node.a, map), b: regenLayout(node.b, map) };
}
export function cloneWorkspaceFresh(ws) {
  let newActivePanelId = null;
  const panels = (ws.panels || []).map((p) => {
    const newPanelId = freshId("panel");
    if (p.id === ws.activePanelId) newActivePanelId = newPanelId;
    let newActiveTabId = null;
    const tabs = (p.tabs || []).map((t) => {
      const newTabId = freshId("tab");
      if (t.id === p.activeTabId) newActiveTabId = newTabId;
      if (!t.layout) return { ...t, id: newTabId, activePaneId: newTabId };
      const map = {};
      const layout = regenLayout(t.layout, map);
      const activePaneId = map[t.activePaneId] || leafIds(layout)[0] || newTabId;
      return { ...t, id: newTabId, layout, activePaneId };
    });
    return { id: newPanelId, tabs, activeTabId: newActiveTabId || (tabs[0] && tabs[0].id) || null };
  });
  return { panels, activePanelId: newActivePanelId || (panels[0] && panels[0].id) || null };
}
