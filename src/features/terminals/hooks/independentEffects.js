// (C)
// Independent, zero-coupling mount-time effects lifted verbatim out of the
// TerminalsTab god component: OS/module probes + subscriptions that feed the
// status bar / chrome. None touch the workspace tree (state.panels) or
// persist(), so extracting them shrinks TerminalsTab with zero behavior change.

import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@backend";
import * as recording from "../recording.js";
import {
  subscribeRegistry,
  getRegistryVersion,
} from "../ptyBridge.js";

// Live system stats (CPU / memory / disk) for DockMonitor (its only consumer).
// Polled 5s; CPU is a real delta because the backend keeps a persistent System
// handle.
export function useSystemStats(enabled = true) {
  const [sysStats, setSysStats] = useState(null);
  useEffect(() => {
    // Only poll while the Monitor panel is actually on-screen (caller gates on
    // dock tab AND collapse). Single-flight: a stalled disk stat (network
    // mount) must not queue overlapping ticks behind the backend mutexes.
    if (!enabled) return;
    let alive = true;
    let inFlight = false;
    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      invoke("system_stats")
        .then((s) => { if (alive) setSysStats(s); })
        .catch(() => {})
        .finally(() => { inFlight = false; });
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [enabled]);
  return sysStats;
}

// Friendly display name for a shell binary (UI-polish pass): raw process
// filenames ("pwsh.exe") are a dev artifact — chrome shows the product name,
// the way Windows Terminal does. Unknown shells just lose the ".exe".
const SHELL_NAMES = {
  pwsh: "PowerShell",
  powershell: "Windows PowerShell",
  cmd: "Command Prompt",
  bash: "Bash",
  zsh: "zsh", // official styling is lowercase
  fish: "fish", // ditto
  nu: "Nushell",
  nushell: "Nushell",
};
export function friendlyShellName(raw) {
  if (!raw || typeof raw !== "string") return raw;
  const base = raw.split(/[\\/]/).pop().replace(/\.exe$/i, "");
  return SHELL_NAMES[base.toLowerCase()] || base;
}

// Display name of the shell new tabs spawn ("PowerShell", "zsh") — fetched
// once, prettified at the source so the status bar and the AI prompts
// ("the user's shell is PowerShell") all read the same clean name.
export function useShellName() {
  const [shellName, setShellName] = useState(null);
  useEffect(() => {
    let cancelled = false;
    invoke("default_shell")
      .then((s) => { if (!cancelled && typeof s === "string") setShellName(friendlyShellName(s)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return shellName;
}

// Dynamic window title: the OS titlebar / taskbar / alt-tab mirror the active
// tab, MobaXterm-style ("label - app"). Chrome effect only — the label arrives
// pre-computed, no workspace-tree coupling. document.title covers the browser/
// phone transport; the native titlebar needs an explicit setTitle (Tauri does
// not sync document.title), fetched lazily so non-Tauri transports just skip.
export function formatWindowTitle(label) {
  const l = typeof label === "string" ? label.trim() : "";
  return l ? `${l} - Pluto's Terminal` : "Pluto's Terminal";
}
export function useWindowTitle(label) {
  useEffect(() => {
    const title = formatWindowTitle(label);
    document.title = title;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setTitle(title);
      } catch { /* browser / phone transport — document.title is all we have */ }
    })();
  }, [label]);
}

// Whether the `claude` CLI is on PATH — checked once on mount (informational).
export function useClaudeAvailable() {
  const [claudeAvailable, setClaudeAvailable] = useState(null);
  useEffect(() => {
    let cancelled = false;
    invoke("check_command_version", { name: "claude" })
      .then((v) => { if (!cancelled) setClaudeAvailable(!!v); })
      .catch(() => { if (!cancelled) setClaudeAvailable(false); });
    return () => { cancelled = true; };
  }, []);
  return claudeAvailable;
}

// Recording-module subscription — status-bar indicator + command-palette labels
// update on start/stop; recordingCapHit tracks the MAX_EVENTS auto-stop.
export function useRecordingState() {
  const [recordingTabIds, setRecordingTabIds] = useState(() => recording.activeTabIds());
  const [recordingCapHit, setRecordingCapHit] = useState(() => recording.anyCapped());
  useEffect(() => {
    const unsubscribe = recording.onChange(() => {
      setRecordingTabIds(recording.activeTabIds());
      setRecordingCapHit(recording.anyCapped());
    });
    return unsubscribe;
  }, []);
  return { recordingTabIds, recordingCapHit };
}

// Re-render on PTY REGISTRY changes (pane spawn/death — rare). TerminalsTab's
// companion session-list derivation subscribes here (P2-T5: it used to ride
// the dims channel, paying a full chrome re-render per resize step).
export function useRegistryListener() {
  return useSyncExternalStore(subscribeRegistry, getRegistryVersion);
}

