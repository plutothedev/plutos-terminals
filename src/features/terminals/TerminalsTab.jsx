// (C)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, listen } from "@backend";
import TerminalPanel from "./TerminalPanel";
import ProjectSidebar from "./ProjectSidebar";
import SnippetsDrawer from "./SnippetsDrawer";
import SftpBrowser from "./SftpBrowser";
import AgentDashboard from "./AgentDashboard";
import FKeyBar from "./chrome/FKeyBar.jsx";
import DockTabStrip from "./chrome/DockTabStrip.jsx";
import StatusBar from "./chrome/StatusBar.jsx";
import MenuBar from "./chrome/MenuBar.jsx";
import ModalHost from "./chrome/ModalHost.jsx";
import Toolbar from "./chrome/Toolbar.jsx";
import { usePaletteCommands } from "./chrome/usePaletteCommands.jsx";
import { PROVIDERS, findProvider } from "./providers.js";
import LocalFileBrowser from "./LocalFileBrowser";
import DockAssistant from "./DockAssistant";
import DockMonitor from "./DockMonitor";
import { useToast } from "../../components/Toast.jsx";
import { useConfirm } from "../../components/ConfirmModal.jsx";

import { KEY_ACTIONS, comboFromEvent, resolveBindings, setResolved, isCapturing, formatCombo } from "./keybindings.js";
import { gridDims, MAX_PANELS } from "./grid";
import { useSystemStats, useShellName, useClaudeAvailable, useRecordingState, useRegistryListener } from "./hooks/independentEffects.js";
import { useDockResize } from "./hooks/useDockResize.js";
import { useBroadcastMode } from "./hooks/useBroadcastMode.js";
import { useSnippets } from "./hooks/useSnippets.js";
import { useSavedPrompts } from "./hooks/useSavedPrompts.js";
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
import { writeToTab, writeBroadcast, getTabText, getPtyId } from "./ptyBridge.js";
import { getLayout, leafIds } from "./splitTree.js";
import { navigatePane } from "./paneNav.js";
import { reconcile, getEntry } from "./paneRegistry.js";
import { allRenderedPaneIds } from "./paneIds.js";
import { trickleTick } from "./trickle.js";
import { setProjectIndex, pruneActivities } from "./activityStore.js";
import { sshAccount } from "./sshAccount.js";

// P4-T5 trickle guard — module-level so ONE trickle runs per window realm no
// matter how the tab tree remounts. Holds the pending timeout id (null = no
// trickle active). Owned by the trickle effect below.
let trickleTimer = null;

