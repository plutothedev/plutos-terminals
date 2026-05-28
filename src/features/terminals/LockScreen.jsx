// (C)
// Master-password unlock screen. Shown by App before the terminal grid when a
// master password is set and this launch hasn't been unlocked yet.
import { useState } from "react";
import { hashPassword, markUnlocked } from "./masterPassword.js";

export default function LockScreen({ expectedHash, onUnlock }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState(false);

  const tryUnlock = async () => {
    const h = await hashPassword(pw);
    if (h === expectedHash) { markUnlocked(); onUnlock(); }
    else { setError(true); setPw(""); }
  };

  return (
    <div style={{ height: "100vh", background: "#0b0c0e", color: "#d4d4d4", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--phn-ui-font, system-ui)" }}>
      <div style={{ width: 320, textAlign: "center" }}>
        <div style={{ fontSize: 30, marginBottom: 10 }}>🔒</div>
        <div style={{ fontSize: 17, letterSpacing: 1, marginBottom: 4 }}>Pluto's Terminal</div>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 20 }}>Enter your master password</div>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => { setPw(e.target.value); setError(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") tryUnlock(); }}
          style={{
            width: "100%", boxSizing: "border-box", textAlign: "center",
            background: "#16181c", border: `1px solid ${error ? "#ff6b6b" : "#2a2a2a"}`,
            color: "#f7f8f8", borderRadius: 6, padding: "10px 12px", fontSize: 14, outline: "none",
          }}
        />
        {error && <div style={{ color: "#ff6b6b", fontSize: 11, marginTop: 8 }}>Incorrect password.</div>}
        <button
          onClick={tryUnlock}
          style={{ marginTop: 14, width: "100%", background: "#4aa8c0", border: "none", color: "#06223a", borderRadius: 6, padding: "9px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          Unlock
        </button>
      </div>
    </div>
  );
}
