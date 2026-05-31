// (C)
// Independent, zero-coupling mount-time effects lifted verbatim out of the
// TerminalsTab god component: OS/module probes + subscriptions that feed the
// status bar / chrome. None touch the workspace tree (state.panels) or
// persist(), so extracting them shrinks TerminalsTab with zero behavior change.

import { useEffect, useState } from "react";
import { invoke } from "@backend";
import * as recording from "../recording.js";
import { onDimsChange } from "../ptyBridge.js";
import { injectHeaderSkinsCss } from "../headerSkins";

// Live system stats (CPU / memory / disk) for the status bar. Polled ~2.5s;
// CPU is a real delta because the backend keeps a persistent System handle.
export function useSystemStats() {
  const [sysStats, setSysStats] = useState(null);
  useEffect(() => {
    let alive = true;
    const poll = () => invoke("system_stats").then((s) => { if (alive) setSysStats(s); }).catch(() => {});
    poll();
    const t = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(t); };
  }, []);
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
// getTabDims on render). Pure subscription; the bump stays a useState here so a
// dims change re-renders the consuming component, exactly as before.
export function useDimsListener() {
  const [, bumpDims] = useState(0);
  useEffect(() => onDimsChange(() => bumpDims((v) => v + 1)), []);
}

// Inject the header-skin CSS once on mount (idempotent inside injectHeaderSkinsCss).
export function useHeaderSkinSetup() {
  useEffect(() => {
    injectHeaderSkinsCss();
  }, []);
}
