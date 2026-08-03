// (C)
// Per-tab telemetry lifted verbatim out of the TerminalsTab god component:
// transient activity state ({tabId: 'idle'|'waiting'|'active'|'done'}) and
// Claude /cost tracking ({tabId: {tokens, cost}}), NEITHER persisted (both are
// meaningless across restarts — PTYs respawn fresh and /cost figures are
// per-session). It also derives the aggregates the chrome reads: the tab→project
// auto-approve / name maps, the live total spend, and per-project activity
// rollups. Inputs: the workspace state + the project list.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLayout, leafIds } from "../splitTree";

// Rollup precedence when several tabs map to one project (or one summary row).
// "waiting" ranks highest on purpose: among a fleet of agents, the one blocked
// on a human is the only one whose state is actionable right now — it must
// never be hidden behind a sibling that happens to be running.
export const ACTIVITY_RANK = { waiting: 3, active: 2, done: 1, idle: 0 };

export function mergeActivity(a, b) {
  return (ACTIVITY_RANK[b] ?? 0) > (ACTIVITY_RANK[a] ?? 0) ? b : (a ?? "idle");
}

// A TAB's status = the loudest of its panes. Split tabs matter here: only one
// child keeps the original tab.id after a split, so anything keying off tab.id
// alone silently misses the other pane's state. Every fleet surface goes
// through this.
export function tabStatus(tab, activities) {
  let best = "idle";
  for (const id of leafIds(getLayout(tab))) {
    best = mergeActivity(best, activities?.[id] || "idle");
    if (best === "waiting") break; // nothing outranks it
  }
  return best;
}

// Fleet counts for the Monitor's summary line, per tab (not per pane).
export function activityCounts(tabs, activities) {
  const counts = { waiting: 0, active: 0, done: 0, idle: 0 };
  for (const t of tabs || []) {
    const st = tabStatus(t, activities);
    if (counts[st] === undefined) counts.idle += 1;
    else counts[st] += 1;
  }
  return counts;
}

export function useTabTelemetry({ state, projects }) {
  // Per-tab activity state ({tabId: 'idle'|'active'|'done'}). NOT persisted —
  // it's transient and meaningless across app restarts (PTYs respawn fresh).
  const [tabActivities, setTabActivities] = useState({});

  // Per-tab cost tracking ({tabId: { tokens, cost }}). Aggregated for the
  // header display. Not persisted — cumulative figures come from Claude's
  // own /cost output each session.
  const [tabCosts, setTabCosts] = useState({});

  // Cost updates arrive per output-chunk during a busy Claude session — committing
  // each one re-renders the whole tab tree (tabCosts feeds the header/status-bar
  // totals). Throttle to at most ONE state commit per second per tab: stash the
  // latest value and commit it on a trailing-edge timer, so the final figure is
  // never lost, just coalesced.
  const pendingCostsRef = useRef(new Map()); // tabId -> latest {tokens, cost}
  const costTimersRef = useRef(new Map()); // tabId -> timeout id
  useEffect(() => {
    const timers = costTimersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); };
  }, []);
  const handleTabCostUpdate = useCallback((tabId, c) => {
    pendingCostsRef.current.set(tabId, c);
    if (costTimersRef.current.has(tabId)) return; // commit already scheduled
    costTimersRef.current.set(tabId, setTimeout(() => {
      costTimersRef.current.delete(tabId);
      const latest = pendingCostsRef.current.get(tabId);
      pendingCostsRef.current.delete(tabId);
      if (!latest) return;
      setTabCosts(prev => {
        const cur = prev[tabId];
        if (cur && cur.tokens === latest.tokens && cur.cost === latest.cost) return prev;
        return { ...prev, [tabId]: latest };
      });
    }, 1000));
  }, []);

  const handleTabActivityChange = useCallback((tabId, nextState) => {
    setTabActivities(prev => {
      if (prev[tabId] === nextState) return prev;
      // 'idle' is the default — drop the entry instead of storing it, so the
      // map stays small as tabs cycle through states.
      if (nextState === "idle") {
        if (!(tabId in prev)) return prev;
        const { [tabId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [tabId]: nextState };
    });
  }, []);

  // Maps from tab id -> project metadata, so each TerminalPane knows which
  // project it represents (for auto-approve toggle + transcript filename).
  const { tabAutoApprove, tabProjectNames } = useMemo(() => {
    const ap = {};
    const names = {};
    for (const panel of state.panels) {
      for (const tab of panel.tabs) {
        if (!tab.projectId) continue;
        const project = projects.find(p => p.id === tab.projectId);
        if (!project) continue;
        if (project.autoApprove) ap[tab.id] = true;
        names[tab.id] = project.name;
      }
    }
    return { tabAutoApprove: ap, tabProjectNames: names };
  }, [state.panels, projects]);

  // Aggregate cost across all CURRENTLY-OPEN tabs/panes. tabCosts is never pruned
  // on close, so summing it raw keeps counting finished sessions (and double-counts
  // on reopen). Collect every live id from the panel/tab/pane tree and only sum
  // entries still present — a superset collect (any `id`) is safe: it can only
  // exclude truly-gone tabs, never drop a live one.
  const totalCost = useMemo(() => {
    const live = new Set();
    const collect = (node) => {
      if (!node || typeof node !== "object") return;
      if (typeof node.id === "string") live.add(node.id);
      for (const k in node) {
        const v = node[k];
        if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === "object") collect(v);
      }
    };
    state.panels.forEach(collect);
    let cost = 0, tokens = 0;
    for (const [id, v] of Object.entries(tabCosts)) {
      if (!live.has(id)) continue;
      cost += v.cost || 0;
      tokens += v.tokens || 0;
    }
    return { cost, tokens };
  }, [tabCosts, state.panels]);

  // Per-project activity: aggregate of any open tab tied to this project.
  // 'active' wins over 'done' wins over 'idle'.
  const projectActivities = useMemo(() => {
    const result = {};
    if (!projects.length) return result;
    for (const panel of state.panels) {
      for (const tab of panel.tabs) {
        if (!tab.projectId) continue;
        const ts = tabActivities[tab.id];
        if (!ts || ts === "idle") continue;
        result[tab.projectId] = mergeActivity(result[tab.projectId], ts);
      }
    }
    return result;
  }, [tabActivities, state.panels, projects]);

  return {
    tabActivities, tabCosts,
    handleTabCostUpdate, handleTabActivityChange,
    tabAutoApprove, tabProjectNames,
    totalCost, projectActivities,
  };
}
