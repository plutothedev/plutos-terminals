import { useRef, useState } from "react";
import TerminalPane from "./TerminalPane";
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
const DOT_IDLE = "#3C3C3C";
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

function dotColor(state) {
  if (state === "active") return DOT_ACTIVE;
  if (state === "done") return DOT_DONE;
  return DOT_IDLE;
}

function aggregatePanelActivity(panel, tabActivities) {
  let hasDone = false;
  for (const t of panel.tabs) {
    const s = tabActivities?.[t.id] || "idle";
    if (s === "active") return "active";
    if (s === "done") hasDone = true;
  }
  return hasDone ? "done" : "idle";
}

export default function TerminalPanel({
  panel,
  isActive,
  canClosePanel,
  tabActivities,
  xtermTheme,
  tabAutoApprove,
  tabProjectNames,
  onActivate,
  onAddTab,
  onCloseTab,
  onSwitchTab,
  onClosePanel,
  onTabActivityChange,
  onTabCostUpdate,
  onRenameTab,
  onMoveTab,
}) {
  const activeTab = panel.tabs.find(t => t.id === panel.activeTabId) || panel.tabs[0];
  const panelState = aggregatePanelActivity(panel, tabActivities);

  // Panel bg = xterm bg so the active tab visually merges with the terminal
  // output area below. Falls back to dark if no xterm theme provided yet.
  const PANEL_BG = xtermTheme?.background || "#0a0a0a";

  // Inline rename state — only one tab in a panel can be renamed at a time.
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef(null);

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

  // Border + glow precedence: focused panel wears the rainbow (CSS class
  // overrides border + bg via !important). Activity colors only show on
  // unfocused panels — that's the whole point of the dots.
  let borderColor = BORDER_DIM;
  let boxShadow = "none";
  if (panelState === "active" && !isActive) {
    borderColor = GLOW_ACTIVE;
    boxShadow = GLOW_ACTIVE_SHADOW;
  } else if (panelState === "done" && !isActive) {
    borderColor = GLOW_DONE;
    boxShadow = GLOW_DONE_SHADOW;
  }

  return (
    <div
      data-panel-id={panel.id}
      className={isActive ? "tg-panel-rainbow" : undefined}
      onMouseDown={onActivate}
      style={{
        display: "flex",
        flexDirection: "column",
        background: PANEL_BG,
        border: `2px solid ${borderColor}`,
        boxShadow,
        borderRadius: 4,
        overflow: "hidden",
        minWidth: 0,
        minHeight: 0,
        transition: "border-color 0.2s, box-shadow 0.2s",
      }}
    >
      {/* Tab strip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          background: STRIP_BG,
          borderBottom: `1px solid ${BORDER_DIM}`,
          minHeight: 26,
          fontFamily: M,
          fontSize: 11,
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", flex: 1, minWidth: 0, overflow: "auto" }}>
          {panel.tabs.map(tab => {
            const active = tab.id === panel.activeTabId;
            const tabState = tabActivities?.[tab.id] || "idle";
            const isRenamingThis = renamingId === tab.id;
            return (
              <div
                key={tab.id}
                onMouseDown={(e) => { handleTabMouseDown(tab, e); }}
                onClick={(e) => { e.stopPropagation(); if (!isRenamingThis) onSwitchTab(tab.id); }}
                onDoubleClick={(e) => { e.stopPropagation(); startRename(tab); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  cursor: isRenamingThis ? "text" : "pointer",
                  background: active ? PANEL_BG : "transparent",
                  color: active ? TAB_FG_ACTIVE : TAB_FG,
                  borderRight: `1px solid ${BORDER_DIM}`,
                  borderBottom: active ? `2px solid ${ACCENT}` : "2px solid transparent",
                  whiteSpace: "nowrap",
                  userSelect: "none",
                }}
                title={isRenamingThis ? "Editing — press Enter to save, Esc to cancel" : `${tab.label} (double-click to rename)`}
              >
                <span
                  className={tabState === "active" ? "phn-tab-dot phn-tab-dot-active" : tabState === "done" ? "phn-tab-dot phn-tab-dot-done" : "phn-tab-dot"}
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: dotColor(tabState),
                    flexShrink: 0,
                    boxShadow: tabState === "active"
                      ? `0 0 8px ${DOT_ACTIVE}`
                      : tabState === "done"
                        ? `0 0 10px ${DOT_DONE}`
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
                      fontFamily: M,
                      fontSize: 11,
                      padding: "0 4px",
                      width: Math.max(60, renameValue.length * 7 + 12),
                      outline: "none",
                      borderRadius: 2,
                    }}
                  />
                ) : (
                  <span>{tab.label}</span>
                )}
                {panel.tabs.length > 1 && !isRenamingThis && (
                  <span
                    onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                    style={{
                      color: "#666",
                      cursor: "pointer",
                      padding: "0 2px",
                      fontSize: 12,
                      lineHeight: 1,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "#f44"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "#666"; }}
                  >
                    ×
                  </span>
                )}
              </div>
            );
          })}
          <div
            onClick={(e) => { e.stopPropagation(); onAddTab(); }}
            style={{
              padding: "4px 10px",
              cursor: "pointer",
              color: TAB_FG,
              fontSize: 13,
              lineHeight: 1,
              userSelect: "none",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = TAB_FG_ACTIVE; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = TAB_FG; }}
            title="New tab in this panel"
          >
            +
          </div>
        </div>
        {canClosePanel && (
          <div
            onClick={(e) => { e.stopPropagation(); onClosePanel(); }}
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

      {/* Pane area: every tab keeps its PTY mounted; only the active one is shown */}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {panel.tabs.map(tab => (
          <TerminalPane
            key={tab.id}
            visible={tab.id === activeTab?.id}
            cwd={tab.cwd || null}
            startCommands={tab.startCommands || null}
            systemPrompt={tab.systemPrompt || null}
            xtermTheme={xtermTheme}
            tabId={tab.id}
            projectName={tabProjectNames?.[tab.id] || null}
            autoApprove={tabAutoApprove?.[tab.id] || false}
            onActivityChange={(state) => onTabActivityChange?.(tab.id, state)}
            onCostUpdate={(c) => onTabCostUpdate?.(tab.id, c)}
          />
        ))}
      </div>
    </div>
  );
}
