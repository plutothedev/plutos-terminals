// (C)
// Session-launch dispatch lifted verbatim out of the TerminalsTab god component
// — the "open a saved project / session" orchestration that ties the workspace
// tree, the session-spawn keystone, and the SSH/VNC/RDP launch modals together.
// openProjectInPanel branches on project type (SSH via ssh2 with a keychain →
// prompt fallback; VNC/RDP focus-existing or cached-password or modal; local
// shell) and is the one place that OPENS the password modals — so the launch
// setters (setSshPrompt / setVncLaunch / setRdpLaunch) are injected from the
// session-launch hooks (which is why this hook is called AFTER them). This
// resolves the sessions↔modals↔grid orchestration triangle without a circular
// import. focusExistingProjectTab (FR-012) avoids duplicate remote-desktop
// connections; runProjectScript and openAgentWorktree are the npm-script and
// git-worktree launch entry points. No secret ever lands in app state —
// passwords go to the ptyBridge (transient) / OS keychain only.

import { useCallback, useRef } from "react";
import { invoke } from "@backend";
import { setTabPassword } from "../ptyBridge.js";
import { sshAccount } from "../sshAccount.js";
import { freshId } from "../ids.js";

export function useSessionDispatch({
  state,
  persist,
  projects,
  toast,
  spawnSessionTab,
  getSessionPassword,
  setSshPrompt,
  setVncLaunch,
  setRdpLaunch,
}) {
  // Latest state/projects behind refs (P2-T2, the useWorkspaceTree pattern):
  // every handler reads *Ref.current at CALL time, so handler identities stay
  // stable across persists. Pre-migration, openProjectInPanel re-minted on
  // every workspace mutation, which churned homeApi and busted every panel
  // memo on every tab switch (plan-audit H3).
  const stateRef = useRef(state);
  stateRef.current = state;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  // FR-012: if a saved session already has an open tab, focus it instead of
  // opening a second connection. Returns true if an existing tab was focused.
  // Scoped to remote-desktop launches (RDP/VNC) where duplicate connections each
  // cost a worker thread + socket; local/SSH keep their multi-tab behavior.
  const focusExistingProjectTab = useCallback((projectId) => {
    const st = stateRef.current;
    for (const p of st.panels) {
      const t = p.tabs.find((t) => t.projectId === projectId);
      if (t) {
        persist({ ...st, activePanelId: p.id, panels: st.panels.map((pp) => pp.id === p.id ? { ...pp, activeTabId: t.id } : pp) });
        return true;
      }
    }
    return false;
  }, [persist]);

  // Add a new tab to `panelId` running `projectId`'s shell with its cwd and
  // start commands. Used by both click (target = active panel) and drop
  // (target = panel under cursor). When `overrideCommands` is provided, it
  // replaces the project's default startCommands — used by the npm-script
  // launcher in the context menu.
  const openProjectInPanel = useCallback((panelId, projectId, overrideCommands) => {
    const projects = projectsRef.current;
    const project = projects.find(p => p.id === projectId);
    if (!project) return;

    // SSH session: connect through the ssh2 transport. Password auth prompts
    // for the secret first (held in-memory only); key/agent connect directly.
    const isSsh = project.type === "ssh" || (project.connection && !project.path);
    if (isSsh) {
      if (!project.connection?.host || !project.connection?.user) {
        toast.error(`"${project.name}" is missing a host or user.`);
        return;
      }
      const tabId = freshId("tab");
      // Jump host (ProxyJump): if the session names a bastion we also have saved,
      // attach its connection so TerminalPane tunnels through it. Key/agent
      // bastions work directly; a password bastion would need its own secret.
      let jump = null;
      if (project.proxyJump) {
        const b = projects.find((p) => p.name === project.proxyJump && p.connection);
        if (b) jump = { host: b.connection.host, port: b.connection.port || 22, user: b.connection.user, auth: b.connection.auth };
        else toast.info(`Jump host "${project.proxyJump}" isn't a saved session — connecting directly.`);
      }
      const tab = {
        id: tabId,
        label: project.name,
        cwd: null,
        startCommands: project.startCommands || [],
        projectId: project.id,
        connection: jump ? { ...project.connection, jump } : project.connection, // { host, port, user, auth } — no secret
      };
      const method = project.connection?.auth?.method || "password";
      if (method === "password") {
        // Try the keychain first; only prompt if there's no saved password.
        (async () => {
          let saved = null;
          try {
            saved = await invoke("secret_get", { account: sshAccount(project.connection) });
          } catch { /* keychain unavailable — fall through to prompt */ }
          if (saved) {
            setTabPassword(tabId, saved);
            spawnSessionTab(panelId, tab);
          } else {
            setSshPrompt({ panelId, tab, project });
          }
        })();
        return;
      }
      spawnSessionTab(panelId, tab); // key / agent need no transient secret
      return;
    }

    // VNC saved session → open a remote-desktop tab (FR-004). Focus an existing
    // tab if one is open (FR-012); reuse the session-cached password if present,
    // else prompt via the VNC modal pre-filled with the saved host/port (T006).
    if (project.type === "vnc" || (project.vnc && !project.connection && !project.path)) {
      if (!project.vnc?.host) { toast.error(`"${project.name}" is missing a host.`); return; }
      if (focusExistingProjectTab(project.id)) return;
      const cached = getSessionPassword(project.id);
      if (cached !== undefined) {
        const tabId = freshId("tab");
        if (cached) setTabPassword(tabId, cached);
        spawnSessionTab(panelId, { id: tabId, label: project.name, cwd: null, startCommands: [], projectId: project.id, vnc: { host: project.vnc.host, port: project.vnc.port } });
      } else {
        setVncLaunch({ panelId, project });
      }
      return;
    }

    // RDP saved session → same pattern as VNC.
    if (project.type === "rdp" || (project.rdp && !project.connection && !project.path)) {
      if (!project.rdp?.host) { toast.error(`"${project.name}" is missing a host.`); return; }
      if (focusExistingProjectTab(project.id)) return;
      const cached = getSessionPassword(project.id);
      if (cached !== undefined) {
        const tabId = freshId("tab");
        if (cached) setTabPassword(tabId, cached);
        spawnSessionTab(panelId, { id: tabId, label: project.name, cwd: null, startCommands: [], projectId: project.id, rdp: { host: project.rdp.host, port: project.rdp.port, username: project.rdp.username, domain: project.rdp.domain } });
      } else {
        setRdpLaunch({ panelId, project });
      }
      return;
    }

    const cmds = overrideCommands || project.startCommands || [];
    const labelSuffix = overrideCommands && overrideCommands.length === 1
      ? ` · ${overrideCommands[0]}`
      : "";
    spawnSessionTab(panelId, {
      id: freshId("tab"),
      label: `${project.name}${labelSuffix}`,
      cwd: project.path,
      startCommands: cmds,
      projectId: project.id,
    });
  }, [toast, spawnSessionTab, focusExistingProjectTab, getSessionPassword]);

  const runProjectScript = useCallback((projectId, scriptName) => {
    openProjectInPanel(stateRef.current.activePanelId, projectId, [`npm run ${scriptName}`]);
  }, [openProjectInPanel]);

  // Tier 1: spawn an agent in its own git worktree (isolated branch + dir) so
  // parallel agents don't clobber each other. The worktree's cwd runs the
  // project's start commands (e.g. `claude`); the tab is tagged `worktree`.
  const openAgentWorktree = useCallback(async (projectId) => {
    const project = projectsRef.current.find(p => p.id === projectId);
    if (!project?.path) { toast.error("Worktree agents need a local git project."); return; }
    const branch = `agent/${Date.now().toString(36).slice(-5)}`;
    toast.info(`Creating worktree ${branch}…`);
    try {
      const wtPath = await invoke("worktree_add", { repo: project.path, branch });
      // activePanelId read AFTER the await, from the live ref — the panel the
      // user is on when the worktree is READY, not when they clicked.
      spawnSessionTab(stateRef.current.activePanelId, {
        id: freshId("tab"),
        label: branch,
        cwd: wtPath,
        startCommands: project.startCommands || [],
        projectId: project.id,
        worktree: { path: wtPath, branch, repo: project.path },
      });
      toast.success(`Agent worktree ${branch} ready.`);
    } catch (e) {
      toast.error(`Worktree failed: ${e}`);
    }
  }, [spawnSessionTab, toast]);

  // focusExistingProjectTab stays internal — only openProjectInPanel uses it.
  return { openProjectInPanel, runProjectScript, openAgentWorktree };
}
