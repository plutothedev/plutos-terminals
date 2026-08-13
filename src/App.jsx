import { useCallback, useEffect, useRef, useState } from "react";
import { APP_VERSION, DISCORD_URL, openExternal } from "./appMeta.js";
import TerminalsTab from "./features/terminals/TerminalsTab.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";
import LockScreen from "./features/terminals/LockScreen.jsx";
import { isUnlockedThisSession } from "./features/terminals/masterPassword.js";
import { destroyAll } from "./features/terminals/paneRegistry.js";
import { USER_STORAGE_KEY, getWindowStorageKey, allOpenTabIds } from "./features/terminals/storageKeys.js";
import { invoke } from "./backend.js";
import {
  migrateAndLoad,
  saveSecretKeys,
  getCachedSecretKeys,
  keychainAvailable,
} from "./features/terminals/secretVault.js";
import { ToastProvider } from "./components/Toast.jsx";
import { ConfirmProvider } from "./components/ConfirmModal.jsx";
import { PromptProvider } from "./components/PromptModal.jsx";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import {
  getLayoutId,
  applyActiveTheme,
  effectiveSkinValue,
  applyGlobalButtonStyle,
  applyGlobalLayout,
} from "./features/terminals/headerSkins.js";
import { useOsDark } from "./features/terminals/hooks/useOsDark.js";
import { configure as configureSync, start as startSync, notifyChange } from "./features/terminals/sync/syncEngine.js";
import { loadMacros, saveMacros, onMacrosChanged } from "./features/terminals/macros.js";
import { isPrimaryWindow } from "./features/terminals/storageKeys.js";

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

// API keys (provider keys + the legacy Anthropic key) are secrets — they are
// mirrored to the OS keychain (secretVault) and stripped from the plaintext
// localStorage blob. Stripping only happens once a keychain write has been
// confirmed (keychainAvailable), so a keychain failure keeps the local copy
// rather than losing the user's keys.
const SECRET_FIELDS = ["providerKeys", "anthropicKey"];

function writeUserState(next) {
  if (typeof window === "undefined") return;
  try {
    saveSecretKeys(next.providerKeys, next.anthropicKey);
    let safe = next;
    if (keychainAvailable()) {
      safe = { ...next };
      for (const f of SECRET_FIELDS) delete safe[f];
    }
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(safe));
  } catch (err) {
    console.warn("Pluto's Terminal: user-state localStorage write failed", err);
  }
}

