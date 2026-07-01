// (C)
// The keystone of the session/grid decomposition: spawnSessionTab (the shared
// "append a session tab and focus it" mutation used by every launch path) plus
// the in-memory RDP/VNC password cache. Lifted verbatim out of the TerminalsTab
// god component. spawnSessionTab closes over (state, persist) — passed in — so
// its identity is stable for the 10+ callbacks across the sessions/grid clusters
// that list it in their dependency arrays. The password cache (sessionPwRef) is
// app-run-lifetime ONLY, NEVER persisted (FR-008); the ref stays internal and
// only the three accessors are returned.

import { useCallback, useRef } from "react";

export function useSessionSpawn({ state, persist }) {
  // Read the LATEST committed state via a ref, not the render-time closure: launch
  // paths call spawnSessionTab AFTER an async keychain/worktree IPC, and a concurrent
  // grid mutation during that await would otherwise be reverted by a stale-snapshot
  // persist (the H7 lost-update class; the same fix useWorkspaceTree already uses).
  const stateRef = useRef(state);
  stateRef.current = state;
  // Append a tab to a panel and make it active. Shared by the local and SSH
  // paths. `extra` carries SSH-only fields (connection); the password (if any)
  // is recorded transiently in the bridge by the caller, never on the tab.
  const spawnSessionTab = useCallback((panelId, tab) => {
    const s = stateRef.current;
    const panels = s.panels.map(p =>
      p.id === panelId
        ? { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id }
        : p
    );
    persist({ ...s, panels, activePanelId: panelId });
  }, [persist]);

  // In-memory per-session password cache (RDP/VNC). Keyed by saved-session id,
  // app-run lifetime only — NEVER persisted to disk (FR-008). A same-run reconnect
  // reuses the secret instead of re-prompting; "forget" (sidebar context menu)
  // clears it. SSH keeps its own keychain path; this is the remote-desktop analog.
  const sessionPwRef = useRef(new Map());
  const rememberSessionPassword = useCallback((sessionId, secret) => {
    if (sessionId) sessionPwRef.current.set(sessionId, secret);
  }, []);
  const getSessionPassword = useCallback((sessionId) => sessionPwRef.current.get(sessionId), []);
  const forgetSessionPassword = useCallback((sessionId) => {
    if (sessionId) sessionPwRef.current.delete(sessionId);
  }, []);

  return { spawnSessionTab, rememberSessionPassword, getSessionPassword, forgetSessionPassword };
}
