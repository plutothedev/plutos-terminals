// Branded toast notification system. Replaces window.alert across the app.
// Three variants: success (green), error (Pluto-magenta), info (accent blue).
// Auto-dismiss after 4 seconds; click to dismiss early.
//
// Usage: import { useToast } from "./Toast.jsx" inside any component within
// <ToastProvider>. Then `const toast = useToast(); toast.success("done");`.
// ToastProvider mounts once at the App root.

import { createContext, useCallback, useContext, useEffect, useState } from "react";

const ToastContext = createContext(null);

const COLORS = {
  success: { bg: "rgba(52, 211, 153, 0.16)", border: "#34D399", fg: "#34D399" },
  error:   { bg: "rgba(255, 0, 128, 0.18)",   border: "#FF0080", fg: "#FF0080" },
  info:    { bg: "rgba(77, 170, 252, 0.16)",  border: "#4DAAFC", fg: "#4DAAFC" },
};

const M = "'JetBrains Mono', Menlo, Monaco, monospace";

let nextId = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((variant, message, opts = {}) => {
    const id = nextId++;
    const ttl = typeof opts.ttl === "number" ? opts.ttl : 4000;
    setToasts((ts) => [...ts, { id, variant, message }]);
    if (ttl > 0) {
      setTimeout(() => dismiss(id), ttl);
    }
    return id;
  }, [dismiss]);

  const api = {
    success: useCallback((m, o) => push("success", m, o), [push]),
    error:   useCallback((m, o) => push("error",   m, o), [push]),
    info:    useCallback((m, o) => push("info",    m, o), [push]),
    dismiss,
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
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
            onClick={() => dismiss(t.id)}
            style={{
              pointerEvents: "auto",
              background: "#181818",
              border: `1px solid ${COLORS[t.variant].border}`,
              borderLeft: `4px solid ${COLORS[t.variant].border}`,
              borderRadius: 4,
              padding: "10px 14px",
              fontFamily: M,
              fontSize: 11,
              color: "#E6E6E6",
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
            {t.message}
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
      error:   (m) => { console.error("[toast:error]", m); window.alert(m); },
      info:    (m) => { console.log("[toast:info]", m); },
      dismiss: () => {},
    };
  }
  return ctx;
}
