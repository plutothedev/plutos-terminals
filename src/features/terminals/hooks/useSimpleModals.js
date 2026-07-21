// (C)
// The pure on/off modal toggles, lifted verbatim out of the TerminalsTab god
// component. These are the ~16 booleans with NO payload and NO coupling to
// session/grid state — each is a plain useState(false) flipped by a menu /
// toolbar / command-palette action and read by the matching modal's `open`
// prop. Payload modals (dialog, summary, diffWorktree, sshPrompt, vncLaunch,
// rdpLaunch, sftp) and the tunnel lifecycle stay in TerminalsTab; they carry
// orchestration state and are extracted in later steps.
//
// serialOpen / vncOpen / rdpOpen are the ephemeral quick-connect toggles; their
// SAVED-session launch payloads (vncLaunch / rdpLaunch) stay behind, and the JSX
// composes `open={vncOpen || !!vncLaunch}` by reading both. The connect/launch
// callbacks (still in TerminalsTab for now) flip these via the returned setters.

import { useState } from "react";

export function useSimpleModals() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [sshKeysOpen, setSshKeysOpen] = useState(false);
  const [macrosOpen, setMacrosOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [masterPwOpen, setMasterPwOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [broadcastGroupOpen, setBroadcastGroupOpen] = useState(false);
  const [netToolsOpen, setNetToolsOpen] = useState(false);
  const [serialOpen, setSerialOpen] = useState(false);
  const [vncOpen, setVncOpen] = useState(false);
  const [rdpOpen, setRdpOpen] = useState(false);
  const [sharesOpen, setSharesOpen] = useState(false); // "My shares" gist list (Stream D)
  return {
    settingsOpen, setSettingsOpen,
    mcpOpen, setMcpOpen,
    modelsOpen, setModelsOpen,
    sshKeysOpen, setSshKeysOpen,
    macrosOpen, setMacrosOpen,
    askOpen, setAskOpen,
    historyOpen, setHistoryOpen,
    workspacesOpen, setWorkspacesOpen,
    masterPwOpen, setMasterPwOpen,
    setupOpen, setSetupOpen,
    commandPaletteOpen, setCommandPaletteOpen,
    broadcastGroupOpen, setBroadcastGroupOpen,
    netToolsOpen, setNetToolsOpen,
    serialOpen, setSerialOpen,
    vncOpen, setVncOpen,
    rdpOpen, setRdpOpen,
    sharesOpen, setSharesOpen,
  };
}
