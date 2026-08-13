// (C)
// The command-palette item array, extracted from TerminalsTab as a hook
// (Stream B2 Task 7; .jsx because the body is full of icon JSX). The array
// was once rebuilt inline on EVERY render — including the 5s sysStats poll
// and per-token cost telemetry, which don't touch any value it reads. The
// useMemo keeps its identity stable across those hot paths so CommandPalette
// can bail out of re-rendering.
//
// Dependency contract (byte-preserved from the pre-extraction memo): the same
// 24 tracked dependencies, of which 22 arrive as named fields on the single
// `args` object (the dep array lists args.<field> for each) and 2 — toast and
// confirm — are context values read via useToast()/useConfirm() HERE and
// listed as the locals. All useState setters and module imports are stable and
// intentionally omitted from the dep list, exactly as before. state/persist DO
// cross into this hook (the reset-workspace action needs them) — the
// sanctioned exception, matching the useWorkspaceTree/useProjects convention.
import { useMemo } from "react";
import { invoke } from "@backend";
import { MAX_PANELS } from "../grid";
import { defaultState } from "../workspaceModel.js";
import { getTabText } from "../ptyBridge.js";
import { modCombo } from "../keybindings.js";
import {
  SSsh, SSerial, SSplit, SSplitRow, SSplitCol, STunnel, SAsk, SModels, SSnips,
  SMouse, SWindows, SFolder, SLock, SKey, SRocket, SGear, SBot, SDoc, SClock, SLayout, SBroadcast, STarget, SPlug, SPhone, SRecord, SStop, SReset,
} from "../toolbarIcons.jsx";
import { useToast } from "../../../components/Toast.jsx";
import { useConfirm } from "../../../components/ConfirmModal.jsx";

