// Branded toast notification system. Replaces window.alert across the app.
// Three variants: success (green), error (danger red), info (accent).
// Auto-dismiss after 4 seconds (errors: 8 — long enough to actually read a
// failure); click to dismiss early. Clicking an error toast also copies its
// full raw detail to the clipboard for pasting into a bug report.
//
// toast.error accepts either a string or a humanizeError() result
// ({ message, detail } — see features/terminals/errorText.js): the message is
// what renders; the detail is what click-to-copy puts on the clipboard.
//
// Usage: import { useToast } from "./Toast.jsx" inside any component within
// <ToastProvider>. Then `const toast = useToast(); toast.success("done");`.
// ToastProvider mounts once at the App root.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const ToastContext = createContext(null);

const COLORS = {
  success: { bg: "rgba(127, 191, 138, 0.14)", border: "#7fbf8a", fg: "#7fbf8a" },
  error:   { bg: "rgba(224, 135, 132, 0.14)", border: "var(--phn-danger, #e08784)", fg: "var(--phn-danger, #e08784)" },
  info:    { bg: "rgba(124, 156, 245, 0.14)", border: "#7c9cf5", fg: "#7c9cf5" },
};

const M = "'JetBrains Mono', Menlo, Monaco, monospace";

// Coerce a toast message to renderable text. toast.error() is called from dozens
// of catch blocks and not every call site hands us a string: a rejected invoke()
// can surface a plain object, and a thrown value can be an Error whose .message
// isn't a string. Rendering one of those as a React child throws "Objects are not
// valid as a React child" from INSIDE ToastProvider, so the throw takes the whole
// window blank with no Reload button and orphaned PTYs. Same coercion
// ConfirmModal.jsx:48 does for request.message, extended to prefer an Error's
// .message (and a JSON dump for plain objects) over a useless "[object Object]".
function toastText(v) {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (v instanceof Error) return v.message || v.name || "Error";
  if (typeof v === "object") {
    if (typeof v.message === "string") return v.message;
    try {
      const j = JSON.stringify(v);
      if (j && j !== "{}") return j;
    } catch { /* circular or non-serializable: fall through to String() */ }
  }
  // String() itself throws on a null-prototype object or a throwing toString.
  try { return String(v); } catch { return "Unknown error"; }
}

let nextId = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((variant, message, opts = {}) => {
    const id = nextId++;
    // Unwrap a humanizeError() result so call sites stay one expression and
    // the raw detail still rides along for click-to-copy.
    let detail = opts.detail;
    if (message && typeof message === "object" && typeof message.message === "string") {
      detail = detail ?? message.detail;
      message = message.message;
    }
    const ttl = typeof opts.ttl === "number" ? opts.ttl : variant === "error" ? 8000 : 4000;
    setToasts((ts) => [...ts, { id, variant, message, detail }]);
    if (ttl > 0) {
      setTimeout(() => dismiss(id), ttl);
    }
    return id;
  }, [dismiss]);

  // Memoized (P2 stream audit W1): a plain object literal here handed every
  // useToast() consumer a FRESH identity on every provider re-render — i.e.
  // on every toast fire AND its ~4s auto-dismiss — which cascaded through
  // useSessionDispatch's deps into homeApi and busted every panel memo.
  const api = useMemo(() => ({
    success: (m, o) => push("success", m, o),
    error: (m, o) => push("error", m, o),
    info: (m, o) => push("info", m, o),
    dismiss,
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          top: 18,
          right: 18,
          zIndex: 10000,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="phn-toast"
            title={t.variant === "error" ? "Click to copy" : undefined}
            onClick={() => {
              if (t.variant === "error") {
                // Coerced too: writeText() converts its argument to a string, and
                // that conversion THROWS synchronously on an exotic object, which
                // ?.catch can't see.
                navigator.clipboard?.writeText(toastText(t.detail || t.message))?.catch(() => {});
              }
              dismiss(t.id);
            }}
            style={{
              pointerEvents: "auto",
              background: "var(--phn-surface-bg, #181818)",
              border: `1px solid ${COLORS[t.variant].border}`,
              borderLeft: `4px solid ${COLORS[t.variant].border}`,
              borderRadius: 4,
              padding: "10px 14px",
              fontFamily: M,
              fontSize: 11,
              color: "var(--phn-text-active, #E6E6E6)",
              maxWidth: 360,
              boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
              cursor: "pointer",
              lineHeight: 1.5,
              animation: "plutos-toast-in 180ms ease-out",
            }}
          >
            <span style={{ color: COLORS[t.variant].fg, fontWeight: 600, marginRight: 8 }}>
              {t.variant === "success" ? "✓" : t.variant === "error" ? "✗" : "ℹ"}
            </span>
            {toastText(t.message)}
          </div>
        ))}
      </div>
      <style>{`
        @keyframes plutos-toast-in {
          from { transform: translateX(20px); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fail-soft: outside ToastProvider, fall back to console + window.alert
    return {
      success: (m) => { console.log("[toast:success]", m); },
      error:   (m) => { console.error("[toast:error]", m); window.alert(toastText(m)); },
      info:    (m) => { console.log("[toast:info]", m); },
      dismiss: () => {},
    };
  }
  return ctx;
}
