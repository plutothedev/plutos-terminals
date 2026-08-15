// (C)
// Right-dock + session-tree sizing/visibility, lifted verbatim out of the
// TerminalsTab god component. dockWidth (drag-resizable splitter) and the
// dockCollapsed / treeCollapsed rails persist to localStorage under the pt:*
// keys; nothing here touches the workspace tree (state.panels) or persist(), so
// this is a zero-coupling extract with no behavior change.

import { useCallback, useEffect, useRef, useState } from "react";

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
  // useCallback'd (P2 stream audit W2): plain closures re-minted per render
  // and defeated every downstream useCallback that listed them as deps (the
  // sidebar's onCollapse churned on EVERY TerminalsTab render).
  const collapseDock = useCallback((v) => { setDockCollapsed(v); localStorage.setItem("pt:dockCollapsed", v ? "1" : "0"); }, []);
  const collapseTree = useCallback((v) => { setTreeCollapsed(v); localStorage.setItem("pt:treeCollapsed", v ? "1" : "0"); }, []);
  // Abort the live drag (if any) on unmount so document listeners + the body
  // cursor/user-select overrides never outlive the component (audit L1).
  const dragAbortRef = useRef(null);
  useEffect(() => () => dragAbortRef.current?.abort(), []);

  // Drag the splitter to resize the right dock (persisted on release).
  const startDockResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    let startW = 320;
    setDockWidth((w) => { startW = w; return w; });
    // AbortController owns teardown: one signal.abort() removes both listeners
    // (registered with { signal }), cancels the pending frame, and restores the
    // body overrides — reached by both mouseup AND unmount-mid-drag (audit L1).
    dragAbortRef.current?.abort(); // end any prior drag before starting a new one
    const ac = new AbortController();
    dragAbortRef.current = ac;
    const { signal } = ac;
    // Coalesce mousemove -> one setDockWidth per animation frame (audit M3):
    // committing raw per-mousemove re-renders the whole (now memoized) chrome
    // tree every pixel; a rAF gate caps it to ~60/s and stays current.
    let raf = 0;
    let pendingW = null;
    const flush = () => { raf = 0; if (pendingW != null) setDockWidth(pendingW); };
    const onMove = (ev) => {
      pendingW = Math.max(220, Math.min(640, startW + (startX - ev.clientX)));
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onUp = () => {
      setDockWidth((w) => {
        const finalW = pendingW != null ? pendingW : w; // commit the last pixel
        localStorage.setItem("pt:dockWidth", String(finalW));
        return finalW;
      });
      ac.abort(); // teardown (also fires on unmount)
    };
    signal.addEventListener("abort", () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove, { signal });
    document.addEventListener("mouseup", onUp, { signal });
  }, []);

  return { dockWidth, dockCollapsed, treeCollapsed, collapseDock, collapseTree, startDockResize };
}
