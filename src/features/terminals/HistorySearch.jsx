// (C)
// Command-history search overlay (Ctrl+R-style). Fuzzy-filters the cross-session
// command history captured via the shell preexec hook (see TerminalPane OSC 1337
// + ptyBridge.recordCommand). Enter inserts the command on the prompt for review;
// mod+Enter (Ctrl on Win/Linux, ⌘ on mac) runs it immediately. Plain Ctrl+R is
// left to the shell's own reverse-i-search (this opens on the app's History
// binding, Ctrl/⌘+R via the collapsed-mod dispatcher).
import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { Button, Input } from "../../components/ui.jsx";
import { modCombo } from "./keybindings.js";

const DIM = "var(--phn-text-dim, #888)";

export default function HistorySearch({ open, history, onClose, onInsert, onRun }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open]);

  const items = useMemo(() => {
    const list = Array.isArray(history) ? history : [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((c) => c.toLowerCase().includes(needle));
  }, [history, q]);

  useEffect(() => { setSel(0); }, [q]);
  const cur = Math.min(sel, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur, items.length]);

  const choose = (cmd, run) => {
    if (!cmd) return;
    if (run) onRun(cmd); else onInsert(cmd);
    onClose();
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(items[cur], e.metaKey || e.ctrlKey); }
  };

  return (
    <Modal open={open} title="Command history — search & re-run" onClose={onClose} width={660}>
      <Input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type to filter your command history…"
      />
      <div ref={listRef} style={{ marginTop: "var(--phn-sp-3)", maxHeight: "55vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
        {items.length === 0 ? (
          <div style={{ color: DIM, fontSize: "var(--phn-fs-sm)", padding: "var(--phn-sp-3) var(--phn-sp-1)" }}>
            {history && history.length
              ? "No commands match your filter."
              : "No history yet — run some commands and they'll show up here."}
          </div>
        ) : (
          items.map((cmd, i) => (
            <div
              key={`${cmd}\u0000${i}`}
              data-idx={i}
              onClick={() => choose(cmd, false)}
              onMouseEnter={() => setSel(i)}
              title={`Enter = insert · ${modCombo("Enter")} = run`}
              style={{
                display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", padding: "5px var(--phn-sp-2)", borderRadius: "var(--phn-r-sm)", cursor: "pointer",
                background: i === cur ? "var(--phn-accent-subtle, rgba(74,168,192,0.16))" : "transparent",
                border: `1px solid ${i === cur ? "var(--phn-link, #7c9cf5)" : "transparent"}`,
              }}
            >
              <span style={{ fontFamily: "var(--phn-mono-font)", fontSize: "var(--phn-fs-sm)", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis", flex: 1, color: "var(--phn-text-fg)" }}>
                {cmd}
              </span>
              {i === cur && (
                <Button variant="primary" size="sm" onClick={(e) => { e.stopPropagation(); choose(cmd, true); }} title={`Run now (${modCombo("Enter")})`}>
                  Run ▶
                </Button>
              )}
            </div>
          ))
        )}
      </div>
      <p style={{ fontSize: "var(--phn-fs-2xs)", color: DIM, marginTop: "var(--phn-sp-3)", lineHeight: "var(--phn-lh)" }}>
        <strong>↑/↓</strong> select · <strong>Enter</strong> insert on the prompt (edit first) ·
        <strong> {modCombo("Enter")}</strong> run now · <strong>Esc</strong> close. Plain <strong>Ctrl+R</strong> still runs the shell's reverse-search.
      </p>
    </Modal>
  );
}
