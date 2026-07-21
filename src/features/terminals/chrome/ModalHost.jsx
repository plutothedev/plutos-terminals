// (C)
// Every modal / overlay TerminalsTab renders, re-homed verbatim (Stream B2
// Task 5). Pure JSX relocation: all open-flags, payloads, and handlers stay in
// the parent and arrive as pass-through props; no modal's own props changed.
// Renders as a fragment so the DOM parent (the flex-column page div) is
// unchanged.
import ProjectDialog from "../ProjectDialog";
import SshPasswordModal from "../SshPasswordModal";
import TunnelsModal from "../TunnelsModal";
import SerialModal from "../SerialModal";
import DiffView from "../DiffView";
import ModelPicker from "../ModelPicker";
import SshKeysModal from "../SshKeysModal";
import MacrosModal from "../MacrosModal";
import MasterPasswordModal from "../MasterPasswordModal";
import AskBar from "../AskBar";
import AgentMode from "../AgentMode";
import SessionSummary from "../SessionSummary";
import HistorySearch from "../HistorySearch";
import WorkspacesModal from "../WorkspacesModal";
import SharesModal from "../SharesModal.jsx";
import BroadcastGroupModal from "../BroadcastGroupModal";
import NetToolsModal from "../NetToolsModal";
import RemoteControlModal from "../RemoteControlModal.jsx";
import VncConnectModal from "../VncConnectModal";
import RdpConnectModal from "../RdpConnectModal";
import OnboardingOverlay from "../OnboardingOverlay";
import SettingsModal from "../../../components/SettingsModal.jsx";
import McpInstaller from "../../../components/McpInstaller.jsx";
import SetupChecker from "../../../components/SetupChecker.jsx";
import CommandPalette from "../../../components/CommandPalette.jsx";
import { writeToTab, getCommandHistory, getLiveTabIds } from "../ptyBridge.js";

export default function ModalHost({
  // tunnels
  tunnelsOpen, setTunnelsOpen, forwards, tunnelBusy, tunnelError, startForward, startSocks, stopForward,
  // serial
  serialOpen, setSerialOpen, connectSerial,
  // vnc / rdp quick-connect + saved-session launch
  vncOpen, setVncOpen, vncLaunch, setVncLaunch, connectVnc, launchVnc,
  rdpOpen, setRdpOpen, rdpLaunch, setRdpLaunch, connectRdp, launchRdp,
  saveQuickConnection,
  // session dialog
  dialog, setDialog, dialogInitial, handleSaveDialog, projects,
  // ssh password prompt
  sshPrompt, setSshPrompt, submitSshPassword,
  // settings
  settingsOpen, setSettingsOpen, st, save, userSt, saveUser,
  // diff review
  diffWorktree, setDiffWorktree, discardWorktree,
  // models
  modelsOpen, setModelsOpen,
  // ask AI / agent mode
  askOpen, setAskOpen, agentOpen, setAgentOpen,
  // session summary
  summary, setSummary,
  // history search
  historyOpen, setHistoryOpen,
  // workspaces
  workspacesOpen, setWorkspacesOpen, workspaces, saveWorkspace, loadWorkspace, deleteWorkspace,
  // broadcast targets
  broadcastGroupOpen, setBroadcastGroupOpen, panels, bcastTargets, applyBroadcastGroup, useAllVisibleBroadcast,
  // network tools
  netToolsOpen, setNetToolsOpen,
  // remote control / ssh keys / macros / master password
  remoteOpen, setRemoteOpen, sshKeysOpen, setSshKeysOpen,
  macrosOpen, setMacrosOpen, masterPwOpen, setMasterPwOpen,
  // MCP installer / setup checker
  mcpOpen, setMcpOpen, setupOpen, setSetupOpen,
  // command palette
  commandPaletteOpen, setCommandPaletteOpen, paletteCommands,
  // "My shares" gist list (Stream D)
  sharesOpen, setSharesOpen,
  // shared session context
  activeTab, activeTabId, shellName, insertSnippet,
}) {
  return (
    <>
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
        onDiscard={discardWorktree}
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
        userSt={userSt}
        saveUser={saveUser}
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

      <SharesModal
        open={sharesOpen}
        shareHistory={userSt?.shareHistory}
        saveUser={saveUser}
        onClose={() => setSharesOpen(false)}
      />

      <BroadcastGroupModal
        open={broadcastGroupOpen}
        panels={panels}
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
    </>
  );
}
