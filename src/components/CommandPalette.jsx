// Command palette — Ctrl+K / Cmd+K opens. Searchable list of all top-level
// actions. Arrow keys navigate; Enter runs; Esc closes. v0.1.16.

import { useEffect, useMemo, useRef, useState } from "react";
import Modal, { MODAL_COLORS } from "./Modal.jsx";

const { FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M } = MODAL_COLORS;

export default function CommandPalette({ open, commands, onClose }) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef(null);

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
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

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

  return (
    <Modal open={open} title="Command palette" onClose={onClose} width={560}>
      <input
        ref={inputRef}
        type="text"
        placeholder="type to search commands… (↑↓ navigate, Enter run, Esc close)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        style={inputStyle}
      />
      <div style={{ marginTop: 14, maxHeight: 360, overflowY: "auto" }}>
        {filtered.length === 0 ? (
          <div style={{ color: FG_DIM, fontSize: 11, padding: "20px 0", textAlign: "center" }}>
            No matches for "{query}"
          </div>
        ) : (
          filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              onClick={() => { onClose(); setTimeout(() => cmd.action(), 0); }}
              onMouseEnter={() => setHighlight(i)}
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
