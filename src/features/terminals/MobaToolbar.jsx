// (C)
// MobaXterm-style grouped icon toolbar. Replaces the old flat .phn-header
// button row with big icon-over-label buttons organised into captioned groups
// separated by vertical dividers — the signature MobaXterm toolbox strip.
//
// Props:
//   brand   — optional node shown flush-left (app mark).
//   groups  — [{ caption, items: [{ id, icon, label, title?, onClick,
//                                   active?, disabled? }] }]
//   right   — optional node pinned to the right edge (e.g. the cost chip).
// Colors come from the active skin's --phn-* vars so every skin themes it.
import "./terminals.css";

export default function MobaToolbar({ brand, groups = [], right }) {
  return (
    <div className="moba-toolbar">
      {brand && <div className="moba-toolbar-brand">{brand}</div>}
      {groups.map((g, gi) => (
        <div className="moba-tool-group" key={g.caption || gi}>
          <div className="moba-tool-btns">
            {g.items.map((it) => (
              <button
                key={it.id}
                className={it.active ? "moba-tool-btn active" : "moba-tool-btn"}
                onClick={it.onClick}
                disabled={it.disabled}
                title={it.title || it.label}
              >
                <span className="moba-tool-icon">{it.icon}</span>
                <span className="moba-tool-label">{it.label}</span>
              </button>
            ))}
          </div>
          {g.caption && <div className="moba-tool-caption">{g.caption}</div>}
        </div>
      ))}
      <div className="moba-toolbar-spacer" />
      {right}
    </div>
  );
}
