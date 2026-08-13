// (C)
// Single source of truth for the app's localStorage keys + per-window suffixing.
// These literals were previously hand-typed across App.jsx, TerminalPane.jsx,
// TerminalsTab.jsx, SettingsModal.jsx and the AI widgets — and TerminalPane read
// the UNsuffixed state key while App wrote the per-window suffixed one, so a
// detached/secondary window's env + provider overrides were silently dropped at
// PTY spawn. Centralizing the keys here fixes that drift.

import { getCachedSecretKeys } from "./secretVault.js";

const STATE_VERSION = "v0";

// Per-window UI/workspace state. The default window uses the bare prefix
// (backward compatible); secondary windows (?w=<id>) get a suffixed key so each
// has independent panels/tabs/skin. The user-level prefs key is shared across
// all windows of the same origin.
export const STATE_KEY_PREFIX = `plutos-terminals:state:${STATE_VERSION}`;
export const USER_STORAGE_KEY = `plutos-terminals:user:${STATE_VERSION}`;

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

// Every tab id currently open in ANY window (default + secondary ?w= windows).
// Used as the KEEP-list for scrollback GC (scrollback_sweep) so a live tab's
// history is never reclaimed. Reads each per-window state blob straight from
// localStorage; a window whose blob won't parse simply contributes no ids, which
// is fail-safe (the sweep keeps more, never deletes a wanted file).
export function allOpenTabIds() {
  const ids = [];
  if (typeof window === "undefined") return ids;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(STATE_KEY_PREFIX)) continue;
      let st;
      try { st = JSON.parse(localStorage.getItem(k) || "{}"); } catch { continue; }
      for (const p of st.panels || []) {
        for (const t of p.tabs || []) {
          if (t && t.id) ids.push(t.id);
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

// Remove every app-owned localStorage key (factory reset). Iterates backwards
// so removal doesn't shift unvisited indices.
export function wipeAllLocalState() {
  if (typeof window === "undefined") return;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && ALL_STORAGE_PREFIXES.some((p) => k.startsWith(p))) {
        localStorage.removeItem(k);
      }
    }
  } catch { /* storage unavailable — nothing to wipe */ }
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
