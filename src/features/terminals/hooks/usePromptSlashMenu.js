// (C)
// Shared state/keyboard machinery for the "/" saved-prompts menu, consumed
// identically by DockAssistant.jsx and AgentMode.jsx. Extracted out of both
// (quality-review fix, 2026-07-21): the two hosts started as near-verbatim
// copies of the same index/filter/keyboard glue, and that duplication is
// exactly how they drifted — the render highlight clamped one way
// (`Math.min(Math.max(idx,0), len-1)` in PromptSlashMenu) while the
// Enter-selection clamped another (`filtered[idx] || filtered[0]` in each
// host's onKeyDown), so an external list change (a drawer add/remove, or a
// cross-device sync merge landing) while the menu was open and the index
// pointed past the new-shorter list could highlight one item and insert a
// different one. This hook owns the index as real state and exposes exactly
// ONE clamped read of it (via clampIndex, imported from PromptSlashMenu.jsx),
// so the two call sites structurally cannot diverge — there's only one
// `selectedIndex` in existence per render.
import { useCallback, useEffect, useState } from "react";
import { filterPrompts, menuKeyAction, clampIndex } from "../PromptSlashMenu.jsx";

export function usePromptSlashMenu({ value, setValue, prompts }) {
  const [closed, setClosed] = useState(false);
  const [rawIndex, setRawIndex] = useState(0);

  const v = String(value || "");
  const hasPrompts = Array.isArray(prompts) && prompts.length > 0;
  // Open-state is NOT purely derived from `value` — `closed` is an explicit
  // override so inserting a prompt whose body itself starts with "/" doesn't
  // immediately reopen the menu on the render the insert causes. It clears on
  // the next real keystroke (see handleChange), so typing further re-evaluates
  // normally.
  const open = !closed && v.startsWith("/") && hasPrompts;

  const filtered = open ? filterPrompts(prompts, v.slice(1)) : [];

  // THE clamp — same function PromptSlashMenu's render uses for its own
  // defensive re-clamp, applied here to the same `filtered` array. This is the
  // value both the highlight AND the Enter-selection consume; there is no
  // second, independently-written clamp anywhere else anymore.
  const selectedIndex = filtered.length ? clampIndex(rawIndex, filtered.length) : 0;

  // Re-clamp the STORED index (not just the derived read above) whenever the
  // filtered set's length changes out from under the menu — e.g. a drawer
  // delete or a sync merge lands while the menu is open, with no keystroke to
  // trigger handleChange. Without this the raw index could sit far out of
  // range indefinitely and "resurrect" a stale position if the list later
  // grows back to cover it.
  useEffect(() => {
    setRawIndex((i) => clampIndex(i, filtered.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.length]);

  const close = useCallback(() => setClosed(true), []);

  const moveSelection = useCallback((delta) => {
    setRawIndex((i) => clampIndex(i + delta, filtered.length));
  }, [filtered.length]);

  // Insert a prompt and close. `prompt` is optional — a mouse pick passes the
  // exact clicked item (bypassing the keyboard-highlighted index entirely,
  // which is correct: click what you clicked); Enter calls this with no
  // argument, falling back to `filtered[selectedIndex]` — the SAME index the
  // menu is currently highlighting, by construction.
  const select = useCallback((prompt) => {
    const item = prompt || filtered[selectedIndex];
    if (!item) return;
    setValue(item.body);
    close();
  }, [filtered, selectedIndex, setValue, close]);

  // The host calls this INSTEAD of calling setValue directly in its onChange —
  // it re-arms the menu (clears the `closed` override) on a real keystroke.
  // `select()`'s own setValue(...) above is followed immediately by close(),
  // so a body that itself starts with "/" doesn't reopen the menu on the
  // render the insert causes; typing again after that goes through here and
  // re-evaluates normally.
  const handleChange = useCallback((next) => {
    setValue(next);
    setClosed(false);
    setRawIndex(0);
  }, [setValue]);

  // The single keyboard entry point: the host's onKeyDown calls this FIRST,
  // before its own Enter-to-send/start. Returns "handled" (host should stop —
  // this function already called preventDefault + did whatever the key meant)
  // or "passthrough" (menu had no opinion; host's existing logic runs
  // untouched — this is what keeps Enter-to-send byte-identical when the menu
  // is closed, and now also when it's open with zero matches).
  const onKeyDown = useCallback((e) => {
    if (!open) return "passthrough";
    if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); return "handled"; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); return "handled"; }
    const action = menuKeyAction(e.key, open, filtered.length > 0);
    if (action === "select") { e.preventDefault(); select(); return "handled"; }
    if (action === "close") { e.preventDefault(); close(); return "handled"; }
    return "passthrough";
  }, [open, filtered.length, moveSelection, select, close]);

  return { open, filtered, selectedIndex, select, close, onKeyDown, handleChange };
}
