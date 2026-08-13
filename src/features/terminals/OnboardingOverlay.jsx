// First-launch onboarding tour. 4-step walk-through: sessions → themes →
// workflows + AI → palette + shortcuts. Skin-aware via CSS vars. Dismissed via
// "Skip" at any step or "Got it" on the final step. The dismissal flag persists
// to st.terminalsOnboarded so it never reappears.

import { useState } from "react";
import { SLocal, SPalette, SBook, SKeyboard } from "./toolbarIcons.jsx";
import { modCombo, formatCombo } from "./keybindings.js";

const STEPS = [
  {
    icon: <SLocal size={28} />,
    title: "Sessions",
    body: (FG, ACCENT) => (
      <>
        <p style={{ marginBottom: 12 }}>
          The left tree holds your saved sessions — local shells, SSH, serial, and RDP/VNC remote desktops. Click <strong style={{ color: ACCENT }}>+ Add session</strong> (or the Local / SSH toolbar buttons) to save a folder or a host, then click it anytime to open a tab.
        </p>
        <p style={{ marginBottom: 12 }}>
          Split any tab side by side or stacked, and run agents (Claude Code, Codex…) in parallel — background tabs glow yellow while running, green when finished, amber when one needs you.
        </p>
      </>
    ),
  },
  {
    icon: <SPalette size={28} />,
    title: "Themes",
    body: (FG, ACCENT) => (
      <>
        <p style={{ marginBottom: 12 }}>
          Open <strong style={{ color: ACCENT }}>Settings</strong> ({formatCombo("Ctrl+,")}) to pick <strong style={{ color: ACCENT }}>Dark</strong>, <strong style={{ color: ACCENT }}>Light</strong>, or <strong style={{ color: ACCENT }}>OLED</strong> — the default, true #000 on every surface.
        </p>
        <p style={{ marginBottom: 12 }}>
          Want more? Paste any Warp theme YAML (<strong>github.com/warpdotdev/themes</strong>) under Settings → Custom themes to reskin the terminal and the whole app, or sync with your OS light/dark automatically.
        </p>
      </>
    ),
  },
  {
    icon: <SBook size={28} />,
    title: "Workflows + AI",
    body: (FG, ACCENT) => (
      <>
        <p style={{ marginBottom: 12 }}>
          <strong style={{ color: ACCENT }}>Workflows</strong> are saved, parameterized commands — open the Workflows panel from the toolbar and click one to run it (Warp workflow YAML imports directly). <strong style={{ color: ACCENT }}>Fleet</strong> sits next to it: every session's state (running / finished / needs you) in one list.
        </p>
        <p style={{ marginBottom: 12 }}>
          <strong style={{ color: ACCENT }}>Ask AI</strong> ({modCombo("I")}) turns plain English into a shell command you review before it runs; <strong style={{ color: ACCENT }}>Agent Mode</strong> ({formatCombo("Ctrl+Shift+A")}) takes a goal and runs the commands itself, asking before anything risky. The right dock adds files (SFTP), an AI assistant, and a live CPU/MEM/DISK monitor.
        </p>
      </>
    ),
  },
  {
    icon: <SKeyboard size={28} />,
    title: "Command palette + shortcuts",
    body: (FG, ACCENT) => (
      <>
        <p style={{ marginBottom: 12 }}>
          Keyboard shortcuts:
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", marginBottom: 14, fontSize: 11 }}>
          <code style={kbdStyle}>{modCombo("K")}</code><span>Command palette (everything in one search)</span>
          <code style={kbdStyle}>{modCombo("I")}</code><span>Ask AI — plain English to command</span>
          <code style={kbdStyle}>{formatCombo("Ctrl+Shift+A")}</code><span>Agent Mode</span>
          <code style={kbdStyle}>{modCombo("R")}</code><span>Command history search</span>
          <code style={kbdStyle}>{formatCombo("Ctrl+Shift+T")}</code><span>New tab in active panel</span>
          <code style={kbdStyle}>{formatCombo("Ctrl+Shift+D")}</code><span>Split the active pane right</span>
          <code style={kbdStyle}>{modCombo("1")}–8</code><span>Switch to panel N</span>
        </div>
        <p style={{ marginBottom: 0 }}>
          The F-key bar along the bottom mirrors the big ones — F1 help, F2 new tab, F3 split, F4 files (SFTP). Every shortcut is rebindable in Settings, and <strong style={{ color: ACCENT }}>Tools → Setup checker</strong> walks you through anything missing (Node, the Claude CLI).
        </p>
      </>
    ),
  },
];

