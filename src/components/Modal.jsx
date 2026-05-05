// Reusable modal wrapper. Esc + click-on-backdrop dismiss. Used by
// SettingsModal, McpInstaller, AboutModal, etc.

import { useEffect } from "react";

const BG = "#181818";
const PAGE = "rgba(0,0,0,0.62)";
const FG = "#CCCCCC";
const FG_ACTIVE = "#E6E6E6";
const FG_DIM = "#9D9D9D";
const ACCENT = "#4DAAFC";
const BORDER = "#2B2B2B";
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

export default function Modal({ open, title, onClose, children, width = 520 }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: PAGE,
        zIndex: 9990,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 12,
        backdropFilter: "blur(2px)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: BG,
          border: `1px solid ${BORDER}`,
          borderRadius: 8,
          width,
          maxWidth: "calc(100vw - 24px)",
          maxHeight: "calc(100vh - 24px)",
          overflowY: "auto",
          boxSizing: "border-box",
          fontFamily: M,
          color: FG,
          fontSize: 12,
          padding: 0,
          boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 20px",
            borderBottom: `1px solid ${BORDER}`,
          }}
        >
          <div style={{ fontSize: 14, color: FG_ACTIVE, letterSpacing: 0.5 }}>{title}</div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: FG_DIM,
              cursor: "pointer",
              fontSize: 18,
              padding: "0 4px",
              lineHeight: 1,
            }}
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}

export const MODAL_COLORS = {
  BG, PAGE, FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M,
};
