import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TerminalPanel from "./TerminalPanel";
import ProjectSidebar from "./ProjectSidebar";
import SnippetsDrawer from "./SnippetsDrawer";
import ProjectDialog from "./ProjectDialog";
import SshPasswordModal from "./SshPasswordModal";
import SftpBrowser from "./SftpBrowser";
import TunnelsModal from "./TunnelsModal";
import SerialModal from "./SerialModal";
import MobaRibbon from "./MobaRibbon";
import MobaMenuBar from "./MobaMenuBar";
import LocalFileBrowser from "./LocalFileBrowser";
import OnboardingOverlay from "./OnboardingOverlay";
import SettingsModal from "../../components/SettingsModal.jsx";
import McpInstaller from "../../components/McpInstaller.jsx";
import SetupChecker from "../../components/SetupChecker.jsx";
import CommandPalette from "../../components/CommandPalette.jsx";
import { useToast } from "../../components/Toast.jsx";
import { useConfirm } from "../../components/ConfirmModal.jsx";

import { gridDims, MAX_PANELS } from "./grid";
import { getLayout, leafIds, leaves, splitLeaf, removeLeaf, setRatio } from "./splitTree";
import {
  getSkinId,
  getSkinXtermTheme,
  injectHeaderSkinsCss,
  applyGlobalSkin,
} from "./headerSkins";
import * as recording from "./recording.js";
import { writeToTab, writeBroadcast, getTabDims, onDimsChange, setBroadcast, setTabPassword, getTabPassword } from "./ptyBridge.js";
import { DEFAULT_SNIPPETS } from "./SnippetsDrawer.jsx";

const M = "'JetBrains Mono', Menlo, Monaco, monospace";

// Keychain account key for an SSH connection's saved password (vault.rs keys
// under a fixed service; this is the per-host/user account).
function sshAccount(conn) {
  return `${conn.user}@${conn.host}:${conn.port || 22}`;
}

// Green / amber / red for a 0..100 load gauge (CPU, disk) in the status bar.
function loadColor(pct) {
  if (pct >= 85) return "#ef4444";
  if (pct >= 60) return "#f59e0b";
  return "#10b981";
}

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