const kbdStyle = {
  fontSize: 10,
  padding: "1px 6px",
  border: "1px solid var(--phn-surface-border, #2B2B2B)",
  borderRadius: 3,
  background: "var(--phn-page-bg, #0a0a0a)",
  color: "var(--phn-text-active, #E6E6E6)",
  fontFamily: "'JetBrains Mono', Menlo, Monaco, monospace",
  whiteSpace: "nowrap",
  textAlign: "center",
};

export default function OnboardingOverlay({ onDismiss }) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const FG = "var(--phn-text-fg, #CCCCCC)";
  const FG_ACTIVE = "var(--phn-text-active, #E6E6E6)";
  const FG_DIM = "var(--phn-text-dim, #9D9D9D)";
  const ACCENT = "var(--phn-link, #7c9cf5)";
  const BORDER = "var(--phn-surface-border, #2B2B2B)";
  const BG = "var(--phn-surface-bg, #181818)";
  const M = "'JetBrains Mono', Menlo, Monaco, monospace";

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,0.62)",
        zIndex: 9985,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 12,
        backdropFilter: "blur(3px)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
      onKeyDown={(e) => { if (e.key === "Escape") onDismiss(); }}
      tabIndex={-1}
    >
      <div
        style={{
          background: BG,
          border: `1px solid ${BORDER}`,
          borderRadius: 10,
          width: 540,
          maxWidth: "calc(100vw - 24px)",
          maxHeight: "calc(100vh - 24px)",
          overflowY: "auto",
          boxSizing: "border-box",
          fontFamily: M,
          color: FG,
          fontSize: 12,
          padding: 28,
          boxShadow: "0 12px 48px rgba(0,0,0,0.65)",
        }}
      >
        {/* Step indicator */}
        <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
          {STEPS.map((_, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                background: i <= step ? ACCENT : BORDER,
                transition: "background 200ms ease",
              }}
            />
          ))}
        </div>

        <div style={{ marginBottom: 8, lineHeight: 1, display: "flex", color: ACCENT }}>{current.icon}</div>
        <div style={{ fontSize: 18, color: FG_ACTIVE, marginBottom: 14, letterSpacing: 0.3 }}>
          {current.title}
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.65, color: FG, marginBottom: 22 }}>
          {current.body(FG, ACCENT)}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button
            onClick={onDismiss}
            style={{
              background: "transparent",
              border: "none",
              color: FG_DIM,
              fontFamily: M,
              fontSize: 11,
              cursor: "pointer",
              padding: "6px 0",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
          >
            Skip the tour
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 0 && (
              <button
                onClick={() => setStep(step - 1)}
                style={{
                  background: "transparent",
                  border: `1px solid ${BORDER}`,
                  color: FG,
                  padding: "6px 14px",
                  borderRadius: 4,
                  fontFamily: M,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                ← Back
              </button>
            )}
            <button
              onClick={isLast ? onDismiss : () => setStep(step + 1)}
              style={{
                background: ACCENT,
                border: `1px solid ${ACCENT}`,
                color: "#001",
                padding: "6px 18px",
                borderRadius: 4,
                fontFamily: M,
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
              autoFocus
            >
              {isLast ? "Got it" : "Next →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
