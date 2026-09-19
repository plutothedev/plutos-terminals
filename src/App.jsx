import { useCallback, useEffect, useRef, useState } from "react";
import { APP_VERSION, DISCORD_URL, openExternal } from "./appMeta.js";
import TerminalsTab from "./features/terminals/TerminalsTab.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";
import LockScreen from "./features/terminals/LockScreen.jsx";
import { isUnlockedThisSession } from "./features/terminals/masterPassword.js";
import { destroyAll } from "./features/terminals/paneRegistry.js";
import { USER_STORAGE_KEY, getWindowStorageKey, harvestKeepList, SECRET_FIELDS, takeDiscardedLayout, localWriteHolds } from "./features/terminals/storageKeys.js";
import { parseWorkspace, needsBackupRead } from "./features/terminals/workspaceBoot.js";
import { createWorkspaceMirror } from "./features/terminals/workspaceMirror.js";
import { runBootRecovery } from "./features/terminals/bootRecovery.js";
import { runBootSweep } from "./features/terminals/diskGc.js";
import { invoke } from "./backend.js";
import {
  migrateAndLoad,
  saveSecretKeys,
  getCachedSecretKeys,
  refreshSecretKeys,
  keychainAvailable,
} from "./features/terminals/secretVault.js";
import { ToastProvider, useToast } from "./components/Toast.jsx";
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
import { stampFieldMeta, mergeUserState } from "./features/terminals/userStateMerge.js";

// Per-window state key (default window = bare key; secondary ?w=<id> windows =
// suffixed for independent panels/skin). Resolver + keys live in storageKeys.js
// (single source of truth, shared with TerminalPane/TerminalsTab/SettingsModal).
const STORAGE_KEY = getWindowStorageKey();

// Did this page load follow the ErrorBoundary's "Reset layout & reload"? That
// hatch discards the window layout ON PURPOSE because it crashed the app, and
// store.json still holds the identical blob, so boot must not restore THAT one.
// This is the one deliberate discard boot cannot recognise from the data alone,
// and recovery is silent, so without the mark the escape hatch would hand the
// crash loop straight back with nothing shown.
//
// It is a fingerprint of the discarded layout, not a boolean: it rules out one
// layout instead of the whole backup. The boolean version skipped the backup
// read altogether, which also skipped the mirror hold, so the boot migrations'
// first flush wrote their defaults into store.json ~200 ms later and the crash
// hatch quietly took the durable backup with it. planRecovery does the
// comparison (workspaceBoot.js).
// Read at module scope, not in the useState initializer below: StrictMode
// double-invokes that initializer in dev, and the second call would find the
// one-shot mark already consumed and recover anyway.
const DISCARDED_LAYOUT = takeDiscardedLayout();

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
// rather than losing the user's keys. SECRET_FIELDS is the ONE canonical list
// (imported from storageKeys, shared with userStateMerge — review M10 #3).

// The toast API for writeUserState, which is module-scope and so cannot reach
// toastRef. AppInner wires this in a mount effect (see below); null until then,
// which is before any user action can fail a write.
let toastSink = null;

// Put the plaintext copy back after the keychain refused it. Re-reads the CURRENT
// blob rather than rewriting `next` wholesale, so a newer non-secret write that
// landed during the failed keychain round-trip survives. The restored copy is
// stripped again by the next save that the keychain accepts.
function restoreLocalSecrets(next) {
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    const cur = raw ? JSON.parse(raw) : {};
    for (const f of SECRET_FIELDS) if (next[f] !== undefined) cur[f] = next[f];
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(cur));
  } catch (err) {
    console.warn("Pluto's Terminal: could not restore the local key copy", err);
  }
}

