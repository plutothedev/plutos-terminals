// (C)
// Floating "/" slash-command menu shown above (or below, when clipped — see
// below) the two AI inputs (DockAssistant, AgentMode) when the typed text
// starts with "/". Lets the user browse/filter their saved prompts (see
// hooks/useSavedPrompts.js) and insert one without leaving the keyboard.
// snippets = shell; prompts = AI — this menu is deliberately NOT wired into the
// shell PromptEditor.jsx overlay (naming collision only; inserting an AI prompt
// body into a shell command line is the wrong surface — dropped scope per the
// Stream C design doc).
//
// State/keyboard ownership lives in hooks/usePromptSlashMenu.js, consumed
// identically by both DockAssistant.jsx and AgentMode.jsx (that hook is what
// killed the near-verbatim copy-paste that used to live in each host, and the
// divergent-clamp bug that came with it — see clampIndex below). This
// component is a near-pure renderer: given an already-filtered `items` list
// and an already-clamped `selectedIndex`, it just draws the list and reports
// mouse picks via onInsert(item). It also owns ONE thing itself, because it's
// a rendering concern, not a keyboard/state concern: adaptive placement
// (open up vs down, capped height) based on measuring its own on-screen
// position, so a menu with little headroom above the input (AgentMode's goal
// input sits ~80-90px below the modal's top edge by default) doesn't clip
// invisibly against a scroll/overflow boundary.
//
// Three pieces are exported standalone and PURE so they're unit-testable
// without rendering anything: `filterPrompts` (fuzzy includes-scoring over
// name+tags), `clampIndex` (the ONE clamp both the render highlight and the
// Enter-selection use — previously two independently-written clamps that could
// disagree once the list shrank without a keystroke), and `menuKeyAction` (the
// Enter/Escape routing decision, now also zero-match-aware so an open menu
// with no matches doesn't swallow a literal "/"-prefixed message on Enter).
import { useLayoutEffect, useRef, useState } from "react";

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

// THE single clamp. Both the render highlight (PromptSlashMenu below) and the
// Enter-selection (usePromptSlashMenu's `select()`) call this exact function
// against the exact same `filtered` array + stored index — so they can never
// independently drift apart again the way the old render-time
// `Math.min(Math.max(idx,0), len-1)` vs. the old host's `arr[idx] || arr[0]`
// fallback did (that pair agreed when the list was stable but silently
// disagreed the instant it shrank out from under an open menu — a drawer
// delete or a cross-device sync merge landing mid-session, no keystroke
// required). length <= 0 clamps to 0 (the empty-list case; callers gate
// selection separately on emptiness, this just never returns an OOB index).
export function clampIndex(index, length) {
  if (!length || length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

// Decides how the HOST's onKeyDown should route a key when its slash-menu might
// be open. Only Enter/Escape are ambiguous against a host default (Enter
// normally sends/starts; Escape is otherwise a no-op) — every other key
// (typing, ArrowUp/Down, etc.) is the host's own concern and always passes
// through untouched; ArrowUp/Down movement is handled by
// usePromptSlashMenu.onKeyDown, not here. When the menu is closed, EVERYTHING
// passes through unconditionally so a closed menu can never intercept typing
// or Enter-to-send.
//
// `hasMatches` (default true for back-compat with existing 2-arg callers)
// closes the zero-match trap: if the menu is open but the current filter has
// no matches, Enter must NOT report "select" (there is nothing to select —
// the old behavior tried to insert `filtered[idx]` anyway, which was
// `undefined`, silently swallowing the keystroke instead of sending/starting).
// Escape is unaffected by match count: closing an empty "no matches" menu is a
// normal, expected action, not a trap.
export function menuKeyAction(key, menuOpen, hasMatches = true) {
  if (!menuOpen) return "passthrough";
  if (key === "Enter") return hasMatches ? "select" : "passthrough";
  if (key === "Escape") return "close";
  return "passthrough";
}

const MENU_MAX_HEIGHT = 220;
const MIN_USABLE_HEIGHT = 100;
const FLIP_THRESHOLD = 80; // px of headroom above which "open upward" stays usable.
const EDGE_MARGIN = 8;

// Presentational + adaptive placement only. Filtering/index/keyboard state
// lives in usePromptSlashMenu.js (shared by both hosts) — this component
// renders whatever `items` + `selectedIndex` it's given and reports mouse
// picks via onInsert(item). Falls back to defensively re-clamping its own
// highlight with `clampIndex` (the same function the hook uses) so even a
// caller that bypasses the hook can't render a highlight that disagrees with
// what Enter would select.
export default function PromptSlashMenu({ items, selectedIndex = 0, onInsert }) {
  const list = Array.isArray(items) ? items : [];
  const activeIndex = list.length ? clampIndex(selectedIndex, list.length) : -1;

  const rootRef = useRef(null);
  const [placement, setPlacement] = useState({ direction: "up", maxHeight: MENU_MAX_HEIGHT });

  // Measure available space above/below on mount (and on resize, since the
  // window can change size while the menu is open) and pick a direction +
  // height that won't clip invisibly against a scroll/overflow boundary — the
  // AgentMode modal (`.phn-modal { overflow-y: auto }`) is the reported case:
  // the goal input sits close enough to the modal's top edge that the default
  // "always open upward, fixed 220px" menu clipped 2-3+ matches with no visual
  // cue. Viewport-relative measurement is a deliberate simplification (vs.
  // walking to the nearest scrollable ancestor) — it directly covers both
  // reported sites (AgentMode's modal-near-viewport-top case, DockAssistant's
  // `.moba-rd-body overflow:hidden` dock which is likewise within the
  // viewport) without per-host plumbing.
  useLayoutEffect(() => {
    const el = rootRef.current;
    const anchor = el?.parentElement;
    if (!anchor) return;
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      const spaceAbove = rect.top - EDGE_MARGIN;
      const spaceBelow = window.innerHeight - rect.bottom - EDGE_MARGIN;
      if (spaceAbove < FLIP_THRESHOLD) {
        setPlacement({ direction: "down", maxHeight: Math.max(MIN_USABLE_HEIGHT, Math.min(MENU_MAX_HEIGHT, spaceBelow)) });
      } else {
        setPlacement({ direction: "up", maxHeight: Math.max(MIN_USABLE_HEIGHT, Math.min(MENU_MAX_HEIGHT, spaceAbove)) });
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return (
    <div
      ref={rootRef}
      className={placement.direction === "down" ? "phn-prompt-menu phn-prompt-menu--down" : "phn-prompt-menu"}
      style={{ maxHeight: placement.maxHeight }}
      role="listbox"
      aria-label="Saved prompts"
    >
      {list.length === 0 ? (
        <div className="phn-prompt-menu-empty">No saved prompts match.</div>
      ) : (
        list.map((p, i) => (
          <div
            key={p.id}
            role="option"
            aria-selected={i === activeIndex}
            className={i === activeIndex ? "phn-prompt-menu-item active" : "phn-prompt-menu-item"}
            // mousedown (not click), preventDefault: picking a prompt must not
            // blur the input — the user keeps typing/editing immediately.
            onMouseDown={(e) => { e.preventDefault(); onInsert?.(p); }}
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
