// (C)
// Right-dock + session-tree sizing/visibility, lifted verbatim out of the
// TerminalsTab god component. dockWidth (drag-resizable splitter) and the
// dockCollapsed / treeCollapsed rails persist to localStorage under the pt:*
// keys; nothing here touches the workspace tree (state.panels) or persist(), so
// this is a zero-coupling extract with no behavior change.

import { useCallback, useState } from "react";

export function useDockResize() {
  // Side-panel sizing/visibility (persisted). Panels can be collapsed to a thin
  // rail (re-expandable) or resized, but never fully removed — so they can't be
  // "lost" like the old close button allowed.
  const [dockWidth, setDockWidth] = useState(() => {
    const v = parseInt(localStorage.getItem("pt:dockWidth") || "", 10);
    return Number.isFinite(v) && v >= 220 && v <= 640 ? v : 320;
  });
  const [dockCollapsed, setDockCollapsed] = useState(() => localStorage.getItem("pt:dockCollapsed") === "1");
  const [treeCollapsed, setTreeCollapsed] = useState(() => localStorage.getItem("pt:treeCollapsed") === "1");
  const collapseDock = (v) => { setDockCollapsed(v); localStorage.setItem("pt:dockCollapsed", v ? "1" : "0"); };
  const collapseTree = (v) => { setTreeCollapsed(v); localStorage.setItem("pt:treeCollapsed", v ? "1" : "0"); };
  // Drag the splitter to resize the right dock (persisted on release).
  const startDockResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    let startW = 320;
    setDockWidth((w) => { startW = w; return w; });
    const onMove = (ev) => {
      const w = Math.max(220, Math.min(640, startW + (startX - ev.clientX)));
      setDockWidth(w);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDockWidth((w) => { localStorage.setItem("pt:dockWidth", String(w)); return w; });
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  return { dockWidth, dockCollapsed, treeCollapsed, collapseDock, collapseTree, startDockResize };
}
