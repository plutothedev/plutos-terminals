// (C)
// Named workspaces — save the current panel/tab/split layout under a name and
// restore it later. A saved workspace captures each tab's config (cwd, start
// commands, SSH connection, split tree); loading REPLACES the current layout,
// so open sessions close and the saved ones re-open fresh (TerminalPane's
// unmount kills the old PTYs; mount spawns the new ones). Persisted in user
// state so workspaces survive restarts and are shared across windows.
import { useEffect, useState } from "react";
import Modal from "../../components/Modal.jsx";

const DIM = "var(--phn-text-dim, #888)";

export default function WorkspacesModal({ open, workspaces, onClose, onSave, onLoad, onDelete }) {
  const [name, setName] = useState("");
  const [confirmLoad, setConfirmLoad] = useState(null); // name awaiting load confirmation

  useEffect(() => { if (open) { setName(""); setConfirmLoad(null); } }, [open]);

  const list = Array.isArray(workspaces) ? workspaces : [];
  const save = () => { const n = name.trim(); if (!n) return; onSave(n); setName(""); };
  const tabCount = (ws) => (ws.panels || []).reduce((n, p) => n + (p.tabs ? p.tabs.length : 0), 0);

  return (
    <Modal open={open} title="Workspaces — save & restore layouts" onClose={onClose} width={560}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          placeholder="Save current layout as…  (e.g. prod-debug)"
          style={input}
        />
        <button onClick={save} disabled={!name.trim()} style={{ ...primaryBtn, opacity: name.trim() ? 1 : 0.5 }}>save</button>
      </div>

      <div style={{ marginTop: 12, maxHeight: "50vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {list.length === 0 ? (
          <div style={{ color: DIM, fontSize: 12, padding: "10px 2px" }}>
            No saved workspaces yet. Save your current panel/tab layout above.
          </div>
        ) : (
          list.map((ws) => (
            <div key={ws.name} style={row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: "var(--phn-text-fg, #d4d4d4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ws.name}</div>
                <div style={{ fontSize: 10, color: DIM }}>
                  {(ws.panels || []).length} panel{(ws.panels || []).length === 1 ? "" : "s"} · {tabCount(ws)} tab{tabCount(ws) === 1 ? "" : "s"}
                  {ws.savedAt ? ` · ${new Date(ws.savedAt).toLocaleDateString()}` : ""}
                </div>
              </div>
              {confirmLoad === ws.name ? (
                <>
                  <span style={{ fontSize: 10.5, color: "#ffb454", whiteSpace: "nowrap" }}>replace current tabs?</span>
                  <button onClick={() => { onLoad(ws); onClose(); }} style={dangerBtn}>yes, load</button>
                  <button onClick={() => setConfirmLoad(null)} style={ghostBtn}>no</button>
                </>
              ) : (
                <>
                  <button onClick={() => setConfirmLoad(ws.name)} style={ghostBtn}>load</button>
                  <button onClick={() => onDelete(ws.name)} title="Delete workspace" style={delBtn}>✕</button>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <p style={{ fontSize: 10.5, color: DIM, marginTop: 12, lineHeight: 1.5 }}>
        Captures your panels, tabs and splits (working dirs + start commands). Loading one{" "}
        <strong>replaces</strong> the current layout — open sessions close and the saved ones re-open fresh.
      </p>
    </Modal>
  );
}

const input = {
  flex: 1, background: "var(--phn-page-bg, #1c1c1c)",
  border: "1px solid var(--phn-surface-border, #2a2a2a)", borderRadius: 4,
  color: "var(--phn-text-fg, #d4d4d4)", padding: "7px 9px", fontSize: 12.5,
  fontFamily: "var(--phn-ui-font)", outline: "none",
};
const row = {
  display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 6,
  background: "var(--phn-surface-bg, #242424)", border: "1px solid var(--phn-surface-border, #2a2a2a)",
};
const primaryBtn = {
  background: "var(--phn-link, #4aa8c0)", border: "1px solid var(--phn-link, #4aa8c0)",
  color: "#06223a", padding: "6px 14px", borderRadius: 4, fontSize: 11.5, fontWeight: 600,
  cursor: "pointer", fontFamily: "var(--phn-ui-font)", whiteSpace: "nowrap",
};
const ghostBtn = {
  background: "transparent", border: "1px solid var(--phn-surface-border, #3a3a3a)",
  color: "var(--phn-text-fg, #d4d4d4)", padding: "5px 12px", borderRadius: 4,
  fontSize: 11, cursor: "pointer", fontFamily: "var(--phn-ui-font)", whiteSpace: "nowrap",
};
const dangerBtn = {
  background: "transparent", border: "1px solid #ffb454", color: "#ffb454",
  padding: "5px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600,
  cursor: "pointer", fontFamily: "var(--phn-ui-font)", whiteSpace: "nowrap",
};
const delBtn = {
  background: "transparent", border: "none", color: "var(--phn-text-dim, #888)",
  padding: "4px 6px", fontSize: 12, cursor: "pointer", fontFamily: "var(--phn-ui-font)",
};