export function usePaletteCommands(args) {
  const toast = useToast();
  const confirm = useConfirm();
  const {
    // dep-array fields (reactive values + hook useCallbacks)
    scOf, addTab, addPanel, canAddPanel, splitPane, equalizePanes, closePane, importSshConfig,
    activeTabId, activeTab, activeTabRecording, broadcast, toggleBroadcast,
    ribbon, selectRibbon, focusFilesDock, tunnelsOpen, setTunnelsOpen, openTunnels,
    stopAndSaveRecording, startRecordingActive, persist, state, setActivePanel,
    // stable React-state setters (dep-exempt, same as pre-extraction)
    setDialog, setSshKeysOpen, setMacrosOpen, setMasterPwOpen, setAskOpen,
    setAgentOpen, setSummary, setHistoryOpen, setWorkspacesOpen, setModelsOpen,
    setSerialOpen, setVncOpen, setRdpOpen, setRemoteOpen, setBroadcastGroupOpen,
    setNetToolsOpen, setMcpOpen, setSetupOpen, setSettingsOpen,
  } = args;

  return useMemo(() => [
    { id: "new-tab", icon: "+", label: "New tab in active panel", shortcut: scOf("newTab"), action: () => addTab(state.activePanelId) },
    { id: "new-session", icon: <SSsh size={14} />, label: "New session", hint: "Save a local folder or an SSH host to the sidebar", action: () => setDialog({ mode: "add" }) },
    { id: "import-ssh", icon: <SKey size={14} />, label: "Import ~/.ssh/config", hint: "Add every SSH host from your OpenSSH config to the Sessions tree", action: () => importSshConfig() },
    { id: "ssh-keys", icon: <SKey size={14} />, label: "SSH keys", hint: "List / generate SSH keypairs; copy a public key to a server", action: () => setSshKeysOpen(true) },
    { id: "macros", icon: <SRecord size={14} />, label: "Keystroke macros", hint: "Record what you type and replay it into the active terminal", action: () => setMacrosOpen(true) },
    { id: "master-pw", icon: <SLock size={14} />, label: "App lock (master password)", hint: "Lock the app behind a password on launch", action: () => setMasterPwOpen(true) },
    { id: "split-right", icon: <SSplitRow size={14} />, label: "Split active pane right", hint: "Side-by-side terminals in the current tab", shortcut: scOf("splitRight"), action: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "row") },
    { id: "split-down", icon: <SSplitCol size={14} />, label: "Split active pane down", hint: "Stacked terminals in the current tab", shortcut: scOf("splitDown"), action: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "col") },
    // Split-tab-only commands: hidden on single-pane tabs (close would surprise
    // by closing the tab; equalize would be a no-op).
    ...(activeTab?.layout ? [
      { id: "equalize-splits", icon: <SSplit size={14} />, label: "Equalize split sizes", hint: "Reset every divider in this tab to 50/50", action: () => equalizePanes(activeTabId) },
      { id: "close-pane", icon: <SSplit size={14} />, label: "Close active pane", hint: "Close the focused pane; its neighbor takes the space", shortcut: scOf("closePane"), action: () => closePane(activeTabId, activeTab?.activePaneId || activeTabId) },
    ] : []),
    { id: "add-panel", icon: "+", label: "Add panel", hint: canAddPanel ? "" : `Max ${MAX_PANELS} panels`, action: () => canAddPanel && addPanel() },
    { id: "ask", icon: <SAsk size={14} />, label: "Ask AI — natural language → command", hint: "Describe what you want; get a reviewable shell command", shortcut: scOf("askAi"), action: () => setAskOpen(true) },
    { id: "agent", icon: <SBot size={14} />, label: "Agent Mode — describe a goal, it runs the commands", hint: "An in-app agent runs commands in the active terminal to accomplish your goal", shortcut: scOf("agentMode"), action: () => setAgentOpen(true) },
    { id: "summarize", icon: <SDoc size={14} />, label: "Summarize this session (AI)", hint: "AI summary of the active terminal's recent output", action: () => { if (!activeTabId) { toast.error("No active terminal."); return; } setSummary({ text: getTabText(activeTabId) }); } },
    { id: "history", icon: <SClock size={14} />, label: "Command history search", hint: `Fuzzy search past commands — Enter inserts, ${modCombo("Enter")} runs`, shortcut: scOf("history"), action: () => setHistoryOpen(true) },
    { id: "workspaces", icon: <SLayout size={14} />, label: "Workspaces — save / restore layout", hint: "Save the current panels/tabs/splits as a named workspace, or restore one", action: () => setWorkspacesOpen(true) },
    { id: "models", icon: <SModels size={14} />, label: "Models — pick provider + model", hint: "Claude, Hermes, Gemini, GLM, Qwen, MiniMax, Kimi, OpenRouter, NVIDIA, HF… or any endpoint", action: () => setModelsOpen(true) },
    { id: "snippets", icon: <SSnips size={14} />, label: "Workflows panel", hint: "Saved parameterized commands — click to run", action: () => selectRibbon(ribbon === "snippets" ? null : "snippets") },
    { id: "files", icon: <SFolder size={14} />, label: "File browser (SFTP) — focus right dock", hint: "Local files, or remote SFTP for an SSH tab, in the right dock (F4)", action: () => focusFilesDock() },
    { id: "tunnels", icon: <STunnel size={14} />, label: "SSH port forwarding", hint: "Forward a local port through the active SSH session", action: () => (tunnelsOpen ? setTunnelsOpen(false) : openTunnels()) },
    { id: "serial", icon: <SSerial size={14} />, label: "Serial console", hint: "Connect to a USB/UART serial device", action: () => setSerialOpen((v) => !v) },
    { id: "vnc", icon: <SMouse size={14} />, label: "VNC remote desktop", hint: "Connect to a VNC server (e.g. macOS Screen Sharing on localhost:5900)", action: () => setVncOpen(true) },
    { id: "rdp", icon: <SWindows size={14} />, label: "RDP remote desktop", hint: "Connect to a Windows / xrdp host over RDP (NLA)", action: () => setRdpOpen(true) },
    { id: "remote-control", icon: <SPhone size={14} />, label: "Remote control (phone)", hint: "Run a private server so your phone can view + type into your terminals over Tailscale", action: () => setRemoteOpen(true) },
    { id: "broadcast", icon: <SBroadcast size={14} />, label: broadcast ? "Turn off broadcast typing" : "Turn on broadcast typing", hint: "Type once, send to every visible terminal at once", action: () => toggleBroadcast() },
    { id: "broadcast-group", icon: <STarget size={14} />, label: "Broadcast targets…", hint: "Pick a subset of terminals for broadcast typing instead of all visible", action: () => setBroadcastGroupOpen(true) },
    { id: "nettools", icon: <SSsh size={14} />, label: "Network tools", hint: "Ping, traceroute, TCP port scan, and DNS lookup", action: () => setNetToolsOpen(true) },
    { id: "toggle-sidebar", icon: <SSplit size={14} />, label: ribbon ? "Hide tools panel" : "Show tools panel", hint: "Show or hide the Workflows / Fleet panel beside the session tree", action: () => selectRibbon(ribbon ? null : "snippets") },
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
    args.scOf, args.addTab, args.addPanel, args.canAddPanel, args.splitPane, args.equalizePanes, args.closePane, args.importSshConfig,
    args.activeTabId, args.activeTab, args.activeTabRecording, args.broadcast, args.toggleBroadcast,
    args.ribbon, args.selectRibbon, args.focusFilesDock, args.tunnelsOpen, args.setTunnelsOpen, args.openTunnels,
    args.stopAndSaveRecording, args.startRecordingActive, toast, confirm,
    args.persist, args.state, args.setActivePanel,
  ]);
}
