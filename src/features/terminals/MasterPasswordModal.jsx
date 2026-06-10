// (C)
// Set / change / remove the master password (app lock). Stores only the SHA-256
// hash in user-state; LockScreen verifies against it on launch.
import { useState } from "react";
import Modal from "../../components/Modal.jsx";
import { useToast } from "../../components/Toast.jsx";
import { hashPassword, verifyPassword } from "./masterPassword.js";

export default function MasterPasswordModal({ open, userSt, saveUser, onClose }) {
  const toast = useToast();
  const isSet = typeof userSt?.masterPasswordHash === "string" && userSt.masterPasswordHash.length > 0;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const reset = () => { setCurrent(""); setNext(""); setConfirm(""); };

  const verifyCurrent = async () => !isSet || (await verifyPassword(current, userSt.masterPasswordHash));

  const apply = async () => {
    if (!(await verifyCurrent())) { toast.error("Current password is incorrect."); return; }
    if (next.length < 8) { toast.error("Use at least 8 characters."); return; }
    if (next !== confirm) { toast.error("New passwords don't match."); return; }
    const hash = await hashPassword(next);
    saveUser({ ...userSt, masterPasswordHash: hash });
    toast.success(isSet ? "Master password changed." : "Master password set — asked on next launch.");
    reset(); onClose();
  };

  const remove = async () => {
    if (!(await verifyCurrent())) { toast.error("Current password is incorrect."); return; }
    const { masterPasswordHash, ...rest } = userSt;
    saveUser(rest);
    toast.success("Master password removed.");
    reset(); onClose();
  };

  return (
    <Modal open={open} title={isSet ? "Master password" : "Set master password"} onClose={() => { reset(); onClose(); }} width={420}>
      <p style={{ fontSize: 12, color: "var(--phn-text-dim, #888)", lineHeight: 1.5, marginTop: 0 }}>
        Locks the app behind a password on launch. Only its hash is stored; SSH and
        API secrets stay in the OS keychain regardless.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {isSet && (
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" style={input} />
        )}
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder={isSet ? "New password" : "Password"} style={input} />
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm password" style={input} onKeyDown={(e) => { if (e.key === "Enter") apply(); }} />
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button onClick={apply} style={primaryBtn}>{isSet ? "Change password" : "Set password"}</button>
          {isSet && <button onClick={remove} style={dangerBtn}>Remove lock</button>}
        </div>
      </div>
    </Modal>
  );
}

const input = {
  background: "var(--phn-page-bg, #1c1c1c)", border: "1px solid var(--phn-surface-border, #2a2a2a)",
  borderRadius: 4, color: "var(--phn-text-fg, #d4d4d4)", padding: "7px 9px", fontSize: 13,
  outline: "none", fontFamily: "var(--phn-ui-font)",
};
const primaryBtn = {
  background: "var(--phn-link, #7c9cf5)", border: "none", color: "#06223a", borderRadius: 5,
  padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--phn-ui-font)",
};
const dangerBtn = {
  background: "transparent", border: "1px solid #ff6b6b", color: "#ff6b6b", borderRadius: 5,
  padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--phn-ui-font)",
};
