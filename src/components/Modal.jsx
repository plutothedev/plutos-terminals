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
function focusablesIn(node) {
  return Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);
}

export default function Modal({ open, title, onClose, children, width = 520 }) {
  const overlayRef = useRef(null);
  const dialogRef = useRef(null);

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

  // Accessibility: move focus into the dialog on open (unless a child already
  // claimed it via autoFocus / its own effect), and restore focus to whatever
  // was focused before — the trigger — when it closes. Keyboard/SR users then
  // land in the dialog instead of Tabbing into the terminal grid behind it.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement;
    const node = dialogRef.current;
    if (node && !node.contains(document.activeElement)) {
      // Focus the first field in the BODY, not the header ✕ (which is DOM-first) —
      // otherwise every modal without its own autoFocus lands the user on Close.
      // Fall back to the dialog itself if the body has nothing focusable.
      const body = node.querySelector(".phn-modal-body");
      const first = body ? focusablesIn(body)[0] : null;
      (first || node).focus();
    }
    return () => { if (prev && typeof prev.focus === "function") prev.focus(); };
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
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  };

  return (
    <div
      ref={overlayRef}
      className="phn-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="phn-modal"
        style={{ width, maxWidth: "calc(100vw - 24px)" }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        onKeyDown={onTrapKey}
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
