// (C)
// Single source of truth for the app's localStorage keys + per-window suffixing.
// These literals were previously hand-typed across App.jsx, TerminalPane.jsx,
// TerminalsTab.jsx, SettingsModal.jsx and the AI widgets — and TerminalPane read
// the UNsuffixed state key while App wrote the per-window suffixed one, so a
// detached/secondary window's env + provider overrides were silently dropped at
// PTY spawn. Centralizing the keys here fixes that drift.

import { getCachedSecretKeys } from "./secretVault.js";
import { getLayout, leafIds } from "./splitTree.js";

const STATE_VERSION = "v0";

// Per-window UI/workspace state. The default window uses the bare prefix
// (backward compatible); secondary windows (?w=<id>) get a suffixed key so each
// has independent panels/tabs/skin. The user-level prefs key is shared across
// all windows of the same origin.
export const STATE_KEY_PREFIX = `plutos-terminals:state:${STATE_VERSION}`;
export const USER_STORAGE_KEY = `plutos-terminals:user:${STATE_VERSION}`;

// userSt fields mirrored to the OS keychain and stripped from the plaintext
// localStorage blob once a keychain write is confirmed. ONE canonical list
// (review M10 #3): App.jsx's writeUserState strips these, and userStateMerge
// must special-case them (never timestamp-merge a secret) — a drift between two
// copies of this list would silently reintroduce the stale-secret-wins bug.
export const SECRET_FIELDS = ["providerKeys", "anthropicKey"];

function currentWindowId() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("w") || null;
}

// The per-window state key. Pass a window id explicitly, or omit it to resolve
// from the current window's ?w= param (server-safe via the typeof-window guard).
export function getWindowStorageKey(winId = currentWindowId()) {
  return winId ? `${STATE_KEY_PREFIX}:${winId}` : STATE_KEY_PREFIX;
}

// True in the primary window (no ?w= suffix). The primary window owns shared
// singletons — the phone-companion mirrors, finish notifications, etc. — so
// secondary windows gate those paths on this.
export function isPrimaryWindow() {
  return !currentWindowId();
}

// Every scrollback-owning id currently open in ANY window (default + secondary
// ?w= windows). Used as the KEEP-list for scrollback GC (scrollback_sweep) so a
// live session's history is never reclaimed. Reads each per-window state blob
// straight from localStorage; a window whose blob won't parse simply contributes
// no ids, which is fail-safe (the sweep keeps more, never deletes a wanted file).
//
// TWO shape traps live here, both found by the RDI-2 audit and its re-review:
//
// 1. The workspace tree nests one level down under `terminalsState`:
//    TerminalsTab's persist writes `{ ...prev, terminalsState: next }` and boot
//    reads `st?.terminalsState`. Reading a top-level `st.panels` matched no real
//    blob, so the keep-set was empty on every sweep and the GC degraded to a
//    pure mtime reaper over live tabs' scrollback.
// 2. The unit that owns a scrollback file is a LEAF, not a tab. TerminalPanel
//    renders each leaf with `tabId={node.id}`, TerminalPane spawns that leaf's
//    PTY under it and pty.rs opens `<leaf>.txt`, so a split tab owns N files.
//    Harvesting `t.id` alone left every `pane_*` file unprotected, and also
//    dropped any tab folded in by drag-to-split (moveTabIntoSplit removes the
//    dragged tab from `p.tabs` and grafts its leaf into the target's tree while
//    the PTY keeps running). getLayout/leafIds are imported rather than
//    re-implemented for exactly the reason this function was broken: a second
//    copy of the tree shape is a second thing to drift.
//
// The top-level `st.panels` fallback is NOT protecting live tabs. Nothing in the
// app writes that key except detachTab before RDI-1 was fixed, and those tabs
// were destroyed rather than opened. It stays because this set is a safety
// exclusion, so the errors are asymmetric: over-keeping strands one stale file
// until the blob is rewritten, under-keeping unlinks a live session's history
// out from under its append handle.
export function allOpenTabIds() {
  const ids = [];
  if (typeof window === "undefined") return ids;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(STATE_KEY_PREFIX)) continue;
      let st;
      try { st = JSON.parse(localStorage.getItem(k) || "{}"); } catch { continue; }
      for (const p of st.terminalsState?.panels || st.panels || []) {
        for (const t of p.tabs || []) {
          if (!t || !t.id) continue;
          for (const id of leafIds(getLayout(t))) ids.push(id);
        }
      }
    }
  } catch { /* storage unavailable */ }
  return ids;
}

// Every localStorage key the app writes lives under one of these prefixes:
// "plutos-terminals:" (state/user blobs, cmd history, macros, dismissed-update)
// and "pt:" (dock/tree layout in useDockResize). Factory reset wipes by prefix
// so new keys can't silently escape the reset.
export const ALL_STORAGE_PREFIXES = ["plutos-terminals:", "pt:"];

// Persistence hold. A factory reset clears BOTH copies of the workspace (the
// durable store.json first, then localStorage) and reloads, and App.jsx's
// debounced flush writes both copies too. Two ways that flush lands behind the
// reset and quietly undoes it:
//   1. the 200 ms debounce fires DURING the await on write_store, mirroring the
//      layout straight back into the store.json that was just cleared;
//   2. the reload fires pagehide/beforeunload, and the flush still holds the
//      last debounced layout (a theme preview one click earlier is enough).
// Both end in localStorage empty and store.json populated, which is the exact
// shape boot recovery reads as profile loss and restores from: the reset is
// undone by the window that performed it.
//
// A count, not a flag, for two reasons. The reset takes the hold BEFORE its
// fallible half and releases it if that half fails, because an aborted reset
// wiped nothing and the app has to keep saving. And a test can assert the delta
// without depending on what ran before it.
//
// In memory on purpose. It has to die with the document, because the window
// reloading into a clean profile must persist normally again; a sessionStorage
// flag would survive the reload and disable saving for good.
let writeHolds = 0;
export function localWriteHolds() {
  return writeHolds;
}

