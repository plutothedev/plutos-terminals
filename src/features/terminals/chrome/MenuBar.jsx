// (C)
import { useCallback, useMemo, useState } from "react";
import { invoke } from "@backend";
import { GITHUB_URL, DISCORD_URL, openExternal } from "../../../appMeta.js";
import { IconMoon, IconSun, IconExit } from "../icons.jsx";
import { getTabText } from "../ptyBridge.js";
import { useToast } from "../../../components/Toast.jsx";
import { usePrompt } from "../../../components/PromptModal.jsx";
import Modal from "../../../components/Modal.jsx";
import { Button } from "../../../components/ui.jsx";
import { toNotebookName } from "../notebookIo.js";
import MobaMenuBar from "../MobaMenuBar.jsx";

export default function MenuBar({
  addTab, addHomeTab, addNotebookTab, addPanel, canAddPanel, splitPane, closeTab,
  activeTabId, activeTab, panels, activePanelId,
  importSshConfig, selectRibbon, openTunnels,
  broadcast, toggleBroadcast, ribbon,
  activeDims, activeModelName, toggleTheme, headerSkinId, exitApp,
  setDialog, setSshKeysOpen, setSerialOpen, setVncOpen, setRdpOpen, setNetToolsOpen,
  setMacrosOpen, setAskOpen, setSummary, setHistoryOpen, setModelsOpen,
  setBroadcastGroupOpen, setRemoteOpen, setMcpOpen, setSetupOpen,
  setCommandPaletteOpen, setWorkspacesOpen, setSettingsOpen, setMasterPwOpen,
  setSharesOpen,
}) {
  const toast = useToast();
  const prompt = usePrompt();
  const [notebookList, setNotebookList] = useState(null); // null = picker closed; array of names = open

  // "New notebook…" (Stream C): the typed text is SANITIZED to a gate-valid
  // filename (notebookIo.toNotebookName) rather than blindly given ".md". The
  // old path appended ".md" to anything — "meeting notes", "café", "notes.md" —
  // and minted a tab whose every save the Rust gate rejected, losing content
  // silently. Now an unusable name is rejected up front with a reason, and the
  // friendly typed text rides along as the tab label while the sanitized name is
  // what hits disk.
  const newNotebook = useCallback(async () => {
    const typed = await prompt("New notebook name?", { title: "New notebook", confirmLabel: "create", placeholder: "notebook name" });
    if (typed == null || !typed.trim()) return; // cancelled or empty — silent, matches window.prompt
    const result = toNotebookName(typed);
    if (!result.ok) { toast.error(`Can't use that notebook name: ${result.reason}.`); return; }
    addNotebookTab(activePanelId, result.name, typed.trim());
  }, [prompt, addNotebookTab, activePanelId, toast]);

  // "Open notebook…" (whole-stream-review Fix 2 — notebook_list had zero
  // callers, so saved notebooks were unreachable once their tab closed). List
  // the on-disk notebooks and, if any, open a picker; selecting one routes
  // through addNotebookTab, which dedupes to an already-open tab or opens fresh.
  const openNotebook = useCallback(async () => {
    let names;
    try {
      names = await invoke("notebook_list");
    } catch (e) {
      toast.error(`Couldn't list notebooks: ${e}`);
      return;
    }
    if (!Array.isArray(names) || names.length === 0) { toast.info("No saved notebooks yet."); return; }
    setNotebookList(names);
  }, [toast]);

  const pickNotebook = useCallback((name) => {
    setNotebookList(null);
    addNotebookTab(activePanelId, name);
  }, [addNotebookTab, activePanelId]);

  const menuBarMenus = useMemo(() => [
    {
      label: "Terminal",
      items: [
        { label: "New tab", shortcut: "Ctrl+Shift+T", action: () => addTab(activePanelId) },
        { label: "New notebook…", action: newNotebook },
        { label: "Open notebook…", action: openNotebook },
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
        { label: "My shares (shared gists)…", action: () => setSharesOpen(true) },
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
    addTab, addHomeTab, newNotebook, openNotebook, addPanel, canAddPanel, splitPane, closeTab,
    activeTabId, activeTab, panels, activePanelId,
    toast, importSshConfig, selectRibbon, openTunnels,
    broadcast, toggleBroadcast, ribbon,
  ]);

  return (
    <>
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

      {/* Open-notebook picker: a minimal list over notebook_list. Reuses the
          shared Modal (skin-consistent, focus-trapped, Esc/backdrop dismiss)
          rather than a bespoke component or a nested menu-bar submenu, which
          MobaMenuBar's flat item model doesn't support. */}
      <Modal open={notebookList != null} title="Open notebook" onClose={() => setNotebookList(null)} width={420}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: "min(60vh, 420px)", overflowY: "auto" }}>
          {(notebookList || []).map((name) => (
            <Button
              key={name}
              variant="ghost"
              onClick={() => pickNotebook(name)}
              style={{ width: "100%", justifyContent: "flex-start", textAlign: "left", fontFamily: "var(--phn-mono-font, monospace)" }}
            >
              {name}
            </Button>
          ))}
        </div>
      </Modal>
    </>
  );
}
