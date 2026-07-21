// (C)
import { APP_VERSION, GITHUB_URL, DISCORD_URL, openExternal } from "../../../appMeta.js";
import { SAsk, SBroadcast } from "../toolbarIcons.jsx";
import * as recording from "../recording.js";

export default function StatusBar({
  activeTab,
  activeTabId,
  tabActivities,
  activeDims,
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
  activeModelName,
  claudeAvailable,
}) {
  return (
    <div
      className="phn-statusbar"
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
      {/* LEFT — active session · shell/encoding */}
      {activeTab && (
        <span className="moba-stat" title="Active session · terminal size (columns × rows)">
          <span className="dot" style={{ background: tabActivities[activeTabId] === "active" ? "#4FB8E6" : tabActivities[activeTabId] === "done" ? "var(--phn-success, #5FB87A)" : "var(--phn-text-faint, #586068)" }} />
          {activeTab.label}{activeDims ? <span style={{ opacity: 0.55, marginLeft: 5 }}>{activeDims.cols}×{activeDims.rows}</span> : null}
        </span>
      )}
      <span title="Shell · encoding · line ending" style={{ opacity: 0.8 }}>{shellName || "shell"} · UTF-8 · LF</span>
      {broadcast && (
        <button
          onClick={() => setBroadcastGroupOpen(true)}
          style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", color: "var(--phn-warning)", fontSize: 11, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}
          title="Broadcast (MultiExec) is on. Click to choose target terminals; the MultiExec button toggles it off."
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
      {(activeModelName || claudeAvailable) && (
        <span className="phn-statusbar-active" title="Active model (Models picker)" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <SAsk size={11} /> {activeModelName || "claude"}
        </span>
      )}
      <span style={{ opacity: 0.45 }}>v{APP_VERSION}</span>
      <button
        onClick={() => openExternal(GITHUB_URL)}
        className="phn-statusbar-link"
        style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", font: "inherit" }}
        title="Open repo on GitHub"
      >
        github
      </button>
      <span className="phn-statusbar-divider">·</span>
      <button
        onClick={() => openExternal(DISCORD_URL)}
        style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", color: "var(--phn-text-dim, #9a9da3)", font: "inherit" }}
        title="Join the Pluto Discord"
      >
        discord
      </button>
    </div>
  );
}
