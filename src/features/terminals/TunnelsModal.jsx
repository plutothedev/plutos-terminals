// (C)
// SSH port-forwarding ("tunnels") manager. Add a local forward
// (127.0.0.1:localPort → remoteHost:remotePort through the active SSH session)
// and see / stop active forwards. Presentational — TerminalsTab owns the list
// and resolves the connection + password.
import { useState } from "react";
import Modal from "../../components/Modal.jsx";

const inputStyle = {
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

export default function TunnelsModal({ open, host, user, forwards = [], busy, error, onStart, onStop, onClose }) {
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("localhost");
  const [remotePort, setRemotePort] = useState("");

  if (!open) return null;

  const canStart =
    /^\d+$/.test(localPort) && /^\d+$/.test(remotePort) && remoteHost.trim().length > 0 && !busy;

  const submit = () => {
    if (!canStart) return;
    onStart?.({
      localPort: parseInt(localPort, 10),
      remoteHost: remoteHost.trim(),
      remotePort: parseInt(remotePort, 10),
    });
    setLocalPort("");
    setRemotePort("");
  };

  return (
    <Modal open={open} title="SSH port forwarding" onClose={onClose} width={540}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 12, color: "var(--phn-text-fg, #b4b8c0)", lineHeight: 1.5 }}>
          Forward a local port through{" "}
          <span style={{ color: "var(--phn-text-active, #f7f8f8)", fontFamily: "var(--phn-mono-font, monospace)" }}>
            {user}@{host}
          </span>
          . Listens on <code>127.0.0.1</code> only.
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{ width: 92 }}>
            <label style={labelStyle}>Local port</label>
            <input style={inputStyle} value={localPort} onChange={(e) => setLocalPort(e.target.value.replace(/[^\d]/g, ""))} placeholder="8080" inputMode="numeric" />
          </div>
          <div style={{ fontSize: 16, color: "var(--phn-text-dim, #888)", paddingBottom: 7 }}>→</div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Remote host</label>
            <input style={inputStyle} value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="localhost" spellCheck={false} />
          </div>
          <div style={{ width: 92 }}>
            <label style={labelStyle}>Remote port</label>
            <input
              style={inputStyle}
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
              placeholder="5432"
              inputMode="numeric"
            />
          </div>
          <button
            onClick={submit}
            disabled={!canStart}
            style={{
              background: "var(--phn-accent-subtle, rgba(94,106,210,0.15))",
              border: "1px solid var(--phn-link, #5e6ad2)",
              color: "var(--phn-link, #828fff)",
              borderRadius: 6,
              padding: "7px 16px",
              fontSize: 12,
              cursor: canStart ? "pointer" : "not-allowed",
              opacity: canStart ? 1 : 0.5,
              whiteSpace: "nowrap",
            }}
          >
            {busy ? "…" : "Start"}
          </button>
        </div>

        {error && (
          <div style={{ fontSize: 11, color: "#f87171" }}>{error}</div>
        )}

        <div>
          <label style={labelStyle}>Active forwards</label>
          {forwards.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--phn-text-dim, #777)", padding: "8px 0" }}>None yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {forwards.map((f) => (
                <div
                  key={f.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--phn-surface-border, #2b2b2b)",
                    background: "var(--phn-page-bg, rgba(0,0,0,0.25))",
                  }}
                >
                  <span style={{ flex: 1, fontFamily: "var(--phn-mono-font, monospace)", fontSize: 12, color: "var(--phn-text-active, #e6e6e6)" }}>
                    <span style={{ color: "var(--phn-success, #10b981)" }}>●</span> 127.0.0.1:{f.localPort} → {f.remoteHost}:{f.remotePort}
                  </span>
                  <button
                    onClick={() => onStop?.(f.id)}
                    title="Stop this forward"
                    style={{
                      background: "transparent",
                      border: "1px solid var(--phn-surface-border, #2b2b2b)",
                      color: "var(--phn-text-fg, #b4b8c0)",
                      borderRadius: 5,
                      padding: "3px 10px",
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    Stop
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