export function holdLocalWrites() {
  writeHolds += 1;
  let released = false;
  return () => {
    if (released) return; // releasing twice would hold nothing, forever
    released = true;
    writeHolds -= 1;
  };
}

// Remove every app-owned localStorage key (factory reset). Iterates backwards
// so removal doesn't shift unvisited indices.
export function wipeAllLocalState() {
  if (typeof window === "undefined") return;
  // Taken and never released: this document is on its way out, and a flush
  // landing behind a PARTIAL wipe (the loop below throwing) is the worst of the
  // available outcomes. The reloaded document starts with no holds.
  holdLocalWrites();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && ALL_STORAGE_PREFIXES.some((p) => k.startsWith(p))) {
        localStorage.removeItem(k);
      }
    }
  } catch { /* storage unavailable — nothing to wipe */ }
}

// The ErrorBoundary's "Reset layout & reload" escape hatch (ErrorBoundary.jsx)
// clears ONLY this window's layout key, deliberately leaving the durable
// store.json mirror alone. Boot recovery treats an absent key as recoverable
// (workspaceBoot.js) and the mirror still holds the SAME blob that just crashed
// the app, so the reloaded window would restore its own poison and hand the
// crash loop straight back. Recovery is silent, so nothing would even ask.
//
// The mark carries a FINGERPRINT of the layout that was thrown away
// (workspaceBoot.js/layoutFingerprint), not a bare "do not recover" flag. The
// flag version suppressed the backup READ, and with it the mirror hold, so the
// boot migrations' first flush replaced store.json with their defaults ~200 ms
// later: the crash hatch destroyed the durable backup as well as the local one.
// Naming the layout lets boot refuse THAT one and still restore a different
// backup, which is a real case (a crash can beat the 200 ms debounce, so
// store.json can still hold the last good layout).
//
// It is the ONE deliberate discard boot cannot recognise from the data alone.
// The other, a Settings factory reset, clears store.json itself, so there is no
// backup left to mistake for profile loss and no mark needed.
//
// sessionStorage, not localStorage: it survives location.reload() (same window)
// but dies with the window, so a mark that somehow never gets consumed cannot
// suppress one layout forever. Consumed exactly once, at boot.
export const LAYOUT_DISCARD_KEY = "pt:layout-discarded";

// No fingerprint means there was nothing recognisable to discard (a missing,
// blank or unparseable blob), and an unusable local layout is not what crashed
// the render anyway, so leave no mark and let boot recover normally.
export function markLayoutDiscarded(fingerprint) {
  if (typeof window === "undefined" || !fingerprint) return;
  try { sessionStorage.setItem(LAYOUT_DISCARD_KEY, String(fingerprint)); } catch { /* storage unavailable */ }
}

// The discarded layout's fingerprint, or null. One-shot.
export function takeDiscardedLayout() {
  if (typeof window === "undefined") return null;
  try {
    const fp = sessionStorage.getItem(LAYOUT_DISCARD_KEY);
    if (fp) sessionStorage.removeItem(LAYOUT_DISCARD_KEY);
    return fp || null;
  } catch {
    return null; // storage unavailable: fail toward offering recovery, not away
  }
}

// Shared, fault-tolerant reader for the user-level prefs blob (welcomeDone,
// providerKeys, activeModel, …). Used by the AI widgets and PTY spawn.
//
// API keys (providerKeys / anthropicKey) are stripped from localStorage once
// mirrored to the OS keychain (secretVault), so overlay the in-memory keychain
// cache here — that's the single read path every spawn/AI-widget consumer uses.
// Parse memo (P4-T4): a 20-pane boot called this per pane — N full
// JSON.parses of the same blob. Keyed by the RAW STRING identity: any write
// changes the string, so staleness is impossible; the keychain overlay below
// is NOT memoized (the in-memory secret cache changes independently of
// localStorage and costs no parse).
let ustMemo = { raw: null, parsed: null };
export function readUserSt() {
  if (typeof window === "undefined") return {};
  const raw = localStorage.getItem(USER_STORAGE_KEY) || "{}";
  if (raw !== ustMemo.raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    ustMemo = { raw, parsed };
  }
  const base = ustMemo.parsed;
  const secrets = getCachedSecretKeys();
  return {
    ...base,
    providerKeys: { ...(base.providerKeys || {}), ...(secrets.providerKeys || {}) },
    anthropicKey: secrets.anthropicKey || base.anthropicKey || "",
  };
}

// Same memo treatment for the per-window state blob (P4-T4; the re-verify
// found the second half of the double-parse had NO shared helper — the parse
// was inlined in TerminalPane's spawn path). Returns the SAME parsed object
// across calls — callers read, never mutate. Keyed on (window key, raw).
let winMemo = { key: null, raw: null, parsed: null };
export function readWindowBlob() {
  if (typeof window === "undefined") return null;
  const key = getWindowStorageKey();
  const raw = localStorage.getItem(key);
  if (raw === null) {
    winMemo = { key, raw: null, parsed: null };
    return null;
  }
  if (key !== winMemo.key || raw !== winMemo.raw) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    winMemo = { key, raw, parsed };
  }
  return winMemo.parsed;
}
