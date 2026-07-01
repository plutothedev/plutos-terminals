// (C)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, listen } from "@backend";
import { APP_VERSION, GITHUB_URL, DISCORD_URL, openExternal } from "../../appMeta.js";
import TerminalPanel from "./TerminalPanel";
import ProjectSidebar from "./ProjectSidebar";
import SnippetsDrawer from "./SnippetsDrawer";
import ProjectDialog from "./ProjectDialog";
import SshPasswordModal from "./SshPasswordModal";
import SftpBrowser from "./SftpBrowser";
import TunnelsModal from "./TunnelsModal";
import SerialModal from "./SerialModal";
import MobaMenuBar from "./MobaMenuBar";
import AgentDashboard from "./AgentDashboard";
import DiffView from "./DiffView";
import ModelPicker from "./ModelPicker";
import SshKeysModal from "./SshKeysModal";
import MacrosModal from "./MacrosModal";
import MasterPasswordModal from "./MasterPasswordModal";
import MobaToolbar from "./MobaToolbar";
import AskBar from "./AskBar";
import AgentMode from "./AgentMode";
import SessionSummary from "./SessionSummary";
import HistorySearch from "./HistorySearch";
import WorkspacesModal from "./WorkspacesModal";
import BroadcastGroupModal from "./BroadcastGroupModal";
import NetToolsModal from "./NetToolsModal";
import RemoteControlModal from "./RemoteControlModal.jsx";
import { PROVIDERS, findProvider } from "./providers.js";
import {
  IconSession, IconServers, IconTools, IconGames, IconStar, IconView,
  IconSplit, IconMultiExec, IconTunneling, IconPackages, IconSettings,
  IconHelp, IconMoon, IconSun, IconExit, IconModels, IconAsk, IconFolder,
} from "./icons.jsx";
import {
  SLocal, SSsh, SSerial, SSplit, SSplitRow, SSplitCol, SMultiX, STunnel, SAsk, SModels, SSnips, SAgents, SSearch, SPulse,
  SMouse, SWindows, SFolder, SLock, SKey, SRocket, SGear, SBot, SDoc, SClock, SLayout, SBroadcast, STarget, SPlug, SPhone, SRecord, SStop, SReset,
} from "./toolbarIcons.jsx";
import LocalFileBrowser from "./LocalFileBrowser";
import DockAssistant from "./DockAssistant";
import DockMonitor from "./DockMonitor";
import VncConnectModal from "./VncConnectModal";
import RdpConnectModal from "./RdpConnectModal";
import OnboardingOverlay from "./OnboardingOverlay";
import SettingsModal from "../../components/SettingsModal.jsx";
import McpInstaller from "../../components/McpInstaller.jsx";
import SetupChecker from "../../components/SetupChecker.jsx";
import CommandPalette from "../../components/CommandPalette.jsx";
import { useToast } from "../../components/Toast.jsx";
import { useConfirm } from "../../components/ConfirmModal.jsx";

import { KEY_ACTIONS, comboFromEvent, resolveBindings, setResolved, isCapturing, formatCombo } from "./keybindings.js";
import { gridDims, MAX_PANELS } from "./grid";
import { useSystemStats, useShellName, useClaudeAvailable, useRecordingState, useDimsListener, useHeaderSkinSetup } from "./hooks/independentEffects.js";
import { useDockResize } from "./hooks/useDockResize.js";
import { useBroadcastMode } from "./hooks/useBroadcastMode.js";
import { useSnippets } from "./hooks/useSnippets.js";
import { useActiveTab } from "./hooks/useActiveTab.js";
import { useSimpleModals } from "./hooks/useSimpleModals.js";
import { useTunnels } from "./hooks/useTunnels.js";
import { useSessionSpawn } from "./hooks/useSessionSpawn.js";
import { useSftpDock } from "./hooks/useSftpDock.js";
import { useRemoteDesktopLaunch } from "./hooks/useRemoteDesktopLaunch.js";
import { useSshConnect } from "./hooks/useSshConnect.js";
import { useProjects } from "./hooks/useProjects.js";
import { useTabTelemetry } from "./hooks/useTabTelemetry.js";
import { useWorkspaceTree } from "./hooks/useWorkspaceTree.js";
import { useSessionDispatch } from "./hooks/useSessionDispatch.js";
import { useWorkspaces } from "./hooks/useWorkspaces.js";
import { defaultState } from "./workspaceModel.js";
import {
  resolveBaseSkinId,
  getActiveXtermTheme,
  applyActiveTheme,
  findCustomTheme,
  effectiveSkinValue,
} from "./headerSkins";
import { isPrimaryWindow } from "./storageKeys.js";
import { useOsDark } from "./hooks/useOsDark.js";
import * as recording from "./recording.js";
import { writeToTab, writeBroadcast, getTabDims, getTabText, getCommandHistory, getLiveTabIds, getPtyId, onDimsChange } from "./ptyBridge.js";
import { getLayout, leafIds } from "./splitTree.js";
import { sshAccount } from "./sshAccount.js";

