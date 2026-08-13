// (C)
// Agent dashboard — a live overview of every session across all panels: status
// (needs you / running / finished / idle), Claude /cost + tokens, and git-worktree
// branch. Click a row to jump to that tab, ✨ to AI-summarize it, diff to review
// a worktree. Filter by status. The parallel-AI "mission control".
import { useState } from "react";
import { getLayout, leafIds } from "./splitTree";
import { SBot, SAgents, SLink, SSerial, SWindows, SLocal, SAsk } from "./toolbarIcons.jsx";
import { tabStatus } from "./hooks/useTabTelemetry.js";
import { useActivitiesSnapshot } from "./activityStore.js";
import "./terminals.css";

function tabCostTokens(tab, tabCosts) {
  let cost = 0, tokens = 0;
  for (const id of leafIds(getLayout(tab))) {
    cost += tabCosts?.[id]?.cost || 0;
    tokens += tabCosts?.[id]?.tokens || 0;
  }
  return { cost, tokens };
}

const fmtTokens = (t) => (t >= 1000 ? `${(t / 1000).toFixed(1)}k` : `${t}`);

const DOT = { waiting: "#E0A93C", active: "#FBBF24", done: "#34D399", idle: "#5a5a5a" };
const LABEL = { waiting: "needs you", active: "running", done: "finished", idle: "idle" };

export default function AgentDashboard({ panels, activePanelId, tabCosts, onFocusTab, onReviewDiff, onSummarize }) {
  const [filter, setFilter] = useState("all"); // all | waiting | active | done
  // Whole-map subscription (P2-T1): header counts, filter pills and the
  // waiting-first sort all need every tab's status; the dashboard mounts only
  // while its ribbon is open.
  const tabActivities = useActivitiesSnapshot();

  const rows = [];
  let total = 0, totalTokens = 0, working = 0, waiting = 0;
  for (const panel of panels) {
    for (const tab of panel.tabs) {
      if (tab.home) continue;
      const status = tabStatus(tab, tabActivities);
      const { cost, tokens } = tabCostTokens(tab, tabCosts);
      total += cost;
      totalTokens += tokens;
      if (status === "active") working += 1;
      if (status === "waiting") waiting += 1;
      const isActive = panel.id === activePanelId && panel.activeTabId === tab.id;
      rows.push({ panel, tab, status, cost, tokens, isActive });
    }
  }
  // The "needs you" pill only renders while something is waiting, so a filter
  // left selected as the last agent unblocks would leave no pill highlighted
  // and an empty list with no explanation. Fall back to "all" in that case.
  const effectiveFilter = filter === "waiting" && waiting === 0 ? "all" : filter;
  // Blocked sessions float to the top of every view: the whole point of a fleet
  // list is that you should never have to hunt for the one that needs you.
  // Array.prototype.sort is stable, so everything else keeps its panel/tab order.
  const shown = (effectiveFilter === "all" ? rows : rows.filter((r) => r.status === effectiveFilter))
    .slice()
    .sort((a, b) => (b.status === "waiting" ? 1 : 0) - (a.status === "waiting" ? 1 : 0));

  const filterBtn = (id, label) => (
    <button
      onClick={() => setFilter(id)}
      style={{
        background: effectiveFilter === id ? "var(--phn-accent-subtle, rgba(74,168,192,0.18))" : "transparent",
        border: `1px solid ${effectiveFilter === id ? "var(--phn-link, #7c9cf5)" : "var(--phn-surface-border, #2a2a2a)"}`,
        color: effectiveFilter === id ? "var(--phn-link, #7c9cf5)" : "var(--phn-text-dim, #888)",
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SBot size={13} /> Fleet</span>
        <span style={{ fontSize: 10, color: "var(--phn-text-dim, #888)", fontWeight: 400 }}>
          {waiting > 0 && (
            <span style={{ color: DOT.waiting, fontWeight: 600 }}>{waiting} needs you · </span>
          )}
          {rows.length} sessions · {working} running
        </span>
      </div>
      <div style={{ display: "flex", gap: 4, padding: "4px 8px" }}>
        {filterBtn("all", `all ${rows.length}`)}
        {waiting > 0 && filterBtn("waiting", `needs you ${waiting}`)}
        {filterBtn("active", `running ${rows.filter((r) => r.status === "active").length}`)}
        {filterBtn("done", `finished ${rows.filter((r) => r.status === "done").length}`)}
      </div>
      <div className="phn-snippets-list">
        {shown.length === 0 ? (
          <div className="phn-snippets-empty">
            {rows.length === 0 ? "No sessions yet. Open a tab or start an agent worktree." : "No sessions match this filter."}
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
                style={{ background: DOT[status], boxShadow: DOT[status] && status !== "idle" ? `0 0 6px ${DOT[status]}` : "none" }}
              />
              <span className="moba-agent-icon" style={{ display: "inline-flex", alignItems: "center" }}>{tab.worktree ? <SAgents size={11} /> : tab.connection ? <SLink size={11} /> : tab.serial ? <SSerial size={11} /> : tab.rdp ? <SWindows size={11} /> : tab.vnc ? <SLocal size={11} /> : "❯"}</span>
              <span className="moba-agent-name">{tab.worktree ? tab.worktree.branch : tab.label}</span>
              {tokens > 0 && <span className="moba-agent-cost" title={`${tokens.toLocaleString()} tokens`} style={{ opacity: 0.7 }}>{fmtTokens(tokens)}t</span>}
              {cost > 0 && <span className="moba-agent-cost">${cost.toFixed(2)}</span>}
              {onSummarize && (
                <button
                  className="moba-agent-diff"
                  onClick={(e) => { e.stopPropagation(); onSummarize(tab.id); }}
                  title="AI-summarize this session"
                >
                  <SAsk size={12} />
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
