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

// Shared, fault-tolerant reader for the user-level prefs blob (welcomeDone,
// providerKeys, activeModel, …). Used by the AI widgets and PTY spawn.
//
// API keys (providerKeys / anthropicKey) are stripped from localStorage once
// mirrored to the OS keychain (secretVault), so overlay the in-memory keychain
// cache here — that's the single read path every spawn/AI-widget consumer uses.
export function readUserSt() {
  if (typeof window === "undefined") return {};
  let base = {};
  try {
    base = JSON.parse(localStorage.getItem(USER_STORAGE_KEY) || "{}");
  } catch {
    base = {};
  }
  const secrets = getCachedSecretKeys();
  return {
    ...base,
    providerKeys: { ...(base.providerKeys || {}), ...(secrets.providerKeys || {}) },
    anthropicKey: secrets.anthropicKey || base.anthropicKey || "",
  };
}
