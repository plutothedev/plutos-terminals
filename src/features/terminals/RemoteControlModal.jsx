// (C)
// Desktop "Remote control" panel — start/stop the phone/web companion server and
// show the QR + link + token to pair a phone over the tailnet. See companion.rs
// + docs/phone-companion-design.md.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@backend";
import QRCode from "qrcode";
import { SPhone } from "./toolbarIcons.jsx";

const overlay = {
  position: "fixed", inset: 0, zIndex: 1000, display: "flex",
  alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", padding: 16,
};
const card = {
  width: "min(440px, 96%)", maxHeight: "92%", overflowY: "auto", boxSizing: "border-box",
  background: "var(--phn-surface-bg, #1a1d21)", border: "1px solid var(--phn-surface-border, #2b2b2b)",
  borderRadius: 12, padding: 18, color: "var(--phn-text-fg, #cfd6dd)",
  fontFamily: "var(--phn-ui-font, -apple-system, sans-serif)", boxShadow: "0 16px 50px rgba(0,0,0,0.6)",
};
const p = { fontSize: 13, lineHeight: 1.5, color: "var(--phn-text-fg, #cfd6dd)", margin: "0 0 12px" };
const xBtn = { background: "transparent", border: "none", color: "var(--phn-text-faint, #6b7480)", cursor: "pointer", fontSize: 15 };
const primaryBtn = { width: "100%", padding: "11px", borderRadius: 8, border: "none", background: "#3FC7C7", color: "#06231a", fontWeight: 700, fontSize: 14, cursor: "pointer" };
const dangerBtn = { width: "100%", padding: "11px", borderRadius: 8, border: "1px solid #E05B5B", background: "transparent", color: "#E05B5B", fontWeight: 600, fontSize: 14, cursor: "pointer", marginTop: 4 };
const warn = { fontSize: 11.5, lineHeight: 1.5, color: "#E0A04F", background: "rgba(224,160,79,0.08)", border: "1px solid rgba(224,160,79,0.25)", borderRadius: 6, padding: "8px 10px", margin: "0 0 12px" };

function Field({ label, value, mono, onCopy }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10.5, color: "var(--phn-text-faint, #6b7480)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          background: "#0e1114", border: "1px solid var(--phn-surface-border, #2b2b2b)", borderRadius: 6, padding: "7px 9px",
          fontSize: 12, fontFamily: mono ? "monospace" : "inherit" }}>{value}</div>
        <button onClick={onCopy} style={{ flexShrink: 0, background: "#23272d", border: "1px solid var(--phn-surface-border, #2b2b2b)", color: "var(--phn-text-fg, #cfd6dd)", borderRadius: 6, padding: "0 12px", cursor: "pointer", fontSize: 12 }}>Copy</button>
      </div>
    </div>
  );
}

export default function RemoteControlModal({ open, onClose }) {
  const [info, setInfo] = useState(null); // { running, url, token, port, host }
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = useCallback(async () => {
    try { setInfo(await invoke("companion_status")); } catch (e) { setErr(String(e)); }
  }, []);

  useEffect(() => { if (open) { setErr(""); refresh(); } }, [open, refresh]);

  useEffect(() => {
    if (info?.running && info.url) {
      QRCode.toDataURL(info.url, { margin: 1, width: 220, color: { dark: "#0b0d0f", light: "#ffffff" } })
        .then(setQr).catch(() => setQr(""));
    } else setQr("");
  }, [info]);

  const start = async () => {
    setBusy(true); setErr("");
    try { setInfo(await invoke("companion_start", {})); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true); setErr("");
    try { await invoke("companion_stop"); setInfo({ running: false }); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };
  const copy = (t) => { try { navigator.clipboard.writeText(t); } catch { /* ignore */ } };

  if (!open) return null;
  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, display: "flex", alignItems: "center", gap: 8 }}><SPhone size={15} /> Remote control</h2>
          <button onClick={onClose} style={xBtn} title="Close">✕</button>
        </div>

        {!info?.running ? (
          <>
            <p style={p}>Run a private server on this machine so your phone (or any browser) can view and type into your terminal sessions over your <b>Tailscale</b> tailnet — no relay, nothing exposed publicly.</p>
            <button onClick={start} disabled={busy} style={primaryBtn}>{busy ? "Starting…" : "Start server"}</button>
          </>
        ) : (
          <>
            <p style={p}>On your phone (same tailnet), scan the QR or open the link:</p>
            {qr && <div style={{ textAlign: "center", marginBottom: 12 }}><img src={qr} alt="pairing QR" width={200} height={200} style={{ borderRadius: 8 }} /></div>}
            <Field label="Link" value={info.url} onCopy={() => copy(info.url)} />
            <Field label="Access token" value={info.token} mono onCopy={() => copy(info.token)} />
            <div style={{ fontSize: 11, color: "var(--phn-text-faint, #6b7480)", margin: "6px 0 12px" }}>Serving on {info.host}:{info.port} · reachable over your tailnet.</div>
            <div style={warn}>⚠ Anyone with this link can run commands in your terminals. Stop the server when you're done — restarting issues a fresh token.</div>
            <button onClick={stop} disabled={busy} style={dangerBtn}>{busy ? "Stopping…" : "Stop server"}</button>
          </>
        )}
        {err && <div style={{ color: "#E05B5B", fontSize: 12, marginTop: 10 }}>{err}</div>}
      </div>
    </div>
  );
}
