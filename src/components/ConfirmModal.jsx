// Branded confirmation modal. Replaces window.confirm. Imperative API via
// useConfirm() hook so call sites read like:
//
//   const confirm = useConfirm();
//   if (await confirm("Replace panels?", { destructive: true })) { ... }

import { createContext, useCallback, useContext, useRef, useState } from "react";
import Modal, { MODAL_COLORS } from "./Modal.jsx";

const { FG, ACCENT, BORDER, M } = MODAL_COLORS;
const PLUTO_MAGENTA = "#e08784";

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);
  // request: { id, message, title, confirmLabel, cancelLabel, destructive, resolve }
  const nextId = useRef(0);

  const confirm = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      setRequest({
        id: ++nextId.current,
        message,
        title: opts.title || "Confirm",
        confirmLabel: opts.confirmLabel || "Confirm",
        cancelLabel: opts.cancelLabel || "Cancel",
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
      {/* Keyed by request: a caller that awaits one confirm and asks the next
          straight away (the recovered-recording loop) gets both setRequest
          calls rendered in one commit, because a real click's microtasks run
          under the click's priority. Without the key `open` stays true, the
          Modal's focus effect never re-runs and focus stays on the button just
          pressed, so the new request's data-autofocus is ignored. With it the
          old Modal unmounts (its cleanup hands focus back to the original
          opener) and the new one records that opener and focuses its own
          default, so the end of the chain still returns to the trigger. */}
      <Modal key={request ? request.id : "closed"} open={!!request} title={request?.title || "Confirm"} onClose={onCancel} width={460}>
        <div style={{ color: FG, fontSize: 12, lineHeight: 1.7, marginBottom: 20, whiteSpace: "pre-wrap" }}>
          {/* Coerce to string so a non-string message degrades to text instead of
              throwing "Objects are not valid as a React child" and crashing the UI. */}
          {typeof request?.message === "string" ? request.message : request?.message == null ? "" : String(request.message)}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            // A destructive confirm ("Reset workspace") opens on Cancel, so an
            // Enter pressed right after it appears cannot destroy anything.
            data-autofocus={request?.destructive ? true : undefined}
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
            {request?.cancelLabel || "Cancel"}
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
            // Default focus: Confirm, unless the action is destructive (see
            // Cancel). The shared Modal focuses the data-autofocus element.
            data-autofocus={request?.destructive ? undefined : true}
          >
            {request?.confirmLabel || "Confirm"}
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
