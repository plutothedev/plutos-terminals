// (C)
import { memo, useRef } from "react";
import { SFolder, SAsk, SPulse } from "../toolbarIcons.jsx";

// Hoisted out of the render so the array (and the three icon elements) are not
// re-minted on every dock re-render; the component is memo'd and this is the
// only thing in it that allocated.
const DOCK_TABS = [
  { id: "files", label: "SFTP", icon: <SFolder size={13} /> },
  { id: "assistant", label: "Assistant", icon: <SAsk size={13} /> },
  { id: "monitor", label: "Monitor", icon: <SPulse size={13} /> },
];

// A11Y-07. These three were click-only <span>s, which left "assistant" and
// "monitor" with NO route at all: unlike "files" they have no F-key, no menu
// entry and no palette command, so a keyboard-only user could never open the
// AI Assistant chat or the CPU/MEM/DISK monitor for the whole session.
//
// They stay <span>s rather than becoming <button>s on purpose. `.moba-rd-tab`
// (headerSkins.css) sets only padding/colour/font-size/border-right/border-top,
// so a UA button box would bring its own buttonface fill, outset left and
// bottom borders and centred system font, repainting the dock on all fourteen
// skins. This change touches no colour and no CSS: role + aria-selected +
// roving tabIndex + key handling is the whole of it.
//
// The collapse control is a real <button> and therefore a non-tab child of the
// tablist. Same compromise as the terminal strip's new-tab +: it is exposed as
// a named button rather than dropped from the a11y tree, because `margin-left:
// auto` inside this flex row is what pins it to the right edge.
function DockTabStrip({ dockTab, setDockTab, collapseDock }) {
  const stripRef = useRef(null);
  // Roving tabIndex: exactly one dock tab in the document tab order. Falls back
  // to the first tab if dockTab is ever a value outside this list, so the strip
  // can never end up with no tab stop.
  const selected = DOCK_TABS.findIndex((t) => t.id === dockTab);
  const rovingIdx = selected >= 0 ? selected : 0;

  const focusTabAt = (i) => {
    stripRef.current?.querySelectorAll('[role="tab"]')[i]?.focus();
  };

  const onTabKeyDown = (i) => (e) => {
    let next = null;
    switch (e.key) {
      case "ArrowRight": next = (i + 1) % DOCK_TABS.length; break;
      case "ArrowLeft": next = (i - 1 + DOCK_TABS.length) % DOCK_TABS.length; break;
      case "Home": next = 0; break;
      case "End": next = DOCK_TABS.length - 1; break;
      case "Enter":
      case " ":
        // A <span role="tab"> gets no synthetic click from Enter the way a
        // <button> would, and Space would scroll the dock body.
        e.preventDefault();
        e.stopPropagation();
        setDockTab(DOCK_TABS[i].id);
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    setDockTab(DOCK_TABS[next].id);
    focusTabAt(next);
  };

  return (
    <div className="moba-rd-tabs" role="tablist" aria-label="Side panel" aria-orientation="horizontal" ref={stripRef}>
      {DOCK_TABS.map((t, i) => (
        <span
          key={t.id}
          className={dockTab === t.id ? "moba-rd-tab active" : "moba-rd-tab"}
          role="tab"
          aria-selected={dockTab === t.id}
          aria-label={t.label}
          tabIndex={i === rovingIdx ? 0 : -1}
          data-tour={`dock-${t.id}`}
          onClick={() => setDockTab(t.id)}
          onKeyDown={onTabKeyDown(i)}
          title={t.label}
        >
          <span aria-hidden="true" style={{ display: "inline-flex" }}>{t.icon}</span> {t.label}
        </span>
      ))}
      <button className="moba-rd-collapse" data-tour="dock-collapse" onClick={() => collapseDock(true)} title="Collapse panel" aria-label="Collapse side panel">›</button>
    </div>
  );
}

export default memo(DockTabStrip);
