// (C)
// Command-history search overlay (Ctrl+R-style). Fuzzy-filters the cross-session
// command history captured via the shell preexec hook (see TerminalPane OSC 1337
// + ptyBridge.recordCommand). Enter inserts the command on the prompt for review;
// mod+Enter (Ctrl on Win/Linux, ⌘ on mac) runs it immediately. Plain Ctrl+R is
// left to the shell's own reverse-i-search (this opens on the app's History
// binding, Ctrl/⌘+R via the collapsed-mod dispatcher).
import { useEffect, useId, useMemo, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { Button, Input } from "../../components/ui.jsx";
import { modCombo } from "./keybindings.js";

const DIM = "var(--phn-text-dim, #888)";

export default function HistorySearch({ open, history, onClose, onInsert, onRun }) {
  // Modal renders nothing while closed, so the body below mounts fresh on every
  // open: the query and selection reset by remounting, not by an effect.
  return (
    <Modal open={open} title="Command history: search & re-run" onClose={onClose} width={660}>
      <HistoryBody history={history} onClose={onClose} onInsert={onInsert} onRun={onRun} />
    </Modal>
  );
}

function HistoryBody({ history, onClose, onInsert, onRun }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const uid = useId();
  const optionId = (i) => `${uid}-opt-${i}`;

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  const items = useMemo(() => {
    const list = Array.isArray(history) ? history : [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((c) => c.toLowerCase().includes(needle));
  }, [history, q]);

  // Typing resets the selection to the first match (done in the handler that
  // changes the query, not in an effect).
  const onQueryChange = (e) => { setQ(e.target.value); setSel(0); };
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
    <>
      {/* Focus never leaves the filter field: the arrow keys move the active
          option and aria-activedescendant tells assistive tech which one it is
          (the listbox pattern for a filter box), so the rows take no focus and
          need no key handler of their own. */}
      <Input
        ref={inputRef}
        value={q}
        onChange={onQueryChange}
        onKeyDown={onKeyDown}
        aria-controls={`${uid}-list`}
        aria-activedescendant={items.length ? optionId(cur) : undefined}
        placeholder="Type to filter your command history…"
      />
      <div ref={listRef} id={`${uid}-list`} role="listbox" aria-label="Command history" style={{ marginTop: "var(--phn-sp-3)", maxHeight: "55vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
        {items.length === 0 ? (
          <div style={{ color: DIM, fontSize: "var(--phn-fs-sm)", padding: "var(--phn-sp-3) var(--phn-sp-1)" }}>
            {history && history.length
              ? "No commands match your filter."
              : "No history yet. Run some commands and they'll show up here."}
          </div>
        ) : (
          items.map((cmd, i) => (
            // Mouse path only: the keyboard path for the same action is the
            // filter field's arrows + Enter, with this row as its
            // aria-activedescendant. The row never takes focus, so a key
            // handler here would be dead code.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- keyboard selection lives on the filter input (aria-activedescendant points at this option); the option is never focused
            <div
              key={`${cmd}\u0000${i}`}
              id={optionId(i)}
              data-idx={i}
              role="option"
              aria-selected={i === cur}
              // -1: an option must be focusable for jsx-a11y, but it is never
              // in the Tab order (focus stays on the filter field).
              tabIndex={-1}
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
        <strong> {modCombo("Enter")}</strong> run now · <strong>Esc</strong> close. Plain <strong>Ctrl+R</strong> still runs the shell&apos;s reverse-search.
      </p>
    </>
  );
}
