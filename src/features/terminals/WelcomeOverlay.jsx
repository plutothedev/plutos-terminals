// (C)
// Welcome card shown over a fresh local terminal pane — the DOM replacement for
// the old printed ANSI box. Because it's a real DOM element it reflows perfectly
// on split/resize (CSS) and never corrupts scrollback. It's transient: the pane
// dismisses it on the first keystroke (see TerminalPane onData), and clicking
// anywhere (or the ✕) dismisses it too. Styled to echo the MobaXterm box vibe.

import { GITHUB_URL, DISCORD_URL, openExternal } from "../../appMeta.js";

const CY = "#3FC7C7"; // cyan accent
const YE = "#E0C04F";
const GR = "#6FB85C";
const MA = "#D982D9";
const RD = "#E0863C";

function Bul({ children }) {
  return (
    <div style={{ display: "flex", gap: 8, lineHeight: 1.5 }}>
      <span style={{ color: CY, flexShrink: 0 }}>►</span>
      <span>{children}</span>
    </div>
  );
}

export default function WelcomeOverlay({ onDismiss }) {
  const link = (url, text, color) => (
    <a
      href="#"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); openExternal(url); onDismiss?.(); }}
      style={{ color, textDecoration: "underline" }}
    >{text}</a>
  );
  return (
    <div
      onClick={onDismiss}
      style={{
        position: "absolute", inset: 0, zIndex: 5,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 14, cursor: "default",
      }}
    >
      <div
        onClick={onDismiss}
        style={{
          maxWidth: "min(560px, 96%)", width: "100%", maxHeight: "100%",
          overflowY: "auto", boxSizing: "border-box",
          background: "rgba(10,12,14,0.86)",
          border: `1px solid ${CY}`, borderRadius: 8,
          padding: "16px 18px",
          fontFamily: "'JetBrains Mono', Menlo, Monaco, monospace",
          fontSize: 12.5, color: "var(--phn-text-fg, #cfd6dd)",
          boxShadow: "0 10px 40px rgba(0,0,0,0.55)",
          position: "relative",
        }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss?.(); }}
          title="Dismiss (or just start typing)"
          style={{
            position: "absolute", top: 8, right: 10,
            background: "transparent", border: "none",
            color: "var(--phn-text-faint, #586068)",
            cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 2,
          }}
        >✕</button>

        <div style={{ textAlign: "center", marginBottom: 10 }}>
          <span style={{ display: "inline-block", background: CY, color: "#06231a", fontWeight: 700, padding: "2px 12px", borderRadius: 4, letterSpacing: 0.5 }}>
            ✦ Pluto's Terminal ✦
          </span>
          <div style={{ color: CY, marginTop: 6, opacity: 0.9 }}>free multi-terminal for the Pluto community</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <Bul>Saved sessions live in the <b style={{ color: YE }}>Sessions</b> panel — SSH · local · serial · RDP/VNC</Bul>
          <Bul>Scrollback is <b style={{ color: GR }}>persistent</b> — every tab is saved and replayed on restart</Bul>
          <Bul><b style={{ color: MA }}>MultiExec</b> broadcasts your typing to every visible terminal at once</Bul>
          <Bul><b style={{ color: CY }}>Models</b>: route to any LLM — Claude · GPT · Gemini · GLM · Kimi · 16 providers</Bul>
          <Bul>Split panes, drag tabs and pin sessions to shape your workspace</Bul>
          <Bul>Tools, snippets and a file browser are one click away in the toolbar</Bul>
          <Bul>Command status shows as a symbol (<b style={{ color: GR }}>✓</b> ok · <b style={{ color: "#E05B5B" }}>✗</b> failed)</Bul>
        </div>

        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.08)", lineHeight: 1.5 }}>
          <span style={{ color: RD, fontWeight: 700 }}>Tip! </span>
          Run <b style={{ color: YE }}>Claude Code</b>, Codex and other AI agents side by side — each in its own git worktree, on <b style={{ color: YE }}>any model</b> you pick. Press <b style={{ color: YE }}>Ctrl+K</b> for the command palette, or <b style={{ color: CY }}>Home</b> to launch.
        </div>

        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 11.5 }}>
          <span><span style={{ color: GR }}>➜ </span>Docs: {link(GITHUB_URL, "github.com/plutothedev/plutos-terminals", CY)}</span>
          <span><span style={{ color: MA }}>➜ </span>Community: {link(DISCORD_URL, "discord.gg/3cZQVgKF", MA)}</span>
        </div>

        <div style={{ marginTop: 10, textAlign: "center", color: "var(--phn-text-faint, #586068)", fontSize: 11 }}>
          start typing to dismiss
        </div>
      </div>
    </div>
  );
}
