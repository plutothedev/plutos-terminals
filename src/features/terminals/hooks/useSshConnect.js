// (C)
// SSH connect flows lifted verbatim out of the TerminalsTab god component: the
// password-prompt state machine (sshPrompt + submitSshPassword) and the
// MobaXterm-style quick connect (parse "[user@]host[:port]" → open an SSH tab,
// prompting for the password unless the keychain already has it). Passwords are
// transient — stashed in the ptyBridge keyed by the pending tab id, optionally
// saved to the OS keychain on the user's explicit "remember", NEVER written to
// app state. setSshPrompt is returned so the grid's openProjectInPanel can open
// the prompt for a saved password-auth session.

import { useCallback, useState } from "react";
import { invoke } from "@backend";
import { setTabPassword } from "../ptyBridge.js";
import { sshAccount } from "../sshAccount.js";
import { freshId } from "../ids.js";
import { humanizeError } from "../errorText.js";

export function useSshConnect({ state, spawnSessionTab, toast }) {
  // SSH password prompt: { panelId, tab, project } or null. On submit, stash the
  // password transiently in the bridge (keyed by the pending tab id) and create
  // the tab — TerminalPane reads the password at ssh_spawn time.
  const [sshPrompt, setSshPrompt] = useState(null);
  const submitSshPassword = useCallback((password, remember) => {
    if (!sshPrompt) return;
    setTabPassword(sshPrompt.tab.id, password);
    if (remember) {
      invoke("secret_set", { account: sshAccount(sshPrompt.project.connection), secret: password })
        .then(() => toast.info("Password saved to keychain."))
        .catch((e) => toast.error(humanizeError(e, "Couldn't save to keychain")));
    }
    spawnSessionTab(sshPrompt.panelId, sshPrompt.tab);
    setSshPrompt(null);
  }, [sshPrompt, spawnSessionTab, toast]);

  // MobaXterm-style quick connect: parse "[user@]host[:port]" and open an SSH
  // session in the active panel (password auth → prompt, like a saved session).
  const quickConnect = useCallback((text) => {
    const t = (text || "").trim();
    if (!t) return;
    const m = t.match(/^(?:([^@\s]+)@)?([^@:\s]+)(?::(\d+))?$/);
    if (!m) { toast.error("Use the form user@host or host:port"); return; }
    const user = m[1] || "root";
    const host = m[2];
    const port = m[3] ? parseInt(m[3], 10) : 22;
    const tabId = freshId("tab");
    const tab = {
      id: tabId,
      label: `${user}@${host}`,
      cwd: null,
      startCommands: [],
      projectId: null,
      connection: { host, port, user, auth: { method: "password" } },
    };
    const project = { name: `${user}@${host}`, connection: tab.connection };
    (async () => {
      let saved = null;
      try { saved = await invoke("secret_get", { account: sshAccount(tab.connection) }); } catch { /* none */ }
      if (saved) { setTabPassword(tabId, saved); spawnSessionTab(state.activePanelId, tab); }
      else { setSshPrompt({ panelId: state.activePanelId, tab, project }); }
    })();
  }, [state.activePanelId, toast, spawnSessionTab]);

  return { sshPrompt, setSshPrompt, submitSshPassword, quickConnect };
}
