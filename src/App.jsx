import { useCallback, useEffect, useState } from "react";
import TerminalsTab from "./features/terminals/TerminalsTab.jsx";

const STORAGE_KEY = "plutos-terminals:state:v0";

const PAGE_BG = "#0a0a0a";
const FG = "#9D9D9D";
const FG_ACTIVE = "#E6E6E6";
const FG_DIM = "#555555";
const ACCENT = "#4DAAFC";
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

export default function App() {
  const [st, setSt] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const save = useCallback((next) => {
    setSt(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (err) {
      console.warn("Pluto's Terminals: localStorage write failed", err);
    }
  }, []);

  const [welcomeDone, setWelcomeDone] = useState(() => st.welcomeDone === true);

  // First-run welcome: branding + Anthropic API key prompt. Persisted as
  // st.welcomeDone so subsequent launches skip straight to the terminals
  // grid. The key itself we DO NOT persist for v0 — the user pastes it into
  // their shell session via the prompt-pack onboarding instead. Future v1:
  // store it via Tauri secure storage and inject into spawned shells.
  if (!welcomeDone) {
    return (
      <Welcome
        onContinue={() => {
          const next = { ...st, welcomeDone: true };
          save(next);
          setWelcomeDone(true);
        }}
      />
    );
  }

  return <TerminalsTab st={st} save={save} />;
}

function Welcome({ onContinue }) {
  const [apiKeyHint, setApiKeyHint] = useState("");

  return (
    <div
      style={{
        height: "100vh",
        background: PAGE_BG,
        color: FG_ACTIVE,
        fontFamily: M,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 560, width: "100%" }}>
        <div style={{ fontSize: 28, color: FG_ACTIVE, letterSpacing: 1.5, marginBottom: 6 }}>
          PLUTO'S TERMINALS
        </div>
        <div style={{ color: ACCENT, fontSize: 12, letterSpacing: 0.5, marginBottom: 28 }}>
          Run my Claude Code setup in 60 seconds.
        </div>

        <p style={{ color: FG, fontSize: 13, lineHeight: 1.7, marginBottom: 28 }}>
          Free multi-terminal app for the <strong style={{ color: FG_ACTIVE }}>Pluto community</strong>.
          Run multiple AI agents (Claude Code, Codex, …) side by side. Save and share terminal setups
          as <code style={{ color: ACCENT }}>.deck.json</code> prompt packs.
        </p>

        <div style={{ marginBottom: 24 }}>
          <label style={{ color: FG_DIM, fontSize: 11, letterSpacing: 0.5, display: "block", marginBottom: 8 }}>
            ANTHROPIC API KEY (OPTIONAL — paste later in your shell with <code style={{ color: ACCENT }}>$env:ANTHROPIC_API_KEY = "sk-..."</code>)
          </label>
          <input
            type="password"
            placeholder="sk-ant-... (will not be stored in v0)"
            value={apiKeyHint}
            onChange={(e) => setApiKeyHint(e.target.value)}
            style={{
              width: "100%",
              background: "#181818",
              border: `1px solid #2B2B2B`,
              color: FG_ACTIVE,
              padding: "10px 12px",
              borderRadius: 4,
              fontFamily: M,
              fontSize: 12,
              outline: "none",
            }}
          />
          <div style={{ color: FG_DIM, fontSize: 10, marginTop: 6 }}>
            v0 does not persist this. Set it in your shell once the terminal opens. Secure storage coming v1.
          </div>
        </div>

        <button
          onClick={onContinue}
          style={{
            background: "transparent",
            border: `1px solid ${ACCENT}`,
            color: ACCENT,
            padding: "10px 28px",
            borderRadius: 4,
            fontFamily: M,
            fontSize: 13,
            letterSpacing: 0.5,
            cursor: "pointer",
          }}
        >
          ENTER →
        </button>

        <div style={{ color: FG_DIM, fontSize: 10, marginTop: 32 }}>
          v0.0.1 · 2026-05-04 · github.com/paidbypluto/plutos-terminals (TBD)
        </div>
      </div>
    </div>
  );
}
