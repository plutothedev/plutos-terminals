// (C)
import { useMemo } from "react";
import { invoke } from "@backend";
import { GITHUB_URL, DISCORD_URL, openExternal } from "../../../appMeta.js";
import { IconMoon, IconSun, IconExit } from "../icons.jsx";
import { getTabText } from "../ptyBridge.js";
import { useToast } from "../../../components/Toast.jsx";
import MobaMenuBar from "../MobaMenuBar.jsx";

export default function MenuBar({
  addTab, addHomeTab, addPanel, canAddPanel, splitPane, closeTab,
  activeTabId, activeTab, panels, activePanelId,
  importSshConfig, selectRibbon, openTunnels,
  broadcast, toggleBroadcast, ribbon,
  activeDims, activeModelName, toggleTheme, headerSkinId, exitApp,
  setDialog, setSshKeysOpen, setSerialOpen, setVncOpen, setRdpOpen, setNetToolsOpen,
  setMacrosOpen, setAskOpen, setSummary, setHistoryOpen, setModelsOpen,
  setBroadcastGroupOpen, setRemoteOpen, setMcpOpen, setSetupOpen,
  setCommandPaletteOpen, setWorkspacesOpen, setSettingsOpen, setMasterPwOpen,
}) {
  const toast = useToast();

  const menuBarMenus = useMemo(() => [
    {
      label: "Terminal",
      items: [
        { label: "New tab", shortcut: "Ctrl+Shift+T", action: () => addTab(activePanelId) },
        { label: "Launch screen (home tab)", action: () => addHomeTab(activePanelId) },
        { label: "New panel", disabled: !canAddPanel, action: () => addPanel() },
        { divider: true },
        { label: "Split right", action: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "row") },
        { label: "Split down", action: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "col") },
        { divider: true },
        { label: "Close tab", shortcut: "Ctrl+Shift+W", action: () => { const p = panels.find((x) => x.id === activePanelId); if (p && p.tabs.length > 1 && p.activeTabId) closeTab(p.id, p.activeTabId); } },
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
    activeTabId, activeTab, panels, activePanelId,
    toast, importSshConfig, selectRibbon, openTunnels,
    broadcast, toggleBroadcast, ribbon,
  ]);

  return (
    <MobaMenuBar
      brand={<><span className="moba-brand-dot" />Pluto</>}
      right={
        <>
          {activeDims && <span className="moba-mb-dim">{activeDims.cols}×{activeDims.rows}</span>}
          <span className="moba-mb-model"><span className="moba-mb-modeldot" />{activeModelName || "claude"}</span>
          <button className="moba-mb-icon" onClick={toggleTheme} title="Toggle dark / light chrome (Ctrl+\\)">{headerSkinId === "moba-light" ? <IconSun size={14} /> : <IconMoon size={14} />}</button>
          <button className="moba-mb-icon" onClick={exitApp} title="Quit (closes all sessions)"><IconExit size={14} /></button>
        </>
      }
      menus={menuBarMenus}
    />
  );
}
