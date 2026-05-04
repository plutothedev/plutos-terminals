import { useCallback, useMemo, useRef, useState } from "react";
import TerminalPanel from "./TerminalPanel";
import ProjectSidebar from "./ProjectSidebar";
import ProjectDialog from "./ProjectDialog";
import OnboardingOverlay from "./OnboardingOverlay";
import { gridDims, MAX_PANELS } from "./grid";
import { THEMES } from "./themes";

const HEADER_BG = "#181818";
const PAGE_BG = "#0a0a0a";
const FG = "#9D9D9D";
const FG_ACTIVE = "#E6E6E6";
const FG_DIM = "#555555";
const ACCENT = "#4DAAFC";
const BORDER = "#2B2B2B";
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

function freshId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function defaultPanel() {
  const tabId = freshId("tab");
  return {
    id: freshId("panel"),
    tabs: [{ id: tabId, label: "Tab 1", cwd: null, startCommands: [], projectId: null }],
    activeTabId: tabId,
  };
}

function defaultState() {
  const panel = defaultPanel();
  return {
    panels: [panel],
    activePanelId: panel.id,
    gridMode: "auto",
    projects: [],
    themeKey: "default",
  };
}

// Re-number tab labels within a panel after a close so we don't end up with
// "Tab 1, Tab 3". Only relabels tabs that still match the default scheme —
// project-named tabs (e.g. "plutos-terminals") are left alone.
function renumberDefaultLabels(tabs) {
  let n = 0;
  return tabs.map(t => {
    if (/^Tab \d+$/.test(t.label || "")) {
      n += 1;
      return { ...t, label: `Tab ${n}` };
    }
    return t;
  });
}

