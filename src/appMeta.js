// (C)
// App-wide metadata + the canonical way to open an external link.
//
// APP_VERSION is sourced from package.json so it never drifts (the status bar,
// welcome screen, and update banner all read this one value).
//
// openExternal: inside a Tauri WKWebView, window.open / <a target="_blank">
// don't reliably reach the system browser (the webview either ignores or
// navigates in-place). Shelling out via the open_path command (open / start /
// xdg-open) is the dependable cross-platform way to open a URL.

import { version } from "../package.json";
import { invoke } from "@tauri-apps/api/core";

export const APP_VERSION = version;
export const GITHUB_URL = "https://github.com/plutothedev/plutos-terminals";
export const DISCORD_URL = "https://discord.gg/3cZQVgKF";

export function openExternal(url) {
  if (!url) return Promise.resolve();
  return invoke("open_path", { path: url }).catch(() => {});
}
