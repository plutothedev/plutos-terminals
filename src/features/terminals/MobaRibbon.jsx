// (C)
// MobaXterm-style vertical ribbon down the far-left edge. Each tab toggles a
// docked left panel (Sessions / Tools / Sftp). Clicking the active tab collapses
// the dock. Labels read vertically like MobaXterm's Sessions/Tools/Macros/Sftp.
import "./terminals.css";

const ITEMS = [
  { id: "sessions", label: "Sessions", icon: "🖥" },
  { id: "snippets", label: "Tools", icon: "🛠" },
  { id: "sftp", label: "Sftp", icon: "📁" },
];

export default function MobaRibbon({ active, onSelect }) {
  return (
    <div className="moba-ribbon">
      {ITEMS.map((it) => (
        <button
          key={it.id}
          className={active === it.id ? "moba-ribbon-tab active" : "moba-ribbon-tab"}
          onClick={() => onSelect(active === it.id ? null : it.id)}
          title={it.label}
        >
          <span className="moba-ribbon-icon">{it.icon}</span>
          <span className="moba-ribbon-label">{it.label}</span>
        </button>
      ))}
    </div>
  );
}
