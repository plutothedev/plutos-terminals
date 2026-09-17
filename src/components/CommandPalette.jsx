// Command palette — Ctrl+K / Cmd+K opens. Searchable list of all top-level
// actions. Arrow keys navigate; Enter runs; Esc closes. v0.1.16.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Modal, { MODAL_COLORS } from "./Modal.jsx";

const { FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M } = MODAL_COLORS;

export default function CommandPalette({ open, commands, onClose }) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const ptRef = useRef(null);
  const uid = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        (c.hint || "").toLowerCase().includes(q) ||
        (c.shortcut || "").toLowerCase().includes(q)
    );
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      // Forget where the pointer was last time this opened, or a replayed
      // pointer event on THIS open reads as movement merely by differing from
      // a stale sample. See onRowPointer.
      ptRef.current = null;
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // A11Y-06. The list box is 360px tall and a row is ~62-68px, so only ~5 of
  // the ~33 commands are on screen; without this the arrow keys move an
  // OFF-SCREEN highlight and Enter runs a command the user never saw. Same
  // pattern (and same reason) as HistorySearch.jsx:36. It queries the row by
  // data-idx rather than holding a ref per row, so the list stays a plain map.
  // `filtered.length` is a dependency because filtering re-keys the rows: the
  // node carrying a given data-idx after a keystroke is not the node that
  // carried it before.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${highlight}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [highlight, filtered.length]);

  if (!open) return null;

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[highlight];
      if (cmd && cmd.action) {
        onClose();
        // Defer so the modal closes before the action runs (avoids double-render).
        setTimeout(() => cmd.action(), 0);
      }
    }
  };

  // Hover must not be able to take a selection away from a STATIONARY mouse.
  // The scroll effect above drags a ~59px row under the cursor on every
  // ArrowDown past the fold, and after a scroll the browser re-hit-tests and
  // replays pointer state onto whatever landed there. With the obvious
  // `onMouseEnter={() => setHighlight(i)}` that replay fires with the mouse
  // untouched and overwrites the row the user just chose with the row that
  // happened to slide under the pointer, so Enter runs the wrong command. On a
  // palette carrying "Reset workspace" that is not cosmetic, and keyboard
  // control of many agent tabs is the feature this app competes on.
  //
  // The gate is "did the pointer actually move", not "was the last input a
  // key", because a replayed pointer update carries the SAME clientX/clientY
  // as the last real one while any genuine movement changes at least one.
  // That keeps hover instant on the first cross-row move after arrowing, which
  // a keyboard-mode flag would have swallowed (boundary events are dispatched
  // ahead of the mousemove that would clear such a flag).
  //
  // The cost is one event of lag the very first time the pointer appears over
  // the list: with no earlier sample there is nothing to compare against, and
  // "no earlier sample" is exactly the shape of a palette opening under a
  // resting cursor. mousemove fires many times per row crossed, so the second
  // sample arrives within a pixel of the first.
  const onRowPointer = (e, i) => {
    const prev = ptRef.current;
    ptRef.current = { x: e.clientX, y: e.clientY };
    if (!prev) return;
    if (prev.x === e.clientX && prev.y === e.clientY) return;
    setHighlight(i);
  };

  return (
    <Modal open={open} title="Command palette" onClose={onClose} width={560}>
      {/* The other half of A11Y-06. Scrolling the highlight into view fixes it
          for a sighted keyboard user; a screen-reader user perceives the
          highlight only if the focused element POINTS at it, which is what
          aria-activedescendant does. Focus stays on the input (this is the
          standard combobox+listbox pattern) so the ~33 rows never become ~33
          tab stops, which is the fix that would have made the palette worse. */}
      <input
        ref={inputRef}
        type="text"
        placeholder="type to search commands… (↑↓ navigate, Enter run, Esc close)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        style={inputStyle}
        role="combobox"
        aria-label="Search commands"
        aria-autocomplete="list"
        aria-controls={`${uid}-list`}
        aria-expanded={filtered.length > 0}
        aria-activedescendant={filtered[highlight] ? `${uid}-opt-${highlight}` : undefined}
      />
      <div
        ref={listRef}
        id={`${uid}-list`}
        // No role when empty: a listbox whose only child is the "No matches"
        // notice is not a listbox.
        role={filtered.length > 0 ? "listbox" : undefined}
        aria-label={filtered.length > 0 ? "Commands" : undefined}
        style={{ marginTop: 14, maxHeight: 360, overflowY: "auto" }}
      >
        {filtered.length === 0 ? (
          <div style={{ color: FG_DIM, fontSize: 11, padding: "20px 0", textAlign: "center" }}>
            No matches for "{query}"
          </div>
        ) : (
          filtered.map((cmd, i) => (
            // Both suppressions below are the aria-activedescendant pattern
            // working AS INTENDED, not a shortcut. An option in this pattern
            // must NOT be focusable (focus stays on the combobox, or the ~33
            // rows become ~33 tab stops), and its keyboard handling lives on
            // that same input's onKeyDown. eslint-plugin-jsx-a11y models the
            // roving-tabindex pattern only, so it cannot see either.
            // eslint-disable-next-line jsx-a11y/interactive-supports-focus, jsx-a11y/click-events-have-key-events
            <div
              key={cmd.id}
              id={`${uid}-opt-${i}`}
              role="option"
              aria-selected={i === highlight}
              data-idx={i}
              onClick={() => { onClose(); setTimeout(() => cmd.action(), 0); }}
              onMouseMove={(e) => onRowPointer(e, i)}
              style={{
                padding: "10px 12px",
                borderRadius: 4,
                cursor: "pointer",
                background: i === highlight ? "rgba(124,156,245,0.12)" : "transparent",
                border: `1px solid ${i === highlight ? ACCENT : "transparent"}`,
                marginBottom: 4,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                {cmd.icon && <span style={{ fontSize: 14, flexShrink: 0 }}>{cmd.icon}</span>}
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: FG_ACTIVE, fontSize: 12, fontWeight: 500, marginBottom: 2 }}>
                    {cmd.label}
                  </div>
                  {cmd.hint && (
                    <div style={{ color: FG_DIM, fontSize: 10, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {cmd.hint}
                    </div>
                  )}
                </div>
              </div>
              {cmd.shortcut && (
                <span
                  style={{
                    color: FG_DIM,
                    fontSize: 10,
                    padding: "2px 6px",
                    border: `1px solid ${BORDER}`,
                    borderRadius: 3,
                    background: "var(--phn-page-bg, #0a0a0a)",
                    flexShrink: 0,
                    fontFamily: M,
                  }}
                >
                  {cmd.shortcut}
                </span>
              )}
            </div>
          ))
        )}
      </div>
      <div style={{ marginTop: 14, color: FG_DIM, fontSize: 10, textAlign: "right" }}>
        {filtered.length} {filtered.length === 1 ? "command" : "commands"} · Esc to close
      </div>
    </Modal>
  );
}

const inputStyle = {
  width: "100%",
  background: "var(--phn-page-bg, #0a0a0a)",
  border: `1px solid ${BORDER}`,
  color: FG_ACTIVE,
  padding: "10px 12px",
  borderRadius: 4,
  fontFamily: M,
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
};
