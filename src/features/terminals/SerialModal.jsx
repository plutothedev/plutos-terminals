// (C)
// Serial console picker. Lists available serial ports (serial_list) and a baud
// rate; on connect, the parent opens a tab whose TerminalPane spawns the port
// via serial_spawn (streamed through the same pty:// seam as shells/SSH).
import { useEffect, useState } from "react";
import { invoke } from "@backend";
import Modal from "../../components/Modal.jsx";
import { humanizeError } from "./errorText.js";

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

const fieldStyle = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--phn-page-bg, #08090a)",
  border: "1px solid var(--phn-surface-border, #2b2b2b)",
  color: "var(--phn-text-active, #f7f8f8)",
  borderRadius: 6,
  padding: "7px 9px",
  fontSize: 13,
  outline: "none",
  fontFamily: "var(--phn-mono-font, monospace)",
};
const labelStyle = { fontSize: 10, letterSpacing: 0.5, color: "var(--phn-text-dim, #888)", marginBottom: 4, display: "block", textTransform: "uppercase" };

export default function SerialModal({ open, onConnect, onClose }) {
  const [ports, setPorts] = useState([]);
  const [selected, setSelected] = useState("");
  const [baud, setBaud] = useState(115200);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const refresh = () => {
    setLoading(true);
    setError(null);
    invoke("serial_list")
      .then((list) => {
        const arr = Array.isArray(list) ? list : [];
        setPorts(arr);
        setSelected((s) => (arr.includes(s) ? s : arr[0] || ""));
      })
      .catch((e) => setError(humanizeError(e).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { if (open) refresh(); }, [open]);

  if (!open) return null;

  const connect = () => { if (selected) onConnect?.({ path: selected, baud }); };

  return (
    <Modal open={open} title="Serial console" onClose={onClose} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Port</label>
            <select style={fieldStyle} value={selected} onChange={(e) => setSelected(e.target.value)} disabled={ports.length === 0}>
              {ports.length === 0 ? (
                <option value="">{loading ? "Scanning…" : "No serial devices found"}</option>
              ) : (
                ports.map((p) => <option key={p} value={p}>{p}</option>)
              )}
            </select>
          </div>
          <div style={{ width: 120 }}>
            <label style={labelStyle}>Baud</label>
            <select style={fieldStyle} value={baud} onChange={(e) => setBaud(parseInt(e.target.value, 10))}>
              {BAUDS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <button
            onClick={refresh}
            title="Rescan ports"
            style={{ background: "transparent", border: "1px solid var(--phn-surface-border, #2b2b2b)", color: "var(--phn-text-fg, #b4b8c0)", borderRadius: 6, padding: "7px 12px", fontSize: 13, cursor: "pointer" }}
          >
            ⟳
          </button>
        </div>

        {error && <div style={{ fontSize: 11, color: "var(--phn-danger, #f87171)" }}>{error}</div>}

        <div style={{ fontSize: 11, color: "var(--phn-text-dim, #888)", lineHeight: 1.5 }}>
          Connects to a USB/UART device. Shows as <code>COM3</code>… on Windows, <code>/dev/tty.usbserial-*</code> on macOS.
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "1px solid var(--phn-surface-border, #2b2b2b)", color: "var(--phn-text-fg, #b4b8c0)", borderRadius: 6, padding: "6px 14px", fontSize: 12, cursor: "pointer" }}
          >
            Cancel
          </button>
          <button
            onClick={connect}
            disabled={!selected}
            style={{
              background: "var(--phn-accent-subtle, rgba(94,106,210,0.15))",
              border: "1px solid var(--phn-link, #5e6ad2)",
              color: "var(--phn-link, #828fff)",
              borderRadius: 6,
              padding: "6px 16px",
              fontSize: 12,
              cursor: selected ? "pointer" : "not-allowed",
              opacity: selected ? 1 : 0.5,
            }}
          >
            Connect
          </button>
        </div>
      </div>
    </Modal>
  );
}
