// (C)
// RDP connection prompt. Password is handed to the RDP tab transiently via
// ptyBridge (never persisted); username/host/port/domain ride on the tab.
import { useEffect, useId, useRef, useState } from "react";
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

// `targetId` names what the form is for: the saved session's project id, or
// "quick" for Quick connect (ModalHost passes it). Without one, the key falls
// back to every field of the target, so two saved sessions on one host and
// port with different users still never share a form.
function formKey(targetId, initial) {
  if (targetId != null) return `id:${targetId}`;
  if (!initial) return "quick";
  return `t:${JSON.stringify([initial.host, initial.port, initial.username, initial.domain])}`;
}

export default function RdpConnectModal({ open, onConnect, onClose, initial = null, lockConnection = false, title, onSaveSession, targetId }) {
  const key = formKey(targetId, initial);
  const bodyRef = useRef(null);
  // The key the form was last mounted under. A switch while open remounts the
  // form, which unmounts the field that had focus and drops focus on <body>;
  // Modal's own initial focus ran once, on open, and does not run again. So
  // after a key change, apply the same data-autofocus rule here: focus the
  // marked field, unless focus is already somewhere inside the dialog.
  const shownKey = useRef(key);
  useEffect(() => {
    if (shownKey.current === key) return;
    shownKey.current = key;
    const root = bodyRef.current;
    const dialog = root?.closest(".phn-modal");
    if (!root || !dialog || dialog.contains(document.activeElement)) return;
    const marked = root.querySelector('[data-autofocus]:not([data-autofocus="false"])');
    marked?.focus();
  }, [key]);

  if (!open) return null;
  return (
    <Modal open={open} title={title || "RDP connection"} onClose={onClose} width={460}>
      {/* Keyed on the target: a switch from one saved session to another (or
          to Quick connect) while open remounts the form, so a password typed
          for one session can never be sent to another. */}
      <RdpConnectBody key={key} rootRef={bodyRef} onConnect={onConnect} onClose={onClose} initial={initial} lockConnection={lockConnection} onSaveSession={onSaveSession} />
    </Modal>
  );
}

// Mounted fresh on every open, so the form starts from `initial` (a saved
// session being launched, locked) or blank, and the typed password is dropped
// with the component when the dialog closes.
function RdpConnectBody({ rootRef, onConnect, onClose, initial, lockConnection, onSaveSession }) {
  const [host, setHost] = useState(initial?.host || "");
  const [port, setPort] = useState(initial?.port != null ? String(initial.port) : "3389");
  const [username, setUsername] = useState(initial?.username || "");
  const [domain, setDomain] = useState(initial?.domain || "");
  const [password, setPassword] = useState("");
  // A11Y-10. Every caption here was a bare <label> sitting NEXT to its input,
  // related only by pixels: a screen reader announced five anonymous "edit"
  // fields in a row, and clicking the word "Host" did not focus Host. useId
  // rather than literal ids so a second instance can never collide.
  const uid = useId();

  // Initial focus is Modal's (data-autofocus below): Host for a new
  // connection; for a saved-session launch, where everything but the password
  // is locked, the password field.

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
    <>
      <div ref={rootRef} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={label} htmlFor={`${uid}-host`}>Host</label>
            <input id={`${uid}-host`} data-autofocus={lockConnection ? undefined : true} style={field} value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" spellCheck={false} readOnly={lockConnection} />
          </div>
          <div style={{ width: 96 }}>
            <label style={label} htmlFor={`${uid}-port`}>Port</label>
            <input id={`${uid}-port`} style={field} value={port} onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" readOnly={lockConnection} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={label} htmlFor={`${uid}-username`}>Username</label>
            <input id={`${uid}-username`} style={field} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Administrator" spellCheck={false} readOnly={lockConnection} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={label} htmlFor={`${uid}-domain`}>Domain (optional)</label>
            <input id={`${uid}-domain`} style={field} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="" spellCheck={false} readOnly={lockConnection} />
          </div>
        </div>
        <div>
          <label style={label} htmlFor={`${uid}-password`}>Password</label>
          <input
            id={`${uid}-password`}
            data-autofocus={lockConnection ? true : undefined}
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
          Connects with NLA (CredSSP). Uses the host&apos;s TLS cert (self-signed accepted). The password is used only for this connection and is never saved.
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
    </>
  );
}
