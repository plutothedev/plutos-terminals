// (C)
// Backend transport seam. Every invoke()/listen() in the app imports from here
// (via the "@backend" alias) instead of directly from @tauri-apps — so the SAME
// React bundle can run two ways:
//   • Desktop (Tauri webview): delegate to the real Tauri IPC.
//   • Phone/web companion (no Tauri): route over the companion WebSocket.
// This is the foundation of the remote-control companion — see
// docs/phone-companion-design.md.
//
// Phase 1a (this commit): the Tauri path only, so desktop behaviour is byte-for-
// byte unchanged. The WebSocket transport is added in Phase 1d behind isTauri();
// it's imported lazily so it never loads inside the desktop app.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

// True inside the Tauri desktop webview; false in a plain browser (the companion).
export function isTauri() {
  return typeof window !== "undefined" && !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
}

// Invoke a backend command. Same signature/return (a Promise) as Tauri's invoke.
export function invoke(cmd, args) {
  // Phase 1d will branch to the WS transport when !isTauri(). For now, Tauri only.
  return tauriInvoke(cmd, args);
}

// Subscribe to a backend event channel (e.g. "pty://<id>"). Returns a Promise of
// an unlisten function, matching Tauri's listen contract.
export function listen(channel, handler) {
  return tauriListen(channel, handler);
}