export default function TerminalsTab({ st, save, userSt = {}, saveUser = () => {} }) {
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
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // v4.0 MobaXterm layout: a vertical ribbon toggles which panel is docked on
  // the left — "sessions" (project/session list), "snippets" (tools), or "sftp"
  // (remote files). null = dock collapsed. Defaults to the sessions list.
  const [ribbon, setRibbon] = useState("sessions");

  // Persisted user snippets. Seeded from the built-in starter set on first use
  // so the drawer is never empty; edits/additions/deletes persist in app state.
  const snippets = Array.isArray(st?.snippets) ? st.snippets : DEFAULT_SNIPPETS;
  const setSnippets = useCallback((next) => {
    save({ ...st, snippets: next });
  }, [st, save]);

  // MultiExec broadcast (MobaXterm-style). Transient per-window mode: when on,
  // a keystroke or snippet goes to every visible terminal at once. Not
  // persisted — auto-typing into every pane after a restart would surprise.
  const [broadcast, setBroadcastState] = useState(false);
  const toggleBroadcast = useCallback(() => {
    setBroadcastState((on) => {
      const next = !on;
      setBroadcast(next);
      return next;
    });
  }, []);

  // Re-render the status bar when the active terminal's dimensions change.
  const [, bumpDims] = useState(0);
  useEffect(() => onDimsChange(() => bumpDims((v) => v + 1)), []);

  // Recording state — subscribe to recording-module changes so the status
  // bar indicator + command palette labels update when start/stop fires.
  // Also tracks cap-hit (v0.1.22) — long recordings auto-stop appending
  // events at MAX_EVENTS to bound memory growth.
  const [recordingTabIds, setRecordingTabIds] = useState(() => recording.activeTabIds());
  const [recordingCapHit, setRecordingCapHit] = useState(() => recording.anyCapped());
  useEffect(() => {
    const unsubscribe = recording.onChange(() => {
      setRecordingTabIds(recording.activeTabIds());
      setRecordingCapHit(recording.anyCapped());
    });
    return unsubscribe;
  }, []);


  // Inject header-skin CSS once. Idempotent inside injectHeaderSkinsCss.
  useEffect(() => {
    injectHeaderSkinsCss();
  }, []);

  // Session-restore confirmation toast — fires once per app launch (not per
  // React remount) when there's a non-trivial saved state to restore.
  // localStorage already persists everything; PTYs respawn from cwd +
  // startCommands; scrollback replays from disk via TerminalPane mount.
  // This toast just surfaces what already happens silently. v0.1.17.
  const restoreToastFiredRef = useRef(false);
  useEffect(() => {
    if (restoreToastFiredRef.current) return;
    restoreToastFiredRef.current = true;
    const panels = state.panels || [];
    const tabCount = panels.reduce((n, p) => n + (p.tabs?.length || 0), 0);
    const panelCount = panels.length;
    // Don't toast on first-ever launch (single default empty panel).
    const isDefaultLayout = panelCount === 1 && tabCount === 1 && (!panels[0]?.tabs?.[0]?.startCommands || panels[0].tabs[0].startCommands.length === 0);
    if (!isDefaultLayout) {
      toast.info(`Session restored — ${panelCount} panel${panelCount === 1 ? "" : "s"} · ${tabCount} tab${tabCount === 1 ? "" : "s"}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const headerSkinId = getSkinId(st?.headerSkin);

  // Apply skin globally on <html> so portaled/sibling elements (toasts,
  // modals via Provider tree) inherit skin CSS vars.
  useEffect(() => {
    applyGlobalSkin(headerSkinId);
  }, [headerSkinId]);

  // Keyboard shortcuts (v0.1.16). Window-level capture so they fire even
  // when xterm has focus. Uses Ctrl+Shift+ for tab/window ops to avoid
  // colliding with shell readline bindings (Ctrl+W = kill word, Ctrl+T =
  // transpose, etc.). Ctrl+P opens pack search; Ctrl+K opens command
  // palette; Ctrl+1..8 switches active panel.
  const shortcutsRef = useRef({});
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      const shift = e.shiftKey;

      const fns = shortcutsRef.current;
      let handled = false;

      if (shift && key === "t") {
        // Ctrl+Shift+T → new tab in active panel
        fns.addTab?.();
        handled = true;
      } else if (shift && key === "w") {
        // Ctrl+Shift+W → close active tab in active panel
        fns.closeActiveTab?.();
        handled = true;
      } else if (key === "k" && !shift) {
        // Ctrl+K → command palette
        fns.openCommandPalette?.();
        handled = true;
      } else if (key === "," && !shift) {
        // Ctrl+, → settings
        fns.openSettings?.();
        handled = true;
      } else if (/^[1-8]$/.test(e.key) && !shift) {
        // Ctrl+1..8 → switch active panel by index
        const idx = parseInt(e.key, 10) - 1;
        fns.switchPanel?.(idx);
        handled = true;
      }

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true); // capture phase
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const pureBlackTerminal = !!st?.pureBlackTerminal;
  const xtermTheme = useMemo(
    () => getSkinXtermTheme(headerSkinId, { pureBlackTerminal }),
    [headerSkinId, pureBlackTerminal]
  );

  // Shell name (basename of the shell new tabs spawn) — fetched once, shown in
  // the status bar so users can see which shell they're in.
  const [shellName, setShellName] = useState(null);
  useEffect(() => {
    let cancelled = false;
    invoke("default_shell")
      .then((s) => { if (!cancelled && typeof s === "string") setShellName(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Live system stats (CPU / memory / disk) for the MobaXterm status bar.
  // Polled every ~2.5s; CPU is a real delta because the backend keeps a
  // persistent System handle.
  const [sysStats, setSysStats] = useState(null);
  useEffect(() => {
    let alive = true;
    const poll = () => invoke("system_stats").then((s) => { if (alive) setSysStats(s); }).catch(() => {});
    poll();
    const t = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(t); };
  }, []);

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

  // ── In-tab split panes (v3.0) ──────────────────────────────────────
  // A tab's content is a binary split tree (splitTree.js). Mutations find the
  // owning panel by tab id so TerminalPanel can call them with just (tabId, …).

  const panelIdForTab = useCallback((tabId) => {
    const p = state.panels.find((pp) => pp.tabs.some((t) => t.id === tabId));
    return p?.id || null;
  }, [state]);

  // Split the pane `paneId` inside `tabId` along `dir` ('row' = side by side,
  // 'col' = stacked). The new pane inherits the split pane's cwd as a fresh
  // shell; the existing pane keeps its live PTY (flat render = no remount).
  const splitPane = useCallback((tabId, paneId, dir) => {
    const panelId = panelIdForTab(tabId);
    if (!panelId) return;
    const newLeafId = freshId("pane");
    const splitId = freshId("split");
    const panels = state.panels.map((p) => {
      if (p.id !== panelId) return p;
      return {
        ...p,
        tabs: p.tabs.map((t) => {
          if (t.id !== tabId) return t;
          const layout = getLayout(t);
          const inheritCwd = leaves(layout).find((l) => l.id === paneId)?.cwd ?? (t.cwd || null);
          const nextLayout = splitLeaf(layout, paneId, dir, { id: newLeafId, cwd: inheritCwd }, splitId);
          return { ...t, layout: nextLayout, activePaneId: newLeafId };
        }),
      };
    });
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist, panelIdForTab]);

  // Close one pane. Closing the last pane of a tab closes the tab.
  const closePane = useCallback((tabId, paneId) => {
    const panelId = panelIdForTab(tabId);
    if (!panelId) return;
    const tab = state.panels.find((p) => p.id === panelId)?.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const layout = getLayout(tab);
    if (leafIds(layout).length <= 1) {
      closeTab(panelId, tabId);
      return;
    }
    const next = removeLeaf(layout, paneId);
    const remaining = leafIds(next);
    let activePaneId = tab.activePaneId || tab.id;
    if (!remaining.includes(activePaneId)) activePaneId = remaining[0];
    const panels = state.panels.map((p) => {
      if (p.id !== panelId) return p;
      return {
        ...p,
        tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, layout: next, activePaneId } : t)),
      };
    });
    persist({ ...state, panels });
  }, [state, persist, panelIdForTab, closeTab]);

  const activatePane = useCallback((tabId, paneId) => {
    const panelId = panelIdForTab(tabId);
    if (!panelId) return;
    const panels = state.panels.map((p) => {
      if (p.id !== panelId) return p;
      return {
        ...p,
        tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t)),
      };
    });
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist, panelIdForTab]);

  const setPaneRatio = useCallback((tabId, splitId, ratio) => {
    const panelId = panelIdForTab(tabId);
    if (!panelId) return;
    const panels = state.panels.map((p) => {
      if (p.id !== panelId) return p;
      return {
        ...p,
        tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, layout: setRatio(getLayout(t), splitId, ratio) } : t)),
      };
    });
    persist({ ...state, panels });
  }, [state, persist, panelIdForTab]);

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
  // Append a tab to a panel and make it active. Shared by the local and SSH
  // paths. `extra` carries SSH-only fields (connection); the password (if any)
  // is recorded transiently in the bridge by the caller, never on the tab.
  const spawnSessionTab = useCallback((panelId, tab) => {
    const panels = state.panels.map(p =>
      p.id === panelId
        ? { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id }
        : p
    );
    persist({ ...state, panels, activePanelId: panelId });
  }, [state, persist]);

  const openProjectInPanel = useCallback((panelId, projectId, overrideCommands) => {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;

    // SSH session: connect through the ssh2 transport. Password auth prompts
    // for the secret first (held in-memory only); key/agent connect directly.
    const isSsh = project.type === "ssh" || (project.connection && !project.path);
    if (isSsh) {
      if (!project.connection?.host || !project.connection?.user) {
        toast.error(`"${project.name}" is missing a host or user.`);
        return;
      }
      const tabId = freshId("tab");
      const tab = {
        id: tabId,
        label: project.name,
        cwd: null,
        startCommands: project.startCommands || [],
        projectId: project.id,
        connection: project.connection, // { host, port, user, auth } — no secret
      };
      const method = project.connection?.auth?.method || "password";
      if (method === "password") {
        // Try the keychain first; only prompt if there's no saved password.
        (async () => {
          let saved = null;
          try {
            saved = await invoke("secret_get", { account: sshAccount(project.connection) });
          } catch { /* keychain unavailable — fall through to prompt */ }
          if (saved) {
            setTabPassword(tabId, saved);
            spawnSessionTab(panelId, tab);
          } else {
            setSshPrompt({ panelId, tab, project });
          }
        })();
        return;
      }
      spawnSessionTab(panelId, tab); // key / agent need no transient secret
      return;
    }

    const cmds = overrideCommands || project.startCommands || [];
    const labelSuffix = overrideCommands && overrideCommands.length === 1
      ? ` · ${overrideCommands[0]}`
      : "";
    spawnSessionTab(panelId, {
      id: freshId("tab"),
      label: `${project.name}${labelSuffix}`,
      cwd: project.path,
      startCommands: cmds,
      projectId: project.id,
    });
  }, [projects, toast, spawnSessionTab]);

  // SSH password prompt: { panelId, tab, project } or null. On submit, stash the
  // password transiently in the bridge (keyed by the pending tab id) and create
  // the tab — TerminalPane reads the password at ssh_spawn time.
  const [sshPrompt, setSshPrompt] = useState(null);
  const submitSshPassword = useCallback((password, remember) => {
    if (!sshPrompt) return;
    setTabPassword(sshPrompt.tab.id, password);
    if (remember) {
      invoke("secret_set", { account: sshAccount(sshPrompt.project.connection), secret: password })
        .then(() => toast.info("Password saved to keychain."))
        .catch((e) => toast.error(`Couldn't save to keychain: ${e}`));
    }
    spawnSessionTab(sshPrompt.panelId, sshPrompt.tab);
    setSshPrompt(null);
  }, [sshPrompt, spawnSessionTab, toast]);

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

  // Recording: start / stop+save handlers for the active tab.
  const activePanel = state.panels.find((p) => p.id === state.activePanelId);
  const activeTabId = activePanel?.activeTabId;
  const activeTab = activePanel?.tabs.find((t) => t.id === activeTabId);
  const activeTabRecording = activeTabId ? recordingTabIds.includes(activeTabId) : false;

  // Snippet insert: type the command into the active tab's shell (no trailing
  // newline — the user reviews it and presses Enter). Bridges via ptyBridge so
  // we don't have to thread the PTY id down through TerminalPanel.
  const insertSnippet = useCallback((command) => {
    if (!activeTabId) {
      toast.error("No active terminal to insert into.");
      return;
    }
    // In broadcast mode the snippet lands in every visible terminal; otherwise
    // just the focused one.
    if (broadcast) {
      const n = writeBroadcast(command);
      if (n === 0) {
        toast.error("No visible terminal is ready yet — try again in a moment.");
        return;
      }
      toast.info(`Broadcast to ${n} terminal${n === 1 ? "" : "s"}: ${command.length > 32 ? command.slice(0, 32) + "…" : command}`);
      return;
    }
    const ok = writeToTab(activeTabId, command);
    if (!ok) {
      toast.error("Active terminal isn't ready yet — try again in a moment.");
      return;
    }
    toast.info(`Inserted: ${command.length > 40 ? command.slice(0, 40) + "…" : command}`);
  }, [activeTabId, broadcast, toast]);

  // Active terminal size for the status bar (cols × rows), reported by
  // TerminalPane via the bridge. bumpDims above forces re-read on change.
  const activeDims = activeTabId ? getTabDims(activeTabId) : null;

  // ── SFTP remote file browser (Phase 3) ─────────────────────────────────
  // Opens for the active SSH tab. Connects a dedicated SFTP session (separate
  // from the shell, which owns its own connection), reusing the tab's
  // connection + transient password.
  const [sftp, setSftp] = useState(null); // { connecting, id, error } | null
  const openSftp = useCallback(async () => {
    const conn = activeTab?.connection;
    if (!conn?.host || !conn?.user) {
      toast.info("Open an SSH session first — the file browser shows its remote files.");
      return;
    }
    const method = conn.auth?.method || "password";
    let password = null;
    if (method === "password") {
      password = getTabPassword(activeTabId);
      if (!password) {
        // Fall back to the keychain (e.g. the shell tab connected from a saved
        // password, or after a restart).
        try { password = await invoke("secret_get", { account: sshAccount(conn) }); } catch { /* ignore */ }
        if (password) setTabPassword(activeTabId, password);
      }
      if (!password) {
        setSftp({ connecting: false, id: null, error: "No saved password for this session — reopen the SSH tab, then open files." });
        return;
      }
    }
    setSftp({ connecting: true, id: null, error: null });
    try {
      const id = await invoke("sftp_connect", {
        host: conn.host,
        port: conn.port || 22,
        user: conn.user,
        auth: { ...conn.auth, password },
      });
      setSftp({ connecting: false, id, error: null });
    } catch (e) {
      setSftp({ connecting: false, id: null, error: String(e) });
    }
  }, [activeTab, activeTabId, toast]);

  const closeSftp = useCallback(() => {
    setSftp((s) => {
      if (s?.id) invoke("sftp_disconnect", { id: s.id }).catch(() => {});
      return null;
    });
  }, []);

  // Ribbon selection: switch the docked panel. The "files" panel shows the
  // local filesystem by default; for an SSH tab it connects remote SFTP.
  // Leaving "files" disconnects any SFTP session so we don't leak it. Clicking
  // the active tab again (id === null) collapses the dock.
  const selectRibbon = useCallback((id) => {
    setRibbon(id);
    if (id === "files") {
      if (activeTab?.connection) openSftp(); // remote SFTP for SSH tabs
    } else if (sftp) {
      closeSftp();
    }
  }, [activeTab, openSftp, sftp, closeSftp]);

  // Write raw data into the active terminal (or all visible, in broadcast mode).
  // Used by the file browser ("cd here", insert path) and snippets.
  const sendToActiveTerminal = useCallback((data) => {
    if (!activeTabId) { toast.error("No active terminal."); return; }
    if (broadcast) writeBroadcast(data);
    else writeToTab(activeTabId, data);
  }, [activeTabId, broadcast, toast]);

  // ── SSH port forwarding (tunnels) ───────────────────────────────────────
  const [tunnelsOpen, setTunnelsOpen] = useState(false);
  const [forwards, setForwards] = useState([]); // { id, localPort, remoteHost, remotePort } (transient)
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelError, setTunnelError] = useState(null);

  const openTunnels = useCallback(() => {
    const conn = activeTab?.connection;
    if (!conn?.host || !conn?.user) {
      toast.info("Open an SSH session first — tunnels forward ports through it.");
      return;
    }
    setTunnelError(null);
    setTunnelsOpen(true);
  }, [activeTab, toast]);

  const startForward = useCallback(async ({ localPort, remoteHost, remotePort }) => {
    const conn = activeTab?.connection;
    if (!conn) return;
    setTunnelBusy(true);
    setTunnelError(null);
    try {
      const method = conn.auth?.method || "password";
      let password = null;
      if (method === "password") {
        password = getTabPassword(activeTabId);
        if (!password) { try { password = await invoke("secret_get", { account: sshAccount(conn) }); } catch { /* ignore */ } }
        if (!password) {
          setTunnelError("No password for this session — reopen the SSH tab first.");
          return;
        }
      }
      const id = await invoke("port_forward_start", {
        host: conn.host,
        port: conn.port || 22,
        user: conn.user,
        auth: { ...conn.auth, password },
        localPort,
        remoteHost,
        remotePort,
      });
      setForwards((f) => [...f, { id, localPort, remoteHost, remotePort }]);
      toast.success(`Forwarding 127.0.0.1:${localPort} → ${remoteHost}:${remotePort}`);
    } catch (e) {
      setTunnelError(String(e));
    } finally {
      setTunnelBusy(false);
    }
  }, [activeTab, activeTabId, toast]);

  const stopForward = useCallback(async (id) => {
    try { await invoke("port_forward_stop", { id }); } catch { /* ignore */ }
    setForwards((f) => f.filter((x) => x.id !== id));
  }, []);

  // ── Serial console ──────────────────────────────────────────────────────
  const [serialOpen, setSerialOpen] = useState(false);
  const connectSerial = useCallback(({ path, baud }) => {
    const short = path.split("/").pop() || path;
    spawnSessionTab(state.activePanelId, {
      id: freshId("tab"),
      label: `Serial: ${short}`,
      cwd: null,
      startCommands: [],
      projectId: null,
      serial: { path, baud },
    });
    setSerialOpen(false);
  }, [state.activePanelId, spawnSessionTab]);

  const startRecordingActive = useCallback(() => {
    if (!activeTabId) return;
    if (recording.isRecording(activeTabId)) {
      toast.info("This tab is already being recorded.");
      return;
    }
    recording.startRecording(activeTabId, {
      width: 80,
      height: 24,
      label: activeTab?.label || "tab",
    });
    toast.success(`🎬 Recording "${activeTab?.label || "tab"}" — pick "Stop & save" when done.`);
  }, [activeTabId, activeTab, toast]);

  const stopAndSaveRecording = useCallback(async () => {
    if (!activeTabId) return;
    if (!recording.isRecording(activeTabId)) {
      toast.error("This tab isn't being recorded.");
      return;
    }
    const cast = recording.stopRecording(activeTabId);
    if (!cast) {
      toast.error("Recording was empty — nothing to save.");
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeLabel = (activeTab?.label || "session").replace(/[^a-zA-Z0-9_-]+/g, "_");
    const suggested = `plutos-terminals_${safeLabel}_${stamp}.cast`;
    try {
      const path = await invoke("save_text_to_file", {
        suggestedName: suggested,
        extension: "cast",
        extensionLabel: "Asciinema cast file (.cast)",
        contents: cast,
      });
      if (path) {
        toast.success(`Saved recording to ${path}`);
      } else {
        toast.info("Recording discarded (save canceled).");
      }
    } catch (err) {
      toast.error(`Save failed: ${err}`);
    }
  }, [activeTabId, activeTab, toast]);

  // Wire keyboard-shortcut callbacks. Updates per-render so closures see the
  // latest state (no stale captures).
  shortcutsRef.current = {
    addTab: () => addTab(state.activePanelId),
    closeActiveTab: () => {
      const panel = state.panels.find((p) => p.id === state.activePanelId);
      if (panel && panel.tabs.length > 1 && panel.activeTabId) {
        closeTab(panel.id, panel.activeTabId);
      }
    },
    openCommandPalette: () => setCommandPaletteOpen(true),
    openSettings: () => setSettingsOpen(true),
    switchPanel: (idx) => {
      if (state.panels[idx]) setActivePanel(state.panels[idx].id);
    },
  };

  return (
    <div className="phn-page" data-phn-skin={headerSkinId} style={{ height: "100%", position: "relative" }}>
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* MobaXterm menu bar — classic dropdown menus wired to existing actions. */}
      <MobaMenuBar
        menus={[
          {
            label: "Terminal",
            items: [
              { label: "New tab", shortcut: "Ctrl+Shift+T", action: () => addTab(state.activePanelId) },
              { label: "New panel", disabled: !canAddPanel, action: () => addPanel() },
              { divider: true },
              { label: "Split right", action: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "row") },
              { label: "Split down", action: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "col") },
              { divider: true },
              { label: "Close tab", shortcut: "Ctrl+Shift+W", action: () => { const p = state.panels.find((x) => x.id === state.activePanelId); if (p && p.tabs.length > 1 && p.activeTabId) closeTab(p.id, p.activeTabId); } },
              { label: "New window", action: async () => { try { const id = `${Date.now().toString(36)}`.slice(-6); await invoke("spawn_new_window", { windowId: id }); } catch (e) { toast.error(`New window failed: ${e}`); } } },
            ],
          },
          {
            label: "Sessions",
            items: [
              { label: "New session…", action: () => setDialog({ mode: "add" }) },
              { divider: true },
              { label: "Sessions panel", action: () => selectRibbon("sessions") },
              { label: "File browser", action: () => selectRibbon("files") },
              { label: "Port forwarding…", disabled: !activeTab?.connection, action: () => openTunnels() },
              { label: "Serial console…", action: () => setSerialOpen(true) },
            ],
          },
          {
            label: "Tools",
            items: [
              { label: "Snippets / Tools panel", action: () => selectRibbon("snippets") },
              { label: broadcast ? "Turn off broadcast (MultiExec)" : "Broadcast (MultiExec)", action: () => toggleBroadcast() },
              { divider: true },
              { label: "MCP servers…", action: () => setMcpOpen(true) },
              { label: "Setup checker…", action: () => setSetupOpen(true) },
              { label: "Command palette", shortcut: "Ctrl+K", action: () => setCommandPaletteOpen(true) },
            ],
          },
          {
            label: "View",
            items: [
              { label: ribbon ? "Hide left panel" : "Show sessions panel", action: () => selectRibbon(ribbon ? null : "sessions") },
              { divider: true },
              { label: "Skins & appearance…", action: () => setSettingsOpen(true) },
            ],
          },
          {
            label: "Settings",
            items: [
              { label: "Settings…", shortcut: "Ctrl+,", action: () => setSettingsOpen(true) },
            ],
          },
          {
            label: "Help",
            items: [
              { label: "GitHub repository", action: () => window.open("https://github.com/plutothedev/plutos-terminals", "_blank") },
              { label: "Pluto Discord", action: () => window.open("https://discord.gg/3cZQVgKF", "_blank") },
            ],
          },
        ]}
      />
      {/* Header — visual treatment driven by user-selected skin (headerSkins.js).
          Layout-only inline styles here; colors/borders/effects come from CSS. */}
      <div className="phn-header" style={{ gap: 5 }}>
        <span className="phn-title" style={{ marginRight: 2 }}>⬢ Pluto</span>
        <span className="phn-toolbar-divider" />

        {/* Primary actions (MobaXterm-style icon toolbar) */}
        <button className="phn-btn" onClick={() => setDialog({ mode: "add" })} title="New session (local folder or SSH host)">🌐 session</button>
        <button className="phn-btn" onClick={() => addTab(state.activePanelId)} title="New tab (Ctrl+Shift+T)">＋ tab</button>
        <button className="phn-btn" onClick={addPanel} disabled={!canAddPanel} title={canAddPanel ? "Add panel" : `Max ${MAX_PANELS} panels`}>▦ pane</button>
        <button className="phn-btn" onClick={() => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "row")} title="Split pane right">⬌</button>
        <button className="phn-btn" onClick={() => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "col")} title="Split pane down">⬍</button>
        <span className="phn-toolbar-divider" />

        <button
          className={ribbon === "snippets" ? "phn-btn phn-btn-on" : "phn-btn"}
          onClick={() => selectRibbon(ribbon === "snippets" ? null : "snippets")}
          title="Tools — saved command snippets, click to insert into the active terminal"
        >
          📋 snippets
        </button>
        <button
          className={ribbon === "files" ? "phn-btn phn-btn-on" : "phn-btn"}
          onClick={() => selectRibbon(ribbon === "files" ? null : "files")}
          title={activeTab?.connection ? "Remote files (SFTP) for the active SSH session" : "Local file browser"}
        >
          📁 files
        </button>
        <button
          className={tunnelsOpen ? "phn-btn phn-btn-on" : "phn-btn"}
          onClick={() => (tunnelsOpen ? setTunnelsOpen(false) : openTunnels())}
          disabled={!tunnelsOpen && !activeTab?.connection}
          title={activeTab?.connection ? "SSH port forwarding (tunnels) for the active SSH session" : "Open an SSH session to forward ports"}
        >
          ⇄ tunnels{forwards.length > 0 ? ` (${forwards.length})` : ""}
        </button>
        <button
          className={serialOpen ? "phn-btn phn-btn-on" : "phn-btn"}
          onClick={() => setSerialOpen((v) => !v)}
          title="Open a serial console (USB/UART device)"
        >
          ⎓ serial
        </button>
        <button
          className={broadcast ? "phn-btn phn-btn-on" : "phn-btn"}
          onClick={toggleBroadcast}
          title="Broadcast (MultiExec) — type once, send to every visible terminal at once"
        >
          📡 broadcast
        </button>

        <div style={{ flex: 1 }} />

        {(totalCost.cost > 0 || totalCost.tokens > 0) && (
          <>
            <span className="phn-cost" title="Live aggregate from Claude /cost output across all sessions">
              ${totalCost.cost.toFixed(2)}
              {totalCost.tokens > 0 && ` · ${totalCost.tokens >= 1000 ? `${(totalCost.tokens / 1000).toFixed(1)}k` : totalCost.tokens} tok`}
            </span>
            <span className="phn-toolbar-divider" />
          </>
        )}

        <button className="phn-btn" onClick={() => setCommandPaletteOpen(true)} title="Command palette (Ctrl+K)">⌘ palette</button>
        <button className="phn-btn" onClick={() => setMcpOpen(true)} title="Curated MCP servers — copy or one-click install">🔌 MCPs</button>
        <button className="phn-btn" onClick={() => setSetupOpen(true)} title="Setup check: Node.js + Claude CLI + API key + live API test">🚀 setup</button>
        <button className="phn-btn phn-muted" onClick={() => setSettingsOpen(true)} title="Settings: API key + skin + factory reset">⚙️</button>
      </div>

      {/* Body: MobaXterm vertical ribbon + docked left panel + terminal grid.
          The ribbon toggles which panel is docked (Sessions / Tools / Sftp). */}
      <div className="moba-body" style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0, position: "relative", overflow: "hidden" }}>
        <MobaRibbon active={ribbon} onSelect={selectRibbon} />
        {ribbon && (
          <div className="moba-dock">
            {ribbon === "sessions" && (
              <ProjectSidebar
                docked
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
                onForgetPassword={(project) => {
                  if (!project?.connection) return;
                  invoke("secret_delete", { account: sshAccount(project.connection) })
                    .then(() => toast.info(`Forgot saved password for ${project.name}.`))
                    .catch((e) => toast.error(`Couldn't clear keychain: ${e}`));
                }}
              />
            )}
            {ribbon === "snippets" && (
              <SnippetsDrawer
                docked
                onInsert={insertSnippet}
                snippets={snippets}
                onSnippetsChange={setSnippets}
              />
            )}
            {ribbon === "files" && (
              activeTab?.connection ? (
                <SftpBrowser
                  docked
                  connecting={sftp?.connecting}
                  error={sftp?.error}
                  sessionId={sftp?.id}
                  onClose={() => selectRibbon("sessions")}
                />
              ) : (
                <LocalFileBrowser onSendToTerminal={sendToActiveTerminal} />
              )
            )}
          </div>
        )}

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
              onSplitPane={splitPane}
              onClosePane={closePane}
              onActivatePane={activatePane}
              onSetPaneRatio={setPaneRatio}
            />
          ))}
        </div>
      </div>

      <TunnelsModal
        open={tunnelsOpen}
        host={activeTab?.connection?.host}
        user={activeTab?.connection?.user}
        forwards={forwards}
        busy={tunnelBusy}
        error={tunnelError}
        onStart={startForward}
        onStop={stopForward}
        onClose={() => setTunnelsOpen(false)}
      />

      <SerialModal
        open={serialOpen}
        onConnect={connectSerial}
        onClose={() => setSerialOpen(false)}
      />

      <ProjectDialog
        open={!!dialog}
        initial={dialogInitial}
        onClose={() => setDialog(null)}
        onSave={handleSaveDialog}
      />

      <SshPasswordModal
        open={!!sshPrompt}
        host={sshPrompt?.project?.connection?.host}
        user={sshPrompt?.project?.connection?.user}
        onSubmit={submitSshPassword}
        onCancel={() => setSshPrompt(null)}
      />

      <SettingsModal
        open={settingsOpen}
        st={st}
        save={save}
        userSt={userSt}
        saveUser={saveUser}
        onClose={() => setSettingsOpen(false)}
      />

      <McpInstaller
        open={mcpOpen}
        onClose={() => setMcpOpen(false)}
      />

      <SetupChecker
        open={setupOpen}
        st={st}
        userSt={userSt}
        onClose={() => setSetupOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <CommandPalette
        open={commandPaletteOpen}
        commands={[
          { id: "new-tab", icon: "+", label: "New tab in active panel", shortcut: "Ctrl+Shift+T", action: () => addTab(state.activePanelId) },
          { id: "new-session", icon: "🌐", label: "New session", hint: "Save a local folder or an SSH host to the sidebar", action: () => setDialog({ mode: "add" }) },
          { id: "split-right", icon: "⬌", label: "Split active pane right", hint: "Side-by-side terminals in the current tab", action: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "row") },
          { id: "split-down", icon: "⬍", label: "Split active pane down", hint: "Stacked terminals in the current tab", action: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "col") },
          { id: "add-panel", icon: "+", label: "Add panel", hint: canAddPanel ? "" : `Max ${MAX_PANELS} panels`, action: () => canAddPanel && addPanel() },
          { id: "snippets", icon: "📋", label: "Tools / snippets panel", hint: "Saved commands — click to insert into the active terminal", action: () => selectRibbon(ribbon === "snippets" ? null : "snippets") },
          { id: "files", icon: "📁", label: "File browser", hint: "Local files (or remote SFTP for an SSH tab) in the left panel", action: () => selectRibbon(ribbon === "files" ? null : "files") },
          { id: "tunnels", icon: "⇄", label: "SSH port forwarding", hint: "Forward a local port through the active SSH session", action: () => (tunnelsOpen ? setTunnelsOpen(false) : openTunnels()) },
          { id: "serial", icon: "⎓", label: "Serial console", hint: "Connect to a USB/UART serial device", action: () => setSerialOpen((v) => !v) },
          { id: "broadcast", icon: "📡", label: broadcast ? "Turn off broadcast (MultiExec)" : "Turn on broadcast (MultiExec)", hint: "Type once, send to every visible terminal at once", action: () => toggleBroadcast() },
          { id: "toggle-sidebar", icon: "◧", label: ribbon ? "Collapse left panel" : "Show sessions panel", hint: "Show or hide the docked left panel", action: () => selectRibbon(ribbon ? null : "sessions") },
          { id: "mcps", icon: "🔌", label: "MCP servers", hint: "Curated catalog with one-click install", action: () => setMcpOpen(true) },
          { id: "setup", icon: "🚀", label: "Setup checker", hint: "Verify Node + Claude CLI + API key + live API test", action: () => setSetupOpen(true) },
          { id: "settings", icon: "⚙️", label: "Open settings", hint: "API key, app skin, header style, density, terminal bg", shortcut: "Ctrl+,", action: () => setSettingsOpen(true) },
          activeTabRecording
            ? {
                id: "stop-recording",
                icon: "⏹",
                label: "Stop & save recording",
                hint: `Save .cast file for the active tab (${activeTab?.label || "tab"})`,
                action: () => stopAndSaveRecording(),
              }
            : {
                id: "start-recording",
                icon: "🎬",
                label: "Start recording active tab",
                hint: `Record terminal output of "${activeTab?.label || "tab"}" as an asciinema .cast file`,
                action: () => startRecordingActive(),
              },
          {
            id: "new-window",
            icon: "🪟",
            label: "Open new window",
            hint: "Spawns a fresh window with its own independent panel layout, skin, and sessions",
            action: async () => {
              try {
                const id = `${Date.now().toString(36)}`.slice(-6);
                const label = await invoke("spawn_new_window", { windowId: id });
                toast.success(`New window opened: ${label}`);
              } catch (err) {
                toast.error(`Failed to open new window: ${err}`);
              }
            },
          },
          {
            id: "reset-workspace",
            icon: "♻️",
            label: "Reset workspace",
            hint: "Clear all panels and tabs (keeps API key, skin, projects)",
            action: async () => {
              const ok = await confirm(
                "Reset workspace? Closes every panel and tab. API key, skin, button style, density, and sessions are kept. The app reloads to a single empty panel.",
                { title: "Reset workspace?", confirmLabel: "reset", destructive: true }
              );
              if (!ok) return;
              const fresh = defaultState();
              persist({ ...state, panels: fresh.panels, activePanelId: fresh.activePanelId });
            },
          },
          ...state.panels.map((p, i) => ({
            id: `panel-${p.id}`,
            icon: i + 1 < 10 ? `${i + 1}` : "•",
            label: `Switch to panel ${i + 1}`,
            hint: `${p.tabs.length} tab${p.tabs.length === 1 ? "" : "s"}${p.id === state.activePanelId ? " · active" : ""}`,
            shortcut: i < 8 ? `Ctrl+${i + 1}` : undefined,
            action: () => setActivePanel(p.id),
          })),
        ]}
        onClose={() => setCommandPaletteOpen(false)}
      />

      {!userSt?.terminalsOnboarded && (
        <OnboardingOverlay
          onDismiss={() => saveUser({ ...userSt, terminalsOnboarded: true })}
        />
      )}

      {/* Status bar — bottom strip with version, claude availability, cost. Skin-controlled. */}
      <div
        className="phn-statusbar"
        style={{
          flexShrink: 0,
          padding: "6px 14px",
          fontSize: 11,
          display: "flex",
          alignItems: "center",
          gap: 14,
          letterSpacing: 0.2,
        }}
      >
        <span>v0.1.26</span>
        {shellName && (
          <>
            <span className="phn-statusbar-divider">·</span>
            <span title="Shell new tabs spawn">{shellName}</span>
          </>
        )}
        {sysStats && (
          <>
            <span className="moba-stat" title="CPU usage">
              <span className="dot" style={{ background: loadColor(sysStats.cpu) }} />
              CPU {Math.round(sysStats.cpu)}%
            </span>
            <span className="moba-stat" title="Memory used / total">
              🧠 {(sysStats.mem_used / 1e9).toFixed(2)} / {(sysStats.mem_total / 1e9).toFixed(2)} GB
            </span>
            <span className="moba-stat" title="Root disk used">
              <span className="dot" style={{ background: loadColor(sysStats.disk_used_pct) }} />
              /: {Math.round(sysStats.disk_used_pct)}%
            </span>
          </>
        )}
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
            fontSize: 11,
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
        <span title="Open panels">{state.panels.length} pane{state.panels.length === 1 ? "" : "s"}</span>
        {broadcast && (
          <>
            <span className="phn-statusbar-divider">·</span>
            <button
              onClick={toggleBroadcast}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                margin: 0,
                cursor: "pointer",
                color: "#FBBF24",
                fontSize: 11,
                fontWeight: 600,
              }}
              title="Broadcast (MultiExec) is on — input goes to every visible terminal. Click to turn off."
            >
              📡 broadcast on
            </button>
          </>
        )}
        {activeTab && (
          <>
            <span className="phn-statusbar-divider">·</span>
            <span title="Active tab">{activeTab.label}</span>
          </>
        )}
        {activeDims && (
          <>
            <span className="phn-statusbar-divider">·</span>
            <span title="Active terminal size (columns × rows)">{activeDims.cols}×{activeDims.rows}</span>
          </>
        )}
        <span className="phn-statusbar-divider">·</span>
        <span>terminal bg: {pureBlackTerminal ? "pure black" : "skin"}</span>
        {recordingTabIds.length > 0 && (
          <>
            <span className="phn-statusbar-divider">·</span>
            <button
              onClick={() => {
                if (activeTabRecording) stopAndSaveRecording();
                else if (recordingTabIds[0]) {
                  // Switch to the recording tab so user can save it.
                  const target = state.panels.find((p) => p.tabs.some((t) => t.id === recordingTabIds[0]));
                  if (target) {
                    setActivePanel(target.id);
                    persist({ ...state, activePanelId: target.id, panels: state.panels.map((p) =>
                      p.id === target.id ? { ...p, activeTabId: recordingTabIds[0] } : p
                    ) });
                  }
                }
              }}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                margin: 0,
                cursor: "pointer",
                color: "#FF0080",
                fontSize: 11,
                fontWeight: 600,
              }}
              title={recordingCapHit
                ? `Recording hit ${recording.RECORDING_MAX_EVENTS / 1000}k events (memory cap). Save now and start a new recording for further capture.`
                : activeTabRecording
                  ? "Click to stop & save the active tab's recording"
                  : "Click to switch to the recording tab"}
            >
              {recordingCapHit ? "⚠ rec capped — save" : `● rec${recordingTabIds.length > 1 ? ` (×${recordingTabIds.length})` : ""}`}
            </button>
          </>
        )}
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
