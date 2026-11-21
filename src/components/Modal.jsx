// Reusable modal wrapper. Esc + click-on-backdrop dismiss. Visual treatment
// driven by the active app skin (headerSkins.js) via .phn-modal-* classes.
// MODAL_COLORS export retained for backward-compat with components that still
// reference the old constant names; values intentionally point at safe
// defaults (the actual rendering uses skin CSS vars via classes).

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Visible focusables within a node — one definition so the initial-focus pick and
// the Tab-trap agree on what "focusable" means (offsetParent filters hidden ones).
// Exported: the guided tour's focus trap (tour/TourOverlay.jsx) reuses it.
export function focusablesIn(node) {
  return Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);
}

export default function Modal({ open, title, onClose, children, width = 520 }) {
  const overlayRef = useRef(null);
  const dialogRef = useRef(null);
  // Whether the current mouse press began on the backdrop itself. A drag that
  // starts inside the dialog (selecting text) and is released over the
  // backdrop fires its click on the common ancestor, the overlay, so the click
  // alone cannot tell a backdrop click from the end of that drag.
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // Only the TOPMOST modal reacts to Escape. A nested modal renders inside its
      // parent's body, so it is the last `.phn-modal-overlay` in document order;
      // gating on that stops one Escape from dismissing both stacked dialogs.
      // Checking the live DOM at event time is robust to effect re-runs from an
      // unstable onClose prop (a counter/depth approach is not).
      const overlays = document.querySelectorAll(".phn-modal-overlay");
      if (overlays.length === 0 || overlays[overlays.length - 1] === overlayRef.current) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Accessibility: move focus into the dialog on open, and restore focus to
  // whatever was focused before (the trigger) when it closes. Keyboard/SR users
  // then land in the dialog instead of Tabbing into the terminal grid behind it.
  //
  // Children pick the initial field with a `data-autofocus` attribute, never
  // React's autoFocus: autoFocus runs in the layout phase, before this passive
  // effect, so `prev` would record the dialog's own field instead of the
  // trigger and close would drop focus on <body>.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement;
    const node = dialogRef.current;
    // The dialog this one is nested in, if any (a nested modal renders inside
    // its parent's body). Captured now: on close this overlay is already gone.
    const outer = overlayRef.current?.parentElement?.closest(".phn-modal") || null;
    if (node && !node.contains(document.activeElement)) {
      // Focus the marked field, else the first field in the BODY, not the
      // header ✕ (which is DOM-first), so a modal without a mark does not land
      // the user on Close. Fall back to the dialog itself if the body has
      // nothing focusable.
      const body = node.querySelector(".phn-modal-body");
      const fields = body ? focusablesIn(body) : [];
      // React renders data-autofocus={false} as the string "false": not a mark.
      const marked = fields.find((el) => el.hasAttribute("data-autofocus") && el.getAttribute("data-autofocus") !== "false");
      (marked || fields[0] || node).focus();
    }
    return () => {
      if (prev && typeof prev.focus === "function") prev.focus();
      // The opener may no longer take focus (disabled while the work it
      // started runs, or unmounted). Keep focus inside the outer dialog then,
      // so its Tab trap still holds, rather than letting it fall to <body>.
      if (outer && outer.isConnected && !outer.contains(document.activeElement)) outer.focus();
    };
  }, [open]);

  if (!open) return null;

  // Trap Tab within the dialog. Bound to the dialog node (not window) so a nested
  // modal's trap and the parent's don't fight — focus lives in the topmost one.
  const onTrapKey = (e) => {
    if (e.key !== "Tab") return;
    const node = dialogRef.current;
    if (!node) return;
    const items = focusablesIn(node); // whole dialog incl. the header ✕ (Tab reaches it)
    if (items.length === 0) { e.preventDefault(); node.focus(); return; }
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    // Focus on the dialog element itself (the fallback when an inner dialog's
    // opener cannot take focus back): the browser's next or previous stop from
    // there can be outside the dialog, so pick the end ourselves.
    if (document.activeElement === node) { e.preventDefault(); (e.shiftKey ? lastEl : firstEl).focus(); }
    else if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  };

  return (
    // The backdrop is presentation only: its click closes the dialog for the
    // mouse, and the keyboard path for the same action is Escape (the window
    // listener above). A click closes only when the press also began on the
    // backdrop (downOnBackdrop, above); the flag is cleared after every click. The Tab trap is bound here rather than on the dialog
    // element because jsx-a11y treats role="dialog" as non-interactive. The
    // overlay's only child is the dialog and the overlay itself never takes
    // focus, so every keydown that reaches this handler came up through this
    // dialog, exactly as before; nested modals render inside the parent's
    // body, so the innermost trap still runs first.
    <div
      ref={overlayRef}
      className="phn-modal-overlay"
      role="presentation"
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        const close = downOnBackdrop.current && e.target === e.currentTarget;
        downOnBackdrop.current = false;
        if (close) onClose();
      }}
      onKeyDown={onTrapKey}
    >
      <div
        ref={dialogRef}
        className="phn-modal"
        // outline none, like the other dialog containers (ProjectDialog,
        // TourOverlay, RemoteControlModal): focus lands on this element only as
        // a fallback, and a UA ring around the whole dialog marks nothing.
        style={{ width, maxWidth: "calc(100vw - 24px)", outline: "none" }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
      >
        <div className="phn-modal-header">
          <div className="phn-modal-title">{title}</div>
          <button
            className="phn-modal-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>
        <div className="phn-modal-body">{children}</div>
      </div>
    </div>
  );
}

// Backward-compat shim for components that destructure these. The actual
// rendering uses CSS classes that read skin vars; these constants are just
// fallback values for any inline-style usage that hasn't been migrated yet.
export const MODAL_COLORS = {
  BG: "var(--phn-surface-bg, #181818)",
  PAGE: "rgba(0,0,0,0.62)",
  FG: "var(--phn-text-fg, #CCCCCC)",
  FG_ACTIVE: "var(--phn-text-active, #E6E6E6)",
  FG_DIM: "var(--phn-text-dim, #9D9D9D)",
  ACCENT: "var(--phn-link, #7c9cf5)",
  BORDER: "var(--phn-surface-border, #2B2B2B)",
  M: "'JetBrains Mono', Menlo, Monaco, monospace",
};