function writeUserState(next) {
  if (typeof window === "undefined") return;
  // Synchronous on the happy path, as before: saveSecretKeys updates the vault's
  // in-memory cache before it returns, so readUserSt resolves the new key at
  // spawn time immediately, and the plaintext copy is stripped in the same tick.
  const pending = saveSecretKeys(next.providerKeys, next.anthropicKey);
  const stripped = keychainAvailable();
  try {
    let safe = next;
    if (stripped) {
      safe = { ...next };
      for (const f of SECRET_FIELDS) delete safe[f];
    }
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(safe));
  } catch (err) {
    console.warn("Pluto's Terminal: user-state localStorage write failed", err);
  }
  // The strip above is a bet on a keychain write that has not happened yet, and
  // the startup probe that justified it never re-runs. Windows Credential
  // Manager caps a credential at 2560 bytes, so a long custom-endpoint token can
  // start failing every write on a machine where the probe passed months ago.
  // The old code swallowed that rejection and claimed it left the local fallback
  // in place; it did not, and the key simply ceased to exist on the next launch.
  // Optional-chained so a test that stubs secretVault with a void saveSecretKeys
  // cannot turn a missing return value into a render-time throw.
  pending?.catch?.((err) => {
    console.warn("Pluto's Terminal: keychain key write failed", err);
    // Both the restore AND the warning belong inside the stripped branch. On a
    // box with no keychain at all (a Linux install with no secret service)
    // nothing is ever stripped and nothing is at risk, but every save still
    // rejects: an unguarded toast turned changing a theme into "Couldn't save
    // your API key", five times over from one settings section alone.
    if (stripped) {
      restoreLocalSecrets(next);
      try {
        toastSink?.error(
          "Couldn't save your API key to the OS keychain. It's being kept on this machine only. Check Credential Manager / Keychain Access.",
        );
      } catch { /* toast best-effort */ }
    }
  });
}

const DEFAULT_DISCORD_URL = DISCORD_URL;

