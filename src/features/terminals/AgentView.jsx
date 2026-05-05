// Agent view — alternative rendering of `state.panels` that surfaces all open
// tabs as compact cards instead of full xterm panes. Designed for monitoring:
// at-a-glance "which agent is working / which is done / what did each cost?"
// across the whole session.
//
// PTYs stay alive — TerminalsTab keeps its terminal-grid mounted with
// display:none when this view is active, so toggling between Agent / Terminal
// doesn't kill any sessions.

const PAGE_BG = "#0a0a0a";
const HEADER_BG = "#181818";
const CARD_BG = "#181818";
const CARD_HOVER = "#202020";
const FG = "#9D9D9D";
const FG_ACTIVE = "#E6E6E6";
const FG_DIM = "#555555";
const ACCENT = "#4DAAFC";
const PLUTO_MAGENTA = "#FF0080";
const BORDER = "#2B2B2B";
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

// iOS-style toggle switch (mirrored from TerminalsTab's ViewToggle so both
// views show the same control). Click anywhere on the pill to flip.
function ViewToggleAgent({ viewMode, onChange }) {
  const isAgent = viewMode === "agent";
  const trackWidth = 52;
  const trackHeight = 24;
  const knobSize = 18;
  const knobInset = 3;
  return (
    <div
      onClick={() => onChange(isAgent ? "terminal" : "agent")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        cursor: "pointer",
        userSelect: "none",
        padding: "2px 4px",
      }}
      role="switch"
      aria-checked={isAgent}
      aria-label={`View mode: ${isAgent ? "agent" : "terminal"}. Click to switch.`}
      title={isAgent ? "Click to switch to terminal view" : "Click to switch to agent view"}
    >
      <span
        style={{
          color: isAgent ? FG : FG_ACTIVE,
          fontFamily: M,
          fontSize: 11,
          fontWeight: isAgent ? 400 : 700,
          letterSpacing: 0.5,
          transition: "color 150ms, font-weight 150ms",
        }}
      >
        💻 TERMINAL
      </span>
      <div
        style={{
          position: "relative",
          width: trackWidth,
          height: trackHeight,
          borderRadius: trackHeight / 2,
          background: BORDER,
          border: `1px solid #3A3A3A`,
          transition: "background 150ms",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: knobInset - 1,
            left: isAgent ? trackWidth - knobSize - knobInset : knobInset,
            width: knobSize,
            height: knobSize,
            borderRadius: "50%",
            background: isAgent ? PLUTO_MAGENTA : ACCENT,
            boxShadow: `0 0 8px ${isAgent ? PLUTO_MAGENTA : ACCENT}`,
            transition: "left 180ms cubic-bezier(0.4, 0, 0.2, 1), background 150ms, box-shadow 150ms",
          }}
        />
      </div>
      <span
        style={{
          color: isAgent ? FG_ACTIVE : FG,
          fontFamily: M,
          fontSize: 11,
          fontWeight: isAgent ? 700 : 400,
          letterSpacing: 0.5,
          transition: "color 150ms, font-weight 150ms",
        }}
      >
        🤖 AGENT
      </span>
    </div>
  );
}

const ACTIVITY_COLORS = {
  active: "#FBBF24",
  done:   "#34D399",
  idle:   "#555555",
};

const ACTIVITY_LABELS = {
  active: "active",
  done:   "done",
  idle:   "idle",
};

