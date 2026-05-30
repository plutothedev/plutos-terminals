import { useCallback, useEffect, useRef, useState } from "react";
import { APP_VERSION, DISCORD_URL, openExternal } from "./appMeta.js";
import TerminalsTab from "./features/terminals/TerminalsTab.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";
import LockScreen from "./features/terminals/LockScreen.jsx";
import { isUnlockedThisSession } from "./features/terminals/masterPassword.js";
import { USER_STORAGE_KEY, getWindowStorageKey } from "./features/terminals/storageKeys.js";
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

// Per-window state key (default window = bare key; secondary ?w=<id> windows =
// suffixed for independent panels/skin). Resolver + keys live in storageKeys.js
// (single source of truth, shared with TerminalPane/TerminalsTab/SettingsModal).
const STORAGE_KEY = getWindowStorageKey();

// Shared user-level state (v0.1.21): welcomeDone, anthropicKey,
// terminalsOnboarded. These are user preferences, not window preferences —
// re-prompting for the API key on every new window or replaying the
// onboarding tour each time you spawn a window is a confidence-killer.
// Stored under a constant key so all windows in the same Tauri origin
// share it via localStorage.
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

const DEFAULT_DISCORD_URL = DISCORD_URL;

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
  const [unlocked, setUnlocked] = useState(isUnlockedThisSession);

  // Persisting the whole state blob on every interaction (tab click, split-drag
  // release) means a synchronous JSON.stringify + localStorage write on the main
  // thread each time. Debounce the write so bursts coalesce; React state stays
  // synchronous so in-memory consumers never see stale data.
  const pendingRef = useRef(null);
  const timerRef = useRef(0);
  const flushNow = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = 0;
    }
    const next = pendingRef.current;
    if (next == null) return;
    pendingRef.current = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (err) {
      console.warn("Pluto's Terminals: localStorage write failed", err);
    }
  }, []);

  const save = useCallback(
    (next) => {
      setSt(next);
      pendingRef.current = next;
      // envOverrides / the legacy anthropicKey are read straight from this blob
      // at PTY spawn (TerminalPane) — persist those synchronously so a freshly
      // opened tab can't miss them. Everything else (layout, UI prefs) debounces.
      if (next.anthropicKey !== st.anthropicKey || next.envOverrides !== st.envOverrides) {
        flushNow();
        return;
      }
      if (!timerRef.current) timerRef.current = setTimeout(flushNow, 200);
    },
    [st.anthropicKey, st.envOverrides, flushNow],
  );

  // Flush any pending write before the window goes away (hide → tray, close,
  // reload) so the last interaction survives a relaunch.
  useEffect(() => {
    const onHide = () => flushNow();
    const onVis = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVis);
      flushNow(); // belt-and-suspenders: persist any pending write on teardown
    };
  }, [flushNow]);

  const saveUser = useCallback((next) => {
    setUserSt(next);
    writeUserState(next);
  }, []);

  // One-time migration: the legacy standalone Anthropic key now lives in the
  // Models section as providerKeys.anthropic (single source of truth for keys).
  // Copy it over so existing users see their key in the Models picker and the
  // default-Claude injection keeps working.
  useEffect(() => {
    if (userSt.anthropicKey && !(userSt.providerKeys && userSt.providerKeys.anthropic)) {
      saveUser({
        ...userSt,
        providerKeys: { ...(userSt.providerKeys || {}), anthropic: userSt.anthropicKey },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Optional master-password lock — gate the UI once per launch when set.
  const lockHash = typeof userSt.masterPasswordHash === "string" ? userSt.masterPasswordHash : "";
  if (welcomeDone && lockHash && !unlocked) {
    return <LockScreen expectedHash={lockHash} onUnlock={() => setUnlocked(true)} />;
  }

  if (!welcomeDone) {
    return (
      <>
        <Welcome
          discordUrl={DEFAULT_DISCORD_URL}
          onContinue={() => {
            saveUser({ ...userSt, welcomeDone: true });
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

const WELCOME_FEATURES = [
  { k: "Ask AI", d: "Describe it in plain English → a reviewable shell command." },
  { k: "16 providers", d: "Claude · GPT · Gemini · GLM · Kimi · Qwen · any endpoint." },
  { k: "Workspaces", d: "Save & restore whole panel / tab / split layouts." },
];

function Welcome({ discordUrl, onContinue }) {
  return (
    <div
      style={{
        height: "100vh",
        // Atmospheric depth: a soft azure glow from above over the deep page,
        // plus a faint hairline grid — texture instead of a flat black field.
        background:
          "radial-gradient(1100px 520px at 50% -8%, rgba(77,163,255,0.10), transparent 62%)," +
          "linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px) 0 0 / 100% 40px," +
          "var(--phn-page-bg, #0B0C0E)",
        color: "var(--phn-text-active, #F2F4F7)",
        fontFamily: "var(--phn-ui-font)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--phn-sp-6)",
      }}
    >
      <div style={{ maxWidth: 600, width: "100%" }}>
        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", marginBottom: "var(--phn-sp-2)" }}>
          <span style={{ color: "var(--phn-link)", fontSize: 26, lineHeight: 1 }}>⬢</span>
          <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--phn-text-active)" }}>
            Pluto's Terminal
          </span>
        </div>
        <div style={{ color: "var(--phn-text-dim)", fontSize: "var(--phn-fs-base)", marginBottom: "var(--phn-sp-6)" }}>
          The AI-native multi-terminal — run agents in parallel, route any model, ship faster.
        </div>

        <p style={{ color: "var(--phn-text-fg)", fontSize: "var(--phn-fs-base)", lineHeight: "var(--phn-lh)", marginBottom: "var(--phn-sp-5)" }}>
          A free, open-source terminal for the <strong style={{ color: "var(--phn-text-active)" }}>Pluto community</strong>.
          Run Claude Code, Codex and other agents side by side — each in its own git worktree, pointed at
          {" "}<strong style={{ color: "var(--phn-text-active)" }}>any model you like</strong>.
        </p>

        {/* Feature highlights */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--phn-sp-2)", marginBottom: "var(--phn-sp-6)" }}>
          {WELCOME_FEATURES.map((f) => (
            <div
              key={f.k}
              style={{
                padding: "var(--phn-sp-3)", borderRadius: "var(--phn-r-md)",
                background: "var(--phn-surface-bg)", border: "1px solid var(--phn-surface-border)",
              }}
            >
              <div style={{ color: "var(--phn-link)", fontSize: "var(--phn-fs-sm)", fontWeight: 600, marginBottom: "var(--phn-sp-1)" }}>{f.k}</div>
              <div style={{ color: "var(--phn-text-dim)", fontSize: "var(--phn-fs-xs)", lineHeight: "var(--phn-lh-tight)" }}>{f.d}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: "var(--phn-sp-3)", alignItems: "center", marginBottom: "var(--phn-sp-5)" }}>
          <button
            onClick={() => onContinue()}
            style={{
              background: "var(--phn-link)", border: "1px solid var(--phn-link)", color: "var(--phn-accent-fg)",
              padding: "11px 30px", borderRadius: "var(--phn-r-md)", fontFamily: "var(--phn-ui-font)",
              fontSize: "var(--phn-fs-md)", fontWeight: 600, cursor: "pointer",
            }}
          >
            Enter →
          </button>
          <button
            onClick={() => openExternal(discordUrl)}
            style={{
              background: "transparent", border: "1px solid var(--phn-surface-border)", color: "var(--phn-text-fg)",
              padding: "11px 20px", borderRadius: "var(--phn-r-md)", fontFamily: "var(--phn-ui-font)",
              fontSize: "var(--phn-fs-sm)", cursor: "pointer",
            }}
          >
            Join the Pluto Discord
          </button>
        </div>

        <div style={{ color: "var(--phn-text-dim)", fontSize: "var(--phn-fs-xs)", lineHeight: "var(--phn-lh)", marginBottom: "var(--phn-sp-5)" }}>
          First time? You'll also need <strong style={{ color: "var(--phn-text-fg)" }}>Node.js</strong> + the{" "}
          <strong style={{ color: "var(--phn-text-fg)" }}>Claude Code CLI</strong> for{" "}
          <code style={{ background: "var(--phn-surface-bg)", padding: "1px 5px", borderRadius: "var(--phn-r-sm)", fontFamily: "var(--phn-mono-font)", fontSize: "var(--phn-fs-2xs)" }}>claude</code>{" "}
          to run in a tab — the header's <strong style={{ color: "var(--phn-text-fg)" }}>🚀 setup</strong> has a guided checklist.
        </div>

        <div style={{ color: "var(--phn-text-faint)", fontSize: "var(--phn-fs-2xs)", fontFamily: "var(--phn-mono-font)" }}>
          v{APP_VERSION} · github.com/plutothedev/plutos-terminals · MIT
        </div>
      </div>
    </div>
  );
}
