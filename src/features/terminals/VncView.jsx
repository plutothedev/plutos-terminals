// (C)
// VNC remote-desktop view. Connects on mount (vnc_connect), draws framebuffer
// dirty-rects streamed from the backend onto a <canvas>, and forwards mouse +
// keyboard input. Password comes transiently from the ptyBridge (keyed by tabId,
// never persisted). One VncView per VNC tab.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getTabPassword } from "./ptyBridge.js";

// JS KeyboardEvent.key → X11 keysym for the common non-printable keys. Printable
// single chars fall through to their char code (Latin-1 keysyms == code points).
const KEYSYMS = {
  Enter: 0xff0d, Backspace: 0xff08, Tab: 0xff09, Escape: 0xff1b,
  ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
  Insert: 0xff63, Delete: 0xffff,
  Control: 0xffe3, Shift: 0xffe1, Alt: 0xffe9, Meta: 0xffe7, CapsLock: 0xffe5,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3,
  F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
};
function keysymFor(e) {
  if (KEYSYMS[e.key] != null) return KEYSYMS[e.key];
  if (e.key.length === 1) return e.key.charCodeAt(0);
  return null;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export default function VncView({ host, port, tabId, visible }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const idRef = useRef(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const buttonsRef = useRef(0);
  const [status, setStatus] = useState("Connecting…");
  // Bumping retryKey re-runs the connect effect (Retry button, FR-009).
  const [retryKey, setRetryKey] = useState(0);
  const isError = status && status !== "Connecting…";
  const retry = () => { idRef.current = null; setStatus("Connecting…"); setRetryKey((k) => k + 1); };

  useEffect(() => {
    let alive = true;
    let unlisten = [];
    (async () => {
      try {
        const password = getTabPassword(tabId);
        const [id, w, h] = await invoke("vnc_connect", { host, port: port || 5900, password: password || null });
        if (!alive) { invoke("vnc_disconnect", { id }).catch(() => {}); return; }
        idRef.current = id;
        sizeRef.current = { w, h };
        const canvas = canvasRef.current;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        setStatus(null);

        unlisten.push(await listen(`vnc-frame://${id}`, (e) => {
          const { x, y, w: rw, h: rh, data } = e.payload;
          try {
            const img = new ImageData(new Uint8ClampedArray(b64ToBytes(data)), rw, rh);
            ctx.putImageData(img, x, y);
          } catch { /* malformed rect — skip */ }
        }));
        unlisten.push(await listen(`vnc-resize://${id}`, (e) => {
          const { w: nw, h: nh } = e.payload;
          canvas.width = nw; canvas.height = nh;
          sizeRef.current = { w: nw, h: nh };
        }));
        unlisten.push(await listen(`vnc-exit://${id}`, () => {
          if (alive) setStatus("Disconnected.");
        }));
      } catch (err) {
        if (alive) setStatus(`Connection failed: ${err}`);
      }
    })();
    return () => {
      alive = false;
      unlisten.forEach((u) => u());
      if (idRef.current) invoke("vnc_disconnect", { id: idRef.current }).catch(() => {});
    };
  }, [host, port, tabId, retryKey]);

  // Focus the surface when this tab becomes visible so keyboard input flows.
  useEffect(() => { if (visible) wrapRef.current?.focus(); }, [visible]);

  // Display coords → framebuffer coords (canvas is scaled to fit via CSS).
  const toFb = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { w, h } = sizeRef.current;
    const x = Math.max(0, Math.min(w - 1, Math.round((e.clientX - rect.left) * (w / rect.width))));
    const y = Math.max(0, Math.min(h - 1, Math.round((e.clientY - rect.top) * (h / rect.height))));
    return { x, y };
  };
  const sendPointer = (e) => {
    if (!idRef.current) return;
    const { x, y } = toFb(e);
    invoke("vnc_pointer", { id: idRef.current, x, y, buttons: buttonsRef.current }).catch(() => {});
  };
  const onMouseDown = (e) => { buttonsRef.current |= 1 << e.button; sendPointer(e); };
  const onMouseUp = (e) => { buttonsRef.current &= ~(1 << e.button); sendPointer(e); };
  const onMouseMove = (e) => { sendPointer(e); };
  const onWheel = (e) => {
    if (!idRef.current) return;
    const { x, y } = toFb(e);
    const mask = e.deltaY < 0 ? 1 << 3 : 1 << 4; // VNC wheel = btn 4 (up) / 5 (down)
    invoke("vnc_pointer", { id: idRef.current, x, y, buttons: buttonsRef.current | mask })
      .then(() => invoke("vnc_pointer", { id: idRef.current, x, y, buttons: buttonsRef.current }))
      .catch(() => {});
  };
  const onKey = (down) => (e) => {
    const ks = keysymFor(e);
    if (ks == null || !idRef.current) return;
    e.preventDefault();
    invoke("vnc_key", { id: idRef.current, keysym: ks, down }).catch(() => {});
  };

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      style={{ width: "100%", height: "100%", overflow: "auto", background: "#000", position: "relative", outline: "none" }}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onMouseMove={onMouseMove}
      onWheel={onWheel}
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
