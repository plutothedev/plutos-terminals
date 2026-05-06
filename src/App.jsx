import { useCallback, useState } from "react";
import TerminalsTab from "./features/terminals/TerminalsTab.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";
import { ToastProvider } from "./components/Toast.jsx";
import { ConfirmProvider } from "./components/ConfirmModal.jsx";

const STORAGE_KEY = "plutos-terminals:state:v0";
const DEFAULT_DISCORD_URL = "https://discord.gg/3cZQVgKF";
const APP_VERSION = "0.1.11";

const PAGE_BG = "#0a0a0a";
const FG = "#9D9D9D";
const FG_ACTIVE = "#E6E6E6";
const FG_DIM = "#555555";
const ACCENT = "#4DAAFC";
const PLUTO_MAGENTA = "#FF0080";
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppInner />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function AppInner() {
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

  if (!welcomeDone) {
    return (
      <>
        <Welcome
          initialKey={typeof st.anthropicKey === "string" ? st.anthropicKey : ""}
          discordUrl={st.discordUrl || DEFAULT_DISCORD_URL}
          onContinue={(apiKey) => {
            const next = {
              ...st,
              welcomeDone: true,
              anthropicKey: apiKey || st.anthropicKey || "",
            };
            save(next);
            setWelcomeDone(true);
          }}
        />
        <UpdateBanner currentVersion={APP_VERSION} />
      </>
    );
  }

  return (
    <>
      <TerminalsTab st={st} save={save} />
      <UpdateBanner currentVersion={APP_VERSION} />
    </>
  );
}

function Welcome({ initialKey, discordUrl, onContinue }) {
  const [apiKey, setApiKey] = useState(initialKey || "");

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
          Run AI agents in parallel. Save your setup. Share it.
        </div>

        <p style={{ color: FG, fontSize: 13, lineHeight: 1.7, marginBottom: 28 }}>
          Free multi-terminal app for the <strong style={{ color: FG_ACTIVE }}>Pluto community</strong>.
          Run Claude Code, Codex, and other AI agents side by side. Save and share terminal setups
          as <code style={{ color: ACCENT }}>.deck.json</code> prompt packs — clone someone else's
          configuration in one click.
        </p>

        <div style={{ marginBottom: 24 }}>
          <label style={{ color: FG_DIM, fontSize: 11, letterSpacing: 0.5, display: "block", marginBottom: 8 }}>
            ANTHROPIC API KEY (saved locally, auto-injected into every new shell)
          </label>
          <input
            type="password"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onContinue(apiKey); }}
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
              boxSizing: "border-box",
            }}
          />
          <div style={{ color: FG_DIM, fontSize: 10, marginTop: 6, lineHeight: 1.6 }}>
            Stored in this app's local data dir (plain JSON). Skip if you'd rather paste per-shell.
            You can edit, clear, or factory-reset later via the ⚙️ settings button in the header.
          </div>
          <div style={{ color: PLUTO_MAGENTA, fontSize: 10, marginTop: 10, lineHeight: 1.6 }}>
            ⚠️ First time? You'll also need <strong>Node.js</strong> + the <strong>Claude Code CLI</strong> installed for <code style={{ background: "#0a0a0a", padding: "0 4px", borderRadius: 2 }}>claude</code> to work in any tab.
            Click <strong>🚀 setup</strong> in the header after enter for a guided checklist + live API test.
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 24 }}>
          <button
            onClick={() => onContinue(apiKey)}
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

          <a
            href={discordUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              background: "transparent",
              border: `1px solid ${PLUTO_MAGENTA}`,
              color: PLUTO_MAGENTA,
              padding: "10px 18px",
              borderRadius: 4,
              fontFamily: M,
              fontSize: 12,
              letterSpacing: 0.5,
              cursor: "pointer",
              textDecoration: "none",
            }}
          >
            JOIN PLUTO DISCORD
          </a>
        </div>

        <div style={{ color: FG_DIM, fontSize: 10, marginTop: 8 }}>
          v{APP_VERSION} · github.com/plutothedev/plutos-terminals · MIT
        </div>
      </div>
    </div>
  );
}
