// (C)
// Named workspaces — save / restore the whole panel/tab/split layout — lifted
// verbatim out of the TerminalsTab god component. Workspaces persist in the
// WINDOW-INDEPENDENT user store (userSt.workspaces via saveUser), distinct from
// the per-window panel state that persist() owns. Loading clones the saved
// layout with fresh ids (cloneWorkspaceFresh) so it lands as a clean instance —
// no scrollback-file or React-key collisions with the layout it replaces — then
// writes it through persist.

import { useCallback } from "react";
import { cloneWorkspaceFresh } from "../workspaceModel.js";

export function useWorkspaces({ state, persist, userSt, saveUser, toast }) {
  const workspaces = Array.isArray(userSt?.workspaces) ? userSt.workspaces : [];
  const saveWorkspace = useCallback((name) => {
    const snap = JSON.parse(JSON.stringify({ panels: state.panels, activePanelId: state.activePanelId }));
    const next = [
      ...workspaces.filter((w) => w.name !== name),
      { name, panels: snap.panels, activePanelId: snap.activePanelId, savedAt: Date.now() },
    ];
    saveUser({ ...userSt, workspaces: next });
    toast.success(`Workspace "${name}" saved.`);
  }, [state.panels, state.activePanelId, workspaces, userSt, saveUser, toast]);
  const loadWorkspace = useCallback((ws) => {
    try {
      const fresh = cloneWorkspaceFresh(JSON.parse(JSON.stringify(ws)));
      if (!fresh.panels.length) { toast.error("That workspace is empty."); return; }
      persist({ ...state, panels: fresh.panels, activePanelId: fresh.activePanelId });
      toast.success(`Loaded workspace "${ws.name}".`);
    } catch (e) {
      toast.error(`Couldn't load workspace: ${e}`);
    }
  }, [state, persist, toast]);
  const deleteWorkspace = useCallback((name) => {
    saveUser({ ...userSt, workspaces: workspaces.filter((w) => w.name !== name) });
  }, [workspaces, userSt, saveUser]);
  return { workspaces, saveWorkspace, loadWorkspace, deleteWorkspace };
}
