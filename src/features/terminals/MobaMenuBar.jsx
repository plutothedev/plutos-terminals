// (C)
// Classic MobaXterm-style menu bar. `menus` is an array of
// { label, items: [{ label, action, shortcut?, disabled?, divider? }] }.
// Click a top label to open; hovering siblings while one is open switches menus
// (classic menu-bar behavior); click-outside or pick an item closes.
import { useEffect, useRef, useState } from "react";
import { formatCombo } from "./keybindings.js";
import "./terminals.css";

export default function MobaMenuBar({ menus, brand, right }) {
  const [open, setOpen] = useState(null); // open menu index, or null
  const ref = useRef(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(null);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="moba-menubar" ref={ref}>
      {brand && <div className="moba-menubar-brand">{brand}</div>}
      {menus.map((menu, i) => (
        <div key={menu.label} className="moba-menu">
          <button
            className={open === i ? "moba-menu-btn active" : "moba-menu-btn"}
            onClick={() => setOpen(open === i ? null : i)}
            onMouseEnter={() => { if (open !== null) setOpen(i); }}
          >
            {menu.label}
          </button>
          {open === i && (
            <div className="moba-menu-dropdown">
              {menu.items.map((it, j) =>
                it.divider ? (
                  <div key={j} className="moba-menu-divider" />
                ) : (
                  <button
                    key={j}
                    className="moba-menu-item"
                    disabled={it.disabled}
                    onClick={() => { setOpen(null); it.action?.(); }}
                  >
                    <span>{it.label}</span>
                    {/* Shortcuts are authored canonically ("Ctrl+K"); formatCombo
                        renders them per-platform (Ctrl+K here, ⌘K on mac). */}
                    {it.shortcut && <span className="moba-menu-shortcut">{formatCombo(it.shortcut)}</span>}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
      {right && <div className="moba-menubar-right">{right}</div>}
    </div>
  );
}
