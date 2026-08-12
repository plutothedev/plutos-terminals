// (C)
// Independent, zero-coupling mount-time effects lifted verbatim out of the
// TerminalsTab god component: OS/module probes + subscriptions that feed the
// status bar / chrome. None touch the workspace tree (state.panels) or
// persist(), so extracting them shrinks TerminalsTab with zero behavior change.

import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@backend";
import * as recording from "../recording.js";
import { subscribeBridge, getBridgeVersion } from "../ptyBridge.js";
import { injectHeaderSkinsCss } from "../headerSkins";

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

// Basename of the shell new tabs spawn (e.g. "zsh"/"pwsh.exe") — fetched once.
export function useShellName() {
  const [shellName, setShellName] = useState(null);
  useEffect(() => {
    let cancelled = false;
    invoke("default_shell")
      .then((s) => { if (!cancelled && typeof s === "string") setShellName(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return shellName;
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

// Force a re-render when any terminal's dimensions change (the status bar reads
// getTabDims on render), via useSyncExternalStore (#27) instead of a bespoke
// bump-state effect. Returns the live bridge version so a caller that also
// needs a change-token (e.g. a memo dep) doesn't need its own subscription.
export function useDimsListener() {
  return useSyncExternalStore(subscribeBridge, getBridgeVersion);
}

// Inject the header-skin CSS once on mount (idempotent inside injectHeaderSkinsCss).
export function useHeaderSkinSetup() {
  useEffect(() => {
    injectHeaderSkinsCss();
  }, []);
}
