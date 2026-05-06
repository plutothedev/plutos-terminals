import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TerminalPanel from "./TerminalPanel";
import ProjectSidebar from "./ProjectSidebar";
import ProjectDialog from "./ProjectDialog";
import OnboardingOverlay from "./OnboardingOverlay";
import SettingsModal from "../../components/SettingsModal.jsx";
import McpInstaller from "../../components/McpInstaller.jsx";
import SetupChecker from "../../components/SetupChecker.jsx";
import PackUrlModal from "../../components/PackUrlModal.jsx";
import { useToast } from "../../components/Toast.jsx";
import { useConfirm } from "../../components/ConfirmModal.jsx";

import { gridDims, MAX_PANELS } from "./grid";
import {
  getSkinId,
  getSkinXtermTheme,
  injectHeaderSkinsCss,
  applyGlobalSkin,
  getButtonStyleId,
  applyGlobalButtonStyle,
} from "./headerSkins";

// Bundled prompt packs — eagerly imported at build time from the repo's
// prompt-packs/ folder. Anyone who downloads a binary release gets all the
// shipped packs available in-app via the 📚 packs dropdown without having to
// download .deck.json files separately. Add a new pack to prompt-packs/ and
// it shows up here on the next build.
const BUNDLED_PACK_MODULES = import.meta.glob("../../../prompt-packs/*.deck.json", {
  eager: true,
  import: "default",
});
const BUNDLED_PACKS = Object.entries(BUNDLED_PACK_MODULES)
  .map(([path, data]) => ({
    filename: path.split("/").pop(),
    data,
  }))
  .sort((a, b) => (a.data?.name || a.filename).localeCompare(b.data?.name || b.filename));

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
  const toast = useToast();
  const confirm = useConfirm();

  // Dialog: null = closed; { mode: "add" } or { mode: "edit", projectId }
  const [dialog, setDialog] = useState(null);

  // Modal toggles
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);


  // Inject header-skin CSS once. Idempotent inside injectHeaderSkinsCss.
  useEffect(() => {
    injectHeaderSkinsCss();
  }, []);

  const headerSkinId = getSkinId(st?.headerSkin);

  // Apply skin globally on <html> so portaled/sibling elements (toasts,
  // modals via Provider tree) inherit skin CSS vars.
  useEffect(() => {
    applyGlobalSkin(headerSkinId);
  }, [headerSkinId]);

  const headerButtonStyleId = getButtonStyleId(st?.headerButtonStyle);
  useEffect(() => {
    applyGlobalButtonStyle(headerButtonStyleId);
  }, [headerButtonStyleId]);
  const pureBlackTerminal = !!st?.pureBlackTerminal;
  const xtermTheme = useMemo(
    () => getSkinXtermTheme(headerSkinId, { pureBlackTerminal }),
    [headerSkinId, pureBlackTerminal]
  );

  // Claude CLI availability — checked once on mount, surfaced in the status
  // bar. Doesn't gate behavior; just informs.
  const [claudeAvailable, setClaudeAvailable] = useState(null);
  useEffect(() => {
    let cancelled = false;
    invoke("check_command_version", { name: "claude" })
      .then((v) => { if (!cancelled) setClaudeAvailable(!!v); })
      .catch(() => { if (!cancelled) setClaudeAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  // First-launch auto-detect: if user has never seen the setup checker AND
  // `claude` isn't on PATH, auto-open the modal so they don't type `claude`
  // and hit "command not recognized" as their first impression. Set
  // st.setupSeen after first run so we don't auto-open again.
  useEffect(() => {
    if (st?.setupSeen) return;
    let cancelled = false;
    (async () => {
      try {
        const claudeVersion = await invoke("check_command_version", { name: "claude" });
        if (cancelled) return;
        if (!claudeVersion) {
          setSetupOpen(true);
        }
      } catch (_) {
        // If the check itself errors (Tauri command not registered, etc.),
        // open the setup modal anyway — better safe than silent.
        if (!cancelled) setSetupOpen(true);
      } finally {
        if (!cancelled) {
          // Mark seen even if claude was found, so subsequent launches skip.
          save({ ...st, setupSeen: true });
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // ── Pack loader (v0.0.2) ───────────────────────────────────────────
  // Replace the current panel/tab layout with the panels described in a
  // .deck.json prompt pack. Existing PTY children get killed (TerminalPane
  // unmount handles cleanup); new tabs spawn fresh shells with the pack's
  // start commands. State persists via the existing save() pipeline.

  const fileInputRef = useRef(null);

  const applyPack = useCallback((pack) => {
    if (!pack || !Array.isArray(pack.panels) || pack.panels.length === 0) {
      toast.error("Invalid pack: missing or empty panels[] array.");
      return;
    }
    const newPanels = pack.panels.slice(0, MAX_PANELS).map((p) => {
      const rawTabs = Array.isArray(p.tabs) && p.tabs.length > 0 ? p.tabs : [{}];
      const tabs = rawTabs.map((t, i) => ({
        id: freshId("tab"),
        label: (t && t.label) || `Tab ${i + 1}`,
        cwd: (t && t.cwd) || null,
        startCommands: Array.isArray(t && t.startCommands) ? t.startCommands : [],
        systemPrompt: (t && typeof t.systemPrompt === "string") ? t.systemPrompt : null,
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
    toast.success(`Pack "${pack.name || "(unnamed)"}" loaded — ${newPanels.length} panel${newPanels.length === 1 ? "" : "s"}.`);
  }, [state, persist, toast]);

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
        toast.error(`Failed to load pack: ${err.message}`);
      }
    };
    reader.onerror = () => {
      toast.error(`Failed to read pack file: ${reader.error?.message || "unknown error"}`);
    };
    reader.readAsText(file);
  }, [applyPack, toast]);

  const onLoadBundledPack = useCallback(async (pack) => {
    const desc = (pack.data?.description || "").substring(0, 220);
    const ok = await confirm(
      `Replace current panels with "${pack.data?.name || pack.filename}"?\n\n${desc}${desc.length === 220 ? "…" : ""}`,
      { title: "Load pack?", confirmLabel: "load", destructive: false }
    );
    if (!ok) return;
    applyPack(pack.data);
  }, [applyPack, confirm]);

  // Drag-and-drop pack files anywhere on the window — alternative to the file
  // picker. Browsers route drop events through window if no inner element
  // handles them; we preventDefault to avoid the browser navigating to the
  // file:// URL.
  useEffect(() => {
    const onDragOver = (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (!file.name.endsWith(".deck.json") && !file.name.endsWith(".json")) return;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const pack = JSON.parse(reader.result);
          applyPack(pack);
        } catch (err) {
          window.alert(`Failed to load pack: ${err.message}`);
        }
      };
      reader.readAsText(file);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [applyPack]);

  // ── Pack export (v0.1.0) ───────────────────────────────────────────
  // Serialize the current panel/tab layout to a .deck.json file and
  // trigger a browser download. The exported pack has no PTY state —
  // just the structure (panels, tabs, cwd, startCommands) — so users
  // can clone their setup, share it on Discord/GitHub, or reload after
  // a factory reset.

  const onExportPack = useCallback(() => {
    const name = window.prompt("Pack name?", "My Pluto's Terminals Setup");
    if (!name || !name.trim()) return;
    const description = window.prompt(
      "Pack description (optional)?",
      "Exported from Pluto's Terminals — multi-panel layout with cwd + start commands per tab."
    ) || "";

    const pack = {
      schema: "plutos-terminals/deck.json/v0",
      name: name.trim(),
      description: description.trim(),
      created: new Date().toISOString().slice(0, 10),
      panels: state.panels.map((p) => ({
        tabs: p.tabs.map((t) => ({
          label: t.label || "Tab",
          cwd: t.cwd || null,
          startCommands: Array.isArray(t.startCommands) ? t.startCommands : [],
        })),
      })),
      mcp_servers: [],
      env_hints: [],
      notes: ["Exported from Pluto's Terminals. Edit this file to share or refine."],
    };

    const json = JSON.stringify(pack, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pluto-pack";
    a.download = `${slug}.deck.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [state]);

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
    <div className="phn-page" data-phn-skin={headerSkinId} style={{ height: "100%", position: "relative", fontFamily: M }}>
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header — visual treatment driven by user-selected skin (headerSkins.js).
          Layout-only inline styles here; colors/borders/effects come from CSS. */}
      <div className="phn-header" style={{ gap: 12 }}>
        <span className="phn-title">TERMINALS</span>
        <span className="phn-meta phn-meta-dot">·</span>
        <span className="phn-meta">
          {state.panels.length} panel{state.panels.length === 1 ? "" : "s"}
          {projects.length > 0 && ` · ${projects.length} project${projects.length === 1 ? "" : "s"}`}
        </span>
        {(totalCost.cost > 0 || totalCost.tokens > 0) && (
          <span
            className="phn-cost"
            style={{ marginLeft: 4 }}
            title="Live aggregate from Claude /cost output across all sessions"
          >
            · ${totalCost.cost.toFixed(2)}
            {totalCost.tokens > 0 && ` · ${totalCost.tokens >= 1000 ? `${(totalCost.tokens / 1000).toFixed(1)}k` : totalCost.tokens} tokens`}
          </span>
        )}
        <div style={{ flex: 1 }} />

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.deck.json"
          onChange={onLoadPackFile}
          style={{ display: "none" }}
        />
        {BUNDLED_PACKS.length > 0 && (
          <select
            className="phn-select"
            value=""
            onChange={(e) => {
              const idx = parseInt(e.target.value, 10);
              if (!Number.isNaN(idx) && BUNDLED_PACKS[idx]) {
                onLoadBundledPack(BUNDLED_PACKS[idx]);
              }
              e.target.value = "";
            }}
            title="Load a bundled prompt pack — see prompt-packs/README.md for catalog"
          >
            <option value="">📚 packs…</option>
            {BUNDLED_PACKS.map((p, i) => (
              <option key={p.filename} value={i}>
                {p.data?.name || p.filename}
              </option>
            ))}
          </select>
        )}
        <button
          className="phn-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Load a .deck.json prompt pack from disk (or drag-drop onto window)"
        >
          📁 from file
        </button>
        <button
          className="phn-btn"
          onClick={() => setUrlOpen(true)}
          title="Load a .deck.json prompt pack from a URL (gist / GitHub raw / any HTTPS source)"
        >
          🔗 from URL
        </button>
        <button
          className="phn-btn"
          onClick={onExportPack}
          title="Export current panel layout as a .deck.json prompt pack"
        >
          💾 export
        </button>
        <button
          className="phn-btn"
          onClick={() => setMcpOpen(true)}
          title="Curated MCP servers — copy or one-click install"
        >
          🔌 MCPs
        </button>
        <button
          className="phn-btn"
          onClick={() => setSetupOpen(true)}
          title="Setup check: Node.js + Claude CLI + API key + live API test"
        >
          🚀 setup
        </button>
        <button
          className="phn-btn phn-muted"
          onClick={() => setSettingsOpen(true)}
          title="Settings: API key + header skin + factory reset"
        >
          ⚙️
        </button>

        <button
          className="phn-btn"
          onClick={addPanel}
          disabled={!canAddPanel}
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
              xtermTheme={xtermTheme}
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

      <SettingsModal
        open={settingsOpen}
        st={st}
        save={save}
        onClose={() => setSettingsOpen(false)}
      />

      <McpInstaller
        open={mcpOpen}
        onClose={() => setMcpOpen(false)}
      />

      <SetupChecker
        open={setupOpen}
        st={st}
        onClose={() => setSetupOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <PackUrlModal
        open={urlOpen}
        onClose={() => setUrlOpen(false)}
        onLoadPack={(pack) => applyPack(pack)}
      />

      {!st?.terminalsOnboarded && (
        <OnboardingOverlay
          onDismiss={() => save({ ...st, terminalsOnboarded: true })}
        />
      )}

      {/* Status bar — bottom strip with version, claude availability, cost. Skin-controlled. */}
      <div
        className="phn-statusbar"
        style={{
          flexShrink: 0,
          padding: "5px 12px",
          fontSize: 10,
          fontFamily: M,
          display: "flex",
          alignItems: "center",
          gap: 14,
          letterSpacing: 0.3,
        }}
      >
        <span>v0.1.13</span>
        <span className="phn-statusbar-divider">·</span>
        <button
          onClick={() => setSetupOpen(true)}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            margin: 0,
            cursor: "pointer",
            color:
              claudeAvailable === true ? "#34D399"
              : claudeAvailable === false ? "#FF0080"
              : "inherit",
            fontFamily: M,
            fontSize: 10,
          }}
          title={
            claudeAvailable === true ? "Claude Code CLI is on PATH"
            : claudeAvailable === false ? "Claude Code CLI not found — click for setup"
            : "Checking…"
          }
        >
          {claudeAvailable === true ? "claude ✓" : claudeAvailable === false ? "claude ✗ — setup" : "claude …"}
        </button>
        <span className="phn-statusbar-divider">·</span>
        <span>terminal bg: {pureBlackTerminal ? "pure black" : "skin"}</span>
        {(totalCost.cost > 0 || totalCost.tokens > 0) && (
          <>
            <span className="phn-statusbar-divider">·</span>
            <span style={{ color: "#34D399" }} title="Aggregate live spend across all sessions">
              ${totalCost.cost.toFixed(2)}
              {totalCost.tokens > 0 && ` · ${totalCost.tokens >= 1000 ? `${(totalCost.tokens / 1000).toFixed(1)}k` : totalCost.tokens} tokens`}
            </span>
          </>
        )}
        <div style={{ flex: 1 }} />
        <a
          href="https://github.com/plutothedev/plutos-terminals"
          target="_blank"
          rel="noreferrer"
          className="phn-statusbar-link"
          title="Open repo on GitHub"
        >
          github
        </a>
        <span className="phn-statusbar-divider">·</span>
        <a
          href="https://discord.gg/3cZQVgKF"
          target="_blank"
          rel="noreferrer"
          style={{ color: "#FF0080", textDecoration: "none" }}
          title="Join the Pluto Discord"
        >
          discord
        </a>
      </div>
      </div>
    </div>
  );
}
