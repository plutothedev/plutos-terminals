import { memo, useMemo, useRef, useState } from "react";
import TerminalPane from "./TerminalPane";
import VncView from "./VncView";
import RdpView from "./RdpView";
import MobaHomeScreen from "./MobaHomeScreen";
import { getLayout, leafIds, isLeaf } from "./splitTree";
import "./terminals.css";

// Colors come from the active app skin via CSS vars on <html>. Module-level
// fallback constants are used by drag-ghost helpers and as defaults if vars
// haven't been injected yet (first paint pre-mount). Component reads
// xtermTheme.background for the panel bg so the active tab's bg seamlessly
// merges with the terminal output area below.
const STRIP_BG = "var(--phn-surface-bg, rgba(17,17,17,0.95))";
const BORDER_DIM = "var(--phn-surface-border, rgba(255,255,255,0.08))";
const TAB_FG = "var(--phn-text-fg, #9D9D9D)";
const TAB_FG_ACTIVE = "var(--phn-text-active, #E6E6E6)";
const ACCENT = "var(--phn-link, #4DAAFC)";
const ACCENT_FALLBACK = "#4DAAFC"; // for drag ghost (DOM-built outside React)
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

// Activity colors mirror Moon Dev: yellow while running, green when finished.
const DOT_ACTIVE = "#FBBF24";
const DOT_DONE = "#34D399";
const GLOW_ACTIVE = "rgba(251,191,36,0.45)";
const GLOW_DONE = "rgba(52,211,153,0.55)";
const GLOW_ACTIVE_SHADOW = "0 0 0 1px rgba(251,191,36,0.25), 0 0 10px rgba(251,191,36,0.15)";
const GLOW_DONE_SHADOW = "0 0 0 1px rgba(52,211,153,0.45), 0 0 12px rgba(52,211,153,0.25)";

// Floating drag preview for tab moves. Mirrors the project-drag ghost.
function makeTabGhost(label) {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed","top:0","left:0",
    "pointer-events:none","z-index:99999",
    `background:${ACCENT_FALLBACK}`,"color:#001",
    "padding:3px 9px","border-radius:3px",
    `font:11px/1 ${M}`,"font-weight:600",
    "box-shadow:0 4px 12px rgba(0,0,0,0.55)",
    "white-space:nowrap","transform:translate(-9999px,-9999px)",
  ].join(";");
  el.textContent = `↪ ${label}`;
  document.body.appendChild(el);
  return el;
}
function clearTabDropHighlights() {
  document.querySelectorAll("[data-panel-id][data-tab-drop='1']").forEach(el => {
    el.removeAttribute("data-tab-drop");
    el.style.outline = "";
    el.style.outlineOffset = "";
  });
}
function highlightTabDrop(el) {
  if (!el || el.getAttribute("data-tab-drop") === "1") return;
  el.setAttribute("data-tab-drop", "1");
  el.style.outline = `2px solid ${ACCENT_FALLBACK}`;
  el.style.outlineOffset = "-2px";
}

// Activity for a single tab = the "loudest" of its panes (active > done > idle).
function aggregateTabActivity(tab, tabActivities) {
  let hasDone = false;
  for (const id of leafIds(getLayout(tab))) {
    const s = tabActivities?.[id] || "idle";
    if (s === "active") return "active";
    if (s === "done") hasDone = true;
  }
  return hasDone ? "done" : "idle";
}

function aggregatePanelActivity(panel, tabActivities) {
  let hasDone = false;
  for (const t of panel.tabs) {
    const s = aggregateTabActivity(t, tabActivities);
    if (s === "active") return "active";
    if (s === "done") hasDone = true;
  }
  return hasDone ? "done" : "idle";
}

