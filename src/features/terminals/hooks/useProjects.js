// (C)
// Project / saved-session CRUD lifted verbatim out of the TerminalsTab god
// component: create/edit (upsertProject), remove (detaching any open tabs that
// referenced it so a live session isn't lost), recolor, rename, set folder, and
// import ~/.ssh/config. All mutate the project list via persist({...state,
// projects}); the password-bearing connection fields hold no secrets (passwords
// live in the keychain / ptyBridge, never the project record).
//
// importSshConfig calls selectRibbon("sessions") to reveal the imported hosts,
// but selectRibbon is declared far BELOW this hook's call site in TerminalsTab —
// passing it directly would touch it in its temporal dead zone at render
// (ReferenceError → blank app). So it is threaded as a ref (selectRibbonRef,
// whose .current is set to selectRibbon each render once selectRibbon exists) and
// invoked only from the post-render callback body.

import { useCallback, useRef } from "react";
import { invoke } from "@backend";
import { freshId } from "../ids.js";
import { humanizeError } from "../errorText.js";

export function useProjects({ state, persist, projects, toast, selectRibbonRef }) {
  // Latest state/projects behind refs (P2-T2, the useWorkspaceTree pattern):
  // handlers read *Ref.current at call time, keeping their identities stable
  // across persists — the old [state, persist, projects] deps re-minted every
  // handler on every workspace mutation and busted the sidebar/panel memos
  // (the "already stable" comment in TerminalsTab was false).
  const stateRef = useRef(state);
  stateRef.current = state;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const upsertProject = useCallback((data, editingId) => {
    const projects = projectsRef.current;
    let nextProjects;
    let resultId;
    if (editingId) {
      nextProjects = projects.map(p => p.id === editingId ? { ...p, ...data } : p);
      resultId = editingId;
    } else {
      const id = freshId("proj");
      nextProjects = [...projects, { id, color: null, ...data }];
      resultId = id;
    }
    persist({ ...stateRef.current, projects: nextProjects });
    return resultId;
  }, [persist]);

  const removeProject = useCallback((projectId) => {
    const st = stateRef.current;
    const nextProjects = projectsRef.current.filter(p => p.id !== projectId);
    // Detach any open tabs that referenced this project (keep the tab + PTY,
    // just clear the link) so the user doesn't lose an active session.
    const panels = st.panels.map(p => ({
      ...p,
      tabs: p.tabs.map(t => t.projectId === projectId ? { ...t, projectId: null } : t),
    }));
    persist({ ...st, projects: nextProjects, panels });
  }, [persist]);

  const colorProject = useCallback((projectId, colorId) => {
    const nextProjects = projectsRef.current.map(p => p.id === projectId ? { ...p, color: colorId } : p);
    persist({ ...stateRef.current, projects: nextProjects });
  }, [persist]);

  const renameProject = useCallback((projectId, name) => {
    if (!name) return;
    const nextProjects = projectsRef.current.map(p => p.id === projectId ? { ...p, name } : p);
    persist({ ...stateRef.current, projects: nextProjects });
  }, [persist]);

  // Import ~/.ssh/config into the Sessions tree (Termius/MobaXterm parity).
  // Each non-wildcard Host becomes an SSH session under an "SSH config" folder;
  // IdentityFile → key auth, otherwise ssh-agent. Existing host+user+port pairs
  // are skipped so re-importing is idempotent. ProxyJump is kept for Tier 3b.
  const importSshConfig = useCallback(async () => {
    let entries;
    try {
      entries = await invoke("parse_ssh_config");
    } catch (e) {
      toast.error(humanizeError(e, "Couldn't read ~/.ssh/config"));
      return;
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      toast.info("No hosts found in ~/.ssh/config.");
      return;
    }
    const seen = new Set(
      projectsRef.current
        .filter((p) => p.connection)
        .map((p) => `${p.connection.host}|${p.connection.user || ""}|${p.connection.port || 22}`)
    );
    const fresh = [];
    for (const e of entries) {
      const port = e.port || 22;
      const user = e.user || "";
      const key = `${e.host_name}|${user}|${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        color: null,
        type: "ssh",
        name: e.alias,
        folder: "SSH config",
        startCommands: [],
        proxyJump: e.proxy_jump || null,
        connection: {
          host: e.host_name,
          port,
          user,
          auth: { method: e.identity_file ? "key" : "agent", keyPath: e.identity_file || null },
        },
      });
    }
    if (fresh.length === 0) {
      toast.info(`~/.ssh/config: all ${entries.length} host${entries.length === 1 ? "" : "s"} already imported.`);
      return;
    }
    // Functional form: this runs after the parse_ssh_config await, so spreading the
    // render-time `state` would revert a grid mutation / drop a project added during
    // that window. Append onto the LATEST committed projects.
    persist((prev) => ({ ...prev, projects: [...(prev.projects || []), ...fresh] }));
    selectRibbonRef.current("sessions");
    toast.success(`Imported ${fresh.length} session${fresh.length === 1 ? "" : "s"} from ~/.ssh/config.`);
    // selectRibbonRef.current is selectRibbon, assigned each render in TerminalsTab
    // AFTER selectRibbon's declaration. The ref is intentionally absent from the
    // deps array (it is stable, and the body runs post-render) — adding selectRibbon
    // itself here would hit its temporal dead zone and blank the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persist, toast]);

  // Assign (or clear, with folder === null) a session's folder grouping in the
  // Sessions tree. Empty/null folder = ungrouped (rendered at the root).
  const setProjectFolder = useCallback((projectId, folder) => {
    const nextProjects = projectsRef.current.map(p => p.id === projectId ? { ...p, folder: folder || null } : p);
    persist({ ...stateRef.current, projects: nextProjects });
  }, [persist]);

  return { upsertProject, removeProject, colorProject, renameProject, importSshConfig, setProjectFolder };
}
