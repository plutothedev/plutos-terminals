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
import { allRenderedPaneIds } from "../paneIds.js";

// Identity-stable shallow-map memo (P2-T2): recomputes per deps like useMemo,
// but hands back the PREVIOUS object when the contents are shallow-equal —
// plain-object shallow equality with a key-count check (covers deletion).
function useStableMap(compute, deps) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(compute, deps);
  const prevRef = useRef(value);
  const prev = prevRef.current;
  let out = value;
  if (prev !== value) {
    const pk = Object.keys(prev);
    const vk = Object.keys(value);
    if (pk.length === vk.length && vk.every((k) => prev[k] === value[k])) {
      out = prev;
    }
  }
  prevRef.current = out;
  return out;
}

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
  // (Activity state moved to activityStore.js in P2-T1 — producers write the
  // module store; consumers subscribe to their slice. This hook keeps costs
  // and the per-tab project maps.)

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

  // Maps from tab id -> project metadata, so each TerminalPane knows which
  // project it represents (for auto-approve toggle + transcript filename).
  // Identity-stable (P2-T2): rebuilt on every workspace mutation but usually
  // shallow-equal — returning the PREVIOUS object then keeps the panel memos
  // holding across unrelated tab switches. A real toggle/rename changes the
  // contents, so a fresh identity flows and the affected panes re-render.
  const tabAutoApprove = useStableMap(() => {
    const ap = {};
    for (const panel of state.panels) {
      for (const tab of panel.tabs) {
        if (!tab.projectId) continue;
        const project = projects.find(p => p.id === tab.projectId);
        if (project?.autoApprove) ap[tab.id] = true;
      }
    }
    return ap;
  }, [state.panels, projects]);
  const tabProjectNames = useStableMap(() => {
    const names = {};
    for (const panel of state.panels) {
      for (const tab of panel.tabs) {
        if (!tab.projectId) continue;
        const project = projects.find(p => p.id === tab.projectId);
        if (project) names[tab.id] = project.name;
      }
    }
    return names;
  }, [state.panels, projects]);

  // Aggregate cost across all CURRENTLY-OPEN tabs/panes. tabCosts is never pruned
  // on close, so summing it raw keeps counting finished sessions (and double-counts
  // on reopen). Live ids = allRenderedPaneIds — the exact leaf-id universe
  // TerminalPanel reports costs under (and the registry sweeps on). P2-T5:
  // the previous recursive walk re-visited every object in the panel tree
  // (connection/auth/worktree/layout nodes included) on EVERY cost tick — up
  // to once per second per running agent — to build this set.
  const livePaneIds = useMemo(
    () => new Set(allRenderedPaneIds(state.panels)),
    [state.panels]
  );
  const totalCost = useMemo(() => {
    let cost = 0, tokens = 0;
    for (const [id, v] of Object.entries(tabCosts)) {
      if (!livePaneIds.has(id)) continue;
      cost += v.cost || 0;
      tokens += v.tokens || 0;
    }
    return { cost, tokens };
  }, [tabCosts, livePaneIds]);

  // (projectActivities moved to the activity store's useProjectRollups —
  // driven by the root-pane→project index TerminalsTab maintains. P2-T1.)

  return {
    tabCosts,
    handleTabCostUpdate,
    tabAutoApprove, tabProjectNames,
    totalCost,
  };
}