export default function TerminalsTab({ st, save, userSt = {}, saveUser = () => {} }) {
  const state = st?.terminalsState || defaultState();
  const projects = state.projects || [];
  const toast = useToast();
  const confirm = useConfirm();

  // Stable toast bridge for the memo'd terminal tree. TerminalPanel is memo'd
  // (and its panes aren't individually memo'd), so it must NOT subscribe to the
  // toast context directly, since that would re-render every pane on every toast
  // fired anywhere in the app (why TerminalPane keeps copy-to-clipboard silent).
  // A ref holds the latest toast api behind this stable callback, so
  // TerminalPanel keeps a constant `notify` prop and its React.memo stays intact.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const notify = useCallback((variant, message) => {
    const fn = toastRef.current?.[variant] || toastRef.current?.info;
    fn?.(message);
  }, []);

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
    sharesOpen, setSharesOpen,
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
  // Saved Prompts (AI-prompt library; synced userSt.savedPrompts collection —
  // see sync/syncState.js). Read by the SnippetsDrawer "Prompts" section and by
  // DockAssistant's "/" menu; AgentMode reads it independently (it already has
  // userSt/saveUser via ModalHost, so it calls useSavedPrompts itself).
  const { prompts: savedPrompts, addPrompt: addSavedPrompt, removePrompt: removeSavedPrompt } = useSavedPrompts({ userSt, saveUser });
  const [agentOpen, setAgentOpen] = useState(false); // Native Agent Mode modal

  // MultiExec broadcast (MobaXterm-style). Transient per-window mode: when on,
  // a keystroke or snippet goes to every visible terminal at once. Not
  // persisted — auto-typing into every pane after a restart would surprise.
  const { broadcast, bcastTargets, toggleBroadcast, applyBroadcastGroup, useAllVisibleBroadcast } = useBroadcastMode(toast);

  // Pane spawn/death channel (P2-T5): drives the companion sessionListJson
  // re-derivation. Dims churn no longer re-renders TerminalsTab at all — the
  // cols×rows readout lives in the ActiveDims leaf inside StatusBar/MenuBar.
  const registryVersion = useRegistryListener();

  // Recording state for the status-bar indicator + command-palette labels
  // (recordingCapHit = MAX_EVENTS auto-stop reached).
  const { recordingTabIds, recordingCapHit } = useRecordingState();

  // Header-skin CSS is a real stylesheet now (P4-T4) — imported by
  // headerSkins.js, extracted + cached by vite; no runtime injection.

  // Registry lifecycle truth: any pane id no longer rendered by the tree is dead —
  // covers every close path (tab/panel/pane close, reset-workspace, workspace
  // load, worktree discard) with one mechanism. Runs after unmounted panes'
  // cleanups in the same commit (React child-cleanup-before-parent-effect order).
  // The activity store prunes on the same sweep (P2-T1): stale entries would
  // otherwise pin needs-you dots to dead/reused ids.
  useEffect(() => {
    const live = new Set(allRenderedPaneIds(state.panels));
    reconcile(live);
    pruneActivities(live);
  }, [state.panels]);

  // Boot-stagger trickle (P4-T5): hidden restored tabs spawn one TAB per tick
  // after boot settles, so background sessions (agent tabs with startCommands
  // the user expects running) come up without a reveal — bounded by N×300ms.
  // tabId-keyed via trickleTick/tabPaneIdGroups (a 3-split tab releases
  // together — one slot); module timer guard = one trickle per window realm;
  // panels read through a ref so mid-trickle layout changes are picked up
  // next tick; the reveal/startSpawn latch makes double-release harmless.
  //
  // Deps are [state.panels] (mini-review HIGH fix): an exhausted trickle lets
  // its timer die, and with []-deps it could never re-arm — a workspace
  // loaded AFTER boot left its hidden agent tabs inert forever, silently
  // breaking the background-startCommands promise. Every panels change now
  // re-arms an idle trickle (the armed-guard makes this a no-op storm-proof);
  // an exhausted re-scan is one cheap pure-JS pass. StrictMode: cleanup
  // clears + nulls the module timer, so the remount restarts cleanly.
  const trickleStateRef = useRef(state.panels);
  trickleStateRef.current = state.panels;
  useEffect(() => {
    if (trickleTimer !== null) return; // already armed (this or another mount)
    const tick = () => {
      trickleTimer = null;
      if (trickleTick(trickleStateRef.current)) {
        trickleTimer = setTimeout(tick, 300);
      }
      // else: nothing unspawned — timer stays dead until the next
      // state.panels change re-arms us.
    };
    trickleTimer = setTimeout(tick, 1000); // let the visible panes' boot burst settle first
    return () => {
      if (trickleTimer !== null) { clearTimeout(trickleTimer); trickleTimer = null; }
    };
  }, [state.panels]);

  // Root-pane→project index for the activity store's project rollups (P2-T1).
  // Root tab ids only — today's rollup semantics. Rebuilt on layout/project
  // changes, which re-render everything anyway; the store routes per-write
  // project notifications through it.
  useEffect(() => {
    const idx = new Map();
    for (const panel of state.panels) {
      for (const tab of panel.tabs || []) {
        if (tab.projectId) idx.set(tab.id, tab.projectId);
      }
    }
    setProjectIndex(idx);
  }, [state.panels, projects]);

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

  // Live system stats (CPU / memory / disk) for DockMonitor (polled 5s). Gated
  // on the monitor tab being SELECTED **and** the dock being open — a
  // collapsed dock with monitor selected polled a disk stat forever (P2-T5).
  const sysStats = useSystemStats(dockTab === "monitor" && !dockCollapsed);

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

  // Claude /cost telemetry (transient) + per-tab project maps. Activity lives
  // in activityStore (P2-T1) — consumers subscribe to their own slice.
  const {
    tabCosts,
    handleTabCostUpdate,
    tabAutoApprove, tabProjectNames,
    totalCost,
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
    addTab, addHomeTab, focusOrAddHomeTab, convertHomeToShell, addNotebookTab,
    closeTab, closeTabs, switchTab, renameTab, setTabColor, duplicateTab, detachTab, closeOtherTabs, moveTab, reorderTab, reopenTab,
    panelIdForTab, splitPane, closePane, activatePane, setPaneRatio, equalizePanes, moveTabIntoSplit,
  } = useWorkspaceTree({ state, persist, toast });

  // Discard an agent worktree from the diff-review modal. Close EVERY tab bound
  // to it first — a live shell cwd'd inside the folder would block git's --force
  // remove on Windows (there's normally exactly one owner; closing all defends a
  // stray sibling). Then retry the removal with backoff, since the PTY (and its
  // child agent) release the directory handle asynchronously after the kill. On
  // final failure the folder is intact and the modal stays open to retry.
  const discardWorktree = useCallback(async (wt) => {
    if (!wt?.path) return;
    const owners = [];
    for (const p of state.panels) {
      for (const t of p.tabs) {
        if (t.worktree?.path === wt.path) owners.push({ panelId: p.id, tabId: t.id });
      }
    }
    // One batched close: per-owner closeTab calls in the same tick each read
    // the same state snapshot, so only the last owner actually closed (lost
    // update) and the survivor's shell kept the folder locked.
    closeTabs(owners);
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 400 : 700));
      try {
        await invoke("worktree_remove", { repo: wt.repo, path: wt.path });
        toast.success(`Worktree "${wt.branch}" discarded.`);
        setDiffWorktree(null);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    // Leave the modal open so the user can retry once any running agent exits.
    toast.error(`Couldn't remove the worktree — a process may still be using it. Close any running agent and try again. (${lastErr})`);
  }, [state.panels, closeTabs, toast]);

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

  // Active model label — read once here so both StatusBar and MenuBar (chrome/)
  // receive an identical string prop instead of each re-deriving it from userSt.
  // (cols×rows moved into the ActiveDims leaf — P2-T5.)
  const activeModelName = userSt?.activeModel?.model;

  // ── Phone companion: publish the live session list ──────────────────────────
  // The companion server (companion.rs) can't read the webview's localStorage
  // (where the panel/tab layout lives) and doesn't know the per-spawn pty channel
  // ids (minted in pty_spawn, held only by each live TerminalPane). So the desktop
  // pushes its session list here whenever the panels/active-tab or the live PTY
  // set changes. Each entry pairs the live channel id (for `pty://` subscribe +
  // write/resize) with the tabId (the scrollback key). Harmless when the server
  // is off — it just stashes the JSON for the next `list_sessions` RPC.
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
    // registryVersion re-derives when a pane spawns/dies (getPtyId changes);
    // equal JSON short-circuits the push effect below (string identity).
    // Dims churn deliberately does NOT re-derive this (P2-T5 channel split).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.panels, state.activePanelId, registryVersion]);
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

  // "Exit" toolbar button — truly quit (kills every PTY). Needs the quit_app
  // backend command; falls back to hiding the window if it isn't available.
  const exitApp = useCallback(async () => {
    // confirm(message: string, opts) — message MUST be a string; passing an
    // object rendered it as a raw JSX child and crashed the whole UI into the
    // ErrorBoundary. Keys are confirmLabel/destructive (not confirmText/danger).
    const ok = await confirm(
      "This closes every terminal session in this window and exits the app.",
      { title: "Quit Pluto's Terminal?", confirmLabel: "Quit", destructive: true }
    );
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
  // (Activity rollups left this object in P2-T1 — MobaHomeScreen subscribes
  // to useProjectRollups itself, so an agent flip no longer churns homeApi's
  // identity through every panel.)
  const homeApi = useMemo(() => ({
    projects,
    startLocal: convertHomeToShell,
    openProject: openProjectInPanel,
    newSession: () => setDialog({ mode: "add" }),
    vnc: () => setVncOpen(true),
    rdp: () => setRdpOpen(true),
    serial: () => setSerialOpen(true),
  }), [projects, convertHomeToShell, openProjectInPanel]);

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

  // Recording-jump: switch to the tab that's actively recording so the user
  // can trigger stop-and-save from a natural place. Hoisted out of the status
  // bar's inline JSX handler (byte-preserved) so the chrome extraction can
  // receive it as a plain callback instead of closing over `state`/`persist`.
  const jumpToRecordingTab = useCallback((recTabId) => {
    const target = state.panels.find((p) => p.tabs.some((t) => t.id === recTabId));
    if (!target) return;
    setActivePanel(target.id);
    persist({ ...state, activePanelId: target.id, panels: state.panels.map((p) =>
      p.id === target.id ? { ...p, activeTabId: recTabId } : p
    ) });
  }, [state, persist, setActivePanel]);

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
      splitActivePane: (dir) => {
        const panel = state.panels.find((p) => p.id === state.activePanelId);
        const tab = panel?.tabs.find((t) => t.id === panel.activeTabId);
        if (!tab || tab.home || tab.notebook) return;
        splitPane(tab.id, tab.activePaneId || tab.id, dir);
      },
      closeActivePane: () => {
        const panel = state.panels.find((p) => p.id === state.activePanelId);
        const tab = panel?.tabs.find((t) => t.id === panel.activeTabId);
        if (!tab || tab.home || tab.notebook) return;
        // Splits only — a single-pane tab is "close tab" (Ctrl+Shift+W)
        // territory; aliasing this to tab-close would invite accidents.
        if (leafIds(getLayout(tab)).length <= 1) return;
        closePane(tab.id, tab.activePaneId || tab.id);
      },
      focusPane: (dir) => {
        const panel = state.panels.find((p) => p.id === state.activePanelId);
        const tab = panel?.tabs.find((t) => t.id === panel.activeTabId);
        if (!tab || tab.home || tab.notebook) return;
        const target = navigatePane(getLayout(tab), tab.activePaneId || tab.id, dir);
        if (!target) return;
        activatePane(tab.id, target);
        // activatePane only marks workspace state; keyboard nav must move real
        // keyboard focus too (a click does it natively — arrows can't). The
        // registry holds the live xterm; defer past this keydown's dispatch.
        setTimeout(() => { try { getEntry(target)?.term?.focus(); } catch {} }, 0);
      },
    };
  });
  // Live-combo lookup for command-palette shortcut chips (reflects remaps).
  const scOf = useCallback((actionId) => {
    const c = resolvedBindings.byAction.get(actionId);
    return c ? formatCombo(c) : undefined;
  }, [resolvedBindings]);

  // ── Stable ProjectSidebar handlers ─────────────────────────────────────
  // ProjectSidebar is memo()'d, so its function props must keep identity across
  // the hot re-render paths (the 5s sysStats poll, per-token cost telemetry).
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
    // null = active panel, resolved inside the hook at call time — closing
    // over state.activePanelId here re-minted this on every panel focus and
    // busted the sidebar memo (T2 review).
    (id) => openProjectInPanel(null, id),
    [openProjectInPanel]
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

  // Command-palette item array — memoized in the hook so its identity stays
  // stable across the hot-path ticks (5s sysStats poll, per-token cost
  // telemetry) and CommandPalette can bail out of re-rendering. Dep contract
  // lives in chrome/usePaletteCommands.jsx: 22 args fields + toast/confirm
  // read from context inside the hook.
  const paletteCommands = usePaletteCommands({
    scOf, addTab, addPanel, canAddPanel, splitPane, equalizePanes, closePane, importSshConfig,
    activeTabId, activeTab, activeTabRecording, broadcast, toggleBroadcast,
    ribbon, selectRibbon, focusFilesDock, tunnelsOpen, setTunnelsOpen, openTunnels,
    stopAndSaveRecording, startRecordingActive, persist, state, setActivePanel,
    setDialog, setSshKeysOpen, setMacrosOpen, setMasterPwOpen, setAskOpen,
    setAgentOpen, setSummary, setHistoryOpen, setWorkspacesOpen, setModelsOpen,
    setSerialOpen, setVncOpen, setRdpOpen, setRemoteOpen, setBroadcastGroupOpen,
    setNetToolsOpen, setMcpOpen, setSetupOpen, setSettingsOpen,
  });

  return (
    <div className="phn-page" data-phn-skin={headerSkinId} data-phn-theme={customThemeActive ? "custom" : undefined} style={{ height: "100%", position: "relative" }}>
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* MobaXterm menu bar — classic dropdown menus wired to existing actions. */}
      <MenuBar
        addTab={addTab}
        addHomeTab={addHomeTab}
        addNotebookTab={addNotebookTab}
        addPanel={addPanel}
        canAddPanel={canAddPanel}
        splitPane={splitPane}
        equalizePanes={equalizePanes}
        closeTab={closeTab}
        activeTab={activeTab}
        panels={state.panels}
        activePanelId={state.activePanelId}
        importSshConfig={importSshConfig}
        selectRibbon={selectRibbon}
        openTunnels={openTunnels}
        broadcast={broadcast}
        toggleBroadcast={toggleBroadcast}
        ribbon={ribbon}
        activeTabId={activeTabId}
        activeModelName={activeModelName}
        toggleTheme={toggleTheme}
        headerSkinId={headerSkinId}
        exitApp={exitApp}
        setDialog={setDialog}
        setSshKeysOpen={setSshKeysOpen}
        setSerialOpen={setSerialOpen}
        setVncOpen={setVncOpen}
        setRdpOpen={setRdpOpen}
        setNetToolsOpen={setNetToolsOpen}
        setMacrosOpen={setMacrosOpen}
        setAskOpen={setAskOpen}
        setSummary={setSummary}
        setHistoryOpen={setHistoryOpen}
        setModelsOpen={setModelsOpen}
        setBroadcastGroupOpen={setBroadcastGroupOpen}
        setRemoteOpen={setRemoteOpen}
        setMcpOpen={setMcpOpen}
        setSetupOpen={setSetupOpen}
        setCommandPaletteOpen={setCommandPaletteOpen}
        setWorkspacesOpen={setWorkspacesOpen}
        setSettingsOpen={setSettingsOpen}
        setMasterPwOpen={setMasterPwOpen}
        setSharesOpen={setSharesOpen}
      />
      {/* MobaXterm grouped icon toolbar — captioned button groups, themed via
          the active skin's --phn-* vars (see MobaToolbar.jsx + terminals.css). */}
      <Toolbar
        activeTabId={activeTabId}
        activeTab={activeTab}
        splitPane={splitPane}
        broadcast={broadcast}
        toggleBroadcast={toggleBroadcast}
        tunnelsOpen={tunnelsOpen}
        setTunnelsOpen={setTunnelsOpen}
        openTunnels={openTunnels}
        ribbon={ribbon}
        selectRibbon={selectRibbon}
        setDialog={setDialog}
        setSerialOpen={setSerialOpen}
        setAskOpen={setAskOpen}
        setAgentOpen={setAgentOpen}
        setModelsOpen={setModelsOpen}
        totalCost={totalCost}
        quickConnect={quickConnect}
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
                prompts={savedPrompts}
                onAddPrompt={addSavedPrompt}
                onRemovePrompt={removeSavedPrompt}
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
              onSplitDropTab={moveTabIntoSplit}
              saveUser={saveUser}
              notify={notify}
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
              <DockTabStrip dockTab={dockTab} setDockTab={setDockTab} collapseDock={collapseDock} />
              <div className="moba-rd-body">
                {dockTab === "assistant" ? (
                  <DockAssistant onSendToTerminal={sendToActiveTerminal} shellName={shellName} cwd={activeTab?.cwd} prompts={savedPrompts} />
                ) : dockTab === "monitor" ? (
                  <DockMonitor sysStats={sysStats} panels={state.panels} />
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

      {/* Modal / overlay layer — pure JSX re-home; every flag/payload/handler
          stays in this component and passes through. See chrome/ModalHost.jsx. */}
      <ModalHost
        tunnelsOpen={tunnelsOpen}
        setTunnelsOpen={setTunnelsOpen}
        forwards={forwards}
        tunnelBusy={tunnelBusy}
        tunnelError={tunnelError}
        startForward={startForward}
        startSocks={startSocks}
        stopForward={stopForward}
        serialOpen={serialOpen}
        setSerialOpen={setSerialOpen}
        connectSerial={connectSerial}
        vncOpen={vncOpen}
        setVncOpen={setVncOpen}
        vncLaunch={vncLaunch}
        setVncLaunch={setVncLaunch}
        connectVnc={connectVnc}
        launchVnc={launchVnc}
        rdpOpen={rdpOpen}
        setRdpOpen={setRdpOpen}
        rdpLaunch={rdpLaunch}
        setRdpLaunch={setRdpLaunch}
        connectRdp={connectRdp}
        launchRdp={launchRdp}
        saveQuickConnection={saveQuickConnection}
        dialog={dialog}
        setDialog={setDialog}
        dialogInitial={dialogInitial}
        handleSaveDialog={handleSaveDialog}
        projects={projects}
        sshPrompt={sshPrompt}
        setSshPrompt={setSshPrompt}
        submitSshPassword={submitSshPassword}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        st={st}
        save={save}
        userSt={userSt}
        saveUser={saveUser}
        diffWorktree={diffWorktree}
        setDiffWorktree={setDiffWorktree}
        discardWorktree={discardWorktree}
        modelsOpen={modelsOpen}
        setModelsOpen={setModelsOpen}
        askOpen={askOpen}
        setAskOpen={setAskOpen}
        agentOpen={agentOpen}
        setAgentOpen={setAgentOpen}
        summary={summary}
        setSummary={setSummary}
        historyOpen={historyOpen}
        setHistoryOpen={setHistoryOpen}
        workspacesOpen={workspacesOpen}
        setWorkspacesOpen={setWorkspacesOpen}
        workspaces={workspaces}
        saveWorkspace={saveWorkspace}
        loadWorkspace={loadWorkspace}
        deleteWorkspace={deleteWorkspace}
        broadcastGroupOpen={broadcastGroupOpen}
        setBroadcastGroupOpen={setBroadcastGroupOpen}
        panels={state.panels}
        bcastTargets={bcastTargets}
        applyBroadcastGroup={applyBroadcastGroup}
        useAllVisibleBroadcast={useAllVisibleBroadcast}
        netToolsOpen={netToolsOpen}
        setNetToolsOpen={setNetToolsOpen}
        remoteOpen={remoteOpen}
        setRemoteOpen={setRemoteOpen}
        sshKeysOpen={sshKeysOpen}
        setSshKeysOpen={setSshKeysOpen}
        macrosOpen={macrosOpen}
        setMacrosOpen={setMacrosOpen}
        masterPwOpen={masterPwOpen}
        setMasterPwOpen={setMasterPwOpen}
        mcpOpen={mcpOpen}
        setMcpOpen={setMcpOpen}
        setupOpen={setupOpen}
        setSetupOpen={setSetupOpen}
        commandPaletteOpen={commandPaletteOpen}
        setCommandPaletteOpen={setCommandPaletteOpen}
        paletteCommands={paletteCommands}
        sharesOpen={sharesOpen}
        setSharesOpen={setSharesOpen}
        activeTab={activeTab}
        activeTabId={activeTabId}
        shellName={shellName}
        insertSnippet={insertSnippet}
      />

      {/* Status bar — bottom strip with version, claude availability, cost. Skin-controlled. */}
      <StatusBar
        activeTab={activeTab}
        activeTabId={activeTabId}
        shellName={shellName}
        broadcast={broadcast}
        bcastTargets={bcastTargets}
        setBroadcastGroupOpen={setBroadcastGroupOpen}
        recordingTabIds={recordingTabIds}
        activeTabRecording={activeTabRecording}
        recordingCapHit={recordingCapHit}
        stopAndSaveRecording={stopAndSaveRecording}
        onJumpToRecording={jumpToRecordingTab}
        totalCost={totalCost}
        activeModelName={activeModelName}
        claudeAvailable={claudeAvailable}
      />

      {/* F-key quick-action bar (MobaXterm-style) */}
      <FKeyBar
        addTab={addTab}
        activePanelId={state.activePanelId}
        activeTabId={activeTabId}
        activeTab={activeTab}
        splitPane={splitPane}
        selectRibbon={selectRibbon}
        setCommandPaletteOpen={setCommandPaletteOpen}
        setAskOpen={setAskOpen}
        setHistoryOpen={setHistoryOpen}
        setModelsOpen={setModelsOpen}
        setMacrosOpen={setMacrosOpen}
      />
      </div>
    </div>
  );
}
