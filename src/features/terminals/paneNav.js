// (C)
// Directional pane focus navigation (Ctrl+Alt+Arrows): given a tab's split
// tree and the focused pane, pick the pane the user means by "left/right/
// up/down". Rects are computed in the same 0-100 ratio space TerminalPanel's
// computeLayout uses, so adjacency here matches what is on screen. Percentages
// ignore the window's aspect ratio, but direction and overlap ranking only
// compare within one axis at a time, so that never changes the answer.

import { isLeaf } from "./splitTree.js";

// Flatten the tree to [{id, rect}] where rect is {left, top, width, height}
// in 0-100 space. Mirrors computeLayout's math minus dividers/drag state.
export function leafRects(node, rect = { left: 0, top: 0, width: 100, height: 100 }) {
  if (!node) return [];
  if (isLeaf(node)) return [{ id: node.id, rect }];
  const ratio = typeof node.ratio === "number" ? node.ratio : 0.5;
  const aRect =
    node.dir === "row"
      ? { ...rect, width: rect.width * ratio }
      : { ...rect, height: rect.height * ratio };
  const bRect =
    node.dir === "row"
      ? { ...rect, left: rect.left + rect.width * ratio, width: rect.width * (1 - ratio) }
      : { ...rect, top: rect.top + rect.height * ratio, height: rect.height * (1 - ratio) };
  return [...leafRects(node.a, aRect), ...leafRects(node.b, bRect)];
}

// Numeric slack for edge comparisons: ratios multiply into floats, and two
// panes sharing a divider must count as adjacent, not overlapping.
const EPS = 0.001;

/**
 * The pane to focus when moving `dir` from `fromId`, or null if none.
 * Ranking among panes strictly in that direction:
 *   1. panes whose perpendicular span contains the from-pane's center
 *      (where the user is looking) beat those that don't;
 *   2. nearer edge wins;
 *   3. larger perpendicular overlap with the from-pane wins (stable tiebreak).
 * @param {object} layout split tree (getLayout(tab))
 * @param {string} fromId focused pane id
 * @param {"left"|"right"|"up"|"down"} dir
 */
export function navigatePane(layout, fromId, dir) {
  const rects = leafRects(layout);
  const from = rects.find((r) => r.id === fromId);
  if (!from) return null;
  const f = from.rect;
  const horizontal = dir === "left" || dir === "right";
  // Perpendicular span + center of the from pane.
  const [pStart, pLen] = horizontal ? [f.top, f.height] : [f.left, f.width];
  const pCenter = pStart + pLen / 2;

  let best = null;
  for (const cand of rects) {
    if (cand.id === fromId) continue;
    const c = cand.rect;
    // Strictly in the requested direction (candidate's near edge at or past
    // the from pane's far edge).
    const inDir =
      dir === "right" ? c.left >= f.left + f.width - EPS
      : dir === "left" ? c.left + c.width <= f.left + EPS
      : dir === "down" ? c.top >= f.top + f.height - EPS
      : c.top + c.height <= f.top + EPS;
    if (!inDir) continue;

    const dist =
      dir === "right" ? c.left - (f.left + f.width)
      : dir === "left" ? f.left - (c.left + c.width)
      : dir === "down" ? c.top - (f.top + f.height)
      : f.top - (c.top + c.height);

    const [cStart, cLen] = horizontal ? [c.top, c.height] : [c.left, c.width];
    const containsCenter = pCenter >= cStart - EPS && pCenter <= cStart + cLen + EPS;
    const overlap = Math.max(
      0,
      Math.min(pStart + pLen, cStart + cLen) - Math.max(pStart, cStart)
    );

    const score = { id: cand.id, containsCenter, dist, overlap };
    if (
      !best ||
      (score.containsCenter && !best.containsCenter) ||
      (score.containsCenter === best.containsCenter &&
        (score.dist < best.dist - EPS ||
          (Math.abs(score.dist - best.dist) <= EPS && score.overlap > best.overlap)))
    ) {
      best = score;
    }
  }
  return best ? best.id : null;
}
