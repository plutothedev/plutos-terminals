// (C)
// Saved Prompts — a small library of reusable AI-prompt bodies, inserted via the
// "/" menu into DockAssistant / AgentMode (see PromptSlashMenu.jsx). Mirrors
// useSnippets.js's shape but reads/writes the synced userSt.savedPrompts
// COLLECTION (per-item cloud merge with tombstones — see sync/syncState.js;
// deliberately NOT a scalar field, which would last-write-wins clobber a
// concurrently-edited list across machines). Snippets = shell commands;
// prompts = AI text — kept as a separate collection/hook rather than folding
// into useSnippets.
//
// Each mutator uses the FUNCTIONAL saveUser form (`saveUser(prev => ...)`) so a
// concurrent cloud-sync applyStores commit isn't reverted by spreading a stale
// render-time `userSt` — same anti-clobber pattern useSnippets.js uses for `st`.
import { useCallback } from "react";
import { freshId } from "../ids.js";

function listOf(store) {
  return Array.isArray(store?.savedPrompts) ? store.savedPrompts : [];
}

export function useSavedPrompts({ userSt, saveUser }) {
  const prompts = listOf(userSt);

  const addPrompt = useCallback((input) => {
    const item = {
      id: freshId("prompt"),
      name: String(input?.name || ""),
      body: String(input?.body || ""),
      tags: Array.isArray(input?.tags) ? input.tags.map(String) : [],
    };
    saveUser((prev) => ({ ...prev, savedPrompts: [...listOf(prev), item] }));
    return item;
  }, [saveUser]);

  const updatePrompt = useCallback((id, patch) => {
    saveUser((prev) => ({
      ...prev,
      savedPrompts: listOf(prev).map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
  }, [saveUser]);

  const removePrompt = useCallback((id) => {
    saveUser((prev) => ({ ...prev, savedPrompts: listOf(prev).filter((p) => p.id !== id) }));
  }, [saveUser]);

  return { prompts, addPrompt, updatePrompt, removePrompt };
}
