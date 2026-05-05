// Branded confirmation modal. Replaces window.confirm. Imperative API via
// useConfirm() hook so call sites read like:
//
//   const confirm = useConfirm();
//   if (await confirm("Replace panels?", { destructive: true })) { ... }

import { createContext, useCallback, useContext, useState } from "react";
import Modal, { MODAL_COLORS } from "./Modal.jsx";

const { FG, FG_ACTIVE, ACCENT, BORDER, M } = MODAL_COLORS;
const PLUTO_MAGENTA = "#FF0080";

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);
  // request: { message, title, confirmLabel, cancelLabel, destructive, resolve }

  const confirm = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      setRequest({
        message,
        title: opts.title || "Confirm",
        confirmLabel: opts.confirmLabel || "confirm",
        cancelLabel: opts.cancelLabel || "cancel",
        destructive: !!opts.destructive,
        resolve,
      });
    });
  }, []);

  const onConfirm = () => {
    if (request) request.resolve(true);
    setRequest(null);
  };
  const onCancel = () => {
    if (request) request.resolve(false);
    setRequest(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal open={!!request} title={request?.title || "Confirm"} onClose={onCancel} width={460}>
        <div style={{ color: FG, fontSize: 12, lineHeight: 1.7, marginBottom: 20, whiteSpace: "pre-wrap" }}>
          {request?.message}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              background: "transparent",
              border: `1px solid ${BORDER}`,
              color: FG,
              padding: "6px 16px",
              borderRadius: 3,
              fontFamily: M,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {request?.cancelLabel || "cancel"}
          </button>
          <button
            onClick={onConfirm}
            style={{
              background: request?.destructive ? PLUTO_MAGENTA : ACCENT,
              border: `1px solid ${request?.destructive ? PLUTO_MAGENTA : ACCENT}`,
              color: request?.destructive ? "#fff" : "#001",
              padding: "6px 16px",
              borderRadius: 3,
              fontFamily: M,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
            autoFocus
          >
            {request?.confirmLabel || "confirm"}
          </button>
        </div>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    // Fail-soft: outside provider, fall back to window.confirm
    return (message) => Promise.resolve(window.confirm(message));
  }
  return ctx;
}
