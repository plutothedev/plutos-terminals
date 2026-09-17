// (C)
// Desktop "Remote control" panel — start/stop the phone/web companion server and
// show the QR + link + token to pair a phone over the tailnet. See companion.rs
// + docs/phone-companion-design.md.

import { useCallback, useEffect, useId, useState } from "react";
import { invoke } from "@backend";
import QRCode from "qrcode";
import { SPhone } from "./toolbarIcons.jsx";
import { humanizeError } from "./errorText.js";

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
// Missed sibling of the warning below: same literal-on-a-light-card shape, and
// #E05B5B is 3.06:1 on moba-light, under the 4.5:1 text floor AND under the 3:1
// floor its border owes. --phn-notice-error-fg is pinned to #E05B5B in all
// twelve dark blocks, so "Stop server" is byte-identical there.
const ERROR_FG = "var(--phn-notice-error-fg, #E05B5B)";
const dangerBtn = { width: "100%", padding: "11px", borderRadius: 8, border: `1px solid ${ERROR_FG}`, background: "transparent", color: ERROR_FG, fontWeight: 600, fontSize: 14, cursor: "pointer", marginTop: 4 };
// This is the per-skin warning-TEXT token the previous pass wrote the spec for
// and could not use, because no such name existed yet. It exists now, pinned to
// #E0A04F in all twelve dark blocks (so they are byte-identical) and to a dark
// amber in the two light ones. The alternative it rejected still holds:
// --phn-warning is a status TINT, #D29922 in both light skins (2.03:1, still
// failing) and pointing at it would have repainted moba and OLED to #d2b36b.
// The 8% fill and 25% border keep their literal amber alphas on purpose: they
// are decorative, they composite to #ebe6df on moba-light and #f3eeea on
// daylight, and the text token is validated against exactly those.
const warn = { fontSize: 11.5, lineHeight: 1.5, color: "var(--phn-notice-warn-fg, #E0A04F)", background: "rgba(224,160,79,0.08)", border: "1px solid rgba(224,160,79,0.25)", borderRadius: 6, padding: "8px 10px", margin: "0 0 12px" };

// The whole point of this screen is that the URL and the pairing token get READ
// off it, so both fills have to invert with the skin. They were hardcoded dark
// hex while the card around them is var(--phn-surface-bg) = #ececec on Light,
// which left two near-black boxes of near-black text (1.32:1) in a light dialog.
//
// Both now use a PINNED token rather than a repurposed one, and the difference
// is the whole lesson of this pass:
//
//   Value box, --phn-well-bg, pinned to #0e1114 in all twelve dark blocks. The
//   attempt before this used --phn-page-bg, which is a different colour from
//   #0e1114 in eleven of the twelve dark skins: it flattened the well into the
//   card on the five where page-bg equals surface-bg, and on OLED it drove the
//   box to #000000, giving up the 1.11:1 lift the literal had. A pinned token
//   keeps every dark skin exactly as it was and still turns white on the light
//   two.
//
//   Copy button, --phn-raised-bg, pinned to #23272d. --phn-chip-bg was the right
//   SHAPE (a small raised control on a panel) but the wrong VALUE: it is #2C3037
//   in the dark blocks, nine RGB points off what this button rendered, so it
//   restyled twelve skins to fix two. --phn-elevated-bg, the previous suggestion,
//   is worse still: :root aliases it to --phn-surface-bg, so in twelve of the
//   fourteen it IS the card fill and the button flattens to 1.00:1 against it,
//   while neon and sunset would paint the card's GRADIENT into a 24px chip.
//
// A11Y-10 note. This modal has no <label> elements to repair: the caption is a
// <div> and the value is a read-only <div>, not a form control, so htmlFor has
// nothing to point at. The real defect of the same shape is that BOTH Copy
// buttons render the accessible name "Copy" and nothing else, so a screen
// reader announces "Copy button, Copy button" for the link and the bearer
// token. The caption is wired to the value box with aria-labelledby, and the
// button borrows the same caption for its own name.
//
// role="group" on the well is LOAD-BEARING, not decoration. A bare <div> maps
// to role=generic, and generic is one of the roles for which the accname spec
// marks name-from-author PROHIBITED: the platform skips step 2B, throws the
// computed name away, and axe-core reports it as aria-prohibited-attr. So
// aria-labelledby on a role-less div is a no-op that reads as a fix. `group`
// is the honest naming-capable role here: it does not claim the box is
// focusable or editable, which role="textbox" would.
function Field({ label, value, mono, onCopy }) {
  const uid = useId();
  return (
    <div style={{ marginBottom: 8 }}>
      <div id={`${uid}-cap`} style={{ fontSize: 10.5, color: "var(--phn-text-faint, #6b7480)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <div role="group" aria-labelledby={`${uid}-cap`} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          background: "var(--phn-well-bg, #0e1114)", border: "1px solid var(--phn-surface-border, #2b2b2b)", borderRadius: 6, padding: "7px 9px",
          fontSize: 12, fontFamily: mono ? "monospace" : "inherit" }}>{value}</div>
        <button onClick={onCopy} aria-label={`Copy ${label}`} title={`Copy ${label}`} style={{ flexShrink: 0, background: "var(--phn-raised-bg, #23272d)", border: "1px solid var(--phn-surface-border, #2b2b2b)", color: "var(--phn-text-fg, #cfd6dd)", borderRadius: 6, padding: "0 12px", cursor: "pointer", fontSize: 12 }}>Copy</button>
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
    try { setInfo(await invoke("companion_status")); } catch (e) { setErr(humanizeError(e).message); }
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
    catch (e) { setErr(humanizeError(e).message); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true); setErr("");
    try { await invoke("companion_stop"); setInfo({ running: false }); }
    catch (e) { setErr(humanizeError(e).message); }
    finally { setBusy(false); }
  };
  const copy = (t) => { try { navigator.clipboard.writeText(t); } catch { /* ignore */ } };

  if (!open) return null;
  return (
    <div onClick={onClose} style={overlay}>
      {/* This modal predates Modal.jsx and never picked up its dialog
          semantics. role + accessible name are free; aria-modal is NOT set on
          purpose, because it promises assistive tech that focus is trapped here
          and this component has no trap (residual: move it onto Modal.jsx). */}
      <div onClick={(e) => e.stopPropagation()} style={card} role="dialog" aria-labelledby="phn-remote-control-title">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 id="phn-remote-control-title" style={{ margin: 0, fontSize: 16, display: "flex", alignItems: "center", gap: 8 }}><SPhone size={15} /> Remote control</h2>
          {/* Accessible name would otherwise be the glyph "✕": for a <button>,
              content wins over title. */}
          <button onClick={onClose} style={xBtn} title="Close" aria-label="Close">✕</button>
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
        {err && <div style={{ color: ERROR_FG, fontSize: 12, marginTop: 10 }}>{err}</div>}
      </div>
    </div>
  );
}
