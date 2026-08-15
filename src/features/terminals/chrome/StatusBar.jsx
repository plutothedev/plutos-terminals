// (C)
import { memo } from "react";
import { APP_VERSION, GITHUB_URL, DISCORD_URL, openExternal } from "../../../appMeta.js";
import { SBroadcast } from "../toolbarIcons.jsx";
import * as recording from "../recording.js";

function StatusBar({
  shellName,
  broadcast,
  bcastTargets,
  setBroadcastGroupOpen,
  recordingTabIds,
  activeTabRecording,
  recordingCapHit,
  stopAndSaveRecording,
  onJumpToRecording,
  totalCost,
}) {
  return (
    <div
      className="phn-statusbar"
      data-tour="status-bar"
      style={{
        flexShrink: 0,
        padding: "6px 14px",
        fontSize: 11,
        display: "flex",
        alignItems: "center",
        gap: 14,
        letterSpacing: 0.2,
      }}
    >
      {/* LEFT — shell/indicators. The "session label + cols×rows" cluster was
          removed 2026-08-14 (pluto: noise) — the tab strip already names the
          active session, and dims live in the resize flow itself. */}
      {/* UI-polish pass: the old "· UTF-8 · LF" suffix here was HARDCODED
          decoration (nothing detected it; terminals don't have a file
          encoding) — fake status is worse than no status. */}
      {shellName && (
        <span title="Default shell for new tabs" style={{ opacity: 0.8 }}>{shellName}</span>
      )}
      {broadcast && (
        <button
          onClick={() => setBroadcastGroupOpen(true)}
          style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", color: "var(--phn-warning)", fontSize: 11, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}
          title="Broadcast typing is on. Click to choose target terminals; the Broadcast button toggles it off."
        >
          <SBroadcast size={12} /> broadcast: {bcastTargets ? `${bcastTargets.length} tab${bcastTargets.length === 1 ? "" : "s"}` : "all visible"}
        </button>
      )}
      {recordingTabIds.length > 0 && (
        <button
          onClick={() => {
            if (activeTabRecording) stopAndSaveRecording();
            else if (recordingTabIds[0]) onJumpToRecording(recordingTabIds[0]);
          }}
          style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", color: "var(--phn-danger)", fontSize: 11, fontWeight: 600 }}
          title={recordingCapHit
            ? `Recording hit ${recording.RECORDING_MAX_EVENTS / 1000}k events (memory cap). Save now and start a new recording for further capture.`
            : activeTabRecording
              ? "Click to stop & save the active tab's recording"
              : "Click to switch to the recording tab"}
        >
          {recordingCapHit ? "⚠ rec capped — save" : `● rec${recordingTabIds.length > 1 ? ` (×${recordingTabIds.length})` : ""}`}
        </button>
      )}

      <div style={{ flex: 1 }} />

      {/* RIGHT — cost · model · links (CPU/MEM/DISK live in the Monitor tab) */}
      {(totalCost.cost > 0 || totalCost.tokens > 0) && (
        <span style={{ color: "var(--phn-success)", fontWeight: 600 }} title="Aggregate live spend across all sessions">
          ${totalCost.cost.toFixed(2)}
          {totalCost.tokens > 0 && ` · ${totalCost.tokens >= 1000 ? `${(totalCost.tokens / 1000).toFixed(1)}k` : totalCost.tokens} tok`}
        </span>
      )}
      {/* Model chip lives in the menu bar only (UI-polish pass — it was
          duplicated in both corners, with a misleading "claude" fallback). */}
      <span style={{ opacity: 0.45 }}>v{APP_VERSION}</span>
      <button
        onClick={() => openExternal(GITHUB_URL)}
        className="phn-statusbar-link"
        style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", font: "inherit" }}
        title="Open repo on GitHub"
      >
        GitHub
      </button>
      <span className="phn-statusbar-divider">·</span>
      <button
        onClick={() => openExternal(DISCORD_URL)}
        style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", color: "var(--phn-text-dim, #9a9da3)", font: "inherit" }}
        title="Join the Pluto Discord"
      >
        Discord
      </button>
    </div>
  );
}

export default memo(StatusBar);
