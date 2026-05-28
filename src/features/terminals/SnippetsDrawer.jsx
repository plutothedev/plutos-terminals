// (C)
// Right-side snippets drawer (Termius-style saved commands). Click a snippet to
// type it into the active terminal — the parent wires onInsert to ptyBridge's
// writeToTab so the command lands in whichever tab is focused (or broadcasts to
// all visible terminals when MultiExec is on).
//
// Snippets persist in app state when the parent passes `snippets` +
// `onSnippetsChange`. With no onSnippetsChange the drawer is read-only and shows
// the built-in starter set, so it still works before persistence is wired.
import { useMemo, useState } from "react";

export const DEFAULT_SNIPPETS = [
  { id: "git-status", name: "Git status", command: "git status" },
  { id: "git-log", name: "Git log", command: "git log --oneline -20" },
  { id: "ls", name: "List files", command: "ls -la" },
  { id: "pwd", name: "Current dir", command: "pwd" },
  { id: "node-v", name: "Node + npm version", command: "node -v && npm -v" },
  { id: "disk", name: "Disk usage", command: "du -sh * | sort -h" },
  { id: "clear", name: "Clear screen", command: "clear" },
];

function freshSnippetId() {
  return `snip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Parameterized snippets: {{name}} placeholders prompt for a value on insert.
const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
function extractVars(command) {
  const out = [];
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(command || ""))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
function fillVars(command, vals) {
  return String(command || "").replace(VAR_RE, (_, name) => (vals[name] ? vals[name] : `{{${name}}}`));
}

export default function SnippetsDrawer({
  open,
  onClose,
  onInsert,
  snippets,
  onSnippetsChange,
  docked = false,
}) {
  const editable = typeof onSnippetsChange === "function";
  const items = Array.isArray(snippets) ? snippets : DEFAULT_SNIPPETS;

  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [fillSnippet, setFillSnippet] = useState(null); // snippet with {{vars}} awaiting values
  const [vals, setVals] = useState({});

  // Click → insert. If the command has {{vars}}, open the fill form first.
  const handlePick = (s) => {
    const vars = extractVars(s.command);
    if (vars.length) {
      setFillSnippet(s);
      setVals(Object.fromEntries(vars.map((v) => [v, ""])));
    } else {
      onInsert?.(s.command);
    }
  };
  const doFill = () => {
    if (!fillSnippet) return;
    onInsert?.(fillVars(fillSnippet.command, vals));
    setFillSnippet(null);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (s) =>
        (s.name || "").toLowerCase().includes(q) ||
        (s.command || "").toLowerCase().includes(q)
    );
  }, [items, query]);

  const commitAdd = () => {
    const name = newName.trim();
    const command = newCommand.trim();
    if (!command) return;
    onSnippetsChange?.([
      ...items,
      { id: freshSnippetId(), name: name || command, command },
    ]);
    setNewName("");
    setNewCommand("");
    setAdding(false);
  };

  const removeSnippet = (id) => {
    onSnippetsChange?.(items.filter((s) => s.id !== id));
  };

  // In MobaXterm layout the drawer renders inline in the left dock (.moba-dock-panel)
  // — no slide-over transform, always shown. Otherwise it's a right slide-over.
  return (
    <div
      className={docked ? "moba-dock-panel" : open ? "phn-snippets-drawer open" : "phn-snippets-drawer"}
      aria-hidden={!docked && !open}
    >
      <div className="phn-snippets-header">
        <span>📋 Snippets</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {editable && (
            <button
              className="phn-snippets-close"
              onClick={() => setAdding((v) => !v)}
              title={adding ? "Cancel" : "Add a snippet"}
              style={{ fontSize: 16 }}
            >
              {adding ? "−" : "+"}
            </button>
          )}
          <button
            className="phn-snippets-close"
            onClick={onClose}
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="phn-sidebar-search-wrap">
        <input
          className="phn-sidebar-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (query) {
                e.stopPropagation();
                setQuery("");
              }
            }
          }}
          placeholder="Filter snippets…"
          spellCheck={false}
        />
      </div>

      {adding && editable && (
        <div style={{ padding: "4px 8px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            className="phn-sidebar-search"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (optional)"
            spellCheck={false}
          />
          <input
            className="phn-sidebar-search"
            value={newCommand}
            onChange={(e) => setNewCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitAdd();
              }
            }}
            placeholder="Command"
            spellCheck={false}
            style={{ fontFamily: "'JetBrains Mono', Menlo, Monaco, monospace" }}
          />
          <button
            className="phn-snippets-close"
            onClick={commitAdd}
            disabled={!newCommand.trim()}
            style={{
              alignSelf: "flex-end",
              border: "1px solid var(--phn-surface-border, #2b2b2b)",
              padding: "4px 12px",
              borderRadius: 4,
              opacity: newCommand.trim() ? 1 : 0.5,
              cursor: newCommand.trim() ? "pointer" : "not-allowed",
            }}
          >
            Save
          </button>
        </div>
      )}

      {fillSnippet && (
        <div style={{ padding: "8px", display: "flex", flexDirection: "column", gap: 6, borderBottom: "1px solid var(--phn-surface-border, #2b2b2b)" }}>
          <div style={{ fontSize: 11, color: "var(--phn-text-dim, #888)" }}>
            Fill in <strong style={{ color: "var(--phn-text-fg, #d4d4d4)" }}>{fillSnippet.name}</strong>
          </div>
          {extractVars(fillSnippet.command).map((v, i) => (
            <input
              key={v}
              className="phn-sidebar-search"
              autoFocus={i === 0}
              value={vals[v] || ""}
              onChange={(e) => setVals({ ...vals, [v]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); doFill(); }
                if (e.key === "Escape") { e.stopPropagation(); setFillSnippet(null); }
              }}
              placeholder={v}
              spellCheck={false}
            />
          ))}
          <div style={{ fontFamily: "'JetBrains Mono', Menlo, Monaco, monospace", fontSize: 10.5, color: "var(--phn-text-dim, #888)", wordBreak: "break-all" }}>
            {fillVars(fillSnippet.command, vals)}
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button className="phn-snippets-close" onClick={() => setFillSnippet(null)} style={{ border: "1px solid var(--phn-surface-border, #2b2b2b)", padding: "4px 12px", borderRadius: 4 }}>cancel</button>
            <button className="phn-snippets-close" onClick={doFill} style={{ border: "1px solid var(--phn-surface-border, #2b2b2b)", padding: "4px 12px", borderRadius: 4 }}>insert</button>
          </div>
        </div>
      )}

      <div className="phn-snippets-list">
        {filtered.length === 0 ? (
          <div className="phn-snippets-empty">
            {query
              ? "No snippets match your filter."
              : "No snippets yet. Use + to add one."}
          </div>
        ) : (
          filtered.map((s) => (
            <div
              key={s.id}
              className="phn-snippet-item"
              onClick={() => handlePick(s)}
              title={`Insert into active terminal: ${s.command}`}
              style={{ position: "relative" }}
            >
              <div className="phn-snippet-name">{s.name}</div>
              <div className="phn-snippet-command">{s.command}</div>
              {editable && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSnippet(s.id);
                  }}
                  title="Delete snippet"
                  style={{
                    position: "absolute",
                    top: 6,
                    right: 8,
                    color: "var(--phn-text-dim, #888)",
                    fontSize: 12,
                    lineHeight: 1,
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "#f44";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--phn-text-dim, #888)";
                  }}
                >
                  ×
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
