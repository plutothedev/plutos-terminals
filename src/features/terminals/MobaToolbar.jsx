// (C)
// MobaXterm-style grouped icon toolbar. Replaces the old flat .phn-header
// button row with big icon-over-label buttons organised into captioned groups
// separated by vertical dividers — the signature MobaXterm toolbox strip.
//
// Props:
//   brand   — optional node shown flush-left (app mark).
//   groups  — [{ caption, items: [{ id, icon, label, title?, onClick,
//                                   active?, disabled?, menu? }] }]
//             An item with `menu: [{ id, label, icon?, onClick }]` opens a small
//             dropdown (reusing the .moba-menu-dropdown style) instead of firing
//             onClick directly — e.g. Split → Side by side / Stacked.
//   right   — optional node pinned to the right edge (e.g. the cost chip).
// Colors come from the active skin's --phn-* vars so every skin themes it.
import { Fragment, useEffect, useRef, useState } from "react";
import "./terminals.css";

export default function MobaToolbar({ brand, groups = [], right }) {
  // Which item's dropdown is open (by item id), or null.
  const [openId, setOpenId] = useState(null);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!openId) return;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpenId(null); };
    const onKey = (e) => { if (e.key === "Escape") setOpenId(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [openId]);

  const button = (it) => (
    <button
      className={it.active ? "moba-tool-btn active" : "moba-tool-btn"}
      onClick={(e) => {
        if (it.menu) { setOpenId((cur) => (cur === it.id ? null : it.id)); }
        else { setOpenId(null); it.onClick?.(e); }
      }}
      disabled={it.disabled}
      title={it.title || it.label}
    >
      <span className="moba-tool-icon" style={it.color ? { color: it.color } : undefined}>{it.icon}</span>
      <span className="moba-tool-label">{it.label}{it.menu ? " ▾" : ""}</span>
    </button>
  );

  return (
    <div className="moba-toolbar" ref={rootRef}>
      {brand && <div className="moba-toolbar-brand">{brand}</div>}
      {groups.map((g, gi) => (
        <div className="moba-tool-group" key={g.caption || gi}>
          <div className="moba-tool-btns">
            {g.items.map((it) => (
              it.menu ? (
                // Dropdown items need a relative anchor for the popover; this is
                // the only kind that gets a wrapper (a Fragment keeps plain
                // buttons as direct flex children, so their layout is unchanged).
                <div key={it.id} style={{ position: "relative", display: "flex" }}>
                  {button(it)}
                  {openId === it.id && (
                    <div className="moba-menu-dropdown" role="menu" style={{ minWidth: 180 }}>
                      {it.menu.map((m) => (
                        <button
                          key={m.id || m.label}
                          className="moba-menu-item"
                          onClick={(e) => { setOpenId(null); m.onClick?.(e); }}
                        >
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            {m.icon && <span style={{ display: "inline-flex" }}>{m.icon}</span>}
                            {m.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <Fragment key={it.id}>{button(it)}</Fragment>
              )
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
