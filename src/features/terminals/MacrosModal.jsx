// (C)
// Keystroke macros manager. Record what you type into a terminal, save it under
// a name, then replay it into the active terminal with one click — handy for
// repeated login dances, boilerplate commands, multi-step flows. Replaying sends
// the exact captured bytes (Enter included) to the active tab via ptyBridge.
import { useEffect, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { useToast } from "../../components/Toast.jsx";
import {
  loadMacros, saveMacros, previewMacro,
  startMacroRecording, stopMacroRecording, cancelMacroRecording,
  isMacroRecording, onMacroStateChange,
} from "./macros.js";
import { STrash } from "./toolbarIcons.jsx";

const ACCENT = "var(--phn-link, #7c9cf5)";
const DIM = "var(--phn-text-dim, #888)";

export default function MacrosModal({ open, onClose, onReplay, canReplay, activeTabId }) {
  const toast = useToast();
  const [macros, setMacros] = useState([]);
  const [recording, setRecording] = useState(isMacroRecording());
  const [name, setName] = useState("");

  useEffect(() => { if (open) setMacros(loadMacros()); }, [open]);
  useEffect(() => onMacroStateChange(setRecording), []);

  const persist = (list) => { setMacros(list); saveMacros(list); };

  const startRec = () => {
    if (!activeTabId) { toast.error("Open/focus a terminal to record into first."); return; }
    startMacroRecording(activeTabId);
    toast.info("Recording the active terminal — avoid typing passwords (they'd be saved). Click Stop & save when done.");
  };

  const stopRec = () => {
    const data = stopMacroRecording();
    if (!data) { toast.info("Nothing recorded."); return; }
    const nm = name.trim() || `macro ${macros.length + 1}`;
    persist([...macros, { id: `${Date.now().toString(36)}`, name: nm, data }]);
    setName("");
    toast.success(`Saved "${nm}".`);
  };

  const remove = (id) => persist(macros.filter((m) => m.id !== id));

  const replay = (m) => {
    if (!canReplay) { toast.error("No active terminal to replay into."); return; }
    onReplay?.(m.data);
    toast.success(`Replayed "${m.name}".`);
  };

  return (
    <Modal open={open} title="Keystroke macros" onClose={onClose} width={580}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "8px 12px", borderRadius: 6, border: `1px solid ${recording ? "#ff6b6b" : "var(--phn-surface-border, #2a2a2a)"}`, background: "var(--phn-page-bg, #1c1c1c)" }}>
        {recording ? (
          <>
            <span style={{ color: "#ff6b6b", fontSize: 12 }}>● recording the active terminal — no passwords</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name this macro" style={input} />
            <button onClick={stopRec} style={primaryBtn}>Stop &amp; save</button>
            <button onClick={() => cancelMacroRecording()} style={ghostBtn}>Cancel</button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 12, color: DIM, flex: 1 }}>Record a sequence of keystrokes to replay later.</span>
            <button onClick={startRec} style={primaryBtn}>● Record</button>
          </>
        )}
      </div>

      <div style={{ maxHeight: "52vh", overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {macros.length === 0 ? (
          <div style={{ color: DIM, fontSize: 12 }}>No macros yet.</div>
        ) : (
          macros.map((m) => (
            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--phn-surface-border, #2a2a2a)", borderRadius: 6, padding: "7px 12px", background: "var(--phn-surface-bg, #242424)" }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--phn-text-fg, #d4d4d4)" }}>{m.name}</span>
              <span style={{ flex: 1, fontFamily: "'MesloLGS NF', monospace", fontSize: 10.5, color: DIM, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{previewMacro(m.data)}</span>
              <button onClick={() => replay(m)} style={ghostBtn} title="Send to the active terminal">▶ Replay</button>
              <span onClick={() => remove(m.id)} title="Delete" style={{ cursor: "pointer", color: DIM, padding: "2px 5px", display: "inline-flex", alignItems: "center" }}><STrash size={12} /></span>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

const input = {
  flex: 1, background: "var(--phn-surface-bg, #242424)",
  border: "1px solid var(--phn-surface-border, #2a2a2a)", borderRadius: 4,
  color: "var(--phn-text-fg, #d4d4d4)", padding: "5px 8px", fontSize: 12,
  fontFamily: "var(--phn-ui-font)", outline: "none",
};
const primaryBtn = {
  background: ACCENT, border: "none", color: "#06223a", borderRadius: 5,
  padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--phn-ui-font)", whiteSpace: "nowrap",
};
const ghostBtn = {
  background: "transparent", border: `1px solid ${ACCENT}`, color: ACCENT,
  padding: "4px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--phn-ui-font)", whiteSpace: "nowrap",
};
