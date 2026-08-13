// Branded single-line text prompt. Replaces window.prompt (which ignores the
// skin, blocks the thread, and renders inconsistently in WebView2). Imperative
// API via usePrompt() so call sites read like:
//
//   const prompt = usePrompt();
//   const name = await prompt("New folder name?", { confirmLabel: "create" });
//   if (name && name.trim()) { ... }
//
// Resolves with the entered string, or null if cancelled (same contract as
// window.prompt, so existing `if (!name)` guards keep working).

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Modal, { MODAL_COLORS } from "./Modal.jsx";

const { FG, FG_ACTIVE, ACCENT, BORDER, M } = MODAL_COLORS;

const PromptContext = createContext(null);

export function PromptProvider({ children }) {
  const [request, setRequest] = useState(null);
  // request: { message, title, placeholder, confirmLabel, cancelLabel, resolve }
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  const prompt = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      setValue(typeof opts.initialValue === "string" ? opts.initialValue : "");
      setRequest({
        message,
        title: opts.title || "Enter a value",
        placeholder: opts.placeholder || "",
        confirmLabel: opts.confirmLabel || "OK",
        cancelLabel: opts.cancelLabel || "Cancel",
        resolve,
      });
    });
  }, []);

  // Focus + select the field when the prompt opens (parity with window.prompt).
  useEffect(() => {
    if (request && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [request]);

  // Resolve the pending prompt and close. Every dismissal path (ok/Enter/cancel/
  // Escape/backdrop) funnels through here so the promise settles exactly once;
  // a duplicate call is a harmless no-op (Promise resolves only the first time).
  const settle = (result) => {
    if (request) request.resolve(result);
    setRequest(null);
    setValue("");
  };

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      <Modal open={!!request} title={request?.title || "Enter a value"} onClose={() => settle(null)} width={440}>
        {request?.message && (
          <div style={{ color: FG, fontSize: 12, lineHeight: 1.6, marginBottom: 12, whiteSpace: "pre-wrap" }}>
            {String(request.message)}
          </div>
        )}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") settle(value); }}
          placeholder={request?.placeholder || ""}
          style={{
            width: "100%", boxSizing: "border-box",
            background: "var(--phn-page-bg, #0a0a0a)", border: `1px solid ${BORDER}`,
            borderRadius: 4, color: FG_ACTIVE, padding: "8px 10px", fontSize: 13,
            fontFamily: M, outline: "none",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            onClick={() => settle(null)}
            style={{
              background: "transparent", border: `1px solid ${BORDER}`, color: FG,
              padding: "6px 16px", borderRadius: 3, fontFamily: M, fontSize: 11, cursor: "pointer",
            }}
          >
            {request?.cancelLabel || "Cancel"}
          </button>
          <button
            onClick={() => settle(value)}
            style={{
              background: ACCENT, border: `1px solid ${ACCENT}`, color: "#001",
              padding: "6px 16px", borderRadius: 3, fontFamily: M, fontSize: 11, fontWeight: 600, cursor: "pointer",
            }}
          >
            {request?.confirmLabel || "OK"}
          </button>
        </div>
      </Modal>
    </PromptContext.Provider>
  );
}

export function usePrompt() {
  const ctx = useContext(PromptContext);
  if (!ctx) {
    // Fail-soft: outside the provider, fall back to the native prompt.
    return (message, opts = {}) =>
      Promise.resolve(window.prompt(message, typeof opts.initialValue === "string" ? opts.initialValue : ""));
  }
  return ctx;
}
