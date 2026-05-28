// (C)
// MobaXterm-style vertical ribbon down the far-left edge. Each tab toggles a
// docked left panel (Sessions / Tools / Sftp). Clicking the active tab collapses
// the dock. Labels read vertically like MobaXterm's Sessions/Tools/Macros/Sftp.
import "./terminals.css";
import { IconStar, IconTools, IconFolder, IconAgents } from "./icons.jsx";

const ITEMS = [
  { id: "sessions", label: "Sessions", icon: <IconStar size={16} /> },
  { id: "agents", label: "Agents", icon: <IconAgents size={16} /> },
  { id: "snippets", label: "Tools", icon: <IconTools size={16} /> },
  { id: "files", label: "Files", icon: <IconFolder size={16} /> },
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
