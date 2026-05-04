// One-time welcome overlay shown the first time a user opens the Terminals
// tab. Dismissed via the "Got it" button or Escape; the dismissal flag is
// persisted to st so it never reappears.

const BG = "#181818";
const PAGE = "#0a0a0a";
const FG = "#CCCCCC";
const FG_DIM = "#9D9D9D";
const FG_ACTIVE = "#E6E6E6";
const ACCENT = "#4DAAFC";
const BORDER = "#2B2B2B";
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

const TIPS = [
  { icon: "📁", text: "Click ", em: "+ Add project", suffix: " to register a folder. Set " , em2: "Start commands", suffix2: ` like "claude" or "npm run dev" so they auto-run when you open it.` },
  { icon: "🎯", text: "Click a project to open it in the active panel. Drag the project row onto another panel to open it there." },
  { icon: "🟡", text: "Background tabs glow ", em: "yellow", suffix: " while working, ", em2: "green", suffix2: " when done — you know which agent needs you without flipping tabs." },
  { icon: "🔗", text: "Toggle ", em: "sync", suffix: " in the header to scroll all panes together. Right-click a project for color, npm scripts, recent files, and auto-approve toggle." },
];

export default function OnboardingOverlay({ onDismiss }) {
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
        backdropFilter: "blur(2px)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
      onKeyDown={(e) => { if (e.key === "Escape") onDismiss(); }}
      tabIndex={-1}
    >
      <div
        style={{
          background: BG,
          border: `1px solid ${BORDER}`,
          borderRadius: 8,
          width: 480,
          maxWidth: "calc(100vw - 24px)",
          maxHeight: "calc(100vh - 24px)",
          overflowY: "auto",
          boxSizing: "border-box",
          fontFamily: M,
          color: FG,
          fontSize: 12,
          padding: 24,
          boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ fontSize: 16, color: FG_ACTIVE, marginBottom: 6, letterSpacing: 0.5 }}>
          Welcome to Terminals
        </div>
        <div style={{ color: FG_DIM, fontSize: 11, lineHeight: 1.5, marginBottom: 16 }}>
          Run multiple AI agents (Claude, Codex, …) side by side, with project context preserved across restarts.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {TIPS.map((tip, i) => (
            <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span style={{ fontSize: 18, flexShrink: 0, lineHeight: 1.2 }}>{tip.icon}</span>
              <span style={{ fontSize: 11, lineHeight: 1.55, color: FG }}>
                {tip.text}
                {tip.em && <strong style={{ color: ACCENT, fontWeight: 600 }}>{tip.em}</strong>}
                {tip.suffix}
                {tip.em2 && <strong style={{ color: ACCENT, fontWeight: 600 }}>{tip.em2}</strong>}
                {tip.suffix2}
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 22 }}>
          <button
            onClick={onDismiss}
            style={{
              background: ACCENT,
              border: `1px solid ${ACCENT}`,
              color: "#001",
              padding: "7px 18px",
              borderRadius: 4,
              fontFamily: M,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
            autoFocus
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
