// (C)
// Named workspaces — save the current panel/tab/split layout under a name and
// restore it later. A saved workspace captures each tab's config (cwd, start
// commands, SSH connection, split tree); loading REPLACES the current layout,
// so open sessions close and the saved ones re-open fresh (TerminalPane's
// unmount kills the old PTYs; mount spawns the new ones). Persisted in user
// state so workspaces survive restarts and are shared across windows.
import { useEffect, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { Button, Input } from "../../components/ui.jsx";

const DIM = "var(--phn-text-dim, #888)";

export default function WorkspacesModal({ open, workspaces, onClose, onSave, onLoad, onDelete }) {
  const [name, setName] = useState("");
  const [confirmLoad, setConfirmLoad] = useState(null); // name awaiting load confirmation

  useEffect(() => { if (open) { setName(""); setConfirmLoad(null); } }, [open]);

  const list = Array.isArray(workspaces) ? workspaces : [];
  const save = () => { const n = name.trim(); if (!n) return; onSave(n); setName(""); };
  const tabCount = (ws) => (ws.panels || []).reduce((n, p) => n + (p.tabs ? p.tabs.length : 0), 0);

  return (
    <Modal open={open} title="Workspaces — save / restore layouts" onClose={onClose} width={560}>
      <div style={{ display: "flex", gap: "var(--phn-sp-2)" }}>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          placeholder="Save current layout as…  (e.g. prod-debug)"
        />
        <Button variant="primary" onClick={save} disabled={!name.trim()}>Save</Button>
      </div>

      <div style={{ marginTop: "var(--phn-sp-3)", maxHeight: "50vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--phn-sp-2)" }}>
        {list.length === 0 ? (
          <div style={{ color: DIM, fontSize: "var(--phn-fs-sm)", padding: "var(--phn-sp-3) 2px" }}>
            No saved workspaces yet. Save your current panel/tab layout above.
          </div>
        ) : (
          list.map((ws) => (
            <div key={ws.name} style={row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--phn-fs-sm)", color: "var(--phn-text-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ws.name}</div>
                <div style={{ fontSize: "var(--phn-fs-2xs)", color: DIM }}>
                  {(ws.panels || []).length} panel{(ws.panels || []).length === 1 ? "" : "s"} · {tabCount(ws)} tab{tabCount(ws) === 1 ? "" : "s"}
                  {ws.savedAt ? ` · ${new Date(ws.savedAt).toLocaleDateString()}` : ""}
                </div>
              </div>
              {confirmLoad === ws.name ? (
                <>
                  <span style={{ fontSize: "var(--phn-fs-2xs)", color: "var(--phn-warning)", whiteSpace: "nowrap" }}>replace current tabs?</span>
                  <Button variant="danger" size="sm" onClick={() => { onLoad(ws); onClose(); }}>Yes, load</Button>
                  <Button variant="subtle" size="sm" onClick={() => setConfirmLoad(null)}>No</Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmLoad(ws.name)}>Load</Button>
                  <Button variant="subtle" size="sm" onClick={() => onDelete(ws.name)} title="Delete workspace">✕</Button>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <p style={{ fontSize: "var(--phn-fs-2xs)", color: DIM, marginTop: "var(--phn-sp-3)", lineHeight: "var(--phn-lh)" }}>
        Captures your panels, tabs and splits (working dirs + start commands). Loading one{" "}
        <strong>replaces</strong> the current layout — open sessions close and the saved ones re-open fresh.
      </p>
    </Modal>
  );
}

const row = {
  display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", padding: "7px var(--phn-sp-3)", borderRadius: "var(--phn-r-md)",
  background: "var(--phn-surface-bg, #242424)", border: "1px solid var(--phn-surface-border, #2a2a2a)",
};
