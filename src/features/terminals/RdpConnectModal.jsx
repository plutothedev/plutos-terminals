// (C)
// RDP connection prompt. Password is handed to the RDP tab transiently via
// ptyBridge (never persisted); username/host/port/domain ride on the tab.
import { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";

const field = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--phn-page-bg, #08090a)",
  border: "1px solid var(--phn-surface-border, #2b2b2b)",
  color: "var(--phn-text-active, #f7f8f8)",
  borderRadius: 6,
  padding: "7px 9px",
  fontSize: 13,
  outline: "none",
};
const label = { fontSize: 10, letterSpacing: 0.5, color: "var(--phn-text-dim, #888)", marginBottom: 4, display: "block", textTransform: "uppercase" };

export default function RdpConnectModal({ open, onConnect, onClose, initial = null, lockConnection = false, title, onSaveSession }) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("3389");
  const [username, setUsername] = useState("");
  const [domain, setDomain] = useState("");
  const [password, setPassword] = useState("");
  const hostRef = useRef(null);

  useEffect(() => {
    if (open) {
      // Pre-fill (and lock) from a saved session when launching; else blank.
      setHost(initial?.host || "");
      setPort(initial?.port != null ? String(initial.port) : "3389");
      setUsername(initial?.username || "");
      setDomain(initial?.domain || "");
      setPassword("");
      const t = setTimeout(() => (lockConnection ? null : hostRef.current?.focus()), 30);
      return () => clearTimeout(t);
    }
  }, [open, initial, lockConnection]);

  if (!open) return null;

  // For a saved-session launch we only need the password; host/username are locked.
  const canConnect = lockConnection ? host.trim().length > 0 : (host.trim().length > 0 && username.trim().length > 0);
  const connect = () => {
    if (!canConnect) return;
    onConnect?.({
      host: host.trim(),
      port: parseInt(port, 10) || 3389,
      username: username.trim(),
      domain: domain.trim() || null,
      password,
    });
  };
  const saveSession = () => {
    if (!(host.trim().length > 0)) return;
    onSaveSession?.({ host: host.trim(), port: parseInt(port, 10) || 3389, username: username.trim(), domain: domain.trim() || null });
  };

  return (
    <Modal open={open} title={title || "RDP connection"} onClose={onClose} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={label}>Host</label>
            <input ref={hostRef} style={field} value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" spellCheck={false} readOnly={lockConnection} />
          </div>
          <div style={{ width: 96 }}>
            <label style={label}>Port</label>
            <input style={field} value={port} onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" readOnly={lockConnection} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={label}>Username</label>
            <input style={field} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Administrator" spellCheck={false} readOnly={lockConnection} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={label}>Domain (optional)</label>
            <input style={field} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="" spellCheck={false} readOnly={lockConnection} />
          </div>
        </div>
        <div>
          <label style={label}>Password</label>
          <input
            style={field}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); connect(); } }}
            placeholder="Password"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div style={{ fontSize: 11, color: "var(--phn-text-dim, #888)", lineHeight: 1.5 }}>
          Connects with NLA (CredSSP). Uses the host's TLS cert (self-signed accepted). The password is used only for this connection and is never saved.
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div>
            {onSaveSession && !lockConnection && (
              <button
                onClick={saveSession}
                disabled={!(host.trim().length > 0)}
                title="Save this connection as a session in the sidebar"
                style={{ background: "transparent", border: "1px solid var(--phn-surface-border, #2b2b2b)", color: "var(--phn-text-dim, #9aa0a6)", borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: host.trim().length > 0 ? "pointer" : "not-allowed", opacity: host.trim().length > 0 ? 1 : 0.5 }}
              >
                Save this connection
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid var(--phn-surface-border, #2b2b2b)", color: "var(--phn-text-fg, #b4b8c0)", borderRadius: 6, padding: "6px 14px", fontSize: 12, cursor: "pointer" }}>Cancel</button>
          <button
            onClick={connect}
            disabled={!canConnect}
            style={{
              background: "var(--phn-accent-subtle, rgba(94,106,210,0.15))",
              border: "1px solid var(--phn-link, #5e6ad2)",
              color: "var(--phn-link, #828fff)",
              borderRadius: 6,
              padding: "6px 16px",
              fontSize: 12,
              cursor: canConnect ? "pointer" : "not-allowed",
              opacity: canConnect ? 1 : 0.5,
            }}
          >
            Connect
          </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
