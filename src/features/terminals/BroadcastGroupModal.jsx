// (C)
// MultiExec broadcast group picker. By default MultiExec types into every
// VISIBLE terminal; this lets you instead pick an explicit subset (across all
// panels, visible or not) so a keystroke fans out only to the chosen tabs.
// Applying a non-empty selection turns broadcast on and sets the target group;
// "All visible" clears the group back to the default behavior.
import { useEffect, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { Button } from "../../components/ui.jsx";
import { SLink } from "./toolbarIcons.jsx";

const DIM = "var(--phn-text-dim, #888)";

export default function BroadcastGroupModal({ open, panels, liveTabIds, current, onClose, onApply, onUseAllVisible }) {
  const [sel, setSel] = useState(() => new Set());

  useEffect(() => {
    if (open) setSel(new Set(current || []));
  }, [open, current]);

  const live = new Set(liveTabIds || []);
  // Only offer tabs that have a live PTY (a fresh/home tab with no shell can't
  // receive a broadcast).
  const groups = (panels || [])
    .map((p, pi) => ({
      pi,
      panelId: p.id,
      tabs: (p.tabs || []).filter((t) => live.has(t.id)),
    }))
    .filter((g) => g.tabs.length);

  const allIds = groups.flatMap((g) => g.tabs.map((t) => t.id));
  const toggle = (id) => {
    const next = new Set(sel);
    next.has(id) ? next.delete(id) : next.add(id);
    setSel(next);
  };

  return (
    <Modal open={open} title="Broadcast typing — choose targets" onClose={onClose} width={520}>
      <div style={{ display: "flex", gap: "var(--phn-sp-2)", marginBottom: "var(--phn-sp-3)" }}>
        <Button variant="ghost" size="sm" onClick={() => setSel(new Set(allIds))}>Select all</Button>
        <Button variant="ghost" size="sm" onClick={() => setSel(new Set())}>Select none</Button>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={() => { onUseAllVisible(); onClose(); }} title="Clear the group — broadcast to every visible terminal">
          All visible (default)
        </Button>
      </div>

      <div style={{ maxHeight: "50vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--phn-sp-3)" }}>
        {groups.length === 0 ? (
          <div style={{ color: DIM, fontSize: "var(--phn-fs-sm)", padding: "var(--phn-sp-2) 2px" }}>
            No live terminals to broadcast to yet.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.panelId}>
              <div style={{ fontSize: "var(--phn-fs-2xs)", color: DIM, letterSpacing: 0.5, marginBottom: "var(--phn-sp-1)" }}>PANEL {g.pi + 1}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {g.tabs.map((t, ti) => (
                  <label key={t.id} style={rowStyle}>
                    <input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} style={{ accentColor: "var(--phn-link, #7c9cf5)" }} />
                    <span style={{ fontSize: "var(--phn-fs-sm)", color: "var(--phn-text-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {ti + 1}. {t.label || "shell"}
                    </span>
                    {t.connection && <span style={{ fontSize: "var(--phn-fs-2xs)", color: DIM, display: "inline-flex", alignItems: "center", gap: 4 }}><SLink size={10} /> {t.connection.host}</span>}
                  </label>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "var(--phn-sp-4)" }}>
        <span style={{ fontSize: "var(--phn-fs-xs)", color: DIM }}>{sel.size} selected</span>
        <div style={{ display: "flex", gap: "var(--phn-sp-2)" }}>
          <Button variant="subtle" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { onApply([...sel]); onClose(); }} disabled={sel.size === 0}>
            Broadcast to {sel.size || ""} ▶
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const rowStyle = {
  display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", padding: "var(--phn-sp-1) var(--phn-sp-2)", borderRadius: "var(--phn-r-sm)",
  cursor: "pointer", background: "var(--phn-surface-bg, #242424)",
  border: "1px solid var(--phn-surface-border, #2a2a2a)",
};
