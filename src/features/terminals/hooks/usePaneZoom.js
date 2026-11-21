// (C)
// Which pane of each panel is zoomed to fill its tab ({ [panelId]: paneId }).
//
// This state used to be local to TerminalPanel, which left zoom reachable only
// by the pane's hover control: that control is mouse-only in practice (it sits
// between xterm inputs, and xterm keeps Tab), and zoom has no key binding (a
// new global combo could collide with shell keys). Lifted here so the command
// palette and the Terminal menu, both built in TerminalsTab, can toggle it for
// the active pane, and the hover control, palette and menu share one state.
// Session-only, never persisted, exactly as before.
import { useCallback, useState } from "react";
import { getLayout, leafIds } from "../splitTree.js";
import { resolveActivePaneId } from "../activePane.js";
import { isSpecialTab } from "../paneIds.js";
import { getEntry } from "../paneRegistry.js";

// The active panel's active pane, when it can be zoomed: a terminal tab with
// more than one pane. Null otherwise (single pane, home, notebook, RDP, VNC).
function zoomTarget(state) {
  const panel = state?.panels?.find((p) => p.id === state.activePanelId);
  const tab = panel?.tabs?.find((t) => t.id === panel.activeTabId);
  if (!tab || isSpecialTab(tab)) return null;
  if (leafIds(getLayout(tab)).length <= 1) return null;
  const paneId = resolveActivePaneId(tab);
  return paneId ? { panelId: panel.id, paneId } : null;
}

export function usePaneZoom(state) {
  const [zoomedPanes, setZoomedPanes] = useState({});

  // TerminalPanel's setter (the hover control): stable, so the memo'd panel
  // never re-renders for it.
  const setPaneZoom = useCallback((panelId, paneId) => {
    setZoomedPanes((prev) => {
      if ((prev[panelId] ?? null) === (paneId ?? null)) return prev;
      const next = { ...prev };
      if (paneId == null) delete next[panelId];
      else next[panelId] = paneId;
      return next;
    });
  }, []);

  const target = zoomTarget(state);
  const canZoomActivePane = target != null;
  const activePaneZoomed = target != null && zoomedPanes[target.panelId] === target.paneId;

  // The palette and menu action. Zooms the active pane, or restores the split
  // when that pane is the zoomed one. Either way the pane it acted on is
  // visible afterwards (zoomed, or back in the split), so keyboard focus goes
  // to its terminal and never to a pane the zoom covers. Deferred a task like
  // the focusPane shortcut: the palette or menu that ran this hands focus back
  // to its opener as it closes, and this must land after that.
  const toggleActivePaneZoom = useCallback(() => {
    const t = zoomTarget(state);
    if (!t) return;
    setZoomedPanes((prev) => {
      const next = { ...prev };
      if (prev[t.panelId] === t.paneId) delete next[t.panelId];
      else next[t.panelId] = t.paneId;
      return next;
    });
    setTimeout(() => {
      try { getEntry(t.paneId)?.term?.focus(); } catch { /* best effort: the pane may have been disposed in the tick since; the zoom already landed */ }
    }, 0);
  }, [state]);

  return { zoomedPanes, setPaneZoom, canZoomActivePane, activePaneZoomed, toggleActivePaneZoom };
}
