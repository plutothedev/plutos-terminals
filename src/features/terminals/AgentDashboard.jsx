// (C)
// Agent dashboard — a live overview of every session across all panels: status
// (working / done / idle), Claude /cost + tokens, and git-worktree branch. Click
// a row to jump to that tab, ✨ to AI-summarize it, diff to review a worktree.
// Filter by status. The parallel-AI "mission control" (Conductor-style).
import { useState } from "react";
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

function tabCostTokens(tab, tabCosts) {
  let cost = 0, tokens = 0;
  for (const id of leafIds(getLayout(tab))) {
    cost += tabCosts?.[id]?.cost || 0;
    tokens += tabCosts?.[id]?.tokens || 0;
  }
  return { cost, tokens };
}

const fmtTokens = (t) => (t >= 1000 ? `${(t / 1000).toFixed(1)}k` : `${t}`);

const DOT = { active: "#FBBF24", done: "#34D399", idle: "#5a5a5a" };
const LABEL = { active: "working", done: "done", idle: "idle" };

export default function AgentDashboard({ panels, activePanelId, tabActivities, tabCosts, onFocusTab, onReviewDiff, onSummarize }) {
  const [filter, setFilter] = useState("all"); // all | active | done

  const rows = [];
  let total = 0, totalTokens = 0, working = 0;
  for (const panel of panels) {
    for (const tab of panel.tabs) {
      if (tab.home) continue;
      const status = tabStatus(tab, tabActivities);
      const { cost, tokens } = tabCostTokens(tab, tabCosts);
      total += cost;
      totalTokens += tokens;
      if (status === "active") working += 1;
      const isActive = panel.id === activePanelId && panel.activeTabId === tab.id;
      rows.push({ panel, tab, status, cost, tokens, isActive });
    }
  }
  const shown = filter === "all" ? rows : rows.filter((r) => r.status === filter);

  const filterBtn = (id, label) => (
    <button
      onClick={() => setFilter(id)}
      style={{
        background: filter === id ? "var(--phn-accent-subtle, rgba(74,168,192,0.18))" : "transparent",
        border: `1px solid ${filter === id ? "var(--phn-link, #4aa8c0)" : "var(--phn-surface-border, #2a2a2a)"}`,
        color: filter === id ? "var(--phn-link, #4aa8c0)" : "var(--phn-text-dim, #888)",
        borderRadius: 4, padding: "1px 7px", fontSize: 9.5, cursor: "pointer",
        fontFamily: "var(--phn-ui-font)",
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="moba-dock-panel">
      <div className="phn-snippets-header">
        <span>🤖 Agents</span>
        <span style={{ fontSize: 10, color: "var(--phn-text-dim, #888)", fontWeight: 400 }}>
          {rows.length} · {working} running
        </span>
      </div>
      <div style={{ display: "flex", gap: 4, padding: "4px 8px" }}>
        {filterBtn("all", `all ${rows.length}`)}
        {filterBtn("active", `running ${rows.filter((r) => r.status === "active").length}`)}
        {filterBtn("done", `done ${rows.filter((r) => r.status === "done").length}`)}
      </div>
      <div className="phn-snippets-list">
        {shown.length === 0 ? (
          <div className="phn-snippets-empty">
            {rows.length === 0 ? "No sessions yet. Open a tab or spawn an agent worktree." : "No sessions match this filter."}
          </div>
        ) : (
          shown.map(({ panel, tab, status, cost, tokens, isActive }) => (
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
              {tokens > 0 && <span className="moba-agent-cost" title={`${tokens.toLocaleString()} tokens`} style={{ opacity: 0.7 }}>{fmtTokens(tokens)}t</span>}
              {cost > 0 && <span className="moba-agent-cost">${cost.toFixed(2)}</span>}
              {onSummarize && (
                <button
                  className="moba-agent-diff"
                  onClick={(e) => { e.stopPropagation(); onSummarize(tab.id); }}
                  title="AI-summarize this session"
                >
                  ✨
                </button>
              )}
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
      {(total > 0 || totalTokens > 0) && (
        <div className="moba-agent-total">
          total spend <strong>${total.toFixed(2)}</strong>
          {totalTokens > 0 && <span style={{ color: "var(--phn-text-dim, #888)" }}> · {fmtTokens(totalTokens)} tokens</span>}
        </div>
      )}
    </div>
  );
}
