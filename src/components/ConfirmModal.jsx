// Branded confirmation modal. Replaces window.confirm. Imperative API via
// useConfirm() hook so call sites read like:
//
//   const confirm = useConfirm();
//   if (await confirm("Replace panels?", { destructive: true })) { ... }
//
// Answers: true from the Confirm button, false from the Cancel button, and
// null when the dialog is dismissed (Escape, the header close button, a
// backdrop click). Read any falsy answer as "no". A caller whose Cancel button
// does something (the recovered-recording prompt's "Discard") checks for
// `false` exactly, so a dismissal leaves things as they were.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Modal, { MODAL_COLORS } from "./Modal.jsx";

const { FG, ACCENT, BORDER, M } = MODAL_COLORS;
const PLUTO_MAGENTA = "#e08784";

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);
  // request: { id, message, title, confirmLabel, cancelLabel, destructive, resolve }
  const nextId = useRef(0);
  // The request on screen, for confirm() and the answer handlers (state lags
  // a render behind them), and the requests waiting behind it, oldest first.
  // A confirm() asked while one is open (a guarded close or Reset workspace
  // fired from a global shortcut, which are not gated while a dialog is up)
  // waits its turn: the open one stays on screen until the user answers it,
  // then the next one shows. No request is ever answered for the user. The
  // queue exists because answering the open one false to make room is not
  // neutral: the recovered-recording loop in TerminalsTab reads false as
  // "discard", so a shortcut would delete a recording nobody answered for,
  // and the loop's next confirm would then replace the shortcut's dialog.
  const pendingRef = useRef(null);
  const queueRef = useRef([]);
  // The element focused when a chain of requests began (asked while none was
  // open), cleared when the last one closes. A queue drain is one chain. The
  // shared Modal hands focus back per request, so an opener that is disabled
  // or gone when the first answer swaps dialogs makes the next one record
  // <body>, and the chain would end there even if the opener can take focus
  // again by then.
  const openerRef = useRef(null);

  const confirm = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      // A caller that asks again straight after an answer does so before the
      // close commits (openerRef is cleared only then), so that is still the
      // same chain.
      if (!openerRef.current) openerRef.current = document.activeElement;
      const next = {
        id: ++nextId.current,
        message,
        title: opts.title || "Confirm",
        confirmLabel: opts.confirmLabel || "Confirm",
        cancelLabel: opts.cancelLabel || "Cancel",
        destructive: !!opts.destructive,
        resolve,
      };
      if (pendingRef.current) {
        queueRef.current.push(next);
        return;
      }
      pendingRef.current = next;
      setRequest(next);
    });
  }, []);

  // Answers the request on screen, then shows the next queued one (a fresh
  // Modal, keyed by id) or closes. A click on a dialog that is no longer the
  // one showing (a second click landing before the re-render) does nothing:
  // it must not answer, skip or close the request that took its place.
  const answer = (value) => {
    if (!request || pendingRef.current !== request) return;
    const next = queueRef.current.shift() || null;
    pendingRef.current = next;
    setRequest(next);
    request.resolve(value);
  };
  const onConfirm = () => answer(true);
  const onCancel = () => answer(false);
  // Escape, the header ✕ and a backdrop click: not the Cancel button's answer
  // (see the header note). Ignores the click event Modal's ✕ passes.
  const onDismiss = () => answer(null);

  // The chain's last request has closed. This runs after the Modal's own
  // cleanup has handed focus back; if that left focus on <body> (the opener
  // could not take it when the chain started) and the opener can take it now,
  // it goes there.
  useEffect(() => {
    if (request) return;
    const opener = openerRef.current;
    openerRef.current = null;
    if (!opener || opener === document.body || !opener.isConnected || opener.disabled) return;
    const active = document.activeElement;
    if ((active == null || active === document.body) && typeof opener.focus === "function") opener.focus({ preventScroll: true });
  }, [request]);

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
      <Modal key={request ? request.id : "closed"} open={!!request} title={request?.title || "Confirm"} onClose={onDismiss} width={460}>
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