// Walk a tab's split tree into a flat list of pane rects (percentages of the
// tab's pane area) + divider descriptors. Flat + percentage-positioned so a
// split/close/resize only moves existing panes (CSS) — it never restructures
// the React tree, so a live pane's PTY is never remounted. `dragRatios`
// overrides a split's stored ratio while its divider is being dragged (local,
// un-persisted) for smooth resizing.
function computeLayout(node, dragRatios, rect = { left: 0, top: 0, width: 100, height: 100 }) {
  if (isLeaf(node)) return { panes: [{ node, rect }], dividers: [] };
  const ratio = dragRatios[node.id] != null ? dragRatios[node.id] : node.ratio;
  const isRow = node.dir === "row";
  let aRect, bRect;
  if (isRow) {
    const w = rect.width * ratio;
    aRect = { left: rect.left, top: rect.top, width: w, height: rect.height };
    bRect = { left: rect.left + w, top: rect.top, width: rect.width - w, height: rect.height };
  } else {
    const h = rect.height * ratio;
    aRect = { left: rect.left, top: rect.top, width: rect.width, height: h };
    bRect = { left: rect.left, top: rect.top + h, width: rect.width, height: rect.height - h };
  }
  const A = computeLayout(node.a, dragRatios, aRect);
  const B = computeLayout(node.b, dragRatios, bRect);
  return {
    panes: [...A.panes, ...B.panes],
    dividers: [{ splitId: node.id, dir: node.dir, container: rect, ratio }, ...A.dividers, ...B.dividers],
  };
}

