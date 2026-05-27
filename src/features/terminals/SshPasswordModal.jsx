// (C)
// Transient SSH password prompt. The password is handed straight to ssh_spawn
// via the ptyBridge (in-memory, keyed by tab id) and is NEVER written to
// localStorage or the saved session — re-prompted on a fresh connect. The
// encrypted credential vault is a later phase.
import { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";

export default function SshPasswordModal({ open, host, user, onSubmit, onCancel }) {
  const [password, setPassword] = useState("");
  const inputRef = useRef(null);

  // Clear the field whenever the modal opens, and focus it. Never keep a
  // password in component state once the modal closes.
  useEffect(() => {
    if (open) {
      setPassword("");
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  if (!open) return null;

  const submit = () => {
    onSubmit?.(password);
    setPassword("");
  };

  return (
    <Modal open={open} title="SSH password" onClose={onCancel} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 12, color: "var(--phn-text-fg, #b4b8c0)", lineHeight: 1.5 }}>
          Connecting to{" "}
          <span style={{ color: "var(--phn-text-active, #f7f8f8)", fontFamily: "var(--phn-mono-font, monospace)" }}>
            {user}@{host}
          </span>
          . The password is used only for this connection and is never saved to disk.
        </div>
        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            else if (e.key === "Escape") { e.preventDefault(); onCancel?.(); }
          }}
          placeholder="Password"
          spellCheck={false}
          autoComplete="off"
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--phn-page-bg, #08090a)",
            border: "1px solid var(--phn-surface-border, #2b2b2b)",
            color: "var(--phn-text-active, #f7f8f8)",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 13,
            outline: "none",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              background: "transparent",
              border: "1px solid var(--phn-surface-border, #2b2b2b)",
              color: "var(--phn-text-fg, #b4b8c0)",
              borderRadius: 6,
              padding: "6px 14px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!password}
            style={{
              background: "var(--phn-accent-subtle, rgba(94,106,210,0.15))",
              border: "1px solid var(--phn-link, #5e6ad2)",
              color: "var(--phn-link, #828fff)",
              borderRadius: 6,
              padding: "6px 14px",
              fontSize: 12,
              cursor: password ? "pointer" : "not-allowed",
              opacity: password ? 1 : 0.5,
            }}
          >
            Connect
          </button>
        </div>
      </div>
    </Modal>
  );
}
