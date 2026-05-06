// First-launch onboarding tour. 4-step walk-through: terminals → skins →
// packs → power features. Skin-aware via CSS vars. Dismissed via "Skip"
// at any step or "Got it" on the final step. The dismissal flag persists
// to st.terminalsOnboarded so it never reappears.

import { useState } from "react";

const STEPS = [
  {
    icon: "🖥",
    title: "Terminals + Projects",
    body: (FG, ACCENT) => (
      <>
        <p style={{ marginBottom: 12 }}>
          Run multiple AI agents (Claude, Codex…) side by side. Up to <strong style={{ color: ACCENT }}>8 panels</strong> in a grid, each with its own tabs and PTY.
        </p>
        <p style={{ marginBottom: 12 }}>
          Click <strong style={{ color: ACCENT }}>+ Add project</strong> in the left sidebar to register a folder with cwd + start commands. Background tabs glow yellow while working, green when done — you can tell which agent needs you without flipping tabs.
        </p>
      </>
    ),
  },
  {
    icon: "🎨",
    title: "Skins paint the whole app",
    body: (FG, ACCENT) => (
      <>
        <p style={{ marginBottom: 12 }}>
          Open <strong style={{ color: ACCENT }}>⚙️ settings</strong> in the top-right. <strong>10 skins</strong> change every surface — header, sidebar, status bar, terminal background.
        </p>
        <p style={{ marginBottom: 12 }}>
          Try <strong style={{ color: ACCENT }}>Synthwave Sunset</strong> for chromatic vibes, <strong style={{ color: ACCENT }}>Brutalist Mono</strong> for ruthless black/white, or <strong style={{ color: ACCENT }}>Daylight</strong> for a real light theme. <strong>6 button styles</strong> and <strong>3 densities</strong> stack on top — 180 distinct looks total.
        </p>
      </>
    ),
  },
  {
    icon: "📚",
    title: "Prompt packs",
    body: (FG, ACCENT) => (
      <>
        <p style={{ marginBottom: 12 }}>
          A <code style={{ color: ACCENT, padding: "1px 4px", borderRadius: 2, background: "var(--phn-page-bg, #0a0a0a)" }}>.deck.json</code> pack describes a multi-panel terminal layout. Loading one replaces your current panels with the pack's setup.
        </p>
        <p style={{ marginBottom: 12 }}>
          <strong>11 packs ship</strong>: claude-code-basic, dual-claude-pair, codebase-explorer, writing-helper, debug-session, language-learning, interview-prep, content-script-writer, rubber-duck, trading-workflow (Pluto Style), example. Click <strong style={{ color: ACCENT }}>📚 packs…</strong> or <strong style={{ color: ACCENT }}>🔍 find</strong> in the header to browse.
        </p>
        <p style={{ marginBottom: 0 }}>
          Each pack ships a <strong>systemPrompt</strong> that auto-types into Claude 2 seconds after spawn — real role-priming, not just labels.
        </p>
      </>
    ),
  },
  {
    icon: "⌨",
    title: "Power features",
    body: (FG, ACCENT) => (
      <>
        <p style={{ marginBottom: 12 }}>
          Keyboard shortcuts:
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", marginBottom: 14, fontSize: 11 }}>
          <code style={kbdStyle}>Ctrl+K</code><span>Command palette (everything in one search)</span>
          <code style={kbdStyle}>Ctrl+P</code><span>Find a pack</span>
          <code style={kbdStyle}>Ctrl+,</code><span>Open settings</span>
          <code style={kbdStyle}>Ctrl+Shift+T</code><span>New tab in active panel</span>
          <code style={kbdStyle}>Ctrl+Shift+W</code><span>Close active tab</span>
          <code style={kbdStyle}>Ctrl+1–8</code><span>Switch to panel N</span>
        </div>
        <p style={{ marginBottom: 0 }}>
          You're set. Click <strong style={{ color: ACCENT }}>🚀 setup</strong> if you haven't installed Claude CLI yet — it walks you through any missing pieces.
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
  const ACCENT = "var(--phn-link, #4DAAFC)";
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

        <div style={{ fontSize: 32, marginBottom: 6, lineHeight: 1 }}>{current.icon}</div>
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
                ← back
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
              {isLast ? "Got it" : "next →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
