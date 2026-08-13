// (C)
// MobaXterm-style session launch screen. Rendered as the content of a "home"
// tab (tab.home === true) instead of a PTY-backed terminal. Shows a big "Start
// local terminal" button, quick-launch protocol cards, and a grid of saved
// sessions. All actions are delegated through the `api` object passed down from
// TerminalsTab (start a shell in-place, open a saved session, open a modal).
import "./terminals.css";
import { SLocal, SSsh, SMouse, SWindows, SSerial } from "./toolbarIcons.jsx";
import { useProjectRollups } from "./activityStore.js";

const QUICK = [
  { id: "local", icon: <SLocal size={22} />, label: "Local shell", desc: "Start a shell here" },
  { id: "ssh", icon: <SSsh size={22} />, label: "SSH", desc: "Connect to a host" },
  { id: "vnc", icon: <SMouse size={22} />, label: "VNC", desc: "Remote desktop" },
  { id: "rdp", icon: <SWindows size={22} />, label: "RDP", desc: "Windows desktop" },
  { id: "serial", icon: <SSerial size={22} />, label: "Serial", desc: "USB / UART console" },
];

export default function MobaHomeScreen({ panelId, tabId, api }) {
  const projects = api?.projects || [];
  // Direct store subscription (P2-T1): home tabs are the only mount, and
  // keeping rollups out of homeApi keeps agent flips from churning that
  // object's identity through every panel.
  const acts = useProjectRollups();

  const onQuick = (id) => {
    if (id === "local") api?.startLocal?.(panelId, tabId);
    else if (id === "ssh") api?.newSession?.();
    else if (id === "vnc") api?.vnc?.();
    else if (id === "rdp") api?.rdp?.();
    else if (id === "serial") api?.serial?.();
  };

  return (
    <div className="moba-home">
      <div className="moba-home-inner">
        <div className="moba-home-brand">⬢ Pluto's Terminal</div>
        <div className="moba-home-tagline">Start a session</div>

        <button className="moba-home-start" onClick={() => api?.startLocal?.(panelId, tabId)}>
          <span className="moba-home-start-icon">▶</span>
          Start local terminal
        </button>

        <div className="moba-home-quick">
          {QUICK.map((q) => (
            <button key={q.id} className="moba-home-card" onClick={() => onQuick(q.id)} title={q.desc}>
              <span className="moba-home-card-icon">{q.icon}</span>
              <span className="moba-home-card-label">{q.label}</span>
              <span className="moba-home-card-desc">{q.desc}</span>
            </button>
          ))}
        </div>

        {projects.length > 0 && (
          <>
            <div className="moba-home-section">Saved sessions</div>
            <div className="moba-home-sessions">
              {projects.slice(0, 16).map((p) => {
                const isRdp = p.type === "rdp" || !!p.rdp;
                const isVnc = p.type === "vnc" || !!p.vnc;
                const ssh = p.type === "ssh" || (p.connection && !p.path && !isRdp && !isVnc);
                const a = acts[p.id];
                const icon = isRdp ? <SWindows size={14} /> : isVnc ? <SMouse size={14} /> : ssh ? <SSsh size={14} /> : <SLocal size={14} />;
                const title = isRdp ? `RDP ${p.rdp?.host || ""}:${p.rdp?.port || 3389}`
                  : isVnc ? `VNC ${p.vnc?.host || ""}:${p.vnc?.port || 5900}`
                  : ssh ? `${p.connection?.user || ""}@${p.connection?.host || ""}:${p.connection?.port || 22}`
                  : (p.path || p.name);
                return (
                  <button
                    key={p.id}
                    className="moba-home-session"
                    onClick={() => api?.openProject?.(panelId, p.id)}
                    title={title}
                  >
                    <span className="moba-home-session-icon">{icon}</span>
                    <span className="moba-home-session-name">{p.name}</span>
                    <span className={"moba-home-session-dot" + (a === "active" ? " active" : a === "done" ? " done" : "")} />
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
