// (C)
// Pure zone math for drag-a-tab-onto-a-pane splitting (VS Code-style drop
// zones). The DOM drag in TerminalPanel feeds cursor + pane rect in; these
// decide which edge the user means, how that maps onto splitLeaf's arguments,
// and what preview rectangle to draw. Kept DOM-free so vitest covers every
// corner case the mouse can produce.

// Fraction of each pane dimension that counts as an edge band. Inside a band
// the drop splits toward that edge; the middle stays "center" (= the existing
// move-tab-to-panel behavior).
export const EDGE_BAND = 0.28;

/**
 * Where inside `rect` the cursor is, as a drop zone.
 * @returns {"left"|"right"|"top"|"bottom"|"center"|null} null when outside
 * the rect or the rect is degenerate. Corners resolve to the NEAREST edge.
 */
export function dropZone(x, y, rect) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const dLeft = fx;
  const dRight = 1 - fx;
  const dTop = fy;
  const dBottom = 1 - fy;
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min > EDGE_BAND) return "center";
  if (min === dLeft) return "left";
  if (min === dRight) return "right";
  if (min === dTop) return "top";
  return "bottom";
}

/** Zone → splitLeaf arguments; null for center/invalid (no split). */
export function zoneToSplit(zone) {
  switch (zone) {
    case "left": return { dir: "row", newFirst: true };
    case "right": return { dir: "row", newFirst: false };
    case "top": return { dir: "col", newFirst: true };
    case "bottom": return { dir: "col", newFirst: false };
    default: return null;
  }
}

/** Zone → the preview overlay's geometry (percent strings of the pane box). */
export function zonePreviewRect(zone) {
  switch (zone) {
    case "left": return { left: "0%", top: "0%", width: "50%", height: "100%" };
    case "right": return { left: "50%", top: "0%", width: "50%", height: "100%" };
    case "top": return { left: "0%", top: "0%", width: "100%", height: "50%" };
    case "bottom": return { left: "0%", top: "50%", width: "100%", height: "50%" };
    default: return null;
  }
}
