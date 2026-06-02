// (C)
// The panel / tab / split-pane reducer — the core workspace-tree mutations,
// lifted verbatim out of the TerminalsTab god component. Every callback closes
// over (state, persist): it derives the next tree and writes it through persist.
// The interdependencies (closeTab → closePanel, closePane → closeTab, detachTab →
// closeTab, moveTab/closePanel → defaultPanel) are all internal to this hook, so
// it extracts cleanly. clearTabPassword drops a leaving tab's transient SSH
// password; detachTab seeds a new window's per-window state and is the only path
// that touches localStorage / spawn_new_window. toast is injected for detachTab's
// user feedback.

import { useCallback } from "react";
import { invoke } from "@backend";
import { clearTabPassword } from "../ptyBridge.js";
import { getWindowStorageKey } from "../storageKeys.js";
import { freshId } from "../ids.js";
import { defaultPanel, renumberDefaultLabels } from "../workspaceModel.js";
import { getLayout, leafIds, leaves, splitLeaf, removeLeaf, setRatio } from "../splitTree";
import { MAX_PANELS } from "../grid";

export function useWorkspaceTree({ state, persist, toast }) {
  // ── Panel / tab mutations ──────────────────────────────────────────

  const setActivePanel = useCallback((panelId) => {
    if (state.activePanelId === panelId) return;
    persist({ ...state, activePanelId: panelId });
  }, [state, persist]);

  const addPanel = useCallback(() => {
    if (state.panels.length >= MAX_PANELS) return;
    const panel = defaultPanel();
    persist({ ...state, panels: [...state.panels, panel], activePanelId: panel.id });
  }, [state, persist]);

  const closePanel = useCallback((panelId) => {
    // Drop any transient SSH passwords for the tabs leaving with this panel.
    // Gated on real removal (not pane unmount) so moveTab — which unmounts +
    // respawns the same tab id in another panel — keeps its password.
    const closing = state.panels.find(p => p.id === panelId);
    if (closing) closing.tabs.forEach(t => clearTabPassword(t.id));
    const panels = state.panels.filter(p => p.id !== panelId);
    if (panels.length === 0) {
      const panel = defaultPanel();
      persist({ ...state, panels: [panel], activePanelId: panel.id });
      return;
    }
    const activePanelId = state.activePanelId === panelId ? panels[0].id : state.activePanelId;
    persist({ ...state, panels, activePanelId });
  }, [state, persist]);

  const addTab = useCallback((panelId) => {
    const panels = state.panels.map(p => {
      if (p.id !== panelId) return p;
      // Base name "shell"; the tab strip prepends the position number
      // (MobaXterm-style "1. shell", "2. shell", …).
      const newTab = {
        id: freshId("tab"),
        label: "shell",
        cwd: null,
        startCommands: [],
        projectId: null,
      };
      return { ...p, tabs: [...p.tabs, newTab], activeTabId: newTab.id };
    });
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist]);

  // Open a fresh MobaXterm launch screen ("home" tab) in a panel. No PTY spawns
  // until the user picks a session from it.
  const addHomeTab = useCallback((panelId) => {
    const newTab = { id: freshId("tab"), label: "Home", home: true, cwd: null, startCommands: [], projectId: null };
    const panels = state.panels.map(p =>
      p.id === panelId ? { ...p, tabs: [...p.tabs, newTab], activeTabId: newTab.id } : p
    );
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist]);

  // Home button (in each panel's tab strip): focus the panel's existing launch
  // screen if it has one, otherwise open a fresh one.
  const focusOrAddHomeTab = useCallback((panelId) => {
    const panel = state.panels.find(p => p.id === panelId);
    const home = panel?.tabs.find(t => t.home);
    if (home) {
      const panels = state.panels.map(p => p.id === panelId ? { ...p, activeTabId: home.id } : p);
      persist({ ...state, panels, activePanelId: panelId });
    } else {
      addHomeTab(panelId);
    }
  }, [state, persist, addHomeTab]);

  // Turn a home tab into a plain local shell in place (the "Start local
  // terminal" action). Dropping the home flag mounts a TerminalPane, which
  // spawns the PTY. Relabels to the default scheme so it reads like a shell tab.
  const convertHomeToShell = useCallback((panelId, tabId) => {
    const panels = state.panels.map(p => {
      if (p.id !== panelId) return p;
      return {
        ...p,
        tabs: p.tabs.map(t => t.id === tabId ? { ...t, home: false, label: "shell" } : t),
        activeTabId: tabId,
      };
    });
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist]);

  const closeTab = useCallback((panelId, tabId) => {
    const target = state.panels.find(p => p.id === panelId);
    if (!target) return;
    if (target.tabs.length === 1) {
      closePanel(panelId);
      return;
    }
    clearTabPassword(tabId); // tab genuinely leaving; closePanel handles the 1-tab case
    const panels = state.panels.map(p => {
      if (p.id !== panelId) return p;
      const tabs = renumberDefaultLabels(p.tabs.filter(t => t.id !== tabId));
      let activeTabId = p.activeTabId;
      if (activeTabId === tabId) {
        const idx = p.tabs.findIndex(t => t.id === tabId);
        const nextIdx = Math.min(idx, tabs.length - 1);
        activeTabId = tabs[nextIdx].id;
      }
      return { ...p, tabs, activeTabId };
    });
    persist({ ...state, panels });
  }, [state, persist, closePanel]);

  const switchTab = useCallback((panelId, tabId) => {
    const panels = state.panels.map(p =>
      p.id === panelId ? { ...p, activeTabId: tabId } : p
    );
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist]);

  const renameTab = useCallback((tabId, label) => {
    const panels = state.panels.map(p => ({
      ...p,
      tabs: p.tabs.map(t => t.id === tabId ? { ...t, label } : t),
    }));
    persist({ ...state, panels });
  }, [state, persist]);

  const setTabColor = useCallback((tabId, color) => {
    const panels = state.panels.map(p => ({
      ...p,
      tabs: p.tabs.map(t => t.id === tabId ? { ...t, color: color || undefined } : t),
    }));
    persist({ ...state, panels });
  }, [state, persist]);

  // Tab context-menu actions (right-click a tab). Duplicate spawns a fresh tab
  // with the same config (cwd / connection / serial / start commands) — a new
  // PTY, single pane (the split layout isn't cloned). Close-others keeps only
  // the chosen tab in its panel.
  const duplicateTab = useCallback((panelId, tabId) => {
    const panel = state.panels.find(p => p.id === panelId);
    const src = panel?.tabs.find(t => t.id === tabId);
    if (!src) return;
    const copy = { ...src, id: freshId("tab"), layout: undefined, activePaneId: undefined };
    const panels = state.panels.map(p =>
      p.id === panelId ? { ...p, tabs: [...p.tabs, copy], activeTabId: copy.id } : p
    );
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist]);

  // Detach a tab into its own window: write a one-panel state under the new
  // window's per-window key (App reads `…:state:v0:<w>`), close the tab here,
  // then open the window. The session re-spawns from its saved config (cwd /
  // connection / start commands) — a fresh process, not a live hand-off, since
  // the running PTY id isn't persisted.
  const detachTab = useCallback(async (panelId, tabId) => {
    const panel = state.panels.find(p => p.id === panelId);
    const src = panel?.tabs.find(t => t.id === tabId);
    if (!src) return;
    if (src.home) { toast.info("Open a session in this tab first, then detach it."); return; }
    const winId = `${Date.now().toString(36)}`.slice(-6);
    const newPanelId = freshId("panel");
    const tabCopy = { ...src, layout: undefined, activePaneId: undefined };
    const newState = {
      panels: [{ id: newPanelId, tabs: [tabCopy], activeTabId: tabCopy.id }],
      activePanelId: newPanelId,
      gridMode: "auto",
      projects: state.projects,
    };
    const stateKey = getWindowStorageKey(winId);
    try { localStorage.setItem(stateKey, JSON.stringify(newState)); } catch { /* ignore */ }
    // Open the window FIRST; only drop the tab here once it succeeds, so a spawn
    // failure never loses the session.
    try {
      await invoke("spawn_new_window", { windowId: winId });
    } catch (e) {
      try { localStorage.removeItem(stateKey); } catch { /* ignore */ }
      toast.error(`Detach failed: ${e}`);
      return;
    }
    closeTab(panelId, tabId);
    toast.success(`Detached "${src.label}" to a new window.`);
  }, [state, closeTab, toast]);

  const closeOtherTabs = useCallback((panelId, keepTabId) => {
    const panel = state.panels.find(p => p.id === panelId);
    if (!panel) return;
    const kept = panel.tabs.filter(t => t.id === keepTabId);
    if (kept.length === 0) return;
    panel.tabs.forEach(t => { if (t.id !== keepTabId) clearTabPassword(t.id); });
    const panels = state.panels.map(p =>
      p.id === panelId ? { ...p, tabs: renumberDefaultLabels(kept), activeTabId: keepTabId } : p
    );
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist]);

  // Move a tab from its current panel to a different one. PTY in the source
  // panel gets killed (TerminalPane unmount), a fresh one spawns in the
  // target panel — startCommands re-run, scrollback replays from the disk
  // file so context isn't lost. v2 (preserve PTY across moves) would need
  // a connection registry outside React's lifecycle.
  const moveTab = useCallback((tabId, tgtPanelId) => {
    const srcPanel = state.panels.find(p => p.tabs.some(t => t.id === tabId));
    if (!srcPanel || srcPanel.id === tgtPanelId) return;
    const tab = srcPanel.tabs.find(t => t.id === tabId);
    if (!tab) return;
    let panels = state.panels.map(p => {
      if (p.id === srcPanel.id) {
        const remaining = p.tabs.filter(t => t.id !== tabId);
        let activeTabId = p.activeTabId;
        if (activeTabId === tabId) {
          const idx = p.tabs.findIndex(t => t.id === tabId);
          const nextIdx = Math.min(idx, remaining.length - 1);
          activeTabId = remaining[nextIdx]?.id || null;
        }
        return { ...p, tabs: remaining, activeTabId };
      }
      if (p.id === tgtPanelId) {
        return { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id };
      }
      return p;
    });
    // If the source panel ran dry, drop it.
    panels = panels.filter(p => p.tabs.length > 0);
    if (panels.length === 0) {
      const fresh = defaultPanel();
      persist({ ...state, panels: [fresh], activePanelId: fresh.id });
      return;
    }
    let activePanelId = panels.find(p => p.id === tgtPanelId) ? tgtPanelId : panels[0].id;
    persist({ ...state, panels, activePanelId });
  }, [state, persist]);

  // Reorder a tab WITHIN its own panel (drag-to-rearrange). Unlike moveTab this
  // keeps the live PTY — the tab keeps its React key (tab.id), so the array just
  // reorders and nothing remounts. Default "shell N" labels renumber to the new
  // order; custom-renamed tabs keep their name.
  const reorderTab = useCallback((tabId, toIndex) => {
    const panel = state.panels.find(p => p.tabs.some(t => t.id === tabId));
    if (!panel) return;
    const from = panel.tabs.findIndex(t => t.id === tabId);
    if (from < 0) return;
    const to = Math.max(0, Math.min(toIndex, panel.tabs.length - 1));
    if (to === from) return;
    const tabs = panel.tabs.slice();
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    const panels = state.panels.map(p =>
      p.id === panel.id ? { ...p, tabs: renumberDefaultLabels(tabs) } : p
    );
    persist({ ...state, panels });
  }, [state, persist]);

  // ── In-tab split panes (v3.0) ──────────────────────────────────────
  // A tab's content is a binary split tree (splitTree.js). Mutations find the
  // owning panel by tab id so TerminalPanel can call them with just (tabId, …).

  const panelIdForTab = useCallback((tabId) => {
    const p = state.panels.find((pp) => pp.tabs.some((t) => t.id === tabId));
    return p?.id || null;
  }, [state]);

  // Split the pane `paneId` inside `tabId` along `dir` ('row' = side by side,
  // 'col' = stacked). The new pane inherits the split pane's cwd as a fresh
  // shell; the existing pane keeps its live PTY (flat render = no remount).
  const splitPane = useCallback((tabId, paneId, dir) => {
    const panelId = panelIdForTab(tabId);
    if (!panelId) return;
    const newLeafId = freshId("pane");
    const splitId = freshId("split");
    const panels = state.panels.map((p) => {
      if (p.id !== panelId) return p;
      return {
        ...p,
        tabs: p.tabs.map((t) => {
          if (t.id !== tabId) return t;
          const layout = getLayout(t);
          const inheritCwd = leaves(layout).find((l) => l.id === paneId)?.cwd ?? (t.cwd || null);
          const nextLayout = splitLeaf(layout, paneId, dir, { id: newLeafId, cwd: inheritCwd }, splitId);
          return { ...t, layout: nextLayout, activePaneId: newLeafId };
        }),
      };
    });
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist, panelIdForTab]);

  // Close one pane. Closing the last pane of a tab closes the tab.
  const closePane = useCallback((tabId, paneId) => {
    const panelId = panelIdForTab(tabId);
    if (!panelId) return;
    const tab = state.panels.find((p) => p.id === panelId)?.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const layout = getLayout(tab);
    if (leafIds(layout).length <= 1) {
      closeTab(panelId, tabId);
      return;
    }
    const next = removeLeaf(layout, paneId);
    const remaining = leafIds(next);
    let activePaneId = tab.activePaneId || tab.id;
    if (!remaining.includes(activePaneId)) activePaneId = remaining[0];
    const panels = state.panels.map((p) => {
      if (p.id !== panelId) return p;
      return {
        ...p,
        tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, layout: next, activePaneId } : t)),
      };
    });
    persist({ ...state, panels });
  }, [state, persist, panelIdForTab, closeTab]);

  const activatePane = useCallback((tabId, paneId) => {
    const panelId = panelIdForTab(tabId);
    if (!panelId) return;
    const panels = state.panels.map((p) => {
      if (p.id !== panelId) return p;
      return {
        ...p,
        tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t)),
      };
    });
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist, panelIdForTab]);

  const setPaneRatio = useCallback((tabId, splitId, ratio) => {
    const panelId = panelIdForTab(tabId);
    if (!panelId) return;
    const panels = state.panels.map((p) => {
      if (p.id !== panelId) return p;
      return {
        ...p,
        tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, layout: setRatio(getLayout(t), splitId, ratio) } : t)),
      };
    });
    persist({ ...state, panels });
  }, [state, persist, panelIdForTab]);

  return {
    setActivePanel, addPanel, closePanel,
    addTab, addHomeTab, focusOrAddHomeTab, convertHomeToShell,
    closeTab, switchTab, renameTab, setTabColor, duplicateTab, detachTab, closeOtherTabs, moveTab, reorderTab,
    panelIdForTab, splitPane, closePane, activatePane, setPaneRatio,
  };
}