function TerminalPanel({
  panel,
  isActive,
  canClosePanel,
  tabActivities,
  xtermTheme,
  tabAutoApprove,
  tabProjectNames,
  homeApi,
  onActivate,
  onAddTab,
  onCloseTab,
  onSwitchTab,
  onClosePanel,
  onTabActivityChange,
  onTabCostUpdate,
  onRenameTab,
  onSetTabColor,
  onDuplicateTab,
  onDetachTab,
  onCloseOthers,
  onMoveTab,
  onSplitPane,
  onClosePane,
  onActivatePane,
  onSetPaneRatio,
}) {
  // Bind this panel's id onto the parent's stable (panelId-first) callbacks so
  // the parent passes stable references and React.memo (below) can skip
  // re-rendering this panel when unrelated TerminalsTab state changes (the 2.5s
  // sysStats poll, modal toggles, dock resize, …). Re-renders still happen when
  // the panel object, activity/cost, or theme actually change.
  const h = useMemo(() => ({
    activate: () => onActivate(panel.id),
    addTab: () => onAddTab(panel.id),
    closeTab: (tabId) => onCloseTab(panel.id, tabId),
    switchTab: (tabId) => onSwitchTab(panel.id, tabId),
    closePanel: () => onClosePanel(panel.id),
    duplicate: (tabId) => onDuplicateTab(panel.id, tabId),
    detach: (tabId) => onDetachTab(panel.id, tabId),
    closeOthers: (tabId) => onCloseOthers(panel.id, tabId),
  }), [panel.id, onActivate, onAddTab, onCloseTab, onSwitchTab, onClosePanel, onDuplicateTab, onDetachTab, onCloseOthers]);

  const activeTab = panel.tabs.find(t => t.id === panel.activeTabId) || panel.tabs[0];
  const panelState = aggregatePanelActivity(panel, tabActivities);

  // Panel bg = xterm bg so the active tab visually merges with the terminal
  // output area below. Falls back to dark if no xterm theme provided yet.
  const PANEL_BG = xtermTheme?.background || "#0a0a0a";

  // Inline rename state — only one tab in a panel can be renamed at a time.
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef(null);
  // Hovered tab — drives the hover-only close button (Termius style).
  const [hoverTabId, setHoverTabId] = useState(null);
  // Right-click tab context menu: { x, y, tabId } or null.
  const [tabCtxMenu, setTabCtxMenu] = useState(null);

  // Transient divider ratios during an active drag, keyed by splitId. Kept out
  // of app state so a drag doesn't hammer localStorage; committed on mouseup.
  const [dragRatios, setDragRatios] = useState({});

  // Tab drag between panels. Mouse-event based (HTML5 drag is broken in
  // WebView2 per the code-rule memo). On drop over a different panel, the
  // tab is moved via onMoveTab — the underlying PTY is killed and a fresh
  // one spawns in the target panel (scrollback replays from disk).
  const handleTabMouseDown = (tab, e) => {
    if (e.button !== 0) return;
    if (renamingId === tab.id) return;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    let ghost = null;
    let lastTargetEl = null;
    const onMove = (ev) => {
      const dx = Math.abs(ev.clientX - startX);
      const dy = Math.abs(ev.clientY - startY);
      if (!dragging && (dx > 5 || dy > 5)) {
        dragging = true;
        ghost = makeTabGhost(tab.label);
      }
      if (dragging && ghost) {
        ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const panelEl = el?.closest("[data-panel-id]");
        const tgtPanelId = panelEl?.getAttribute("data-panel-id");
        const isOwn = tgtPanelId === panel.id;
        if (panelEl !== lastTargetEl) {
          clearTabDropHighlights();
          if (panelEl && !isOwn) highlightTabDrop(panelEl);
          lastTargetEl = panelEl || null;
        }
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (ghost) ghost.remove();
      const tgt = lastTargetEl?.getAttribute("data-panel-id");
      clearTabDropHighlights();
      if (dragging && tgt && tgt !== panel.id) {
        onMoveTab?.(tab.id, tgt);
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // Divider drag. The divider's parent is the tab's pane-area element, so its
  // bounding rect gives the pixel size to convert a cursor position into a
  // ratio. We preview via local state and commit once on release.
  const handleDividerMouseDown = (divider, tabId, e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const areaEl = e.currentTarget.parentElement;
    if (!areaEl) return;
    const isRow = divider.dir === "row";
    const onMove = (ev) => {
      const r = areaEl.getBoundingClientRect();
      const subStart = isRow
        ? r.left + (divider.container.left / 100) * r.width
        : r.top + (divider.container.top / 100) * r.height;
      const subSize = isRow
        ? (divider.container.width / 100) * r.width
        : (divider.container.height / 100) * r.height;
      if (subSize <= 0) return;
      const pos = isRow ? ev.clientX : ev.clientY;
      let ratio = (pos - subStart) / subSize;
      ratio = Math.max(0.1, Math.min(0.9, ratio));
      setDragRatios(prev => ({ ...prev, [divider.splitId]: ratio }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setDragRatios(prev => {
        const final = prev[divider.splitId];
        if (final != null) onSetPaneRatio?.(tabId, divider.splitId, final);
        const { [divider.splitId]: _drop, ...rest } = prev;
        return rest;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const startRename = (tab) => {
    setRenamingId(tab.id);
    setRenameValue(tab.label || "");
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  };
  const commitRename = () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (trimmed) onRenameTab?.(renamingId, trimmed);
    setRenamingId(null);
  };
  const cancelRename = () => setRenamingId(null);

  // Flat panel framing (mockup 12): a thin neutral border, no glow, no
  // rainbow. The focused panel only gets a blue edge when the grid is split
  // (canClosePanel ⇒ >1 panel), so a single terminal stays clean. Activity is
  // conveyed by the tab dots, not a glowing terminal frame.
  let borderColor = "var(--phn-surface-border, #34383F)";
  const boxShadow = "none";
  if (isActive && canClosePanel) {
    borderColor = "var(--phn-link, #4D8FE0)";
  } else if (!isActive && panelState === "active") {
    borderColor = GLOW_ACTIVE;
  } else if (!isActive && panelState === "done") {
    borderColor = GLOW_DONE;
  }

  const activePaneId = activeTab?.activePaneId || activeTab?.id;
  const activeTabMulti = activeTab ? !isLeaf(getLayout(activeTab)) : false;

  return (
    <div
      data-panel-id={panel.id}
      onMouseDown={h.activate}
      style={{
        display: "flex",
        flexDirection: "column",
        background: PANEL_BG,
        border: `1px solid ${borderColor}`,
        boxShadow,
        borderRadius: 3,
        overflow: "hidden",
        minWidth: 0,
        minHeight: 0,
        transition: "border-color 0.2s, box-shadow 0.2s",
      }}
    >
      {/* Tab strip — MobaXterm look: white tab slabs sit on the dark terminal
          background. Using PANEL_BG (the xterm theme bg) rather than the chrome
          surface so tabs read like MobaXterm's "white slabs on black" tabs. */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          background: "var(--phn-surface, #24272D)",
          borderBottom: "1px solid var(--phn-surface-border, #34383F)",
          height: 30,
          fontSize: 12,
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", flex: 1, minWidth: 0, overflow: "auto", alignItems: "stretch" }}>
          {panel.tabs.map((tab, ti) => {
            const active = tab.id === panel.activeTabId;
            const tabState = aggregateTabActivity(tab, tabActivities);
            const isRenamingThis = renamingId === tab.id;
            const paneCount = leafIds(getLayout(tab)).length;
            const dotBg = tab.color
              ? tab.color
              : tabState === "active" ? DOT_ACTIVE
              : tabState === "done" ? DOT_DONE
              : "var(--phn-text-faint, #586068)";
            return (
              <div
                key={tab.id}
                className={active ? "moba-tab active" : "moba-tab"}
                onMouseDown={(e) => { handleTabMouseDown(tab, e); }}
                onClick={(e) => { e.stopPropagation(); if (!isRenamingThis) h.switchTab(tab.id); }}
                onDoubleClick={(e) => { e.stopPropagation(); startRename(tab); }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setTabCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id }); }}
                onMouseEnter={() => setHoverTabId(tab.id)}
                onMouseLeave={() => setHoverTabId((cur) => (cur === tab.id ? null : cur))}
                style={{ cursor: isRenamingThis ? "text" : "pointer" }}
                title={isRenamingThis ? "Editing — press Enter to save, Esc to cancel" : `${tab.label} (double-click to rename)`}
              >
                <span
                  className={tabState === "active" ? "phn-tab-dot phn-tab-dot-active" : tabState === "done" ? "phn-tab-dot phn-tab-dot-done" : "phn-tab-dot"}
                  title={tab.home ? "Session launch screen" : tab.worktree ? `Agent worktree (${tab.worktree.branch})` : tab.rdp ? "RDP desktop" : tab.vnc ? "VNC desktop" : tab.connection ? "SSH session" : tab.serial ? "Serial console" : "Local shell"}
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: dotBg,
                    flexShrink: 0,
                    boxShadow: tabState === "active"
                      ? `0 0 6px ${DOT_ACTIVE}`
                      : tabState === "done"
                        ? `0 0 7px ${DOT_DONE}`
                        : "none",
                    transition: "background 0.2s, box-shadow 0.2s",
                  }}
                />
                {isRenamingThis ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                      else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                    }}
                    spellCheck={false}
                    style={{
                      background: "rgba(255,255,255,0.08)",
                      border: `1px solid ${ACCENT}`,
                      color: "#fff",
                      fontFamily: "inherit",
                      fontSize: 12,
                      padding: "0 4px",
                      width: Math.max(60, renameValue.length * 7 + 12),
                      outline: "none",
                      borderRadius: 2,
                    }}
                  />
                ) : (
                  <span className="moba-tab-label">{tab.label}</span>
                )}
                {paneCount > 1 && !isRenamingThis && (
                  <span title={`${paneCount} panes`} style={{ color: "var(--phn-text-faint, #586068)", fontSize: 9, flexShrink: 0 }}>
                    ⊞{paneCount}
                  </span>
                )}
                {panel.tabs.length > 1 && !isRenamingThis && (
                  <span
                    className="moba-tab-x"
                    onClick={(e) => { e.stopPropagation(); h.closeTab(tab.id); }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "#f44"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = ""; }}
                  >
                    ×
                  </span>
                )}
              </div>
            );
          })}
          <div
            onClick={(e) => { e.stopPropagation(); h.addTab(); }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 12px",
              cursor: "pointer",
              color: "var(--phn-text-faint, #586068)",
              fontSize: 15,
              lineHeight: 1,
              userSelect: "none",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--phn-text-bright, #F2F4F7)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--phn-text-faint, #586068)"; }}
            title="New tab in this panel"
          >
            +
          </div>
        </div>
        {canClosePanel && (
          <div
            onClick={(e) => { e.stopPropagation(); h.closePanel(); }}
            style={{
              padding: "4px 8px",
              cursor: "pointer",
              color: "#555",
              fontSize: 11,
              userSelect: "none",
            }}
            title="Close this panel"
            onMouseEnter={(e) => { e.currentTarget.style.color = "#f44"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "#555"; }}
          >
            ✕
          </div>
        )}
      </div>

      {/* Pane area: every tab stays mounted (only the active one is shown); each
          tab renders its split tree as flat positioned panes so splits/resizes
          never remount a live PTY. */}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {panel.tabs.map(tab => {
          const tabVisible = tab.id === activeTab?.id;
          const layout = getLayout(tab);
          const { panes, dividers } = computeLayout(layout, dragRatios);
          const multi = panes.length > 1;
          const tabActivePaneId = tab.activePaneId || tab.id;
          return (
            <div
              key={tab.id}
              style={{ position: "absolute", inset: 0, display: tabVisible ? "block" : "none" }}
            >
              {tab.home ? (
                <MobaHomeScreen panelId={panel.id} tabId={tab.id} api={homeApi} />
              ) : tab.vnc ? (
                <VncView host={tab.vnc.host} port={tab.vnc.port} tabId={tab.id} visible={tabVisible} />
              ) : tab.rdp ? (
                <RdpView host={tab.rdp.host} port={tab.rdp.port} username={tab.rdp.username} domain={tab.rdp.domain} tabId={tab.id} visible={tabVisible} />
              ) : (
              <>
              {panes.map(({ node, rect }) => {
                const isRoot = node.id === tab.id;
                const paneActive = node.id === tabActivePaneId;
                return (
                  <div
                    key={`pane-${node.id}`}
                    onMouseDownCapture={() => { if (multi && !paneActive) onActivatePane?.(tab.id, node.id); }}
                    style={{
                      position: "absolute",
                      left: `${rect.left}%`,
                      top: `${rect.top}%`,
                      width: `${rect.width}%`,
                      height: `${rect.height}%`,
                      boxSizing: "border-box",
                      outline: multi && paneActive ? `1px solid ${ACCENT}` : "none",
                      outlineOffset: "-1px",
                      overflow: "hidden",
                    }}
                  >
                    <TerminalPane
                      visible={tabVisible}
                      active={tabVisible && paneActive}
                      cwd={isRoot ? (tab.cwd || null) : (node.cwd ?? null)}
                      connection={isRoot ? (tab.connection || null) : null}
                      serial={isRoot ? (tab.serial || null) : null}
                      startCommands={isRoot ? (tab.startCommands || null) : null}
                      systemPrompt={isRoot ? (tab.systemPrompt || null) : null}
                      xtermTheme={xtermTheme}
                      tabId={node.id}
                      projectName={isRoot ? (tabProjectNames?.[tab.id] || null) : null}
                      autoApprove={isRoot ? (tabAutoApprove?.[tab.id] || false) : false}
                      onActivityChange={(state) => onTabActivityChange?.(node.id, state)}
                      onCostUpdate={(c) => onTabCostUpdate?.(node.id, c)}
                    />
                    {multi && (
                      <span
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onClosePane?.(tab.id, node.id); }}
                        title="Close this pane"
                        style={{
                          position: "absolute",
                          top: 3,
                          right: 5,
                          zIndex: 5,
                          color: "#777",
                          cursor: "pointer",
                          fontSize: 12,
                          lineHeight: 1,
                          padding: "0 3px",
                          borderRadius: 2,
                          background: "rgba(0,0,0,0.35)",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = "#f44"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = "#777"; }}
                      >
                        ×
                      </span>
                    )}
                  </div>
                );
              })}
              {dividers.map((d) => {
                const isRow = d.dir === "row";
                const boundary = isRow
                  ? d.container.left + d.container.width * d.ratio
                  : d.container.top + d.container.height * d.ratio;
                return (
                  <div
                    key={`div-${d.splitId}`}
                    onMouseDown={(e) => handleDividerMouseDown(d, tab.id, e)}
                    title="Drag to resize"
                    style={{
                      position: "absolute",
                      zIndex: 4,
                      cursor: isRow ? "col-resize" : "row-resize",
                      ...(isRow
                        ? {
                            left: `calc(${boundary}% - 3px)`,
                            top: `${d.container.top}%`,
                            width: 6,
                            height: `${d.container.height}%`,
                          }
                        : {
                            top: `calc(${boundary}% - 3px)`,
                            left: `${d.container.left}%`,
                            height: 6,
                            width: `${d.container.width}%`,
                          }),
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(77,170,252,0.35)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  />
                );
              })}
              </>
              )}
            </div>
          );
        })}
      </div>

      {/* Tab context menu (right-click a tab). */}
      {tabCtxMenu && (() => {
        const tab = panel.tabs.find(t => t.id === tabCtxMenu.tabId);
        if (!tab) return null;
        const close = () => setTabCtxMenu(null);
        const multi = panel.tabs.length > 1;
        const item = (label, onClick, opts = {}) => (
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); close(); if (!opts.disabled) onClick(); }}
            disabled={opts.disabled}
            style={{
              display: "block", width: "100%", textAlign: "left",
              background: "transparent", border: "none",
              color: opts.danger ? "#f87171" : TAB_FG_ACTIVE,
              padding: "6px 12px", fontFamily: M, fontSize: 12,
              cursor: opts.disabled ? "default" : "pointer", opacity: opts.disabled ? 0.4 : 1,
              whiteSpace: "nowrap", borderRadius: 4, boxSizing: "border-box",
            }}
            onMouseEnter={(e) => { if (!opts.disabled) e.currentTarget.style.background = "rgba(127,127,127,0.18)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            {label}
          </button>
        );
        return (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onMouseDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            <div
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                position: "fixed",
                left: Math.min(tabCtxMenu.x, window.innerWidth - 190),
                top: Math.min(tabCtxMenu.y, window.innerHeight - 180),
                width: 178,
                background: "var(--phn-surface-bg, #2d2d2d)",
                border: `1px solid ${BORDER_DIM}`,
                borderRadius: 6, padding: 5, zIndex: 9999,
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
              }}
            >
              {item("Rename", () => startRename(tab))}
              {onSetTabColor && (
                <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "6px 10px" }}>
                  {[null, "#ef4444", "#f59e0b", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7"].map((c) => (
                    <span
                      key={c || "none"}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); close(); onSetTabColor(tab.id, c); }}
                      title={c ? "Color this tab" : "Clear color"}
                      style={{
                        width: 14, height: 14, borderRadius: "50%", cursor: "pointer", flexShrink: 0,
                        background: c || "transparent",
                        border: c
                          ? (tab.color === c ? "2px solid #fff" : "1px solid rgba(255,255,255,0.25)")
                          : "1px solid #777",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 9, color: "#999", lineHeight: 1,
                      }}
                    >
                      {c ? "" : "✕"}
                    </span>
                  ))}
                </div>
              )}
              {item("Duplicate", () => h.duplicate(tab.id))}
              {onDetachTab && !tab.home && item("Detach to new window", () => h.detach(tab.id))}
              {onSplitPane && item("Split right", () => onSplitPane(tab.id, tab.activePaneId || tab.id, "row"))}
              <div style={{ height: 1, background: BORDER_DIM, margin: "4px 0" }} />
              {item("Close others", () => h.closeOthers(tab.id), { disabled: !multi })}
              {item("Close", () => h.closeTab(tab.id), { disabled: !multi, danger: true })}
            </div>
          </>
        );
      })()}
    </div>
  );
}

// Memoized so a TerminalsTab re-render that doesn't change THIS panel's props
// (e.g. the 2.5s sysStats poll, a modal toggle, dock resize) skips re-rendering
// the panel + its xterm panes. All props are stable refs (panelId-bound
// callbacks via the `h` map; data props are useMemo/useState/primitives), so
// the default shallow compare correctly re-renders only on real panel changes.
export default memo(TerminalPanel);
