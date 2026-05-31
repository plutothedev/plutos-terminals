// (C)
// SSH port forwarding (tunnels) — a self-contained lifecycle lifted verbatim out
// of the TerminalsTab god component. Local-forwards and the SOCKS5 proxy run
// through the ACTIVE SSH tab's connection; the password comes from the in-memory
// ptyBridge cache or the OS keychain (via secret_get) and is NEVER persisted.
// Inputs: the active tab ({ activeTab, activeTabId }) + toast. setForwards /
// setTunnelBusy / setTunnelError stay internal; the values are returned for the
// TunnelsModal to render.

import { useCallback, useState } from "react";
import { invoke } from "@backend";
import { getTabPassword } from "../ptyBridge.js";
import { sshAccount } from "../sshAccount.js";

export function useTunnels({ activeTab, activeTabId, toast }) {
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

  const startSocks = useCallback(async ({ localPort }) => {
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
      const id = await invoke("socks_forward_start", {
        host: conn.host, port: conn.port || 22, user: conn.user,
        auth: { ...conn.auth, password }, localPort,
      });
      setForwards((f) => [...f, { id, localPort, socks: true }]);
      toast.success(`SOCKS5 proxy on 127.0.0.1:${localPort} → through ${conn.host}`);
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

  return { tunnelsOpen, setTunnelsOpen, forwards, tunnelBusy, tunnelError, openTunnels, startForward, startSocks, stopForward };
}
