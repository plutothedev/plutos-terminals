// (C)
// RDP remote-desktop view. Same canvas/framebuffer pipeline as VncView, but RDP
// input differs: per-button press/release (not a mask) and PC set-1 *scancodes*
// (not X11 keysyms). Connects on mount via rdp_connect; credentials come from
// tab.rdp.username + a transient password in ptyBridge.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@backend";
import { listen } from "@backend";
import { getTabPassword } from "./ptyBridge.js";

// JS KeyboardEvent.code → PS/2 set-1 scancode (the common, non-extended keys).
const SCAN = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d,
  Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14,
  KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b,
  Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22,
  KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30,
  KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, AltLeft: 0x38,
  Space: 0x39, CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40,
  F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, F11: 0x57, F12: 0x58,
};

function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export default function RdpView({ host, port, username, domain, tabId, visible }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const idRef = useRef(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const [status, setStatus] = useState("Connecting…");
  // Bumping retryKey re-runs the connect effect (Retry button, FR-009).
  const [retryKey, setRetryKey] = useState(0);
  const isError = status && status !== "Connecting…";
  const retry = () => { idRef.current = null; setStatus("Connecting…"); setRetryKey((k) => k + 1); };

  useEffect(() => {
    let alive = true;
    const unlisten = [];
    (async () => {
      try {
        const password = getTabPassword(tabId) || "";
        const [id, w, h] = await invoke("rdp_connect", {
          host, port: port || 3389, username, password, domain: domain || null,
        });
        if (!alive) { invoke("rdp_disconnect", { id }).catch(() => {}); return; }
        idRef.current = id;
        sizeRef.current = { w, h };
        const canvas = canvasRef.current;
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        setStatus(null);
        // Each listen() is awaited — if the view unmounts mid-await, cleanup
        // has already run with a partially-filled unlisten[], so detach the
        // late-resolved handle immediately or it leaks. Frame handler also
        // bails on !alive so it stops decoding into a disposed canvas.
        const unFrame = await listen(`rdp-frame://${id}`, (e) => {
          if (!alive) return;
          const { x, y, w: rw, h: rh, data } = e.payload;
          try {
            ctx.putImageData(new ImageData(new Uint8ClampedArray(b64ToBytes(data)), rw, rh), x, y);
          } catch { /* skip malformed rect */ }
        });
        if (!alive) { unFrame(); return; }
        unlisten.push(unFrame);
        const unExit = await listen(`rdp-exit://${id}`, () => { if (alive) setStatus("Disconnected."); });
        if (!alive) { unExit(); return; }
        unlisten.push(unExit);
      } catch (err) {
        if (alive) setStatus(`Connection failed: ${err}`);
      }
    })();
    return () => {
      alive = false;
      unlisten.forEach((u) => u());
      if (idRef.current) invoke("rdp_disconnect", { id: idRef.current }).catch(() => {});
    };
  }, [host, port, username, domain, tabId, retryKey]);

  useEffect(() => { if (visible) wrapRef.current?.focus(); }, [visible]);

  const toFb = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    const { w, h } = sizeRef.current;
    return {
      x: Math.max(0, Math.min(w - 1, Math.round((e.clientX - r.left) * (w / r.width)))),
      y: Math.max(0, Math.min(h - 1, Math.round((e.clientY - r.top) * (h / r.height)))),
    };
  };
  const ptr = (e, button, down) => {
    if (!idRef.current) return;
    const { x, y } = toFb(e);
    invoke("rdp_pointer", { id: idRef.current, x, y, button, down }).catch(() => {});
  };
  const onKey = (down) => (e) => {
    const sc = SCAN[e.code];
    if (sc == null || !idRef.current) return;
    e.preventDefault();
    invoke("rdp_key", { id: idRef.current, scancode: sc, down }).catch(() => {});
  };

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      style={{ width: "100%", height: "100%", overflow: "auto", background: "#000", position: "relative", outline: "none" }}
      onMouseMove={(e) => ptr(e, null, false)}
      onMouseDown={(e) => ptr(e, e.button, true)}
      onMouseUp={(e) => ptr(e, e.button, false)}
      onKeyDown={onKey(true)}
      onKeyUp={onKey(false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {status && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", gap: 12, alignItems: "center", justifyContent: "center", color: "var(--phn-text-dim, #9aa0a6)", fontSize: 13, fontFamily: "var(--phn-ui-font)" }}>
          <div>{status}</div>
          {isError && (
            <button
              onClick={retry}
              style={{ background: "var(--phn-accent-subtle, rgba(94,106,210,0.15))", border: "1px solid var(--phn-link, #5e6ad2)", color: "var(--phn-link, #828fff)", borderRadius: 6, padding: "6px 18px", fontSize: 12, cursor: "pointer" }}
            >
              Retry
            </button>
          )}
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: "block", imageRendering: "pixelated" }} />
    </div>
  );
}
