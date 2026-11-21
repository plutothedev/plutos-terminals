// (C)
// Which pane of each panel is zoomed to fill its tab ({ [panelId]: paneId }).
//
// This state used to be local to TerminalPanel, which left zoom reachable only
// by the pane's hover control: that control is mouse-only in practice (it sits
// between xterm inputs, and xterm keeps Tab), and zoom has no key binding (a
// new global combo could collide with shell keys). Lifted here so the command
// palette and the Terminal menu, both built in TerminalsTab, can toggle it, and
// the hover control, palette and menu share one state. Session-only, never
// persisted, exactly as before.
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { getLayout, leafIds } from "../splitTree.js";
import { resolveActivePaneId } from "../activePane.js";
import { isSpecialTab } from "../paneIds.js";
import { getEntry } from "../paneRegistry.js";

// The active panel's active terminal tab, when it can be zoomed (more than one
// pane): its panel, its active pane and its panes. Null otherwise (one pane,
// home, notebook, RDP, VNC).
function zoomTarget(state) {
  const panel = state?.panels?.find((p) => p.id === state.activePanelId);
  const tab = panel?.tabs?.find((t) => t.id === panel.activeTabId);
  if (!tab || isSpecialTab(tab)) return null;
  const leaves = leafIds(getLayout(tab));
  if (leaves.length <= 1) return null;
  const paneId = resolveActivePaneId(tab);
  return paneId ? { panelId: panel.id, paneId, leaves } : null;
}

// The target tab is zoomed when its panel's zoomed pane is one of its panes,
// WHICHEVER pane is active: the focusPane shortcut can make a pane the zoom
// covers active, and the command must then offer Restore, not zoom the hidden
// pane over the visible one.
const tabIsZoomed = (zoomedPanes, t) => {
  const z = zoomedPanes[t.panelId];
  return z != null && t.leaves.includes(z);
};

const panelIdsOf = (state) => new Set((state?.panels || []).map((p) => p.id));

// The next map: entries for panels that no longer exist are dropped (closed
// panels would otherwise linger for the session), then panelId is set to
// paneId, or cleared for null. Returns prev itself when nothing changed.
function nextZoom(prev, livePanelIds, panelId, paneId) {
  const next = {};
  for (const [id, z] of Object.entries(prev)) if (livePanelIds.has(id)) next[id] = z;
  if (paneId == null) delete next[panelId];
  else next[panelId] = paneId;
  const keys = Object.keys(next);
  const same = keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]);
  return same ? prev : next;
}

export function usePaneZoom(state) {
  const [zoomedPanes, setZoomedPanes] = useState({});

  // The workspace as of the last commit, for the two callbacks below. Read
  // through a ref so they keep ONE identity: memo(MenuBar) and the memo'd
  // TerminalPanels then never re-render because the workspace changed.
  const stateRef = useRef(state);
  useLayoutEffect(() => { stateRef.current = state; });

  // TerminalPanel's setter (the hover control).
  const setPaneZoom = useCallback((panelId, paneId) => {
    const live = panelIdsOf(stateRef.current);
    live.add(panelId); // the panel calling is on screen, whatever the ref says
    setZoomedPanes((prev) => nextZoom(prev, live, panelId, paneId ?? null));
  }, []);

  const target = zoomTarget(state);
  const canZoomActivePane = target != null;
  // True when the active TAB is zoomed (not necessarily on its active pane):
  // the command then reads "Restore split (un-zoom)".
  const activePaneZoomed = target != null && tabIsZoomed(zoomedPanes, target);

  // The palette and menu action: restores the split when the active tab is
  // zoomed, else zooms the active pane. Either way the active pane is visible
  // afterwards (zoomed, or back in the split), so keyboard focus goes to its
  // terminal, never to a pane the zoom covers.
  //
  // The focus waits one task, like the focusPane shortcut. The Terminal menu
  // calls this inside its item's click, before React has re-rendered and
  // removed the menu; the palette calls it a task after its onClose, and the
  // zoom it sets has not rendered yet either way. One task later the zoom has
  // rendered and the caller's own handling is over, so nothing it does to
  // focus can land after this.
  const toggleActivePaneZoom = useCallback(() => {
    const st = stateRef.current;
    const t = zoomTarget(st);
    if (!t) return;
    setZoomedPanes((prev) => nextZoom(prev, panelIdsOf(st), t.panelId, tabIsZoomed(prev, t) ? null : t.paneId));
    setTimeout(() => {
      try { getEntry(t.paneId)?.term?.focus(); } catch { /* best effort: the pane may have been disposed in the tick since; the zoom already landed */ }
    }, 0);
  }, []);

  return { zoomedPanes, setPaneZoom, canZoomActivePane, activePaneZoomed, toggleActivePaneZoom };
}