export default function App() {
  return (
    // ErrorBoundary is OUTERMOST on purpose. Nested under the providers it could
    // not catch a throw in a PROVIDER's OWN render (e.g. ToastProvider rendering
    // a non-string toast message), and that throw escaped to the root: blank
    // window, no Reload button, PTYs orphaned. The boundary is a class component
    // that consumes no context (no useToast/useConfirm/usePrompt), so it can sit
    // above them safely; AppInner still sees all three providers.
    <ErrorBoundary storageKey={STORAGE_KEY}>
      <ToastProvider>
        <ConfirmProvider>
          <PromptProvider>
            <AppInner />
          </PromptProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}

function AppInner() {
  // The boot read of the per-window blob, handed to the async recovery effect
  // below. Non-null ONLY when boot came up with no usable layout (missing,
  // blank or garbled: see needsBackupRead) in the PRIMARY window, which is
  // exactly when the durable Rust backup is worth consulting instead of
  // silently living with an empty workspace (audit C2, widened by R-C2-1).
  // Secondary (?w=) windows are ephemeral, never write the backup, and must not
  // restore the primary's layout into themselves.
  const bootReadRef = useRef(null);
  // The durable store.json mirror of this window's blob. It lives in a ref so
  // the []-dep flushNow can reach it without re-minting, and it is created here,
  // above the boot read, because that read has to suspend it before anything
  // else can write. While the recovery below is still reading the backup the
  // mirror is held: otherwise the unconditional boot migrations (OLED skin, moba
  // layout) each fire a save() on the empty fallback and flushNow mirrors those
  // defaults over store.json ~200 ms later, destroying the backup before it is
  // read and then "recovering" the file it just overwrote. workspaceMirror.js
  // owns the rest (secret stripping, and deferring a held write instead of
  // dropping it).
  const mirrorRef = useRef(null);
  if (mirrorRef.current == null) {
    mirrorRef.current = createWorkspaceMirror((data) => {
      invoke("write_store", { data }).catch(() => {});
    });
  }
  const [st, setSt] = useState(() => {
    const boot = parseWorkspace(localStorage.getItem(STORAGE_KEY));
    if (needsBackupRead(boot) && isPrimaryWindow()) {
      bootReadRef.current = boot;
      mirrorRef.current.suspend();
    }
    return boot.state;
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

  // Toast held in a ref so the stable ([]-dep) flushNow can reach it without
  // re-minting on every render.
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const quotaWarnedRef = useRef(false);

  // writeUserState is module-scope (it predates the component and runs from the
  // boot effect), so its failure path reaches the toast through a module-level
  // sink. Wired in an effect, not in the render body: reassigning a module
  // variable during render is a side effect (react-hooks/globals). Nothing is
  // lost by waiting for mount — the earliest write that can fail is an async
  // keychain round-trip. `toast` is memoized in ToastProvider, so this runs once.
  useEffect(() => {
    toastSink = toast;
    return () => { if (toastSink === toast) toastSink = null; };
  }, [toast]);

  // Persisting the whole state blob on every interaction (tab click, split-drag
  // release) means a synchronous JSON.stringify + localStorage write on the main
  // thread each time. Debounce the write so bursts coalesce; React state stays
  // synchronous so in-memory consumers never see stale data.
  const pendingRef = useRef(null);
  const timerRef = useRef(0);
  const flushNow = useCallback(() => {
    // A factory reset (SettingsModal) clears store.json and localStorage and
    // then reloads. This flush writes both of those, and it can still fire twice
    // behind the reset: once from the 200 ms debounce during the write_store
    // round-trip, once from the pagehide/beforeunload handler below as the
    // reload starts. Either one repopulates the pair, and the window undoes its
    // own factory reset. Nothing here is worth saving into a profile that is
    // being wiped (storageKeys.js/holdLocalWrites).
    //
    // Clear the debounce id BEFORE that hold check, never after. By the time
    // flushNow runs its timer has already fired, so the id is dead either way,
    // and `save` below only arms a new one while timerRef is falsy. Returning
    // early with a stale id still set therefore wedges the scheduler for the
    // life of the window: every later save updates state and pendingRef but
    // never schedules a flush again. Reachable today through the factory-reset
    // hold, which is released when write_store fails, leaving the app running
    // and telling the user "nothing was wiped" while it has silently stopped
    // persisting anything.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = 0;
    }
    if (localWriteHolds() > 0) return;
    const next = pendingRef.current;
    if (next == null) return;
    pendingRef.current = null;
    let json;
    try {
      json = JSON.stringify(next);
      localStorage.setItem(STORAGE_KEY, json);
    } catch (err) {
      console.warn("Pluto's Terminal: localStorage write failed", err);
      // Quota exceeded (big workspace + many custom themes) silently stops ALL
      // further persistence — surface it ONCE so it's discoverable (audit M11).
      if (!quotaWarnedRef.current) {
        quotaWarnedRef.current = true;
        try { toastRef.current?.error("Storage is full. Layout changes may stop saving. Trim custom themes or saved workspaces."); } catch { /* toast best-effort */ }
      }
    }
    // Durable mirror to the atomic Rust store (audit C2): localStorage is the
    // only home for the layout, so a WebView2 profile corruption would lose it
    // with no backup. Primary window only — secondary windows are ephemeral and
    // would clobber each other's copy in the single store.json. Secret stripping
    // and the boot-time hold live in workspaceMirror.js; note that `next` has
    // already been consumed out of pendingRef above, so a write the mirror
    // cannot take right now is the mirror's to remember, not ours.
    if (json != null && isPrimaryWindow()) mirrorRef.current.write(next);
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

  // Boot recovery (audit C2, widened by R-C2-1): if boot came up with no usable
  // layout, try the durable Rust backup before living with an empty one. Async
  // (read_store is an IPC round-trip) so it runs here, not in the sync init.
  // The whole sequence lives in bootRecovery.js, where its branches are under
  // test; this effect only supplies the collaborators. (`toast` is declared
  // above, near flushNow.)
  //
  // Deliberately NO cancelled-flag, unlike the listener effects (invariant 4).
  // StrictMode double-invokes mount effects, and a one-shot boot read whose own
  // cleanup cancels its result never applies it under `tauri dev` at all: pass 1
  // is cancelled by the simulated unmount, pass 2 is short-circuited by the
  // guard. ranRef keeps this to exactly one read_store per mount instead, and
  // there is no listener here to leak.
  const recoveryRanRef = useRef(false);
  // Published so the disk GC below can wait for the restore to LAND before it
  // harvests its keep-list (diskGc.js). Stays null when recovery never ran,
  // which is the common case (the layout parsed) and means there is nothing to
  // wait for. It never rejects: the catch is inside the promise.
  const recoveryDoneRef = useRef(null);
  useEffect(() => {
    const boot = bootReadRef.current;
    if (!boot || recoveryRanRef.current) return;
    recoveryRanRef.current = true;
    recoveryDoneRef.current = (async () => {
      try {
        await runBootRecovery({
          boot,
          readStore: () => invoke("read_store"), // resolves "null" when there is no backup file
          mirror: mirrorRef.current,
          save,
          getState: () => stRef.current,
          toast,
          discarded: DISCARDED_LAYOUT,
        });
      } catch (err) {
        // Nothing in there is expected to throw (it already guards the IPC read
        // and the mirror), but boot must not end on an unhandled rejection. The
        // mirror releases in runBootRecovery's own finally either way.
        console.warn("Pluto's Terminal: boot recovery failed", err);
      } finally {
        bootReadRef.current = null;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Same object-or-updater contract as `save` (see above). userStRef is also
  // refreshed by the two non-saveUser setUserSt paths (keychain migration,
  // cross-window storage sync) so functional updates never see a stale base.
  const userStRef = useRef(userSt);
  const saveUser = useCallback((next) => {
    const prev = userStRef.current;
    const resolved = typeof next === "function" ? next(prev) : next;
    // Stamp per-field write times (audit M10) so a cross-window storage event
    // can merge field-by-field instead of clobbering this window's edits.
    const stamped = stampFieldMeta(prev, resolved, Date.now());
    userStRef.current = stamped;
    setUserSt(stamped);
    writeUserState(stamped);
    if (isPrimaryWindow() && stamped?.sync?.enabled) notifyChange();
  }, []);

  useEffect(() => {
    if (!isPrimaryWindow()) return;            // background sync = primary only
    configureSync({
      getStores: () => ({ userSt: userStRef.current, st: stRef.current, macros: loadMacros() }),
      applyStores: ({ userSt, st, macros }) => {
        // KNOWN follow-up (review M10 #2): saveUser stamps these cloud-pulled
        // fields with Date.now(), not their true cross-device edit time, so in a
        // narrow window a stale remote value could out-timestamp a fresher
        // sibling-window edit. A proper fix threads per-field timestamps from the
        // cloud merge (sync/merge.js fieldMeta) into userSt's _fieldMeta —
        // deferred as a cross-cutting sync change, out of M10's scope.
        if (userSt && Object.keys(userSt).length) saveUser((prev) => ({ ...prev, ...userSt }));
        if (st && Object.keys(st).length) save((prev) => ({ ...prev, ...st }));
        if (macros) saveMacros(macros);
      },
      getRepoUrl: () => userStRef.current?.sync?.repoUrl,
      // The engine's own off switch. Its work is driven by timers that outlive
      // any one render, so it re-reads the LIVE flag on every tick instead of
      // trusting whatever was true when it was configured.
      getEnabled: () => !!userStRef.current?.sync?.enabled,
      setStatus: () => {},
    });
    // Macro edits go through saveMacros (not save/saveUser), so subscribe here
    // to push them promptly instead of waiting for the next poll.
    const unsubMacros = onMacrosChanged(() => {
      if (userStRef.current?.sync?.enabled) notifyChange();
    });
    return () => { unsubMacros(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The poller is keyed on the enabled flag, NOT on mount. Starting it inside
  // the mount-only effect above meant "Disable sync" left the 5-minute poll
  // pulling, merging and pushing with the user's token until the app restarted,
  // and enabling sync after a boot where it was off started nothing at all.
  // Declared after the configure effect so this one's immediate sync (start()
  // runs syncNow() before it polls) always finds a configured engine; the
  // engine gates on getEnabled too, for the stragglers a cleanup can't reach.
  const syncEnabled = !!userSt?.sync?.enabled;
  useEffect(() => {
    if (!isPrimaryWindow() || !syncEnabled) return;
    return startSync();
  }, [syncEnabled]);

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
      if (e.key !== USER_STORAGE_KEY || !e.newValue) return;
      let parsed;
      try { parsed = JSON.parse(e.newValue); } catch { return; }
      // Secrets come from the KEYCHAIN, re-read now — not from this window's own
      // module cache, which is precisely the copy that is stale at this moment.
      // The other window fired this event because it changed something; if what
      // it changed was a provider key, the cache here still holds the value that
      // key just replaced, and overlaying it would show (and later re-write) the
      // rotated-away key. A revoked key that keeps coming back with no
      // explanation is the whole defect.
      //
      // Detached promise, never awaited inline: this is a DOM event handler and
      // a locked keychain can block for as long as the user takes to answer the
      // OS prompt. The merge is computed AFTER the refresh, against the LIVE
      // userStRef, so a second event landing meanwhile is merged in rather than
      // dropped by a stale closure.
      refreshSecretKeys()
        .catch(() => getCachedSecretKeys()) // keychain unreachable: keep what we hold
        .then((s) => {
          // Field-level LWW merge (audit M10): merge the other window's blob
          // onto THIS window's current state per-field by _fieldMeta timestamp,
          // so two windows editing DIFFERENT settings both survive instead of
          // one clobbering the other. mergeUserState carries local's secret
          // fields through untouched; they are replaced below.
          const mergedFields = mergeUserState(userStRef.current, parsed);
          // With a proven keychain it is the sole source of truth, so a key the
          // other window CLEARED disappears here too. Without one the keys still
          // live in the plaintext blob, and the cache only fills its gaps.
          const chainOk = keychainAvailable();
          const merged = {
            ...mergedFields,
            providerKeys: chainOk
              ? { ...(s.providerKeys || {}) }
              : { ...(mergedFields.providerKeys || {}), ...(s.providerKeys || {}) },
            anthropicKey: chainOk
              ? (s.anthropicKey || "")
              : (s.anthropicKey || mergedFields.anthropicKey || ""),
          };
          userStRef.current = merged;
          setUserSt(merged);
        })
        .catch(() => { /* ignore */ });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Inject skin CSS once + apply skin/button-style/layout globally on <html>
  // BEFORE Welcome screen renders so first-launch picks up saved settings.
  // Header buttons are locked to "bracket" terminal-aesthetic style as of
  // v0.1.20 (the picker was removed; one canonical look across all skins).

  // Same idea as toastRef above, for the same reason: it lets the GC effect
  // below keep a `[]` dep array without silently depending on flushNow's
  // identity staying stable (review F4). Updated in an effect rather than during
  // render, which is what react-hooks/refs wants and costs nothing here: useRef
  // seeds it with the first flushNow so the ref is never empty, and the sweep
  // runs on an idle callback well after mount.
  const flushNowRef = useRef(flushNow);
  useEffect(() => { flushNowRef.current = flushNow; }, [flushNow]);

  // Disk GC (primary window only), on boot and then daily: reclaim scrollback
  // files whose tab is no longer open in ANY window AND untouched for 30+ days,
  // and transcript day-folders past their retention window. Best-effort, never
  // blocks boot.
  //
  // The scrollback half is ORDERED, and the ordering is the whole point:
  // harvestKeepList() reads localStorage only, so harvesting it while boot
  // recovery is still awaiting read_store yields an EMPTY keep-list — which
  // protects nothing and reaps every aged file of the very panes recovery is
  // about to restore. runBootSweep awaits recovery, flushes the pending layout
  // write so an adopted backup is actually IN localStorage, harvests, and
  // refuses outright on an empty OR INCOMPLETE keep-list (diskGc.js has the full
  // account; the incomplete case is the two-window one, where the primary's blob
  // is unreadable and a secondary's ids make the list look healthy).
  //
  // transcript_sweep stays a bare invoke: it carries no keep-list at all (only
  // a retention window), so none of the above applies to it and it must keep
  // running even on the boot where the scrollback sweep refuses.
  //
  // It repeats because closing the window HIDES the app to the tray rather than
  // quitting (see lib.rs) — a boot-only sweep never fires again across a
  // weeks-long resident session, which is exactly when the files pile up.
  useEffect(() => {
    if (!isPrimaryWindow()) return;
    const sweep = () => {
      runBootSweep({
        bootSettled: recoveryDoneRef.current,
        flush: flushNowRef.current,
        harvest: harvestKeepList,
        invoke,
      }).catch((e) => console.warn("Pluto's Terminal: scrollback sweep failed", e));
      invoke("transcript_sweep", {})
        .catch((e) => console.warn("Pluto's Terminal: transcript sweep failed", e));
    };
    // Deferred off the boot burst (P4-T4): harvestKeepList() walks + parses
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
    // [] ON PURPOSE, and flushNow is read through a ref to keep it that way
    // (review F4). flushNow is []-dep'd today so the array below was harmless,
    // but it made the mount-once guarantee depend on a fact about ANOTHER hook:
    // if that identity ever started changing, this effect would tear down and
    // re-arm, which re-runs the idle sweep on every re-mint and restarts the
    // 24 h interval from zero each time — a daily GC that never reaches its own
    // deadline. The ref is read inside `sweep`, so each run still gets the
    // current flush.
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
        {isPrimaryWindow() && <UpdateBanner currentVersion={APP_VERSION} />}
      </>
    );
  }

  return (
    <>
      <TerminalsTab st={st} save={save} userSt={userSt} saveUser={saveUser} />
      {/* Primary window only (review): every detached win-* window loads the
          same bundle, so mounting this everywhere meant N update checks and,
          worse, a user with several windows open could click "Install &
          restart" in two of them and launch concurrent installers against the
          same product code. One window owns the update. */}
      {isPrimaryWindow() && <UpdateBanner currentVersion={APP_VERSION} />}
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