export default function AgentView({ panels, projects, tabActivities, tabCosts, totalCost, onFocusTab, viewMode, onSwitchView }) {
  // Flatten all tabs across all panels into a single ordered list for the grid.
  const allTabs = [];
  for (const panel of panels) {
    for (const tab of panel.tabs) {
      allTabs.push({ panel, tab });
    }
  }

  return (
    <div
      style={{
        height: "100%",
        background: PAGE_BG,
        fontFamily: M,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          background: HEADER_BG,
          borderBottom: `1px solid ${BORDER}`,
          fontSize: 11,
          color: FG,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        {onSwitchView && (
          <ViewToggleAgent viewMode={viewMode || "agent"} onChange={onSwitchView} />
        )}
        <span style={{ color: FG_DIM, opacity: 0.4 }}>·</span>
        <span style={{ color: FG_DIM }}>
          {allTabs.length} agent{allTabs.length === 1 ? "" : "s"} across {panels.length} panel{panels.length === 1 ? "" : "s"}
        </span>
        {(totalCost?.cost > 0 || totalCost?.tokens > 0) && (
          <span style={{ color: "#34D399", marginLeft: "auto" }} title="Aggregate live spend across all sessions">
            ${(totalCost.cost || 0).toFixed(2)}
            {totalCost.tokens > 0 && ` · ${totalCost.tokens >= 1000 ? `${(totalCost.tokens / 1000).toFixed(1)}k` : totalCost.tokens} tokens`}
          </span>
        )}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 18,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 14,
          alignContent: "start",
        }}
      >
        {allTabs.map(({ panel, tab }) => {
          const projectId = tab.projectId;
          const project = projectId ? (projects || []).find((p) => p.id === projectId) : null;
          const activity = tabActivities?.[tab.id] || "idle";
          const cost = tabCosts?.[tab.id];
          return (
            <button
              key={tab.id}
              onClick={() => onFocusTab && onFocusTab(panel.id, tab.id)}
              style={{
                background: CARD_BG,
                border: `1px solid ${BORDER}`,
                borderRadius: 6,
                padding: 14,
                fontFamily: M,
                color: FG_ACTIVE,
                fontSize: 11,
                textAlign: "left",
                cursor: "pointer",
                transition: "background 120ms, border-color 120ms",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = CARD_HOVER;
                e.currentTarget.style.borderColor = ACCENT;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = CARD_BG;
                e.currentTarget.style.borderColor = BORDER;
              }}
              title="Click to focus this tab in terminal view"
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: ACTIVITY_COLORS[activity],
                    flexShrink: 0,
                    boxShadow: activity === "active" ? `0 0 8px ${ACTIVITY_COLORS[activity]}` : "none",
                  }}
                />
                <span style={{ color: FG_ACTIVE, fontSize: 12, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {tab.label || "Tab"}
                </span>
                <span style={{ color: ACTIVITY_COLORS[activity], fontSize: 9, letterSpacing: 0.5, textTransform: "uppercase" }}>
                  {ACTIVITY_LABELS[activity]}
                </span>
              </div>

              {project && (
                <div style={{ color: ACCENT, fontSize: 10, marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  📁 {project.name || "project"}
                </div>
              )}

              {tab.cwd && (
                <div style={{ color: FG_DIM, fontSize: 10, marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl" }}>
                  {tab.cwd}
                </div>
              )}

              {Array.isArray(tab.startCommands) && tab.startCommands.length > 0 && (
                <div style={{ color: FG, fontSize: 10, marginBottom: 6, fontFamily: M, opacity: 0.7 }}>
                  $ {tab.startCommands[0].slice(0, 36)}{tab.startCommands[0].length > 36 ? "…" : ""}
                </div>
              )}

              {cost && (cost.cost > 0 || cost.tokens > 0) && (
                <div style={{ color: "#34D399", fontSize: 10, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${BORDER}` }}>
                  ${cost.cost?.toFixed(2) || "0.00"}
                  {cost.tokens > 0 && ` · ${cost.tokens >= 1000 ? `${(cost.tokens / 1000).toFixed(1)}k` : cost.tokens} tokens`}
                </div>
              )}
            </button>
          );
        })}

        {allTabs.length === 0 && (
          <div style={{ color: FG_DIM, fontSize: 12, padding: 24, textAlign: "center", gridColumn: "1 / -1" }}>
            No agents running. Switch to terminal view and add a tab.
          </div>
        )}
      </div>

      <div
        style={{
          padding: "8px 14px",
          background: HEADER_BG,
          borderTop: `1px solid ${BORDER}`,
          fontSize: 10,
          color: FG_DIM,
          flexShrink: 0,
          textAlign: "center",
        }}
      >
        Click any agent card to focus it in terminal view. PTYs stay alive across view toggles.
      </div>
    </div>
  );
}
