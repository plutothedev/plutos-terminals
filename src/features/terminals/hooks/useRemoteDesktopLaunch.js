// (C)
// The modal-driven session launchers lifted verbatim out of the TerminalsTab god
// component: VNC + RDP remote-desktop connects (ephemeral quick-connect AND
// saved-session launch), the serial-console connect, and promoting a quick
// connection to a saved sidebar session. SSH launching is NOT here — it flows
// through openProjectInPanel / quickConnect (which read grid state) and stays in
// TerminalsTab for now.
//
// Passwords are transient: connect/launch put the secret in the ptyBridge
// (setTabPassword, keyed by the new tab id) and, for saved RDP/VNC, in the
// in-memory rememberSessionPassword cache — NEVER persisted (FR-008).
// setVncLaunch / setRdpLaunch are returned so the grid's openProjectInPanel can
// open the saved-session password modal.

import { useCallback, useState } from "react";
import { setTabPassword } from "../ptyBridge.js";
import { freshId } from "../ids.js";

export function useRemoteDesktopLaunch({
  state,
  spawnSessionTab,
  rememberSessionPassword,
  setSerialOpen,
  setVncOpen,
  setRdpOpen,
  upsertProject,
  toast,
}) {
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

  // `vncOpen` (useSimpleModals) = ephemeral quick-connect; `vncLaunch` =
  // { panelId, project } when opening a SAVED VNC session (the modal then acts
  // as a password prompt, T006).
  const [vncLaunch, setVncLaunch] = useState(null);
  const connectVnc = useCallback(({ host, port, password }) => {
    const tabId = freshId("tab");
    if (password) setTabPassword(tabId, password); // transient, never persisted
    spawnSessionTab(state.activePanelId, {
      id: tabId,
      label: `VNC: ${host}`,
      cwd: null,
      startCommands: [],
      projectId: null,
      vnc: { host, port },
    });
    setVncOpen(false);
  }, [state.activePanelId, spawnSessionTab]);
  const launchVnc = useCallback(({ password }) => {
    if (!vncLaunch) return;
    const { panelId, project } = vncLaunch;
    rememberSessionPassword(project.id, password || ""); // in-memory only (FR-008)
    const tabId = freshId("tab");
    if (password) setTabPassword(tabId, password);
    spawnSessionTab(panelId, {
      id: tabId, label: project.name, cwd: null, startCommands: [], projectId: project.id,
      vnc: { host: project.vnc.host, port: project.vnc.port },
    });
    setVncLaunch(null);
  }, [vncLaunch, spawnSessionTab, rememberSessionPassword]);

  // `rdpOpen` lives in useSimpleModals; `rdpLaunch` carries the saved-session payload.
  const [rdpLaunch, setRdpLaunch] = useState(null);
  const connectRdp = useCallback(({ host, port, username, domain, password }) => {
    const tabId = freshId("tab");
    if (password) setTabPassword(tabId, password); // transient, never persisted
    spawnSessionTab(state.activePanelId, {
      id: tabId,
      label: `RDP: ${host}`,
      cwd: null,
      startCommands: [],
      projectId: null,
      rdp: { host, port, username, domain },
    });
    setRdpOpen(false);
  }, [state.activePanelId, spawnSessionTab]);
  const launchRdp = useCallback(({ password }) => {
    if (!rdpLaunch) return;
    const { panelId, project } = rdpLaunch;
    rememberSessionPassword(project.id, password || ""); // in-memory only (FR-008)
    const tabId = freshId("tab");
    if (password) setTabPassword(tabId, password);
    spawnSessionTab(panelId, {
      id: tabId, label: project.name, cwd: null, startCommands: [], projectId: project.id,
      rdp: { host: project.rdp.host, port: project.rdp.port, username: project.rdp.username, domain: project.rdp.domain },
    });
    setRdpLaunch(null);
  }, [rdpLaunch, spawnSessionTab, rememberSessionPassword]);

  // FR-013: promote a quick-connect entry to a saved sidebar session (no password).
  const saveQuickConnection = useCallback((rec) => {
    const name = rec.host;
    if (rec.type === "vnc") {
      upsertProject({ type: "vnc", name, folder: null, tags: [], vnc: { host: rec.host, port: rec.port } });
    } else {
      upsertProject({ type: "rdp", name, folder: null, tags: [], rdp: { host: rec.host, port: rec.port, username: rec.username, domain: rec.domain || null } });
    }
    toast.success(`Saved ${rec.type.toUpperCase()} session "${name}".`);
  }, [upsertProject, toast]);

  return {
    connectSerial,
    vncLaunch, setVncLaunch, connectVnc, launchVnc,
    rdpLaunch, setRdpLaunch, connectRdp, launchRdp,
    saveQuickConnection,
  };
}