export default function TerminalsTab({ st, save, userSt = {}, saveUser = () => {} }) {
  const state = st?.terminalsState || defaultState();
  const projects = state.projects || [];
  const toast = useToast();
  const confirm = useConfirm();

  // Dialog: null = closed; { mode: "add" } or { mode: "edit", projectId }
  const [dialog, setDialog] = useState(null);

  // Pure on/off modal toggles (no payload) — see useSimpleModals. serialOpen /
  // vncOpen / rdpOpen are the ephemeral quick-connect flags; their saved-session
  // launch payloads (vncLaunch / rdpLaunch) stay below.
  const {
    settingsOpen, setSettingsOpen, mcpOpen, setMcpOpen, modelsOpen, setModelsOpen,
    sshKeysOpen, setSshKeysOpen, macrosOpen, setMacrosOpen, askOpen, setAskOpen,
    historyOpen, setHistoryOpen, workspacesOpen, setWorkspacesOpen, masterPwOpen, setMasterPwOpen,
    setupOpen, setSetupOpen, commandPaletteOpen, setCommandPaletteOpen,
    broadcastGroupOpen, setBroadcastGroupOpen, netToolsOpen, setNetToolsOpen,
    serialOpen, setSerialOpen, vncOpen, setVncOpen, rdpOpen, setRdpOpen,
  } = useSimpleModals();

  // Payload modals (carry state; extracted in later steps).
  const [remoteOpen, setRemoteOpen] = useState(false); // phone/web remote-control panel
  const [summary, setSummary] = useState(null); // { text } when the summary modal is open
  // Diff-review modal: the worktree { path, branch, repo } to review, or null.
  const [diffWorktree, setDiffWorktree] = useState(null);

  // v4.0 MobaXterm layout: a vertical ribbon toggles which panel is docked on
  // the left — "sessions" (project/session list), "snippets" (tools), or "sftp"
  // (remote files). null = dock collapsed. Defaults to the sessions list.
  const [ribbon, setRibbon] = useState(null); // secondary left panel: null | "snippets" | "agents" (session tree is always docked)
  const [dockTab, setDockTab] = useState("files"); // right-dock tab: files | assistant | monitor (the dock is always open)
  // Right-dock + session-tree sizing/visibility (persisted to localStorage).
  const { dockWidth, dockCollapsed, treeCollapsed, collapseDock, collapseTree, startDockResize } = useDockResize();

  // Persisted user snippets (seeded from the starter set; written to the
  // window-independent st.snippets key, not the per-window panel state).
  const { snippets, setSnippets } = useSnippets(st, save);
  const [agentOpen, setAgentOpen] = useState(false); // Native Agent Mode modal

  // MultiExec broadcast (MobaXterm-style). Transient per-window mode: when on,
  // a keystroke or snippet goes to every visible terminal at once. Not
  // persisted — auto-typing into every pane after a restart would surprise.
  const { broadcast, bcastTargets, toggleBroadcast, applyBroadcastGroup, useAllVisibleBroadcast } = useBroadcastMode(toast);

  // Re-render the status bar when the active terminal's dimensions change.
  useDimsListener();

  // Recording state for the status-bar indicator + command-palette labels
  // (recordingCapHit = MAX_EVENTS auto-stop reached).
  const { recordingTabIds, recordingCapHit } = useRecordingState();

  // Inject header-skin CSS once. Idempotent inside injectHeaderSkinsCss.
  useHeaderSkinSetup();

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

  // Active skin value, honoring OS light/dark sync when enabled.
  const osDark = useOsDark();
  const activeSkin = effectiveSkinValue(st, userSt, osDark);
  // Effective base built-in skin (custom themes ride on moba/moba-light).
  const headerSkinId = resolveBaseSkinId(activeSkin, userSt?.customThemes);
  const customThemeActive = !!findCustomTheme(activeSkin, userSt?.customThemes);

  // Apply the active theme globally on <html> so portaled/sibling elements
  // (toasts, modals via Provider tree) inherit the theme's CSS vars. Custom
  // themes also inject their --phn-* overrides here.
  useEffect(() => {
    applyActiveTheme(activeSkin, userSt?.customThemes);
  }, [activeSkin, userSt?.customThemes]);

  // Dark ⇄ Light chrome toggle (toolbar button + Ctrl+\). From light it returns
  // to OLED Black (the default dark since v0.4.3); from any dark variant it goes
  // light. A manual flip turns OFF OS sync so the choice sticks.
  const toggleTheme = useCallback(() => {
    const next = headerSkinId === "moba-light" ? "oled" : "moba-light";
    // Functional saves so a concurrent cloud-sync applyStores commit isn't reverted
    // by spreading a stale render-time snapshot (lost-update anti-clobber pattern).
    if (userSt?.themeFollowOS) saveUser((prev) => ({ ...prev, themeFollowOS: false }));
    save((prev) => ({ ...prev, headerSkin: next }));
  }, [headerSkinId, save, userSt, saveUser]);

  // Keyboard shortcuts (v0.1.16). Window-level capture so they fire even
  // when xterm has focus. Uses Ctrl+Shift+ for tab/window ops to avoid
  // colliding with shell readline bindings (Ctrl+W = kill word, Ctrl+T =
  // transpose, etc.). Ctrl+P opens pack search; Ctrl+K opens command
  // palette; Ctrl+1..8 switches active panel.
  const shortcutsRef = useRef({});
  // Resolved combo→action map, derived from userSt.keybindings. The memo gives
  // render-time readers (the palette's shortcut chips) a fresh value; the effect
  // mirrors it into the ref for the stable [] dispatcher and into keybindings.js's
  // shared cache (setResolved, read by TerminalPane's find handler) — that
  // module-cache mutation must happen post-commit, not during render.
  const resolvedBindings = useMemo(() => resolveBindings(userSt?.keybindings), [userSt?.keybindings]);
  const bindingsRef = useRef(resolvedBindings);
  useEffect(() => {
    bindingsRef.current = resolvedBindings;
    setResolved(userSt?.keybindings);
  }, [resolvedBindings, userSt?.keybindings]);
  useEffect(() => {
    const onKey = (e) => {
      // Stand down while the Keybindings remap UI is capturing a keystroke.
      if (isCapturing()) return;
      // Only act on combos with a non-Shift modifier — never swallow plain
      // typing in the terminal.
      if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
      const fns = shortcutsRef.current;
      let handled = false;

      // Look the pressed combo up in the user-resolved map. (Find-in-terminal
      // resolves to "find", which has no global fn — it falls through to
      // xterm's own handler in TerminalPane, where the active pane is known.)
      const combo = comboFromEvent(e);
      const actionId = combo ? bindingsRef.current.byCombo.get(combo) : null;
      if (actionId) {
        const action = KEY_ACTIONS.find((a) => a.id === actionId);
        if (action && fns[action.fn]) {
          fns[action.fn](action.arg);
          handled = true;
        }
      }

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true); // capture phase
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Apply the user's stored OS-level summon hotkey on boot (Rust registers the
  // Ctrl+Shift+` default at startup; this overrides it if remapped/disabled).
  useEffect(() => {
    const s = userSt?.keybindings?.summon;
    const combo = s === undefined ? "Ctrl+Shift+Backquote" : s; // null → disabled
    invoke("set_summon_shortcut", { combo: combo || "" }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pureBlackTerminal = !!st?.pureBlackTerminal;
  const xtermTheme = useMemo(
    () => getActiveXtermTheme(activeSkin, userSt?.customThemes, { pureBlackTerminal }),
    [activeSkin, userSt?.customThemes, pureBlackTerminal]
  );

  // Shell name (basename of the shell new tabs spawn) — shown in the status bar.
  const shellName = useShellName();

  // Live system stats (CPU / memory / disk) for the status bar (polled ~2.5s).
  const sysStats = useSystemStats(dockTab === "monitor");

  // Claude CLI availability — checked once on mount, surfaced in the status bar.
  const claudeAvailable = useClaudeAvailable();

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
          // Functional form: `st` was captured before the await — spreading it
          // here would clobber any save that landed during the version check.
          save((prev) => ({ ...prev, setupSeen: true }));
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-tab activity + Claude /cost telemetry (transient) and the derived
  // aggregates the chrome reads. See useTabTelemetry.
  const {
    tabActivities, tabCosts,
    handleTabCostUpdate, handleTabActivityChange,
    tabAutoApprove, tabProjectNames,
    totalCost, projectActivities,
  } = useTabTelemetry({ state, projects });

  const persist = useCallback((next) => {
    // Accept a value OR a functional updater (like save): callers running after an
    // await should pass (prevTerminalsState) => ... so a concurrent commit isn't
    // clobbered by a stale render-time spread (the lost-update anti-clobber form).
    save((prev) => ({
      ...prev,
      terminalsState: typeof next === "function" ? next(prev.terminalsState) : next,
    }));
  }, [save]);

  // ── Panel / tab / pane tree mutations (the workspace reducer) ───────
  // ~20 interdependent mutations that all close over (state, persist). Lifted
  // into useWorkspaceTree; the interdependencies (closeTab→closePanel,
  // closePane→closeTab, detachTab→closeTab) are internal to the hook.
  const {
    setActivePanel, addPanel, closePanel,
    addTab, addHomeTab, focusOrAddHomeTab, convertHomeToShell,
    closeTab, switchTab, renameTab, setTabColor, duplicateTab, detachTab, closeOtherTabs, moveTab, reorderTab, reopenTab,
    panelIdForTab, splitPane, closePane, activatePane, setPaneRatio,
  } = useWorkspaceTree({ state, persist, toast });

  // ── Project mutations ──────────────────────────────────────────────
  // importSshConfig reveals the imported hosts via selectRibbon, which is
  // declared far below — bridge it through a ref so passing it doesn't touch a
  // temporal dead zone at render. The ref's .current is set just after
  // selectRibbon's declaration.
  const selectRibbonRef = useRef(null);
  const { upsertProject, removeProject, colorProject, renameProject, importSshConfig, setProjectFolder } =
    useProjects({ state, persist, projects, toast, selectRibbonRef });

  // Session-tab spawn + in-memory RDP/VNC password cache (keystone — see
  // useSessionSpawn). spawnSessionTab is the shared launch mutation; the cache is
  // app-run-lifetime only, never persisted (FR-008).
  const { spawnSessionTab, rememberSessionPassword, getSessionPassword, forgetSessionPassword } = useSessionSpawn({ state, persist });

  // SSH connect: password-prompt state machine + MobaXterm quick connect.
  // setSshPrompt is returned so openProjectInPanel can open the saved-session prompt.
  const { sshPrompt, setSshPrompt, submitSshPassword, quickConnect } = useSshConnect({ state, spawnSessionTab, toast });

  // ── Dialog handlers ────────────────────────────────────────────────

  const dialogInitial = useMemo(() => {
    if (!dialog) return null;
    if (dialog.mode === "edit") return projects.find(p => p.id === dialog.projectId) || null;
    // "add" — let a caller (e.g. the Servers button) preset the session type.
    if (dialog.initialType) return { type: dialog.initialType };
    return null;
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

  // Active panel / tab derivation (plain, un-memoized — see useActiveTab). Sits
  // here so every reader below keeps the same declaration order.
  const { activePanel, activeTabId, activeTab, activeTabRecording } = useActiveTab(state, recordingTabIds);

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

  // ── Phone companion: publish the live session list ──────────────────────────
  // The companion server (companion.rs) can't read the webview's localStorage
  // (where the panel/tab layout lives) and doesn't know the per-spawn pty channel
  // ids (minted in pty_spawn, held only by each live TerminalPane). So the desktop
  // pushes its session list here whenever the panels/active-tab or the live PTY
  // set changes. Each entry pairs the live channel id (for `pty://` subscribe +
  // write/resize) with the tabId (the scrollback key). Harmless when the server
  // is off — it just stashes the JSON for the next `list_sessions` RPC.
  const [bridgeTick, setBridgeTick] = useState(0);
  useEffect(() => onDimsChange(() => setBridgeTick((n) => (n + 1) % 1e9)), []);
  const sessionListJson = useMemo(() => {
    const out = [];
    for (const panel of state.panels) {
      for (const tab of panel.tabs || []) {
        if (tab.home) continue; // launch screens (and vnc/rdp tabs) have no PTY
        const leaves = leafIds(getLayout(tab));
        leaves.forEach((leafId, i) => {
          const id = getPtyId(leafId);
          if (!id) return; // pane not spawned yet
          const active =
            panel.id === state.activePanelId &&
            tab.id === panel.activeTabId &&
            leafId === (tab.activePaneId || tab.id);
          out.push({
            id,
            tabId: leafId,
            label: leaves.length > 1 ? `${tab.label || "shell"} ·${i + 1}` : tab.label || "shell",
            active,
          });
        });
      }
    }
    return JSON.stringify(out);
    // bridgeTick re-derives when a pane spawns/dies (getPtyId changes); equal
    // JSON short-circuits the push effect below (string identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.panels, state.activePanelId, bridgeTick]);
  useEffect(() => {
    // Only the primary window owns the companion's session mirror. Secondary
    // (?w=) windows have their own per-window layout; if they pushed too, the two
    // would race on the single shared CompanionState and the phone would flap
    // between / write to the wrong window's terminals (matches the listener gates).
    if (!isPrimaryWindow()) return;
    invoke("companion_set_sessions", { sessions: sessionListJson }).catch(() => {});
  }, [sessionListJson]);

  // Phone companion: publish the snippet set. Read-only on the phone — it inserts
  // a snippet's command into the active session; it never edits the set. Same push
  // rationale as the session list (the page can't read st.snippets from the
  // webview localStorage). String identity short-circuits redundant pushes.
  const snippetsJson = useMemo(() => JSON.stringify(snippets || []), [snippets]);
  useEffect(() => {
    if (!isPrimaryWindow()) return; // primary window owns the mirror
    invoke("companion_set_snippets", { snippets: snippetsJson }).catch(() => {});
  }, [snippetsJson]);

  // Phone companion: publish the model catalog + active selection. ONLY a `hasKey`
  // boolean per provider crosses the wire — the API keys never leave this
  // localStorage. The phone's picker sets `activeModel` (which the next spawned
  // shell routes to), exactly like the desktop ModelPicker.
  const modelsJson = useMemo(() => {
    const keys = userSt?.providerKeys || {};
    const providers = PROVIDERS.map((pp) => ({
      id: pp.id,
      label: pp.label,
      models: pp.models || [],
      hasKey: typeof keys[pp.id] === "string" && keys[pp.id].length > 0,
    }));
    return JSON.stringify({ active: userSt?.activeModel || null, providers });
  }, [userSt]);
  useEffect(() => {
    if (!isPrimaryWindow()) return; // primary window owns the mirror
    invoke("companion_set_models", { models: modelsJson }).catch(() => {});
  }, [modelsJson]);

  // Phone companion → "new session" requests. The phone can't spawn a PTY itself,
  // so companion.rs emits this event and the desktop opens the tab (which spawns
  // a shell that flows back into the session list). A ref carries the latest
  // addTab/activePanelId so the listener registers once (no re-subscribe churn).
  const newSessionReqRef = useRef(() => {});
  newSessionReqRef.current = () => addTab(state.activePanelId);
  useEffect(() => {
    // companion://* are GLOBAL app.emit broadcasts → every open window receives
    // them. Only the primary window (no ?w= suffix) should act, else one phone
    // tap spawns a shell tab in EVERY window. Secondary windows skip registration.
    if (!isPrimaryWindow()) return;
    let un, cancelled = false;
    // Guard the async listen(): if this effect unmounts before the promise
    // resolves, unlisten as soon as we get the handle (else the listener leaks
    // and a single phone tap fires addTab twice under StrictMode/HMR).
    listen("companion://new-session", () => newSessionReqRef.current())
      .then((f) => { if (cancelled) f(); else un = f; })
      .catch(() => {});
    return () => { cancelled = true; if (un) un(); };
  }, []);

  // Phone companion → "set active model". The phone picks a provider/model from
  // the pushed catalog; we accept it only when it's a known provider WITH a key
  // configured, then persist activeModel (one field — NOT write_store, so a leaked
  // token can't rewrite the layout or touch keys). The next spawned shell routes
  // to it (TerminalPane reads activeModel at spawn). Ref carries latest userSt.
  const setActiveModelRef = useRef(() => {});
  setActiveModelRef.current = (payload) => {
    const providerId = payload?.providerId;
    const model = payload?.model;
    if (!providerId || typeof model !== "string" || !model) return;
    const provider = findProvider(providerId);
    const key = userSt?.providerKeys?.[providerId];
    if (!provider || typeof key !== "string" || !key) return; // unknown provider / no key → ignore
    saveUser({ ...userSt, activeModel: { providerId, model } });
  };
  useEffect(() => {
    if (!isPrimaryWindow()) return; // primary window only (see new-session)
    let un, cancelled = false;
    listen("companion://set-active-model", (e) => setActiveModelRef.current(e?.payload))
      .then((f) => { if (cancelled) f(); else un = f; })
      .catch(() => {});
    return () => { cancelled = true; if (un) un(); };
  }, []);

  // Named workspaces — save/restore the whole panel/tab/split layout. Persisted
  // in the window-independent user store (userSt.workspaces). See useWorkspaces.
  const { workspaces, saveWorkspace, loadWorkspace, deleteWorkspace } =
    useWorkspaces({ state, persist, userSt, saveUser, toast });

  // ── SFTP remote file browser (Phase 3) ─────────────────────────────────
  // Bound to the active SSH tab; connects/disconnects automatically (see
  // useSftpDock). dockTab/setDockTab stay here — the right-dock JSX uses them.
  const { sftp, focusFilesDock } = useSftpDock({ activeTab, activeTabId, dockTab, setDockTab });

  // Secondary left panel selection (Snippets / Agents). "files" focuses the
  // right dock's SFTP tab. "sessions" is a no-op — the tree is always docked.
  const selectRibbon = useCallback((id) => {
    if (id === "files") { focusFilesDock(); return; }
    if (id === "sessions") return; // the session tree is always docked — don't touch the secondary panel
    setRibbon(id);
  }, [focusFilesDock]);
  // Bridge selectRibbon to useProjects' importSshConfig (declared above) without a
  // render-time TDZ: the ref is read only from post-render callback bodies, so an
  // effect-time write (not a render-phase one) is always fresh enough.
  useEffect(() => { selectRibbonRef.current = selectRibbon; }, [selectRibbon]);

  // "Games" toolbar button — MobaXterm has built-in games; we keep it honest
  // with a wink toward the palette.
  const playGames = useCallback(() => {
    toast.info("No games bundled — but Ctrl+K opens the command palette.");
  }, [toast]);

  // "Exit" toolbar button — truly quit (kills every PTY). Needs the quit_app
  // backend command; falls back to hiding the window if it isn't available.
  const exitApp = useCallback(async () => {
    const ok = await confirm({
      title: "Quit Pluto's Terminal?",
      message: "This closes every terminal session in this window and exits the app.",
      confirmText: "Quit",
      danger: true,
    });
    if (!ok) return;
    try { await invoke("quit_app"); }
    catch { try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); getCurrentWindow().close(); } catch { /* ignore */ } }
  }, [confirm]);

  // Write raw data into the active terminal (or all visible, in broadcast mode).
  // Used by the file browser ("cd here", insert path) and snippets.
  const sendToActiveTerminal = useCallback((data) => {
    if (!activeTabId) { toast.error("No active terminal."); return; }
    if (broadcast) writeBroadcast(data);
    else writeToTab(activeTabId, data);
  }, [activeTabId, broadcast, toast]);

  // ── SSH port forwarding (tunnels) ───────────────────────────────────────
  const { tunnelsOpen, setTunnelsOpen, forwards, tunnelBusy, tunnelError, openTunnels, startForward, startSocks, stopForward } = useTunnels({ activeTab, activeTabId, toast });

  // ── VNC / RDP / serial connect + launch (modal-driven) — see
  // useRemoteDesktopLaunch. setVncLaunch / setRdpLaunch are returned so
  // openProjectInPanel can open the saved-session password modal.
  const {
    connectSerial,
    vncLaunch, setVncLaunch, connectVnc, launchVnc,
    rdpLaunch, setRdpLaunch, connectRdp, launchRdp,
    saveQuickConnection,
  } = useRemoteDesktopLaunch({
    state, spawnSessionTab, rememberSessionPassword,
    setSerialOpen, setVncOpen, setRdpOpen, upsertProject, toast,
  });

  // Session-launch dispatch (open a saved project: SSH/VNC/RDP/local + npm-script
  // + worktree). Called AFTER the session-launch hooks so it can receive the
  // launch-modal setters (setSshPrompt/setVncLaunch/setRdpLaunch). See
  // useSessionDispatch — the sessions↔modals↔grid orchestration knot.
  const { openProjectInPanel, runProjectScript, openAgentWorktree } = useSessionDispatch({
    state, persist, projects, toast,
    spawnSessionTab, getSessionPassword,
    setSshPrompt, setVncLaunch, setRdpLaunch,
  });

  // Actions surfaced on the MobaXterm launch screen (home tabs). useState
  // setters have stable identity, so they're omitted from the dep list.
  const homeApi = useMemo(() => ({
    projects,
    projectActivities,
    startLocal: convertHomeToShell,
    openProject: openProjectInPanel,
    newSession: () => setDialog({ mode: "add" }),
    vnc: () => setVncOpen(true),
    rdp: () => setRdpOpen(true),
    serial: () => setSerialOpen(true),
  }), [projects, projectActivities, convertHomeToShell, openProjectInPanel]);

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
    toast.success(`Recording "${activeTab?.label || "tab"}" — pick "Stop & save" when done.`);
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

  // Wire keyboard-shortcut callbacks. Dep-less effect = refreshed after every
  // render so closures see the latest state (no stale captures), without the
  // ref write happening during the render phase. Key handlers only read it on
  // events, so post-commit freshness is sufficient.
  useEffect(() => {
    shortcutsRef.current = {
      addTab: () => addTab(state.activePanelId),
      closeActiveTab: () => {
        const panel = state.panels.find((p) => p.id === state.activePanelId);
        if (panel && panel.tabs.length > 1 && panel.activeTabId) {
          closeTab(panel.id, panel.activeTabId);
        }
      },
      openCommandPalette: () => setCommandPaletteOpen(true),
      openAskAi: () => setAskOpen(true),
      openAgent: () => setAgentOpen(true),
      openHistory: () => setHistoryOpen(true),
      openSettings: () => setSettingsOpen(true),
      reopenTab,
      toggleTheme,
      switchPanel: (idx) => {
        if (state.panels[idx]) setActivePanel(state.panels[idx].id);
      },
      togglePromptEditor: () => save((prev) => ({ ...prev, promptEditor: !prev?.promptEditor })),
    };
  });
  // Live-combo lookup for command-palette shortcut chips (reflects remaps).
  const scOf = useCallback((actionId) => {
    const c = resolvedBindings.byAction.get(actionId);
    return c ? formatCombo(c) : undefined;
  }, [resolvedBindings]);

  // ── Stable ProjectSidebar handlers ─────────────────────────────────────
  // ProjectSidebar is memo()'d, so its function props must keep identity across
  // the hot re-render paths (the 2.5s sysStats poll, per-token cost telemetry).
  // The hook-returned handlers (removeProject/colorProject/renameProject/
  // runProjectScript/setProjectFolder/openAgentWorktree) are already useCallback-
  // stable; these wrap the previously-inline arrow props so the whole prop set is
  // stable. setDialog is a stable useState setter; openProjectInPanel is a hook
  // useCallback; toast/forgetSessionPassword are stable. collapseTree is NOT
  // memoized in useDockResize, so onCollapse re-stabilizes whenever it changes —
  // harmless (collapseTree only changes on a full re-render, which already busts
  // memo via other props) and correct.
  const sidebarAddProject = useCallback(() => setDialog({ mode: "add" }), []);
  const sidebarEditProject = useCallback((id) => setDialog({ mode: "edit", projectId: id }), []);
  const sidebarClickProject = useCallback(
    (id) => openProjectInPanel(state.activePanelId, id),
    [openProjectInPanel, state.activePanelId]
  );
  const sidebarDropProject = useCallback(
    (id, panelId) => openProjectInPanel(panelId, id),
    [openProjectInPanel]
  );
  const sidebarCollapse = useCallback(() => collapseTree(true), [collapseTree]);
  const sidebarForgetPassword = useCallback((project) => {
    // RDP/VNC keep the secret in-memory only — clear the session cache.
    if (project?.type === "rdp" || project?.type === "vnc" || project?.rdp || project?.vnc) {
      forgetSessionPassword(project.id);
      toast.info(`Forgot session password for ${project.name}.`);
      return;
    }
    if (!project?.connection) return;
    invoke("secret_delete", { account: sshAccount(project.connection) })
      .then(() => toast.info(`Forgot saved password for ${project.name}.`))
      .catch((e) => toast.error(`Couldn't clear keychain: ${e}`));
  }, [forgetSessionPassword, toast]);

  // ── Memoized chrome arrays ──────────────────────────────────────────────
  // The menu bar, toolbar, and command-palette item arrays were rebuilt inline
  // on EVERY render — including the 2.5s sysStats poll and per-token cost
  // telemetry, which don't touch any value these arrays read. Memoizing them
  // keeps their identity stable across those hot paths so MobaMenuBar /
  // MobaToolbar / CommandPalette can bail out of re-rendering. All useState
  // setters and module-level imports are stable and intentionally omitted from
  // the dep lists; the deps below are exactly the reactive values + hook
  // useCallbacks each array reads.
  const menuBarMenus = useMemo(() => [
    {
      label: "Terminal",
      items: [
        { label: "New tab", shortcut: "Ctrl+Shift+T", action: () => addTab(state.activePanelId) },
        { label: "Launch screen (home tab)", action: () => addHomeTab(state.activePanelId) },
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
        { label: "Import from ~/.ssh/config…", action: () => importSshConfig() },
        { label: "SSH keys…", action: () => setSshKeysOpen(true) },
        { divider: true },
        { label: "Sessions panel", action: () => selectRibbon("sessions") },
        { label: "File browser", action: () => selectRibbon("files") },
        { label: "Port forwarding…", disabled: !activeTab?.connection, action: () => openTunnels() },
        { label: "Serial console…", action: () => setSerialOpen(true) },
        { label: "VNC remote desktop…", action: () => setVncOpen(true) },
        { label: "RDP remote desktop…", action: () => setRdpOpen(true) },
        { label: "Network tools (ping · traceroute · ports · DNS)…", action: () => setNetToolsOpen(true) },
      ],
    },
    {
      label: "Tools",
      items: [
        { label: "Snippets panel", action: () => selectRibbon("snippets") },
        { label: "Keystroke macros…", action: () => setMacrosOpen(true) },
        { label: "Ask AI — natural language → command", shortcut: "Ctrl+I", action: () => setAskOpen(true) },
        { label: "Summarize this session (AI)", action: () => { if (!activeTabId) { toast.error("No active terminal."); return; } setSummary({ text: getTabText(activeTabId) }); } },
        { label: "Command history search…", shortcut: "Cmd+R", action: () => setHistoryOpen(true) },
        { label: "Models — pick provider + model…", action: () => setModelsOpen(true) },
        { label: broadcast ? "Turn off broadcast (MultiExec)" : "Broadcast (MultiExec)", action: () => toggleBroadcast() },
        { label: "Broadcast targets… (choose terminals)", action: () => setBroadcastGroupOpen(true) },
        { divider: true },
        { label: "Remote control (phone)…", action: () => setRemoteOpen(true) },
        { label: "MCP servers…", action: () => setMcpOpen(true) },
        { label: "Setup checker…", action: () => setSetupOpen(true) },
        { label: "Command palette", shortcut: "Ctrl+K", action: () => setCommandPaletteOpen(true) },
      ],
    },
    {
      label: "View",
      items: [
        { label: ribbon ? "Hide tools panel" : "Show snippets panel", action: () => selectRibbon(ribbon ? null : "snippets") },
        { label: "Workspaces — save / restore layout…", action: () => setWorkspacesOpen(true) },
        { divider: true },
        { label: "Skins & appearance…", action: () => setSettingsOpen(true) },
      ],
    },
    {
      label: "Settings",
      items: [
        { label: "Settings…", shortcut: "Ctrl+,", action: () => setSettingsOpen(true) },
        { label: "Master password…", action: () => setMasterPwOpen(true) },
      ],
    },
    {
      label: "Help",
      items: [
        { label: "GitHub repository", action: () => openExternal(GITHUB_URL) },
        { label: "Pluto Discord", action: () => openExternal(DISCORD_URL) },
      ],
    },
  ], [
    addTab, addHomeTab, addPanel, canAddPanel, splitPane, closeTab,
    activeTabId, activeTab, state.panels, state.activePanelId,
    toast, importSshConfig, selectRibbon, openTunnels,
    broadcast, toggleBroadcast, ribbon,
  ]);

  const toolbarGroups = useMemo(() => [
    {
      caption: "Connect",
      items: [
        { id: "local", icon: <SLocal />, label: "Local", title: "New local shell session", onClick: () => setDialog({ mode: "add" }) },
        { id: "ssh", icon: <SSsh />, label: "SSH", title: "New SSH / server session", onClick: () => setDialog({ mode: "add", initialType: "ssh" }) },
        { id: "serial", icon: <SSerial />, label: "Serial", title: "Serial console session", onClick: () => setSerialOpen(true) },
      ],
    },
    {
      caption: "Workspace",
      items: [
        { id: "split", icon: <SSplit />, label: "Split", title: "Split the active pane", disabled: !activeTabId, menu: [
          { id: "split-row", icon: <SSplitRow size={15} />, label: "Side by side", onClick: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "row") },
          { id: "split-col", icon: <SSplitCol size={15} />, label: "Stacked", onClick: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "col") },
        ] },
        { id: "multiexec", icon: <SMultiX />, label: "MultiX", title: "Broadcast typing to every visible terminal at once", active: broadcast, onClick: toggleBroadcast },
        { id: "tunnel", icon: <STunnel />, label: "Tunnel", title: activeTab?.connection ? "SSH port forwarding (tunnels) for the active SSH session" : "Open an SSH session to forward ports", active: tunnelsOpen, disabled: !tunnelsOpen && !activeTab?.connection, onClick: () => (tunnelsOpen ? setTunnelsOpen(false) : openTunnels()) },
      ],
    },
    {
      caption: "AI · Tools",
      items: [
        { id: "ask", icon: <SAsk />, label: "Ask AI", title: "Ask AI to turn plain English into a shell command (Ctrl+I)", onClick: () => setAskOpen(true) },
        { id: "agent", icon: <SAgents />, label: "Agent", title: "Agent Mode — give a goal in plain English; it runs commands to do it (Ctrl+Shift+A)", onClick: () => setAgentOpen(true) },
        { id: "models", icon: <SModels />, label: "Models", title: "Pick your LLM provider + model and enter its API key", onClick: () => setModelsOpen(true) },
        { id: "snips", icon: <SSnips />, label: "Workflows", title: "Workflows — saved parameterized commands; click to run", active: ribbon === "snippets", onClick: () => selectRibbon(ribbon === "snippets" ? null : "snippets") },
        { id: "agents", icon: <SAgents />, label: "Agents", title: "Agent mission control", active: ribbon === "agents", onClick: () => selectRibbon(ribbon === "agents" ? null : "agents") },
      ],
    },
  ], [
    activeTabId, activeTab, splitPane, broadcast, toggleBroadcast,
    tunnelsOpen, setTunnelsOpen, openTunnels, ribbon, selectRibbon,
  ]);

  const paletteCommands = useMemo(() => [
    { id: "new-tab", icon: "+", label: "New tab in active panel", shortcut: scOf("newTab"), action: () => addTab(state.activePanelId) },
    { id: "new-session", icon: <SSsh size={14} />, label: "New session", hint: "Save a local folder or an SSH host to the sidebar", action: () => setDialog({ mode: "add" }) },
    { id: "import-ssh", icon: <SKey size={14} />, label: "Import ~/.ssh/config", hint: "Add every SSH host from your OpenSSH config to the Sessions tree", action: () => importSshConfig() },
    { id: "ssh-keys", icon: <SKey size={14} />, label: "SSH keys", hint: "List / generate SSH keypairs; copy a public key to a server", action: () => setSshKeysOpen(true) },
    { id: "macros", icon: <SRecord size={14} />, label: "Keystroke macros", hint: "Record what you type and replay it into the active terminal", action: () => setMacrosOpen(true) },
    { id: "master-pw", icon: <SLock size={14} />, label: "Master password", hint: "Lock the app behind a password on launch", action: () => setMasterPwOpen(true) },
    { id: "split-right", icon: <SSplitRow size={14} />, label: "Split active pane right", hint: "Side-by-side terminals in the current tab", action: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "row") },
    { id: "split-down", icon: <SSplitCol size={14} />, label: "Split active pane down", hint: "Stacked terminals in the current tab", action: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "col") },
    { id: "add-panel", icon: "+", label: "Add panel", hint: canAddPanel ? "" : `Max ${MAX_PANELS} panels`, action: () => canAddPanel && addPanel() },
    { id: "ask", icon: <SAsk size={14} />, label: "Ask AI — natural language → command", hint: "Describe what you want; get a reviewable shell command", shortcut: scOf("askAi"), action: () => setAskOpen(true) },
    { id: "agent", icon: <SBot size={14} />, label: "Agent Mode — describe a goal, it runs the commands", hint: "An in-app agent runs commands in the active terminal to accomplish your goal", shortcut: scOf("agentMode"), action: () => setAgentOpen(true) },
    { id: "summarize", icon: <SDoc size={14} />, label: "Summarize this session (AI)", hint: "AI summary of the active terminal's recent output", action: () => { if (!activeTabId) { toast.error("No active terminal."); return; } setSummary({ text: getTabText(activeTabId) }); } },
    { id: "history", icon: <SClock size={14} />, label: "Command history search", hint: "Fuzzy search past commands — Enter inserts, ⌘/Ctrl+Enter runs", shortcut: scOf("history"), action: () => setHistoryOpen(true) },
    { id: "workspaces", icon: <SLayout size={14} />, label: "Workspaces — save / restore layout", hint: "Save the current panels/tabs/splits as a named workspace, or restore one", action: () => setWorkspacesOpen(true) },
    { id: "models", icon: <SModels size={14} />, label: "Models — pick provider + model", hint: "Claude, Hermes, Gemini, GLM, Qwen, MiniMax, Kimi, OpenRouter, NVIDIA, HF… or any endpoint", action: () => setModelsOpen(true) },
    { id: "snippets", icon: <SSnips size={14} />, label: "Workflows panel", hint: "Saved parameterized commands — click to run", action: () => selectRibbon(ribbon === "snippets" ? null : "snippets") },
    { id: "files", icon: <SFolder size={14} />, label: "File browser (SFTP) — focus right dock", hint: "Local files, or remote SFTP for an SSH tab, in the right dock (F4)", action: () => focusFilesDock() },
    { id: "tunnels", icon: <STunnel size={14} />, label: "SSH port forwarding", hint: "Forward a local port through the active SSH session", action: () => (tunnelsOpen ? setTunnelsOpen(false) : openTunnels()) },
    { id: "serial", icon: <SSerial size={14} />, label: "Serial console", hint: "Connect to a USB/UART serial device", action: () => setSerialOpen((v) => !v) },
    { id: "vnc", icon: <SMouse size={14} />, label: "VNC remote desktop", hint: "Connect to a VNC server (e.g. macOS Screen Sharing on localhost:5900)", action: () => setVncOpen(true) },
    { id: "rdp", icon: <SWindows size={14} />, label: "RDP remote desktop", hint: "Connect to a Windows / xrdp host over RDP (NLA)", action: () => setRdpOpen(true) },
    { id: "remote-control", icon: <SPhone size={14} />, label: "Remote control (phone)", hint: "Run a private server so your phone can view + type into your terminals over Tailscale", action: () => setRemoteOpen(true) },
    { id: "broadcast", icon: <SBroadcast size={14} />, label: broadcast ? "Turn off broadcast (MultiExec)" : "Turn on broadcast (MultiExec)", hint: "Type once, send to every visible terminal at once", action: () => toggleBroadcast() },
    { id: "broadcast-group", icon: <STarget size={14} />, label: "Broadcast targets… (choose terminals)", hint: "Pick a subset of terminals for MultiExec instead of all visible", action: () => setBroadcastGroupOpen(true) },
    { id: "nettools", icon: <SSsh size={14} />, label: "Network tools", hint: "Ping, traceroute, TCP port scan, and DNS lookup", action: () => setNetToolsOpen(true) },
    { id: "toggle-sidebar", icon: <SSplit size={14} />, label: ribbon ? "Hide tools panel" : "Show snippets panel", hint: "Show or hide the Snippets / Agents panel beside the session tree", action: () => selectRibbon(ribbon ? null : "snippets") },
    { id: "mcps", icon: <SPlug size={14} />, label: "MCP servers", hint: "Curated catalog with one-click install", action: () => setMcpOpen(true) },
    { id: "setup", icon: <SRocket size={14} />, label: "Setup checker", hint: "Verify Node + Claude CLI + API key + live API test", action: () => setSetupOpen(true) },
    { id: "settings", icon: <SGear size={14} />, label: "Open settings", hint: "Appearance, keyboard shortcuts, factory reset", shortcut: scOf("settings"), action: () => setSettingsOpen(true) },
    activeTabRecording
      ? {
          id: "stop-recording",
          icon: <SStop size={14} />,
          label: "Stop & save recording",
          hint: `Save .cast file for the active tab (${activeTab?.label || "tab"})`,
          action: () => stopAndSaveRecording(),
        }
      : {
          id: "start-recording",
          icon: <SRecord size={14} />,
          label: "Start recording active tab",
          hint: `Record terminal output of "${activeTab?.label || "tab"}" as an asciinema .cast file`,
          action: () => startRecordingActive(),
        },
    {
      id: "new-window",
      icon: <SWindows size={14} />,
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
      icon: <SReset size={14} />,
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
      shortcut: i < 8 ? scOf(`panel${i + 1}`) : undefined,
      action: () => setActivePanel(p.id),
    })),
  ], [
    scOf, addTab, addPanel, canAddPanel, splitPane, importSshConfig,
    activeTabId, activeTab, activeTabRecording, broadcast, toggleBroadcast,
    ribbon, selectRibbon, focusFilesDock, tunnelsOpen, setTunnelsOpen, openTunnels,
    stopAndSaveRecording, startRecordingActive, toast, confirm,
    persist, state, setActivePanel,
  ]);

  return (
    <div className="phn-page" data-phn-skin={headerSkinId} data-phn-theme={customThemeActive ? "custom" : undefined} style={{ height: "100%", position: "relative" }}>
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* MobaXterm menu bar — classic dropdown menus wired to existing actions. */}
      <MobaMenuBar
        brand={<><span className="moba-brand-dot" />Pluto</>}
        right={
          <>
            {activeDims && <span className="moba-mb-dim">{activeDims.cols}×{activeDims.rows}</span>}
            <span className="moba-mb-model"><span className="moba-mb-modeldot" />{userSt?.activeModel?.model || "claude"}</span>
            <button className="moba-mb-icon" onClick={toggleTheme} title="Toggle dark / light chrome (Ctrl+\\)">{headerSkinId === "moba-light" ? <IconSun size={14} /> : <IconMoon size={14} />}</button>
            <button className="moba-mb-icon" onClick={exitApp} title="Quit (closes all sessions)"><IconExit size={14} /></button>
          </>
        }
        menus={menuBarMenus}
      />
      {/* MobaXterm grouped icon toolbar — captioned button groups, themed via
          the active skin's --phn-* vars (see MobaToolbar.jsx + terminals.css). */}
      <MobaToolbar
        right={
          <>
            {(totalCost.cost > 0 || totalCost.tokens > 0) && (
              <span className="phn-cost" title="Live aggregate from Claude /cost output across all sessions">
                ${totalCost.cost.toFixed(2)}
                {totalCost.tokens > 0 && ` · ${totalCost.tokens >= 1000 ? `${(totalCost.tokens / 1000).toFixed(1)}k` : totalCost.tokens} tok`}
              </span>
            )}
            <div className="moba-qc-inline" title="Quick connect — user@host (Enter)">
              <SSearch size={13} />
              <input
                placeholder="quick connect — user@host"
                spellCheck={false}
                onKeyDown={(e) => { if (e.key === "Enter") { quickConnect(e.currentTarget.value); e.currentTarget.value = ""; } }}
              />
            </div>
          </>
        }
        groups={toolbarGroups}
      />

      {/* Body: MobaXterm vertical ribbon + docked left panel + terminal grid.
          The ribbon toggles which panel is docked (Sessions / Tools / Sftp).
          MobaXterm layout: Quick-connect sits NARROW at the top of the left dock
          (not a full-width bar), beside the per-panel tab strip on the right. */}
      <div className="moba-body" style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0, position: "relative", overflow: "hidden" }}>
        {/* Permanent session tree — always docked (workstation layout).
            Collapsible to a thin rail (re-expandable), never fully removed. */}
        {treeCollapsed ? (
          <div className="moba-railcol" onClick={() => collapseTree(false)} title="Show sessions">
            ›<span className="lbl">Sessions</span>
          </div>
        ) : (
        <div className="moba-dock">
          <div className="moba-dock-body">
              <ProjectSidebar
                docked
                onCollapse={sidebarCollapse}
                projects={projects}
                projectActivities={projectActivities}
                onAddProject={sidebarAddProject}
                onEditProject={sidebarEditProject}
                onRemoveProject={removeProject}
                onColorProject={colorProject}
                onRenameProject={renameProject}
                onClickProject={sidebarClickProject}
                onDropProject={sidebarDropProject}
                onRunScript={runProjectScript}
                onSetFolder={setProjectFolder}
                onNewWorktreeAgent={openAgentWorktree}
                onForgetPassword={sidebarForgetPassword}
              />
          </div>
        </div>
        )}

        {/* Secondary left panel — Snippets / Agents, toggled from the toolbar.
            Never replaces the session tree (which is always docked above). */}
        {(ribbon === "agents" || ribbon === "snippets") && (
          <div className="moba-dock">
            <div className="moba-dock-body">
            {ribbon === "agents" && (
              <AgentDashboard
                panels={state.panels}
                activePanelId={state.activePanelId}
                tabActivities={tabActivities}
                tabCosts={tabCosts}
                onFocusTab={(panelId, tabId) => switchTab(panelId, tabId)}
                onReviewDiff={(wt) => setDiffWorktree(wt)}
                onSummarize={(tabId) => setSummary({ text: getTabText(tabId) })}
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
            </div>
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
              promptEditor={!!st?.promptEditor}
              promptEditorVim={!!st?.promptEditorVim}
              tabAutoApprove={tabAutoApprove}
              tabProjectNames={tabProjectNames}
              homeApi={homeApi}
              onActivate={setActivePanel}
              onAddTab={addTab}
              onCloseTab={closeTab}
              onSwitchTab={switchTab}
              onClosePanel={closePanel}
              onTabActivityChange={handleTabActivityChange}
              onTabCostUpdate={handleTabCostUpdate}
              onRenameTab={renameTab}
              onSetTabColor={setTabColor}
              onDuplicateTab={duplicateTab}
              onDetachTab={detachTab}
              onCloseOthers={closeOtherTabs}
              onMoveTab={moveTab}
              onReorderTab={reorderTab}
              onSplitPane={splitPane}
              onClosePane={closePane}
              onActivatePane={activatePane}
              onSetPaneRatio={setPaneRatio}
            />
          ))}
        </div>

        {/* Right dock — SFTP / Assistant / Monitor. Always present (workstation
            layout); collapsible to a rail and drag-resizable. F4 focuses SFTP. */}
        {dockCollapsed ? (
          <div className="moba-railcol" onClick={() => collapseDock(false)} title="Show tools panel">
            ‹<span className="lbl">Tools</span>
          </div>
        ) : (
          <>
            <div className="moba-splitter" title="Drag to resize" onMouseDown={startDockResize} style={{ cursor: "col-resize" }}><span className="moba-grip"><i></i><i></i><i></i></span></div>
            <div className="moba-rightdock" style={{ width: dockWidth }}>
              <div className="moba-rd-tabs">
                {[
                  { id: "files", label: "SFTP", icon: <SFolder size={13} /> },
                  { id: "assistant", label: "Assistant", icon: <SAsk size={13} /> },
                  { id: "monitor", label: "Monitor", icon: <SPulse size={13} /> },
                ].map((t) => (
                  <span
                    key={t.id}
                    className={dockTab === t.id ? "moba-rd-tab active" : "moba-rd-tab"}
                    onClick={() => setDockTab(t.id)}
                    title={t.label}
                  >
                    <span style={{ display: "inline-flex" }}>{t.icon}</span> {t.label}
                  </span>
                ))}
                <button className="moba-rd-collapse" onClick={() => collapseDock(true)} title="Collapse panel">›</button>
              </div>
              <div className="moba-rd-body">
                {dockTab === "assistant" ? (
                  <DockAssistant onSendToTerminal={sendToActiveTerminal} shellName={shellName} cwd={activeTab?.cwd} />
                ) : dockTab === "monitor" ? (
                  <DockMonitor sysStats={sysStats} panels={state.panels} activities={tabActivities} />
                ) : activeTab?.connection ? (
                  <SftpBrowser
                    docked
                    connecting={sftp?.connecting}
                    error={sftp?.error}
                    sessionId={sftp?.id}
                  />
                ) : (
                  <LocalFileBrowser onSendToTerminal={sendToActiveTerminal} />
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <TunnelsModal
        open={tunnelsOpen}
        host={activeTab?.connection?.host}
        user={activeTab?.connection?.user}
        forwards={forwards}
        busy={tunnelBusy}
        error={tunnelError}
        onStart={startForward}
        onStartSocks={startSocks}
        onStop={stopForward}
        onClose={() => setTunnelsOpen(false)}
      />

      <SerialModal
        open={serialOpen}
        onConnect={connectSerial}
        onClose={() => setSerialOpen(false)}
      />

      <VncConnectModal
        open={vncOpen || !!vncLaunch}
        initial={vncLaunch?.project?.vnc || null}
        lockConnection={!!vncLaunch}
        title={vncLaunch ? `Connect — ${vncLaunch.project.name}` : undefined}
        onConnect={vncLaunch ? launchVnc : connectVnc}
        onSaveSession={vncLaunch ? undefined : (rec) => saveQuickConnection({ type: "vnc", ...rec })}
        onClose={() => { setVncOpen(false); setVncLaunch(null); }}
      />

      <RdpConnectModal
        open={rdpOpen || !!rdpLaunch}
        initial={rdpLaunch?.project?.rdp || null}
        lockConnection={!!rdpLaunch}
        title={rdpLaunch ? `Connect — ${rdpLaunch.project.name}` : undefined}
        onConnect={rdpLaunch ? launchRdp : connectRdp}
        onSaveSession={rdpLaunch ? undefined : (rec) => saveQuickConnection({ type: "rdp", ...rec })}
        onClose={() => { setRdpOpen(false); setRdpLaunch(null); }}
      />

      <ProjectDialog
        open={!!dialog}
        initial={dialogInitial}
        existingFolders={[...new Set(projects.map((p) => p.folder).filter(Boolean))]}
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

      <DiffView
        open={!!diffWorktree}
        worktree={diffWorktree}
        onClose={() => setDiffWorktree(null)}
      />

      <ModelPicker
        open={modelsOpen}
        userSt={userSt}
        saveUser={saveUser}
        onClose={() => setModelsOpen(false)}
      />

      <AskBar
        open={askOpen}
        shellName={shellName}
        cwd={activeTab?.cwd}
        onClose={() => setAskOpen(false)}
        onRun={(cmd) => { if (activeTabId) writeToTab(activeTabId, cmd + "\r"); }}
        onInsert={(cmd) => insertSnippet(cmd)}
      />

      <AgentMode
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
        tabId={activeTab?.activePaneId || activeTabId}
        cwd={activeTab?.cwd || null}
        shellName={shellName}
      />

      <SessionSummary
        open={!!summary}
        text={summary?.text || ""}
        onClose={() => setSummary(null)}
      />

      <HistorySearch
        open={historyOpen}
        history={historyOpen ? getCommandHistory() : []}
        onClose={() => setHistoryOpen(false)}
        onInsert={(cmd) => insertSnippet(cmd)}
        onRun={(cmd) => { if (activeTabId) writeToTab(activeTabId, cmd + "\r"); }}
      />

      <WorkspacesModal
        open={workspacesOpen}
        workspaces={workspaces}
        onClose={() => setWorkspacesOpen(false)}
        onSave={saveWorkspace}
        onLoad={loadWorkspace}
        onDelete={deleteWorkspace}
      />

      <BroadcastGroupModal
        open={broadcastGroupOpen}
        panels={state.panels}
        liveTabIds={broadcastGroupOpen ? getLiveTabIds() : []}
        current={bcastTargets}
        onClose={() => setBroadcastGroupOpen(false)}
        onApply={applyBroadcastGroup}
        onUseAllVisible={useAllVisibleBroadcast}
      />

      <NetToolsModal
        open={netToolsOpen}
        initialHost={activeTab?.connection?.host || ""}
        onClose={() => setNetToolsOpen(false)}
      />

      <RemoteControlModal open={remoteOpen} onClose={() => setRemoteOpen(false)} />

      <SshKeysModal open={sshKeysOpen} onClose={() => setSshKeysOpen(false)} />

      <MacrosModal
        open={macrosOpen}
        canReplay={!!activeTabId}
        activeTabId={activeTabId}
        onReplay={(data) => activeTabId && writeToTab(activeTabId, data)}
        onClose={() => setMacrosOpen(false)}
      />

      <MasterPasswordModal
        open={masterPwOpen}
        userSt={userSt}
        saveUser={saveUser}
        onClose={() => setMasterPwOpen(false)}
      />

      <McpInstaller
        open={mcpOpen}
        onClose={() => setMcpOpen(false)}
      />

      <SetupChecker
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
      />

      <CommandPalette
        open={commandPaletteOpen}
        commands={paletteCommands}
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
        {/* LEFT — active session · shell/encoding */}
        {activeTab && (
          <span className="moba-stat" title="Active session · terminal size (columns × rows)">
            <span className="dot" style={{ background: tabActivities[activeTabId] === "active" ? "#4FB8E6" : tabActivities[activeTabId] === "done" ? "var(--phn-success, #5FB87A)" : "var(--phn-text-faint, #586068)" }} />
            {activeTab.label}{activeDims ? <span style={{ opacity: 0.55, marginLeft: 5 }}>{activeDims.cols}×{activeDims.rows}</span> : null}
          </span>
        )}
        <span title="Shell · encoding · line ending" style={{ opacity: 0.8 }}>{shellName || "shell"} · UTF-8 · LF</span>
        {broadcast && (
          <button
            onClick={() => setBroadcastGroupOpen(true)}
            style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", color: "var(--phn-warning)", fontSize: 11, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}
            title="Broadcast (MultiExec) is on. Click to choose target terminals; the MultiExec button toggles it off."
          >
            <SBroadcast size={12} /> broadcast: {bcastTargets ? `${bcastTargets.length} tab${bcastTargets.length === 1 ? "" : "s"}` : "all visible"}
          </button>
        )}
        {recordingTabIds.length > 0 && (
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
            style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", color: "var(--phn-danger)", fontSize: 11, fontWeight: 600 }}
            title={recordingCapHit
              ? `Recording hit ${recording.RECORDING_MAX_EVENTS / 1000}k events (memory cap). Save now and start a new recording for further capture.`
              : activeTabRecording
                ? "Click to stop & save the active tab's recording"
                : "Click to switch to the recording tab"}
          >
            {recordingCapHit ? "⚠ rec capped — save" : `● rec${recordingTabIds.length > 1 ? ` (×${recordingTabIds.length})` : ""}`}
          </button>
        )}

        <div style={{ flex: 1 }} />

        {/* RIGHT — cost · model · links (CPU/MEM/DISK live in the Monitor tab) */}
        {(totalCost.cost > 0 || totalCost.tokens > 0) && (
          <span style={{ color: "var(--phn-success)", fontWeight: 600 }} title="Aggregate live spend across all sessions">
            ${totalCost.cost.toFixed(2)}
            {totalCost.tokens > 0 && ` · ${totalCost.tokens >= 1000 ? `${(totalCost.tokens / 1000).toFixed(1)}k` : totalCost.tokens} tok`}
          </span>
        )}
        {(userSt?.activeModel?.model || claudeAvailable) && (
          <span className="phn-statusbar-active" title="Active model (Models picker)" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <SAsk size={11} /> {userSt?.activeModel?.model || "claude"}
          </span>
        )}
        <span style={{ opacity: 0.45 }}>v{APP_VERSION}</span>
        <button
          onClick={() => openExternal(GITHUB_URL)}
          className="phn-statusbar-link"
          style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", font: "inherit" }}
          title="Open repo on GitHub"
        >
          github
        </button>
        <span className="phn-statusbar-divider">·</span>
        <button
          onClick={() => openExternal(DISCORD_URL)}
          style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", color: "var(--phn-text-dim, #9a9da3)", font: "inherit" }}
          title="Join the Pluto Discord"
        >
          discord
        </button>
      </div>

      {/* F-key quick-action bar (MobaXterm-style) */}
      <div className="phn-fnbar">
        {[
          { k: "F1", l: "Help", fn: () => openExternal(GITHUB_URL) },
          { k: "F2", l: "Tab", fn: () => addTab(state.activePanelId) },
          { k: "F3", l: "Split", fn: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "row") },
          { k: "F4", l: "SFTP", fn: () => selectRibbon("files") },
          { k: "⌘K", l: "Palette", fn: () => setCommandPaletteOpen(true) },
          { k: "⌘I", l: "Ask AI", fn: () => setAskOpen(true) },
          { k: "⌘R", l: "History", fn: () => setHistoryOpen(true) },
          { k: "⌘M", l: "Models", fn: () => setModelsOpen(true) },
          { k: "F9", l: "Macro", fn: () => setMacrosOpen(true) },
        ].map((b) => (
          <button key={b.k} className="phn-fn" onClick={b.fn} title={`${b.k} — ${b.l}`}>
            <b>{b.k}</b> {b.l}
          </button>
        ))}
      </div>
      </div>
    </div>
  );
}
