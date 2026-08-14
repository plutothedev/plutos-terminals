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
//             onClick directly — e.g. Split → Side by side / Stacked. The dropdown
//             is PORTALED to <body> and positioned with the button's rect, so the
//             toolbar's overflow-x:auto (which forces overflow-y to clip) can't
//             cut it off behind the tabs below.
//   right   — optional node pinned to the right edge (e.g. the cost chip).
// Colors come from the active skin's --phn-* vars so every skin themes it.
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./terminals.css";

export default function MobaToolbar({ brand, groups = [], right }) {
  // Which item's dropdown is open (by item id) + the button rect to anchor it.
  const [openId, setOpenId] = useState(null);
  const [anchor, setAnchor] = useState(null); // { left, bottom }
  const menuRef = useRef(null);
  useEffect(() => {
    if (!openId) return;
    const close = () => setOpenId(null);
    const onDown = (e) => {
      if (menuRef.current && menuRef.current.contains(e.target)) return; // click inside the menu
      close();
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // Position is captured on open; a scroll/resize would move the anchor, so close.
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [openId]);

  const toggle = (it, e) => {
    if (openId === it.id) { setOpenId(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    setAnchor({ left: r.left, bottom: r.bottom });
    setOpenId(it.id);
  };

  const button = (it) => (
    <button
      className={it.active ? "moba-tool-btn active" : "moba-tool-btn"}
      data-tour={it.id}
      onClick={(e) => { if (it.menu) toggle(it, e); else { setOpenId(null); it.onClick?.(e); } }}
      disabled={it.disabled}
      title={it.title || it.label}
    >
      <span className="moba-tool-icon" style={it.color ? { color: it.color } : undefined}>{it.icon}</span>
      <span className="moba-tool-label">{it.label}{it.menu ? " ▾" : ""}</span>
    </button>
  );

  return (
    <div className="moba-toolbar">
      {brand && <div className="moba-toolbar-brand">{brand}</div>}
      {groups.map((g, gi) => (
        <div className="moba-tool-group" key={g.caption || gi}>
          <div className="moba-tool-btns">
            {g.items.map((it) => <Fragment key={it.id}>{button(it)}</Fragment>)}
          </div>
          {g.caption && <div className="moba-tool-caption">{g.caption}</div>}
        </div>
      ))}
      <div className="moba-toolbar-spacer" />
      {right}

      {/* Portaled dropdown — escapes the toolbar's overflow clip. */}
      {openId && anchor && createPortal(
        (() => {
          const item = groups.flatMap((g) => g.items).find((it) => it.id === openId);
          if (!item?.menu) return null;
          return (
            <div
              ref={menuRef}
              className="moba-menu-dropdown"
              role="menu"
              style={{ position: "fixed", top: anchor.bottom, left: anchor.left, minWidth: 180, zIndex: 1000 }}
            >
              {item.menu.map((m) => (
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
          );
        })(),
        document.body
      )}
    </div>
  );
}
