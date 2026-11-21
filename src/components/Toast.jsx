// Branded toast notification system. Replaces window.alert across the app.
// Three variants: success (green), error (danger red), info (accent).
// Auto-dismiss after 4 seconds (errors: 8 — long enough to actually read a
// failure), paused while the toast has keyboard focus; click to dismiss early. Clicking an error toast also copies its
// full raw detail to the clipboard for pasting into a bug report.
//
// toast.error accepts either a string or a humanizeError() result
// ({ message, detail } — see features/terminals/errorText.js): the message is
// what renders; the detail is what click-to-copy puts on the clipboard.
//
// Usage: import { useToast } from "./Toast.jsx" inside any component within
// <ToastProvider>. Then `const toast = useToast(); toast.success("done");`.
// ToastProvider mounts once at the App root.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

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
  // Auto-dismiss timers by toast id: { handle, deadline, remaining }. handle is
  // null while paused. A toast is a Tab stop, and one that vanished while
  // focused would drop focus to <body>, so its timer pauses while it has focus
  // and resumes with the time it had left on blur.
  const timersRef = useRef(new Map());
  // Focus hand-back. A toast that is dismissed while it has focus (Enter,
  // Space, a click, or api.dismiss) would otherwise drop focus to <body>.
  // returnFocusRef is the element that had focus when focus entered the toast
  // stack from outside (moving between toasts keeps it); focusedIdRef is the
  // toast holding focus now.
  const stackRef = useRef(null);
  const returnFocusRef = useRef(null);
  const focusedIdRef = useRef(null);

  const dismiss = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer.handle);
      timersRef.current.delete(id);
    }
    if (focusedIdRef.current === id) {
      // Move focus before the toast leaves the DOM. The timer is already gone,
      // so the blur this causes cannot re-arm it.
      focusedIdRef.current = null;
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      if (back && back.isConnected && typeof back.focus === "function") back.focus();
    }
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const arm = useCallback((id, ms) => {
    timersRef.current.set(id, {
      handle: setTimeout(() => dismiss(id), ms),
      deadline: Date.now() + ms,
      remaining: ms,
    });
  }, [dismiss]);

  const pause = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (!timer || timer.handle == null) return;
    clearTimeout(timer.handle);
    timer.handle = null;
    timer.remaining = Math.max(0, timer.deadline - Date.now());
  }, []);

  const resume = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (!timer || timer.handle != null) return;
    arm(id, timer.remaining);
  }, [arm]);

  // Unmount: no timer outlives the provider. The cleanup suspends running
  // timers (keeping the time each had left) instead of forgetting them, and
  // setup re-arms the suspended ones: StrictMode's dev cycle runs this cleanup
  // and setup again right after the first mount, and a toast pushed from a
  // child's mount effect is already armed by then. Clearing the map there left
  // that toast on screen for good. On a real unmount nothing re-arms.
  useEffect(() => {
    const timers = timersRef.current;
    for (const [id, timer] of timers) {
      if (timer.suspended) arm(id, timer.remaining);
    }
    return () => {
      for (const timer of timers.values()) {
        if (timer.handle == null) continue; // paused by focus: stays paused
        clearTimeout(timer.handle);
        timer.handle = null;
        timer.remaining = Math.max(0, timer.deadline - Date.now());
        timer.suspended = true;
      }
    };
  }, [arm]);

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
    if (ttl > 0) arm(id, ttl);
    return id;
  }, [arm]);

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
        ref={stackRef}
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
        {toasts.map((t) => {
          const activate = () => {
            if (t.variant === "error") {
              // Coerced too: writeText() converts its argument to a string, and
              // that conversion THROWS synchronously on an exotic object, which
              // ?.catch can't see.
              navigator.clipboard?.writeText(toastText(t.detail || t.message))?.catch(() => {});
            }
            dismiss(t.id);
          };
          // A div with role="button", not a <button>: as a flex item in this
          // shrink-to-fit column a <button> sizes itself narrower than the div
          // (measured in Edge: 336px wide against 393px), so the swap would
          // move every toast. Keyboard users get the same action on Enter/Space.
          return (
            <div
              key={t.id}
              className="phn-toast"
              role="button"
              tabIndex={0}
              title={t.variant === "error" ? "Click to copy" : undefined}
              onClick={activate}
              onFocus={(e) => {
                // Record where focus came from only when it enters the stack
                // from outside; Tab between toasts keeps the first origin.
                const from = e.relatedTarget;
                if (!(from && stackRef.current?.contains(from))) returnFocusRef.current = from || null;
                focusedIdRef.current = t.id;
                pause(t.id);
              }}
              onBlur={() => {
                if (focusedIdRef.current === t.id) focusedIdRef.current = null;
                resume(t.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate();
                }
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
          );
        })}
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
