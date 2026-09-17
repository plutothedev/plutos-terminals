// (C)
// The thin rail a dock leaves behind when it collapses. The collapse side of
// both docks is a real, labelled <button> (ProjectSidebar's moba-tree-collapse,
// DockTabStrip's moba-rd-collapse), and pt:treeCollapsed / pt:dockCollapsed
// persist across restarts, so this expand side has to be reachable from the
// keyboard too, or collapsing once from the keyboard loses the panel for good
// (audit A11Y-02, the half that was still open after Batch C).
//
// A div with role="button" rather than a <button>: the rail is styled as a
// column of chrome, and a UA button box (buttonface fill, outset border,
// centred system font) would repaint it on all fourteen skins. The keyboard
// contract of a button is reproduced by hand: Enter and Space activate, nothing
// else does, and both are swallowed so Space cannot scroll the grid.
import { memo } from "react";

function CollapsedRail({ glyph, label, title, onExpand }) {
  const onKeyDown = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    onExpand();
  };
  return (
    <div
      className="moba-railcol"
      role="button"
      tabIndex={0}
      aria-label={title}
      title={title}
      onClick={onExpand}
      onKeyDown={onKeyDown}
    >
      {glyph}
      {/* The vertical caption is decoration for sighted users; the accessible
          name is the title, which says what pressing it does. */}
      <span className="lbl" aria-hidden="true">{label}</span>
    </div>
  );
}

export default memo(CollapsedRail);
