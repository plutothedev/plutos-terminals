// Reusable modal wrapper. Esc + click-on-backdrop dismiss. Visual treatment
// driven by the active app skin (headerSkins.js) via .phn-modal-* classes.
// MODAL_COLORS export retained for backward-compat with components that still
// reference the old constant names; values intentionally point at safe
// defaults (the actual rendering uses skin CSS vars via classes).

import { useEffect, useRef } from "react";

export default function Modal({ open, title, onClose, children, width = 520 }) {
  const overlayRef = useRef(null);
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

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="phn-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="phn-modal" style={{ width, maxWidth: "calc(100vw - 24px)" }}>
        <div className="phn-modal-header">
          <div className="phn-modal-title">{title}</div>
          <button
            className="phn-modal-close"
            onClick={onClose}
            title="Close (Esc)"
          >
            ×
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
