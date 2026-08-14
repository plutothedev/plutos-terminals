// (C)
// Pure placement math for the tour card: pick a side with room, clamp into
// the viewport. No DOM access — testable in node.
const MARGIN = 12;

export function pickPlacement(targetRect, card, viewport) {
  const clampX = (x) =>
    Math.round(Math.min(Math.max(x, MARGIN), viewport.w - card.w - MARGIN));
  const clampY = (y) =>
    Math.round(Math.min(Math.max(y, MARGIN), viewport.h - card.h - MARGIN));

  if (!targetRect) {
    return {
      side: "center",
      x: Math.round((viewport.w - card.w) / 2),
      y: Math.round((viewport.h - card.h) / 2),
    };
  }

  const centeredX = clampX(targetRect.left + targetRect.width / 2 - card.w / 2);
  const below = targetRect.top + targetRect.height + MARGIN;
  if (below + card.h <= viewport.h - MARGIN) {
    return { side: "below", x: centeredX, y: Math.round(below) };
  }
  const above = targetRect.top - card.h - MARGIN;
  if (above >= MARGIN) {
    return { side: "above", x: centeredX, y: Math.round(above) };
  }
  const centeredY = clampY(targetRect.top + targetRect.height / 2 - card.h / 2);
  const right = targetRect.left + targetRect.width + MARGIN;
  if (right + card.w <= viewport.w - MARGIN) {
    return { side: "right", x: Math.round(right), y: centeredY };
  }
  const left = targetRect.left - card.w - MARGIN;
  if (left >= MARGIN) {
    return { side: "left", x: Math.round(left), y: centeredY };
  }
  return { side: "center", x: clampX((viewport.w - card.w) / 2), y: clampY((viewport.h - card.h) / 2) };
}