const DEFAULT_DISCORD_URL = DISCORD_URL;

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <PromptProvider>
          <ErrorBoundary storageKey={STORAGE_KEY}>
            <AppInner />
          </ErrorBoundary>
        </PromptProvider>
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
      console.warn("Pluto's Terminal: localStorage write failed", err);
    }
  }, []);

  // `save` accepts either a whole next-state object or a functional updater
  // (prev => next). Async callers MUST use the functional form: a post-await
  // `save({ ...st, … })` spreads the state captured before the await and
  // silently reverts anything that landed in between (lost update). stRef
  // mirrors the latest committed value so back-to-back saves in one tick
  // compose instead of clobbering; `save` is the only writer of setSt.
  const stRef = useRef(st);
  const save = useCallback(
    (next) => {
      const prev = stRef.current;
      const resolved = typeof next === "function" ? next(prev) : next;
      stRef.current = resolved;
      setSt(resolved);
      pendingRef.current = resolved;
      // sync.enabled lives in the SHARED userSt store, not this per-window blob —
      // gate the cloud-sync trigger on it so st changes (skin/workflows/prompt
      // editor) push only when the user has cloud sync turned on.
      if (isPrimaryWindow() && userStRef.current?.sync?.enabled) notifyChange();
      // envOverrides / the legacy anthropicKey are read straight from this blob
      // at PTY spawn (TerminalPane) — persist those synchronously so a freshly
      // opened tab can't miss them. Everything else (layout, UI prefs) debounces.
      if (resolved.anthropicKey !== prev.anthropicKey || resolved.envOverrides !== prev.envOverrides) {
        flushNow();
        return;
      }
      if (!timerRef.current) timerRef.current = setTimeout(flushNow, 200);
    },
    [flushNow],
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

  // Same object-or-updater contract as `save` (see above). userStRef is also
  // refreshed by the two non-saveUser setUserSt paths (keychain migration,
  // cross-window storage sync) so functional updates never see a stale base.
  const userStRef = useRef(userSt);
  const saveUser = useCallback((next) => {
    const resolved = typeof next === "function" ? next(userStRef.current) : next;
    userStRef.current = resolved;
    setUserSt(resolved);
    writeUserState(resolved);
    if (isPrimaryWindow() && resolved?.sync?.enabled) notifyChange();
  }, []);

  useEffect(() => {
    if (!isPrimaryWindow()) return;            // background sync = primary only
    configureSync({
      getStores: () => ({ userSt: userStRef.current, st: stRef.current, macros: loadMacros() }),
      applyStores: ({ userSt, st, macros }) => {
        if (userSt && Object.keys(userSt).length) saveUser((prev) => ({ ...prev, ...userSt }));
        if (st && Object.keys(st).length) save((prev) => ({ ...prev, ...st }));
        if (macros) saveMacros(macros);
      },
      getRepoUrl: () => userStRef.current?.sync?.repoUrl,
      setStatus: () => {},
    });
    // Macro edits go through saveMacros (not save/saveUser), so subscribe here
    // to push them promptly instead of waiting for the next poll.
    const unsubMacros = onMacrosChanged(() => {
      if (userStRef.current?.sync?.enabled) notifyChange();
    });
    let stopSync;
    if (userStRef.current?.sync?.enabled) stopSync = startSync();
    return () => { unsubMacros(); if (stopSync) stopSync(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // One-time migration (v0.4.3): OLED Black replaces refined-dark "moba" as the
  // default skin. Installs whose stored skin is unset or the old default flip to
  // "oled"; an explicit other choice (light, custom:<id>, legacy skins) is kept.
  useEffect(() => {
    if (!stRef.current.oledDefaultMigrated) {
      save((prev) => ({
        ...prev,
        headerSkin: (prev.headerSkin == null || prev.headerSkin === "moba") ? "oled" : prev.headerSkin,
        oledDefaultMigrated: true,
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Move provider API keys from plaintext localStorage into the OS keychain
  // (secretVault) on boot, then re-persist: writeUserState now strips the keys
  // from localStorage (keychain confirmed), and readUserSt overlays the keychain
  // cache so spawn/AI paths still resolve them. Best-effort: if the keychain is
  // unavailable the keys simply stay in localStorage.
  useEffect(() => {
    migrateAndLoad(userSt.providerKeys, userSt.anthropicKey)
      .then(() => {
        const s = getCachedSecretKeys();
        const merged = {
          ...userSt,
          providerKeys: { ...(userSt.providerKeys || {}), ...s.providerKeys },
          anthropicKey: s.anthropicKey || userSt.anthropicKey || "",
        };
        userStRef.current = merged;
        setUserSt(merged);
        writeUserState(merged); // keychainAvailable() now true → secrets pruned from localStorage
      })
      .catch(() => { /* keychain unavailable — keep localStorage copy */ });
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
          // The persisted blob has secrets stripped (they live in the keychain),
          // so overlay the in-memory keychain cache or this window would lose its
          // provider keys on any cross-window user-state update.
          const parsed = JSON.parse(e.newValue);
          const s = getCachedSecretKeys();
          const merged = {
            ...parsed,
            providerKeys: { ...(parsed.providerKeys || {}), ...(s.providerKeys || {}) },
            anthropicKey: s.anthropicKey || parsed.anthropicKey || "",
          };
          userStRef.current = merged;
          setUserSt(merged);
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

  // Disk GC (primary window only), on boot and then daily: reclaim scrollback
  // files whose tab is no longer open in ANY window AND untouched for 30+ days,
  // and transcript day-folders past their retention window. The scrollback
  // keep-set (every open tab id) is a safety exclusion, so a live tab's history
  // is never swept; best-effort, never blocks boot.
  //
  // It repeats because closing the window HIDES the app to the tray rather than
  // quitting (see lib.rs) — a boot-only sweep never fires again across a
  // weeks-long resident session, which is exactly when the files pile up.
  useEffect(() => {
    if (!isPrimaryWindow()) return;
    const sweep = () => {
      invoke("scrollback_sweep", { keepTabIds: allOpenTabIds() })
        .catch((e) => console.warn("Pluto's Terminal: scrollback sweep failed", e));
      invoke("transcript_sweep", {})
        .catch((e) => console.warn("Pluto's Terminal: transcript sweep failed", e));
    };
    // Deferred off the boot burst (P4-T4): allOpenTabIds() walks + parses
    // every per-window localStorage blob, and GC latency is irrelevant.
    // Feature-detected fallback (audit C3): WKWebView has NO
    // requestIdleCallback — a bare call would ReferenceError and macOS builds
    // would never sweep (unbounded scrollback growth).
    const rIC = window.requestIdleCallback ?? ((cb) => setTimeout(cb, 3000));
    const idle = rIC(sweep, { timeout: 10_000 });
    const id = setInterval(sweep, 24 * 60 * 60 * 1000);
    return () => {
      (window.cancelIdleCallback ?? clearTimeout)(idle);
      clearInterval(id);
    };
  }, []);

  // v4.0 one-time migration: force the "moba" (MobaXterm) LAYOUT once so everyone
  // lands on the new layout. The SKIN is intentionally NOT forced here: the OLED
  // default migration above owns headerSkin, and forcing "moba" would override it and
  // land fresh v0.4.3 installs on the wrong (non-OLED) skin. Only overrides while
  // mobaDefaultForced is unset.
  useEffect(() => {
    if (st?.mobaDefaultForced) return;
    // Functional form: child (TerminalsTab) mount effects run before this parent
    // effect; a spread of the render-time `st` here would clobber their saves.
    save((prev) => ({ ...prev, uiLayout: "moba", mobaDefaultForced: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const osDark = useOsDark();
  const activeSkin = effectiveSkinValue(st, userSt, osDark);
  const layoutId = getLayoutId(st.headerLayout);
  useEffect(() => { applyActiveTheme(activeSkin, userSt.customThemes); }, [activeSkin, userSt.customThemes]);
  useEffect(() => { applyGlobalButtonStyle("bracket"); }, []);
  useEffect(() => { applyGlobalLayout(layoutId); }, [layoutId]);

  const welcomeDone = userSt.welcomeDone === true;

  // Optional master-password lock — gate the UI once per launch when set.
  const lockHash = typeof userSt.masterPasswordHash === "string" ? userSt.masterPasswordHash : "";

  // Locking must kill live sessions, exactly like the pre-registry behavior —
  // a parked PTY behind the password gate could keep auto-approving with zero
  // supervision once the window loses OS focus.
  useEffect(() => {
    if (welcomeDone && lockHash && !unlocked) destroyAll();
  }, [welcomeDone, lockHash, unlocked]);

  if (welcomeDone && lockHash && !unlocked) {
    return <LockScreen expectedHash={lockHash} onUnlock={() => setUnlocked(true)} />;
  }

  if (!welcomeDone) {
    return (
      <>
        <Welcome
          discordUrl={DEFAULT_DISCORD_URL}
          onContinue={() => {
            // Functional form: the keychain migration effect may merge keys into
            // user state between render and this click — don't clobber it.
            saveUser((prev) => ({ ...prev, welcomeDone: true }));
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
          A free, source-available terminal for the <strong style={{ color: "var(--phn-text-active)" }}>Pluto community</strong>.
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
          to run in a tab — the header's <strong style={{ color: "var(--phn-text-fg)" }}>setup</strong> has a guided checklist.
        </div>

        <div style={{ color: "var(--phn-text-faint)", fontSize: "var(--phn-fs-2xs)", fontFamily: "var(--phn-mono-font)" }}>
          v{APP_VERSION} · github.com/plutothedev/plutos-terminals · source-available
        </div>
      </div>
    </div>
  );
}