export default function TerminalsTab({ st, save }) {
  const state = st?.terminalsState || defaultState();
  const projects = state.projects || [];

  // Dialog: null = closed; { mode: "add" } or { mode: "edit", projectId }
  const [dialog, setDialog] = useState(null);

  // Per-tab activity state ({tabId: 'idle'|'active'|'done'}). NOT persisted —
  // it's transient and meaningless across app restarts (PTYs respawn fresh).
  const [tabActivities, setTabActivities] = useState({});

  // Per-tab cost tracking ({tabId: { tokens, cost }}). Aggregated for the
  // header display. Not persisted — cumulative figures come from Claude's
  // own /cost output each session.
  const [tabCosts, setTabCosts] = useState({});

  const handleTabCostUpdate = useCallback((tabId, c) => {
    setTabCosts(prev => {
      const cur = prev[tabId];
      if (cur && cur.tokens === c.tokens && cur.cost === c.cost) return prev;
      return { ...prev, [tabId]: c };
    });
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

  // Aggregate cost across all open tabs. Each tab's value is Claude's
  // cumulative session cost, so summing gives the total live spend.
  const totalCost = useMemo(() => {
    let cost = 0, tokens = 0;
    for (const v of Object.values(tabCosts)) {
      cost += v.cost || 0;
      tokens += v.tokens || 0;
    }
    return { cost, tokens };
  }, [tabCosts]);

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
        const cur = result[tab.projectId];
        if (cur === "active") continue;
        if (ts === "active" || cur !== "done") result[tab.projectId] = ts;
      }
    }
    return result;
  }, [tabActivities, state.panels, projects]);

  const persist = useCallback((next) => {
    save({ ...st, terminalsState: next });
  }, [st, save]);

  // ── Panel / tab mutations ──────────────────────────────────────────

  const setActivePanel = useCallback((panelId) => {
    if (state.activePanelId === panelId) return;
    persist({ ...state, activePanelId: panelId });
  }, [state, persist]);

  const addPanel = useCallback(() => {
    if (state.panels.length >= MAX_PANELS) return;
    const panel = defaultPanel();
    persist({ ...state, panels: [...state.panels, panel], activePanelId: panel.id });
  }, [state, persist]);

  const closePanel = useCallback((panelId) => {
    const panels = state.panels.filter(p => p.id !== panelId);
    if (panels.length === 0) {
      const panel = defaultPanel();
      persist({ ...state, panels: [panel], activePanelId: panel.id });
      return;
    }
    const activePanelId = state.activePanelId === panelId ? panels[0].id : state.activePanelId;
    persist({ ...state, panels, activePanelId });
  }, [state, persist]);

  const addTab = useCallback((panelId) => {
    const panels = state.panels.map(p => {
      if (p.id !== panelId) return p;
      const numbered = p.tabs.filter(t => /^Tab \d+$/.test(t.label || "")).length;
      const newTab = {
        id: freshId("tab"),
        label: `Tab ${numbered + 1}`,
        cwd: null,
        startCommands: [],
        projectId: null,
      };
      return { ...p, tabs: [...p.tabs, newTab], activeTabId: newTab.id };
    });
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist]);

  const closeTab = useCallback((panelId, tabId) => {
    const target = state.panels.find(p => p.id === panelId);
    if (!target) return;
    if (target.tabs.length === 1) {
      closePanel(panelId);
      return;
    }
    const panels = state.panels.map(p => {
      if (p.id !== panelId) return p;
      const tabs = renumberDefaultLabels(p.tabs.filter(t => t.id !== tabId));
      let activeTabId = p.activeTabId;
      if (activeTabId === tabId) {
        const idx = p.tabs.findIndex(t => t.id === tabId);
        const nextIdx = Math.min(idx, tabs.length - 1);
        activeTabId = tabs[nextIdx].id;
      }
      return { ...p, tabs, activeTabId };
    });
    persist({ ...state, panels });
  }, [state, persist, closePanel]);

  const switchTab = useCallback((panelId, tabId) => {
    const panels = state.panels.map(p =>
      p.id === panelId ? { ...p, activeTabId: tabId } : p
    );
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist]);

  const renameTab = useCallback((tabId, label) => {
    const panels = state.panels.map(p => ({
      ...p,
      tabs: p.tabs.map(t => t.id === tabId ? { ...t, label } : t),
    }));
    persist({ ...state, panels });
  }, [state, persist]);

  // Move a tab from its current panel to a different one. PTY in the source
  // panel gets killed (TerminalPane unmount), a fresh one spawns in the
  // target panel — startCommands re-run, scrollback replays from the disk
  // file so context isn't lost. v2 (preserve PTY across moves) would need
  // a connection registry outside React's lifecycle.
  const moveTab = useCallback((tabId, tgtPanelId) => {
    const srcPanel = state.panels.find(p => p.tabs.some(t => t.id === tabId));
    if (!srcPanel || srcPanel.id === tgtPanelId) return;
    const tab = srcPanel.tabs.find(t => t.id === tabId);
    if (!tab) return;
    let panels = state.panels.map(p => {
      if (p.id === srcPanel.id) {
        const remaining = p.tabs.filter(t => t.id !== tabId);
        let activeTabId = p.activeTabId;
        if (activeTabId === tabId) {
          const idx = p.tabs.findIndex(t => t.id === tabId);
          const nextIdx = Math.min(idx, remaining.length - 1);
          activeTabId = remaining[nextIdx]?.id || null;
        }
        return { ...p, tabs: remaining, activeTabId };
      }
      if (p.id === tgtPanelId) {
        return { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id };
      }
      return p;
    });
    // If the source panel ran dry, drop it.
    panels = panels.filter(p => p.tabs.length > 0);
    if (panels.length === 0) {
      const fresh = defaultPanel();
      persist({ ...state, panels: [fresh], activePanelId: fresh.id });
      return;
    }
    let activePanelId = panels.find(p => p.id === tgtPanelId) ? tgtPanelId : panels[0].id;
    persist({ ...state, panels, activePanelId });
  }, [state, persist]);

  const setTheme = useCallback((key) => {
    if (state.themeKey === key) return;
    persist({ ...state, themeKey: key });
  }, [state, persist]);

  // ── Pack loader (v0.0.2) ───────────────────────────────────────────
  // Replace the current panel/tab layout with the panels described in a
  // .deck.json prompt pack. Existing PTY children get killed (TerminalPane
  // unmount handles cleanup); new tabs spawn fresh shells with the pack's
  // start commands. State persists via the existing save() pipeline.

  const fileInputRef = useRef(null);

  const applyPack = useCallback((pack) => {
    if (!pack || !Array.isArray(pack.panels) || pack.panels.length === 0) {
      window.alert("Invalid pack: missing or empty panels[] array.");
      return;
    }
    const newPanels = pack.panels.slice(0, MAX_PANELS).map((p) => {
      const rawTabs = Array.isArray(p.tabs) && p.tabs.length > 0 ? p.tabs : [{}];
      const tabs = rawTabs.map((t, i) => ({
        id: freshId("tab"),
        label: (t && t.label) || `Tab ${i + 1}`,
        cwd: (t && t.cwd) || null,
        startCommands: Array.isArray(t && t.startCommands) ? t.startCommands : [],
        projectId: null,
      }));
      return {
        id: freshId("panel"),
        tabs,
        activeTabId: tabs[0].id,
      };
    });
    persist({
      ...state,
      panels: newPanels,
      activePanelId: newPanels[0].id,
    });
  }, [state, persist]);

  const onLoadPackFile = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // reset so re-loading the same file fires onChange
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const pack = JSON.parse(reader.result);
        applyPack(pack);
      } catch (err) {
        window.alert(`Failed to load pack: ${err.message}`);
      }
    };
    reader.onerror = () => {
      window.alert(`Failed to read pack file: ${reader.error?.message || "unknown error"}`);
    };
    reader.readAsText(file);
  }, [applyPack]);

  const onQuickSpawnGrid = useCallback(() => {
    if (!window.confirm("Replace current panels with a 4-up agent grid (Researcher / Coder / Reviewer / Journal)? Existing sessions will be killed.")) {
      return;
    }
    applyPack({
      schema: "plutos-terminals/deck.json/v0",
      name: "Agent Grid",
      panels: [
        { tabs: [{ label: "Researcher", startCommands: ["echo 'RESEARCHER — paste your research query, then run claude'"] }] },
        { tabs: [{ label: "Coder", startCommands: ["echo 'CODER — Claude Code session for hands-on edits, run claude'"] }] },
        { tabs: [{ label: "Reviewer", startCommands: ["echo 'REVIEWER — code review focus, run claude'"] }] },
        { tabs: [{ label: "Journal", startCommands: ["echo 'JOURNAL — running session log, append with Add-Content'"] }] },
      ],
    });
  }, [applyPack]);

  // ── Project mutations ──────────────────────────────────────────────

  const upsertProject = useCallback((data, editingId) => {
    let nextProjects;
    let resultId;
    if (editingId) {
      nextProjects = projects.map(p => p.id === editingId ? { ...p, ...data } : p);
      resultId = editingId;
    } else {
      const id = freshId("proj");
      nextProjects = [...projects, { id, color: null, ...data }];
      resultId = id;
    }
    persist({ ...state, projects: nextProjects });
    return resultId;
  }, [state, persist, projects]);

  const removeProject = useCallback((projectId) => {
    const nextProjects = projects.filter(p => p.id !== projectId);
    // Detach any open tabs that referenced this project (keep the tab + PTY,
    // just clear the link) so the user doesn't lose an active session.
    const panels = state.panels.map(p => ({
      ...p,
      tabs: p.tabs.map(t => t.projectId === projectId ? { ...t, projectId: null } : t),
    }));
    persist({ ...state, projects: nextProjects, panels });
  }, [state, persist, projects]);

  const colorProject = useCallback((projectId, colorId) => {
    const nextProjects = projects.map(p => p.id === projectId ? { ...p, color: colorId } : p);
    persist({ ...state, projects: nextProjects });
  }, [state, persist, projects]);

  const renameProject = useCallback((projectId, name) => {
    if (!name) return;
    const nextProjects = projects.map(p => p.id === projectId ? { ...p, name } : p);
    persist({ ...state, projects: nextProjects });
  }, [state, persist, projects]);

  // Add a new tab to `panelId` running `projectId`'s shell with its cwd and
  // start commands. Used by both click (target = active panel) and drop
  // (target = panel under cursor). When `overrideCommands` is provided, it
  // replaces the project's default startCommands — used by the npm-script
  // launcher in the context menu.
  const openProjectInPanel = useCallback((panelId, projectId, overrideCommands) => {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    const cmds = overrideCommands || project.startCommands || [];
    const labelSuffix = overrideCommands && overrideCommands.length === 1
      ? ` · ${overrideCommands[0]}`
      : "";
    const panels = state.panels.map(p => {
      if (p.id !== panelId) return p;
      const newTab = {
        id: freshId("tab"),
        label: `${project.name}${labelSuffix}`,
        cwd: project.path,
        startCommands: cmds,
        projectId: project.id,
      };
      return { ...p, tabs: [...p.tabs, newTab], activeTabId: newTab.id };
    });
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist, projects]);

  const runProjectScript = useCallback((projectId, scriptName) => {
    openProjectInPanel(state.activePanelId, projectId, [`npm run ${scriptName}`]);
  }, [openProjectInPanel, state.activePanelId]);

  // ── Dialog handlers ────────────────────────────────────────────────

  const dialogInitial = useMemo(() => {
    if (!dialog || dialog.mode !== "edit") return null;
    return projects.find(p => p.id === dialog.projectId) || null;
  }, [dialog, projects]);

  const handleSaveDialog = useCallback((data) => {
    upsertProject(data, dialog?.mode === "edit" ? dialog.projectId : null);
    setDialog(null);
  }, [upsertProject, dialog]);

  // ── Render ─────────────────────────────────────────────────────────

  const dims = useMemo(
    () => gridDims(state.panels.length, state.gridMode === "row" ? "row" : "auto"),
    [state.panels.length, state.gridMode]
  );

  const canAddPanel = state.panels.length < MAX_PANELS;
  const canClosePanel = state.panels.length > 1;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: PAGE_BG, fontFamily: M }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "6px 10px",
          background: HEADER_BG,
          borderBottom: `1px solid ${BORDER}`,
          fontSize: 11,
          color: FG,
          flexShrink: 0,
          minHeight: 32,
          boxSizing: "border-box",
        }}
      >
        <span style={{ color: FG_ACTIVE, letterSpacing: 0.5 }}>TERMINALS</span>
        <span style={{ color: FG_DIM }}>
          {state.panels.length} panel{state.panels.length === 1 ? "" : "s"}
          {projects.length > 0 && ` · ${projects.length} project${projects.length === 1 ? "" : "s"}`}
        </span>
        {(totalCost.cost > 0 || totalCost.tokens > 0) && (
          <span
            style={{ color: "#34D399", marginLeft: 4 }}
            title="Live aggregate from Claude /cost output across all sessions"
          >
            · ${totalCost.cost.toFixed(2)}
            {totalCost.tokens > 0 && ` · ${totalCost.tokens >= 1000 ? `${(totalCost.tokens / 1000).toFixed(1)}k` : totalCost.tokens} tokens`}
          </span>
        )}
        <div style={{ flex: 1 }} />

        {/* Pack loader + quick-spawn agent grid (v0.0.2) */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.deck.json"
          onChange={onLoadPackFile}
          style={{ display: "none" }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{
            background: "transparent",
            border: `1px solid ${BORDER}`,
            color: ACCENT,
            cursor: "pointer",
            padding: "3px 10px",
            borderRadius: 3,
            fontFamily: M,
            fontSize: 11,
          }}
          title="Load a .deck.json prompt pack — replaces current panel layout"
        >
          📦 load pack
        </button>
        <button
          onClick={onQuickSpawnGrid}
          style={{
            background: "transparent",
            border: `1px solid ${BORDER}`,
            color: ACCENT,
            cursor: "pointer",
            padding: "3px 10px",
            borderRadius: 3,
            fontFamily: M,
            fontSize: 11,
          }}
          title="Quick-spawn: 4-panel agent grid (Researcher / Coder / Reviewer / Journal)"
        >
          ⚡ agent grid
        </button>

        <select
          value={state.themeKey || "default"}
          onChange={(e) => setTheme(e.target.value)}
          title="Terminal color theme"
          style={{
            background: "transparent",
            border: `1px solid ${BORDER}`,
            color: FG,
            padding: "3px 6px",
            borderRadius: 3,
            fontFamily: M,
            fontSize: 11,
            outline: "none",
            cursor: "pointer",
          }}
        >
          {Object.entries(THEMES).map(([key, t]) => (
            <option key={key} value={key} style={{ background: "#181818", color: FG }}>{t.label}</option>
          ))}
        </select>
        <button
          onClick={addPanel}
          disabled={!canAddPanel}
          style={{
            background: "transparent",
            border: `1px solid ${canAddPanel ? BORDER : "#222"}`,
            color: canAddPanel ? ACCENT : "#444",
            cursor: canAddPanel ? "pointer" : "not-allowed",
            padding: "3px 10px",
            borderRadius: 3,
            fontFamily: M,
            fontSize: 11,
          }}
          title={canAddPanel ? "Add panel" : `Max ${MAX_PANELS} panels`}
        >
          + pane
        </button>
      </div>

      {/* Body: sidebar + grid */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0 }}>
        <ProjectSidebar
          projects={projects}
          projectActivities={projectActivities}
          onAddProject={() => setDialog({ mode: "add" })}
          onEditProject={(id) => setDialog({ mode: "edit", projectId: id })}
          onRemoveProject={removeProject}
          onColorProject={colorProject}
          onRenameProject={renameProject}
          onClickProject={(id) => openProjectInPanel(state.activePanelId, id)}
          onDropProject={(id, panelId) => openProjectInPanel(panelId, id)}
          onRunScript={runProjectScript}
        />

        <div
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: `repeat(${dims.cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${dims.rows}, minmax(0, 1fr))`,
            gap: 4,
            padding: 4,
            minHeight: 0,
            minWidth: 0,
          }}
        >
          {state.panels.map(panel => (
            <TerminalPanel
              key={panel.id}
              panel={panel}
              isActive={panel.id === state.activePanelId}
              canClosePanel={canClosePanel}
              tabActivities={tabActivities}
              themeKey={state.themeKey || "default"}
              tabAutoApprove={tabAutoApprove}
              tabProjectNames={tabProjectNames}
              onActivate={() => setActivePanel(panel.id)}
              onAddTab={() => addTab(panel.id)}
              onCloseTab={(tabId) => closeTab(panel.id, tabId)}
              onSwitchTab={(tabId) => switchTab(panel.id, tabId)}
              onClosePanel={() => closePanel(panel.id)}
              onTabActivityChange={handleTabActivityChange}
              onTabCostUpdate={handleTabCostUpdate}
              onRenameTab={renameTab}
              onMoveTab={moveTab}
            />
          ))}
        </div>
      </div>

      <ProjectDialog
        open={!!dialog}
        initial={dialogInitial}
        onClose={() => setDialog(null)}
        onSave={handleSaveDialog}
      />

      {!st?.terminalsOnboarded && (
        <OnboardingOverlay
          onDismiss={() => save({ ...st, terminalsOnboarded: true })}
        />
      )}
    </div>
  );
}
