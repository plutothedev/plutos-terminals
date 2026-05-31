// (C)
// The right-dock SFTP browser binding, lifted verbatim out of the TerminalsTab
// god component. Keeps a dedicated SFTP session bound to the ACTIVE SSH tab:
// connect when that tab is an SSH session AND the SFTP dock tab is being viewed,
// disconnect otherwise (so the backend connection never leaks). A monotonic
// token (sftpTokenRef) discards a connect that resolves after the user has
// switched away. SFTP auth reuses the shell tab's transient password (ptyBridge)
// or the OS keychain — never persisted. Inputs: the active tab + the right-dock
// tab state (dockTab/setDockTab stay in TerminalsTab; the dock JSX uses them).
// Returns { sftp } for the SftpBrowser props and focusFilesDock for the F4 /
// command-palette "focus files" action.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@backend";
import { getTabPassword, setTabPassword } from "../ptyBridge.js";
import { sshAccount } from "../sshAccount.js";

export function useSftpDock({ activeTab, activeTabId, dockTab, setDockTab }) {
  const [sftp, setSftp] = useState(null); // { connecting, id, error } | null
  // Monotonic token bumped whenever the active SSH context changes, so a
  // connect that resolves after the user has moved on can be discarded.
  const sftpTokenRef = useRef(0);
  const openSftp = useCallback(async (token) => {
    const conn = activeTab?.connection;
    if (!conn?.host || !conn?.user) return;
    // Tear down any previous SFTP session before opening a new one so switching
    // between SSH tabs doesn't leak the backend connection.
    setSftp((s) => { if (s?.id) invoke("sftp_disconnect", { id: s.id }).catch(() => {}); return null; });
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
        if (token === sftpTokenRef.current) setSftp({ connecting: false, id: null, error: "No saved password for this session — reopen the SSH tab, then open files." });
        return;
      }
    }
    if (token !== sftpTokenRef.current) return; // active tab changed while resolving the password
    setSftp({ connecting: true, id: null, error: null });
    try {
      const id = await invoke("sftp_connect", {
        host: conn.host,
        port: conn.port || 22,
        user: conn.user,
        auth: { ...conn.auth, password },
      });
      // If the user switched away mid-connect, drop this session instead of
      // pointing the dock at a no-longer-active tab's host.
      if (token !== sftpTokenRef.current) { invoke("sftp_disconnect", { id }).catch(() => {}); return; }
      setSftp({ connecting: false, id, error: null });
    } catch (e) {
      if (token === sftpTokenRef.current) setSftp({ connecting: false, id: null, error: String(e) });
    }
  }, [activeTab, activeTabId]);

  const closeSftp = useCallback(() => {
    setSftp((s) => {
      if (s?.id) invoke("sftp_disconnect", { id: s.id }).catch(() => {});
      return null;
    });
  }, []);

  // The right dock (SFTP / Assistant / Monitor) is always open — focusing the
  // SFTP tab is what "F4 / file browser" does now. SFTP itself connects/
  // disconnects automatically with the active SSH tab via the effect below.
  const focusFilesDock = useCallback(() => setDockTab("files"), []);

  // Keep the SFTP browser bound to the active tab: connect remote SFTP when the
  // focused tab is an SSH session, disconnect (so we don't leak it) otherwise.
  // Key on a stable connection identity so unrelated re-renders (activity/cost
  // updates that rebuild the tab object) don't trigger a reconnect.
  const sshKey = activeTab?.connection
    ? `${activeTab.connection.user}@${activeTab.connection.host}:${activeTab.connection.port || 22}`
    : null;
  useEffect(() => {
    const token = ++sftpTokenRef.current;
    // Connect lazily: only when the SFTP tab is actually being viewed, not just
    // because an SSH tab is focused while the user is on Assistant/Monitor.
    if (dockTab === "files" && activeTab?.connection) openSftp(token);
    else closeSftp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, sshKey, dockTab]);

  return { sftp, focusFilesDock };
}
