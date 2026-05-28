// (C)
// Agent dashboard — a live overview of every session across all panels: status
// (working / done / idle), Claude /cost, and git-worktree branch. Click a row to
// jump to that tab. The parallel-AI "mission control" (Conductor/Vibe-Kanban-style).
import { getLayout, leafIds } from "./splitTree";
import "./terminals.css";

// A tab's status = the loudest of its panes (active > done > idle). Mirrors
// aggregateTabActivity in TerminalPanel, but works off the raw per-pane map.
function tabStatus(tab, tabActivities) {
  let done = false;
  for (const id of leafIds(getLayout(tab))) {
    const s = tabActivities?.[id] || "idle";
    if (s === "active") return "active";
    if (s === "done") done = true;
  }
  return done ? "done" : "idle";
}

function tabCost(tab, tabCosts) {
  let c = 0;
  for (const id of leafIds(getLayout(tab))) c += tabCosts?.[id]?.cost || 0;
  return c;
}

const DOT = { active: "#FBBF24", done: "#34D399", idle: "#5a5a5a" };
const LABEL = { active: "working", done: "done", idle: "idle" };

export default function AgentDashboard({ panels, activePanelId, tabActivities, tabCosts, onFocusTab, onReviewDiff }) {
  const rows = [];
  let total = 0;
  let working = 0;
  for (const panel of panels) {
    for (const tab of panel.tabs) {
      if (tab.home) continue;
      const status = tabStatus(tab, tabActivities);
      const cost = tabCost(tab, tabCosts);
      total += cost;
      if (status === "active") working += 1;
      const isActive = panel.id === activePanelId && panel.activeTabId === tab.id;
      rows.push({ panel, tab, status, cost, isActive });
    }
  }

  return (
    <div className="moba-dock-panel">
      <div className="phn-snippets-header">
        <span>🤖 Agents</span>
        <span style={{ fontSize: 10, color: "var(--phn-text-dim, #888)", fontWeight: 400 }}>
          {rows.length} · {working} running
        </span>
      </div>
      <div className="phn-snippets-list">
        {rows.length === 0 ? (
          <div className="phn-snippets-empty">No sessions yet. Open a tab or spawn an agent worktree.</div>
        ) : (
          rows.map(({ panel, tab, status, cost, isActive }) => (
            <div
              key={tab.id}
              className={isActive ? "moba-agent-row active" : "moba-agent-row"}
              onClick={() => onFocusTab?.(panel.id, tab.id)}
              title={tab.worktree ? `worktree: ${tab.worktree.branch}` : tab.label}
            >
              <span
                className="moba-agent-dot"
                style={{ background: DOT[status], boxShadow: status === "active" ? `0 0 6px ${DOT.active}` : status === "done" ? `0 0 6px ${DOT.done}` : "none" }}
              />
              <span className="moba-agent-icon">{tab.worktree ? "🌿" : tab.connection ? "🔗" : tab.serial ? "⎓" : tab.rdp ? "🪟" : tab.vnc ? "🖥" : "❯"}</span>
              <span className="moba-agent-name">{tab.worktree ? tab.worktree.branch : tab.label}</span>
              {cost > 0 && <span className="moba-agent-cost">${cost.toFixed(2)}</span>}
              {tab.worktree && onReviewDiff && (
                <button
                  className="moba-agent-diff"
                  onClick={(e) => { e.stopPropagation(); onReviewDiff(tab.worktree); }}
                  title={`Review diff + open PR for ${tab.worktree.branch}`}
                >
                  diff
                </button>
              )}
              <span className="moba-agent-status">{LABEL[status]}</span>
            </div>
          ))
        )}
      </div>
      {total > 0 && (
        <div className="moba-agent-total">
          total spend <strong>${total.toFixed(2)}</strong>
        </div>
      )}
    </div>
  );
}
