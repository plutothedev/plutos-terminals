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
import { humanizeError } from "../errorText.js";

// The saved list as the live user state holds it.
const listOf = (us) => (Array.isArray(us?.workspaces) ? us.workspaces : []);

export function useWorkspaces({ state, persist, userSt, saveUser, toast }) {
  const workspaces = listOf(userSt);
  // Updaters over the live user state (saveUserUpdaters.test.js): it carries the
  // API keys, and a copy of the rendered one can lack a key that has reached
  // App since, which the keychain mirror would then delete.
  const saveWorkspace = useCallback((name) => {
    const snap = JSON.parse(JSON.stringify({ panels: state.panels, activePanelId: state.activePanelId }));
    const entry = { name, panels: snap.panels, activePanelId: snap.activePanelId, savedAt: Date.now() };
    saveUser((prev) => ({ ...prev, workspaces: [...listOf(prev).filter((w) => w.name !== name), entry] }));
    toast.success(`Workspace "${name}" saved.`);
  }, [state.panels, state.activePanelId, saveUser, toast]);
  const loadWorkspace = useCallback((ws) => {
    try {
      const fresh = cloneWorkspaceFresh(JSON.parse(JSON.stringify(ws)));
      if (!fresh.panels.length) { toast.error("That workspace is empty."); return; }
      persist({ ...state, panels: fresh.panels, activePanelId: fresh.activePanelId });
      toast.success(`Loaded workspace "${ws.name}".`);
    } catch (e) {
      toast.error(humanizeError(e, "Couldn't load workspace"));
    }
  }, [state, persist, toast]);
  const deleteWorkspace = useCallback((name) => {
    saveUser((prev) => ({ ...prev, workspaces: listOf(prev).filter((w) => w.name !== name) }));
  }, [saveUser]);
  return { workspaces, saveWorkspace, loadWorkspace, deleteWorkspace };
}
