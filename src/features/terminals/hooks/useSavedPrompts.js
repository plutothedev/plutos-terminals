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

// Saved prompts ride cloud sync, and the sync engine JSON-stringifies and
// encrypts the WHOLE surface on every push — so one accidental paste of a
// large file into a prompt body inflates every subsequent sync for every
// machine, forever (the sync repo keeps a fresh blob per commit). Clamp on the
// way in. Generous enough that no real prompt hits it; a paste of a whole file
// does. Same reasoning as the agent-context budget in agentContext.js.
export const PROMPT_NAME_MAX = 200;
export const PROMPT_BODY_MAX = 8 * 1024;
export const PROMPT_TAGS_MAX = 20;
export const PROMPT_TAG_MAX = 40;
const clamp = (v, n) => String(v ?? "").slice(0, n);

// Pure so the clamp is testable without mounting the hook.
export function normalizePrompt(input) {
  return {
    name: clamp(input?.name, PROMPT_NAME_MAX),
    body: clamp(input?.body, PROMPT_BODY_MAX),
    tags: Array.isArray(input?.tags)
      ? input.tags.slice(0, PROMPT_TAGS_MAX).map((t) => clamp(t, PROMPT_TAG_MAX))
      : [],
  };
}

export function useSavedPrompts({ userSt, saveUser }) {
  const prompts = listOf(userSt);

  const addPrompt = useCallback((input) => {
    const item = { id: freshId("prompt"), ...normalizePrompt(input) };
    saveUser((prev) => ({ ...prev, savedPrompts: [...listOf(prev), item] }));
    return item;
  }, [saveUser]);

  const removePrompt = useCallback((id) => {
    saveUser((prev) => ({ ...prev, savedPrompts: listOf(prev).filter((p) => p.id !== id) }));
  }, [saveUser]);

  return { prompts, addPrompt, removePrompt };
}
