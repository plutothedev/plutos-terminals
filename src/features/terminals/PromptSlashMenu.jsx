// (C)
// Floating "/" slash-command menu shown above the two AI inputs (DockAssistant,
// AgentMode) when the typed text starts with "/". Lets the user browse/filter
// their saved prompts (see hooks/useSavedPrompts.js) and insert one without
// leaving the keyboard. snippets = shell; prompts = AI — this menu is deliberately
// NOT wired into the shell PromptEditor.jsx overlay (naming collision only;
// inserting an AI prompt body into a shell command line is the wrong surface —
// dropped scope per the Stream C design doc).
//
// Two pieces are exported standalone and PURE so they're unit-testable without
// rendering anything: `filterPrompts` (fuzzy includes-scoring over name+tags)
// and `menuKeyAction` (the Enter/Escape routing decision). The host's onKeyDown
// (DockAssistant.jsx / AgentMode.jsx) calls menuKeyAction BEFORE its own
// Enter-to-send/start check, so an OPEN menu's Enter selects a prompt instead of
// sending the message — the audit-pinned case both call sites guard against.
import { useMemo } from "react";

// Fuzzy-ish includes scoring over name + tags: exact name match ranks highest,
// then name-prefix, then name-substring, then a tag hit (exact, then
// substring). No match = excluded entirely. Empty/missing query = every prompt,
// unranked (browse mode when the user has typed a bare "/").
export function filterPrompts(prompts, query) {
  const list = Array.isArray(prompts) ? prompts : [];
  const q = String(query || "").trim().toLowerCase();
  if (!q) return list;
  const scored = [];
  for (const p of list) {
    const name = String(p?.name || "").toLowerCase();
    const tags = Array.isArray(p?.tags) ? p.tags.map((t) => String(t).toLowerCase()) : [];
    let score = -1;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (tags.some((t) => t === q)) score = 50;
    else if (tags.some((t) => t.includes(q))) score = 40;
    if (score >= 0) scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.p);
}

// Decides how the HOST's onKeyDown should route a key when its slash-menu might
// be open. Only Enter/Escape are ambiguous against a host default (Enter
// normally sends/starts; Escape is otherwise a no-op) — every other key
// (typing, ArrowUp/Down, etc.) is the host's own concern and always passes
// through untouched; the host handles Arrow selection-movement itself,
// separately from this helper. When the menu is closed, EVERYTHING passes
// through unconditionally so a closed menu can never intercept typing or
// Enter-to-send — this is what keeps the menu from swallowing keys once
// PromptSlashMenu.onInsert has explicitly closed it.
export function menuKeyAction(key, menuOpen) {
  if (!menuOpen) return "passthrough";
  if (key === "Enter") return "select";
  if (key === "Escape") return "close";
  return "passthrough";
}

// query = whatever follows the leading "/" in the raw input value.
function queryFrom(inputValue) {
  const v = String(inputValue || "");
  return v.startsWith("/") ? v.slice(1) : v;
}

// Presentational: filtering/highlight only. Keyboard routing (open/close,
// ArrowUp/Down selection index, Enter/Escape decisions) lives in the host per
// the module comment above — this component just renders whatever `prompts` +
// `selectedIndex` it's given and reports mouse picks via onInsert. Callers that
// don't wire arrow-key navigation still get a working click-to-insert list
// (selectedIndex defaults to the first item).
export default function PromptSlashMenu({ prompts, inputValue, selectedIndex = 0, onInsert }) {
  const filtered = useMemo(
    () => filterPrompts(prompts, queryFrom(inputValue)),
    [prompts, inputValue]
  );
  const activeIndex = filtered.length ? Math.min(Math.max(selectedIndex, 0), filtered.length - 1) : -1;

  return (
    <div className="phn-prompt-menu" role="listbox" aria-label="Saved prompts">
      {filtered.length === 0 ? (
        <div className="phn-prompt-menu-empty">No saved prompts match.</div>
      ) : (
        filtered.map((p, i) => (
          <div
            key={p.id}
            role="option"
            aria-selected={i === activeIndex}
            className={i === activeIndex ? "phn-prompt-menu-item active" : "phn-prompt-menu-item"}
            // mousedown (not click), preventDefault: picking a prompt must not
            // blur the input — the user keeps typing/editing immediately.
            onMouseDown={(e) => { e.preventDefault(); onInsert?.(p.body); }}
            title={p.body}
          >
            <div className="phn-prompt-menu-name">{p.name || "(untitled)"}</div>
            {Array.isArray(p.tags) && p.tags.length > 0 && (
              <div className="phn-prompt-menu-tags">{p.tags.join(", ")}</div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
