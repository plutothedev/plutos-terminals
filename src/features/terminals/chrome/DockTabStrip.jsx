// (C)
import { SFolder, SAsk, SPulse } from "../toolbarIcons.jsx";

export default function DockTabStrip({ dockTab, setDockTab, collapseDock }) {
  return (
    <div className="moba-rd-tabs">
      {[
        { id: "files", label: "SFTP", icon: <SFolder size={13} /> },
        { id: "assistant", label: "Assistant", icon: <SAsk size={13} /> },
        { id: "monitor", label: "Monitor", icon: <SPulse size={13} /> },
      ].map((t) => (
        <span
          key={t.id}
          className={dockTab === t.id ? "moba-rd-tab active" : "moba-rd-tab"}
          data-tour={`dock-${t.id}`}
          onClick={() => setDockTab(t.id)}
          title={t.label}
        >
          <span style={{ display: "inline-flex" }}>{t.icon}</span> {t.label}
        </span>
      ))}
      <button className="moba-rd-collapse" data-tour="dock-collapse" onClick={() => collapseDock(true)} title="Collapse panel">›</button>
    </div>
  );
}
