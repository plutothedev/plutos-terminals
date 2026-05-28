import { useCallback, useEffect, useState } from "react";
import TerminalsTab from "./features/terminals/TerminalsTab.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";
import { ToastProvider } from "./components/Toast.jsx";
import { ConfirmProvider } from "./components/ConfirmModal.jsx";
import {
  getSkinId,
  getLayoutId,
  injectHeaderSkinsCss,
  applyGlobalSkin,
  applyGlobalButtonStyle,
  applyGlobalLayout,
} from "./features/terminals/headerSkins.js";

// Per-window storage key (v0.1.19 multi-window). The default window has no
// ?w= query param → uses the original key for backward compat. Secondary
// windows spawned via the spawn_new_window Tauri command get ?w=<id> →
// suffix the key so each window has independent state (panels, skin, etc.).
function getWindowStorageKey() {
  if (typeof window === "undefined") return "plutos-terminals:state:v0";
  const w = new URLSearchParams(window.location.search).get("w");
  if (!w) return "plutos-terminals:state:v0";
  return `plutos-terminals:state:v0:${w}`;
}
const STORAGE_KEY = getWindowStorageKey();

// Shared user-level state (v0.1.21): welcomeDone, anthropicKey,
// terminalsOnboarded. These are user preferences, not window preferences —
// re-prompting for the API key on every new window or replaying the
// onboarding tour each time you spawn a window is a confidence-killer.
// Stored under a constant key so all windows in the same Tauri origin
// share it via localStorage.
const USER_STORAGE_KEY = "plutos-terminals:user:v0";

function readUserState() {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeUserState(next) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn("Pluto's Terminals: user-state localStorage write failed", err);
  }
}

const WINDOW_ID = (() => {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("w") || null;
})();
const DEFAULT_DISCORD_URL = "https://discord.gg/3cZQVgKF";
const APP_VERSION = "0.1.26";

const PAGE_BG = "var(--phn-page-bg, #0a0a0a)";
const FG = "var(--phn-text-fg, #9D9D9D)";
const FG_ACTIVE = "var(--phn-text-active, #E6E6E6)";
const FG_DIM = "var(--phn-text-dim, #555555)";
const ACCENT = "var(--phn-link, #4DAAFC)";
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

  // Shared user-level state. Synchronous one-time migration on first run
  // of v0.1.21+: if userState is empty but window-state has the user-level
  // fields (welcomeDone / anthropicKey / terminalsOnboarded), copy them over
  // so existing users don't see Welcome / onboarding again on upgrade.
  const [userSt, setUserSt] = useState(() => {
    let us = readUserState();
    if (Object.keys(us).length === 0) {
      try {
        const winRaw = localStorage.getItem(STORAGE_KEY);
        const winSt = winRaw ? JSON.parse(winRaw) : {};
        if (winSt.welcomeDone || winSt.anthropicKey || winSt.terminalsOnboarded) {
          us = {
            welcomeDone: winSt.welcomeDone === true,
            anthropicKey: typeof winSt.anthropicKey === "string" ? winSt.anthropicKey : "",
            terminalsOnboarded: winSt.terminalsOnboarded === true,
          };
          writeUserState(us);
        }
      } catch { /* ignore */ }
    }
    return us;
  });

  const save = useCallback((next) => {
    setSt(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (err) {
      console.warn("Pluto's Terminals: localStorage write failed", err);
    }
  }, []);

  const saveUser = useCallback((next) => {
    setUserSt(next);
    writeUserState(next);
  }, []);

  // Cross-window sync: if another window updates user state, pick it up here.
  // localStorage `storage` events fire in OTHER tabs/windows of the same
  // origin (not the originating one). Useful when window 1 dismisses the
  // tour and window 2 is already open.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === USER_STORAGE_KEY && e.newValue) {
        try {
          setUserSt(JSON.parse(e.newValue));
        } catch { /* ignore */ }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Inject skin CSS once + apply skin/button-style/layout globally on <html>
  // BEFORE Welcome screen renders so first-launch picks up saved settings.
  // Header buttons are locked to "bracket" terminal-aesthetic style as of
  // v0.1.20 (the picker was removed; one canonical look across all skins).
  useEffect(() => { injectHeaderSkinsCss(); }, []);

  // v4.0 one-time migration: force the "moba" (MobaXterm) skin + layout once so
  // everyone lands on the new default look. They can switch skins afterward —
  // we only override while mobaDefaultForced is unset.
  useEffect(() => {
    if (st?.mobaDefaultForced) return;
    save({ ...st, headerSkin: "moba", uiLayout: "moba", mobaDefaultForced: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skinId = getSkinId(st.headerSkin);
  const layoutId = getLayoutId(st.headerLayout);
  useEffect(() => { applyGlobalSkin(skinId); }, [skinId]);
  useEffect(() => { applyGlobalButtonStyle("bracket"); }, []);
  useEffect(() => { applyGlobalLayout(layoutId); }, [layoutId]);

  const welcomeDone = userSt.welcomeDone === true;

  if (!welcomeDone) {
    return (
      <>
        <Welcome
          initialKey={typeof userSt.anthropicKey === "string" ? userSt.anthropicKey : ""}
          discordUrl={DEFAULT_DISCORD_URL}
          onContinue={(apiKey) => {
            saveUser({
              ...userSt,
              welcomeDone: true,
              anthropicKey: apiKey || userSt.anthropicKey || "",
            });
          }}
        />
        <UpdateBanner currentVersion={APP_VERSION} />
      </>
    );
  }

  return (
    <>
      <TerminalsTab st={st} save={save} userSt={userSt} saveUser={saveUser} />
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
          PLUTO'S TERMINAL
        </div>
        <div style={{ color: ACCENT, fontSize: 12, letterSpacing: 0.5, marginBottom: 28 }}>
          Run AI agents in parallel. Save your setup. Share it.
        </div>

        <p style={{ color: FG, fontSize: 13, lineHeight: 1.7, marginBottom: 28 }}>
          Free multi-terminal app for the <strong style={{ color: FG_ACTIVE }}>Pluto community</strong>.
          Run Claude Code, Codex, and other AI agents side by side — each in its own git worktree,
          pointed at <strong style={{ color: FG_ACTIVE }}>any model</strong> you like
          (Claude, Kimi K2, OpenRouter, and more) with your own API key.
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
