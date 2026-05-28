// (C)
// MultiExec broadcast group picker. By default MultiExec types into every
// VISIBLE terminal; this lets you instead pick an explicit subset (across all
// panels, visible or not) so a keystroke fans out only to the chosen tabs.
// Applying a non-empty selection turns broadcast on and sets the target group;
// "All visible" clears the group back to the default behavior.
import { useEffect, useState } from "react";
import Modal from "../../components/Modal.jsx";

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
    <Modal open={open} title="MultiExec — choose broadcast targets" onClose={onClose} width={520}>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button onClick={() => setSel(new Set(allIds))} style={ghostBtn}>select all</button>
        <button onClick={() => setSel(new Set())} style={ghostBtn}>select none</button>
        <span style={{ flex: 1 }} />
        <button onClick={() => { onUseAllVisible(); onClose(); }} style={ghostBtn} title="Clear the group — broadcast to every visible terminal">
          all visible (default)
        </button>
      </div>

      <div style={{ maxHeight: "50vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
        {groups.length === 0 ? (
          <div style={{ color: DIM, fontSize: 12, padding: "8px 2px" }}>
            No live terminals to broadcast to yet.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.panelId}>
              <div style={{ fontSize: 10, color: DIM, letterSpacing: 0.5, marginBottom: 4 }}>PANEL {g.pi + 1}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {g.tabs.map((t, ti) => (
                  <label key={t.id} style={rowStyle}>
                    <input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} style={{ accentColor: "var(--phn-link, #4aa8c0)" }} />
                    <span style={{ fontSize: 12.5, color: "var(--phn-text-fg, #d4d4d4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {ti + 1}. {t.label || "shell"}
                    </span>
                    {t.connection && <span style={{ fontSize: 10, color: DIM }}>🔗 {t.connection.host}</span>}
                  </label>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
        <span style={{ fontSize: 11, color: DIM }}>{sel.size} selected</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={ghostBtn}>cancel</button>
          <button onClick={() => { onApply([...sel]); onClose(); }} disabled={sel.size === 0} style={{ ...primaryBtn, opacity: sel.size ? 1 : 0.5 }}>
            broadcast to {sel.size || ""} ▶
          </button>
        </div>
      </div>
    </Modal>
  );
}

const rowStyle = {
  display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", borderRadius: 4,
  cursor: "pointer", background: "var(--phn-surface-bg, #242424)",
  border: "1px solid var(--phn-surface-border, #2a2a2a)",
};
const ghostBtn = {
  background: "transparent", border: "1px solid var(--phn-surface-border, #3a3a3a)",
  color: "var(--phn-text-fg, #d4d4d4)", padding: "5px 12px", borderRadius: 4,
  fontSize: 11, cursor: "pointer", fontFamily: "var(--phn-ui-font)", whiteSpace: "nowrap",
};
const primaryBtn = {
  background: "var(--phn-link, #4aa8c0)", border: "1px solid var(--phn-link, #4aa8c0)",
  color: "#06223a", padding: "5px 14px", borderRadius: 4, fontSize: 11.5, fontWeight: 600,
  cursor: "pointer", fontFamily: "var(--phn-ui-font)", whiteSpace: "nowrap",
};
