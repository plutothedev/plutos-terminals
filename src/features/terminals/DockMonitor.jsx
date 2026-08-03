// (C)
// Right-dock system Monitor — live CPU / MEM / DISK gauges (from the same
// sysStats poll the status bar uses) plus the agent fleet: every open
// session/tab with its activity state, blocked ones first, under a summary
// line. Read-only; no extra polling of its own.

import { ACTIVITY_RANK, activityCounts } from "./hooks/useTabTelemetry.js";

function loadColor(p) {
  return p < 60 ? "#6FB85C" : p < 85 ? "#E0A93C" : "#E0574A";
}

function Gauge({ label, value, pct }) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return (
    <div className="phn-mon-gauge">
      <div className="phn-mon-gauge-top">
        <span className="lbl">{label}</span>
        <span className="val">{value}</span>
      </div>
      <div className="phn-mon-bar"><i style={{ width: `${p}%`, background: loadColor(p) }} /></div>
    </div>
  );
}

// waiting is amber and leads the legend: it is the only state asking something
// of you. active/done keep their established colours.
const DOT = { waiting: "#E0A93C", active: "#4FB8E6", done: "#6FB85C", idle: "#586068" };

export default function DockMonitor({ sysStats, panels, activities }) {
  const sessions = [];
  (panels || []).forEach((pan) =>
    (pan.tabs || []).forEach((t) => sessions.push(t))
  );
  const counts = activityCounts(sessions, activities);
  // Blocked sessions sort to the top — in a fleet, hunting for the one that
  // needs you defeats the point. Sort is stable, so ties keep tab order.
  const ordered = [...sessions].sort(
    (a, b) =>
      (ACTIVITY_RANK[activities?.[b.id] || "idle"] ?? 0) -
      (ACTIVITY_RANK[activities?.[a.id] || "idle"] ?? 0)
  );
  return (
    <div className="phn-monitor">
      <div className="phn-mon-sec">System</div>
      {sysStats ? (
        <>
          <Gauge label="CPU" value={`${Math.round(sysStats.cpu)}%`} pct={sysStats.cpu} />
          <Gauge
            label="MEM"
            value={sysStats.mem_total > 0 ? `${(sysStats.mem_used / 1e9).toFixed(1)} / ${(sysStats.mem_total / 1e9).toFixed(0)} G` : "—"}
            pct={sysStats.mem_total > 0 ? (sysStats.mem_used / sysStats.mem_total) * 100 : 0}
          />
          <Gauge label="DISK" value={`${Math.round(sysStats.disk_used_pct)}%`} pct={sysStats.disk_used_pct} />
        </>
      ) : (
        <div className="phn-mon-empty">Collecting stats…</div>
      )}

      <div className="phn-mon-sec">Agents · {sessions.length}</div>
      {sessions.length > 0 && (
        <div className="phn-mon-fleet" aria-label="Agent states">
          {[
            ["waiting", "needs you"],
            ["active", "running"],
            ["done", "finished"],
          ].map(([state, label]) =>
            counts[state] > 0 ? (
              <span key={state} className="phn-mon-fleet-item">
                <span className="dot" style={{ background: DOT[state] }} />
                {counts[state]} {label}
              </span>
            ) : null
          )}
          {counts.waiting + counts.active + counts.done === 0 ? (
            <span className="phn-mon-fleet-item phn-mon-fleet-quiet">all idle</span>
          ) : null}
        </div>
      )}
      {sessions.length === 0 ? (
        <div className="phn-mon-empty">No open sessions.</div>
      ) : (
        ordered.map((s) => {
          const st = activities?.[s.id] || "idle";
          const kind = s.home ? "home" : s.worktree ? "agent" : s.rdp ? "rdp" : s.vnc ? "vnc" : s.connection ? "ssh" : s.serial ? "serial" : "local";
          const label = st === "waiting" ? "needs you" : st;
          return (
            <div
              key={s.id}
              className={`phn-mon-row${st === "waiting" ? " is-waiting" : ""}`}
              title={st === "waiting" ? `${s.label} — waiting for your approval` : `${s.label} — ${st}`}
            >
              <span className="dot" style={{ background: DOT[st] || DOT.idle }} />
              <span className="nm">{s.label}</span>
              <span className="kind">{kind}</span>
              <span className="st" style={st === "waiting" ? { color: DOT.waiting } : undefined}>{label}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
