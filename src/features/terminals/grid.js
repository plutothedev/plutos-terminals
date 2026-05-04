// Auto-grid sizing for the Terminals tab.
//
// Mirrors Moon Dev's layout: 1 fills the area, 2 split horizontally, 3 in a
// row, 4 as 2x2 (preferred over 4-in-a-row), 5-6 in a 3x2 grid, 7-8 in 4x2.
// Hard cap at 8 panels — past that you can't read any of them anyway.

export const MAX_PANELS = 8;

export function gridDims(count, fourPanelMode) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count === 3) return { cols: 3, rows: 1 };
  if (count === 4) return fourPanelMode === "row" ? { cols: 4, rows: 1 } : { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  return { cols: 4, rows: 2 };
}
