// (C)
// Right-dock system Monitor — live CPU / MEM / DISK gauges (from the same
// sysStats poll the status bar uses) plus a list of every open session/tab with
// its activity state. Read-only; no extra polling of its own.

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

const DOT = { active: "#4FB8E6", done: "#6FB85C", idle: "#586068" };

export default function DockMonitor({ sysStats, panels, activities }) {
  const sessions = [];
  (panels || []).forEach((pan) =>
    (pan.tabs || []).forEach((t) => sessions.push(t))
  );
  return (
    <div className="phn-monitor">
      <div className="phn-mon-sec">System</div>
      {sysStats ? (
        <>
          <Gauge label="CPU" value={`${Math.round(sysStats.cpu)}%`} pct={sysStats.cpu} />
          <Gauge
            label="MEM"
            value={`${(sysStats.mem_used / 1e9).toFixed(1)} / ${(sysStats.mem_total / 1e9).toFixed(0)} G`}
            pct={(sysStats.mem_used / sysStats.mem_total) * 100}
          />
          <Gauge label="DISK" value={`${Math.round(sysStats.disk_used_pct)}%`} pct={sysStats.disk_used_pct} />
        </>
      ) : (
        <div className="phn-mon-empty">Collecting stats…</div>
      )}

      <div className="phn-mon-sec">Sessions · {sessions.length}</div>
      {sessions.length === 0 ? (
        <div className="phn-mon-empty">No open sessions.</div>
      ) : (
        sessions.map((s) => {
          const st = activities?.[s.id] || "idle";
          const kind = s.home ? "home" : s.worktree ? "agent" : s.rdp ? "rdp" : s.vnc ? "vnc" : s.connection ? "ssh" : s.serial ? "serial" : "local";
          return (
            <div key={s.id} className="phn-mon-row" title={`${s.label} — ${st}`}>
              <span className="dot" style={{ background: DOT[st] || DOT.idle }} />
              <span className="nm">{s.label}</span>
              <span className="kind">{kind}</span>
              <span className="st">{st}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
