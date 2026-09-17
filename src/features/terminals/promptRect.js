// (C)
// Pure geometry for the app-owned prompt editor overlay.
//
// Extracted from TerminalPane.jsx's capturePrompt() (audit PERF-4). The two
// getBoundingClientRect() reads stay in the component -- they are the forced
// layouts, and they are the whole reason this path had to be rAF-coalesced --
// but the arithmetic they feed, and the "did anything actually move" test, are
// side-effect-free and belong where they can be tested.

// Place the editor over the cursor cell, in coordinates relative to the pane
// wrapper (which is `position: absolute; inset: 0`, so the overlay is
// positioned against it).
//
// Cell size is derived from the measured .xterm-screen box divided by the
// terminal's own cols/rows rather than read from xterm's internal renderer,
// which is what the inline version did and is preserved verbatim.
//
// The two clamps are load-bearing and also verbatim: a 60px floor on width
// keeps the editor usable when the cursor sits near the right edge (a long
// wrapped command line), and a 12px floor on height keeps it from collapsing
// to nothing if a measurement lands mid-layout with a zero-height screen box.
// The `- 4` is right-edge breathing room inside the pane.
export function computePromptRect({
  wrapTop, wrapLeft,
  screenTop, screenLeft, screenWidth, screenHeight,
  cols, rows, cursorX, cursorY,
}) {
  const cellW = screenWidth / cols;
  const cellH = screenHeight / rows;
  return {
    top: (screenTop - wrapTop) + cursorY * cellH,
    left: (screenLeft - wrapLeft) + cursorX * cellW,
    width: Math.max(60, screenWidth - cursorX * cellW - 4),
    height: Math.max(12, cellH),
  };
}

// Do these two rects describe the same box?
//
// PERF-4: capturePrompt() ran `setPeRect({...})` with a freshly built object on
// every xterm onScroll, and xterm fires onScroll once PER SCROLLED LINE. A new
// object is never Object.is-equal to the old state, so React re-rendered the
// whole pane for every line of a scrollback flick even though the editor had
// not moved by a pixel. Feeding this through the functional-updater form and
// returning the PREVIOUS object when nothing changed is what lets React bail
// out of the render entirely.
//
// A missing/absent rect is deliberately never "same" -- there is nothing to
// preserve identity of, so the caller should take the new object.
export function samePromptRect(a, b) {
  if (!a || !b) return false;
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height
  );
}
