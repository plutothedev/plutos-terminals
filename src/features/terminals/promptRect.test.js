// (C)
import { describe, it, expect } from "vitest";
import { computePromptRect, samePromptRect } from "./promptRect";

// The real functions TerminalPane's capturePrompt() imports. The two
// getBoundingClientRect() reads stay in the component (they are DOM I/O); every
// number derived from them is computed here.

describe("computePromptRect", () => {
  // A conventional pane: 80x20 cells over an 800x400 screen box, so cells are
  // 10 wide and 20 tall. Screen sits 10px inside the wrapper on both axes.
  const base = {
    wrapTop: 50, wrapLeft: 100,
    screenTop: 60, screenLeft: 110,
    screenWidth: 800, screenHeight: 400,
    cols: 80, rows: 20,
    cursorX: 0, cursorY: 0,
  };

  it("places the editor at the screen origin for a cursor at 0,0", () => {
    expect(computePromptRect(base)).toEqual({
      top: 10,    // screenTop - wrapTop
      left: 10,   // screenLeft - wrapLeft
      width: 796, // screenWidth - 0 - 4
      height: 20, // cellH
    });
  });

  it("offsets by whole cells as the cursor moves", () => {
    const r = computePromptRect({ ...base, cursorX: 5, cursorY: 3 });
    expect(r.left).toBe(10 + 5 * 10);
    expect(r.top).toBe(10 + 3 * 20);
    expect(r.width).toBe(800 - 50 - 4);
    expect(r.height).toBe(20);
  });

  it("is measured relative to the wrapper, not the viewport", () => {
    // Scroll the whole window: both rects shift together and the overlay must
    // not move, because it is absolutely positioned inside the wrapper.
    const scrolled = computePromptRect({
      ...base, wrapTop: 950, wrapLeft: 1000, screenTop: 960, screenLeft: 1010,
    });
    expect(scrolled).toEqual(computePromptRect(base));
  });

  it("floors the width at 60px when the cursor is near the right edge", () => {
    // Cursor in column 79 of 80 leaves 10 - 4 = 6px of real room. An editor 6px
    // wide is unusable, so it overhangs instead.
    const r = computePromptRect({ ...base, cursorX: 79 });
    expect(r.width).toBe(60);
    expect(r.left).toBe(10 + 790);
  });

  it("floors the height at 12px", () => {
    // A measurement taken mid-layout can report a near-zero screen box; the
    // overlay must not collapse to nothing.
    const r = computePromptRect({ ...base, screenHeight: 20 }); // cellH = 1
    expect(r.height).toBe(12);
  });

  it("does not clamp a genuinely large cell", () => {
    const r = computePromptRect({ ...base, screenHeight: 800 }); // cellH = 40
    expect(r.height).toBe(40);
  });
});

describe("samePromptRect", () => {
  const r = { top: 10, left: 20, width: 300, height: 18 };

  it("is true for equal boxes", () => {
    expect(samePromptRect(r, { ...r })).toBe(true);
    expect(samePromptRect(r, r)).toBe(true);
  });

  it("is false when any single dimension moves", () => {
    // Each field checked separately: a comparison that forgets one of the four
    // would freeze the overlay on that axis.
    expect(samePromptRect(r, { ...r, top: 11 })).toBe(false);
    expect(samePromptRect(r, { ...r, left: 21 })).toBe(false);
    expect(samePromptRect(r, { ...r, width: 301 })).toBe(false);
    expect(samePromptRect(r, { ...r, height: 19 })).toBe(false);
  });

  it("is false against a missing rect", () => {
    expect(samePromptRect(null, r)).toBe(false);
    expect(samePromptRect(r, null)).toBe(false);
    expect(samePromptRect(undefined, undefined)).toBe(false);
  });

  it("regression PERF-4: an unmoved cursor yields state identity", () => {
    // What the caller does: setPeRect(prev => samePromptRect(prev, next) ? prev : next).
    // Returning the SAME object reference is what makes React bail out of the
    // render, so a scroll that does not move the editor costs no re-render.
    const geom = {
      wrapTop: 0, wrapLeft: 0, screenTop: 6, screenLeft: 6,
      screenWidth: 800, screenHeight: 400, cols: 80, rows: 20,
      cursorX: 12, cursorY: 4,
    };
    const prev = computePromptRect(geom);
    const next = computePromptRect(geom); // a fresh object, equal values
    expect(next).not.toBe(prev);
    const committed = samePromptRect(prev, next) ? prev : next;
    expect(committed).toBe(prev);

    // And it must still move when the cursor actually moves.
    const moved = computePromptRect({ ...geom, cursorY: 5 });
    expect(samePromptRect(prev, moved) ? prev : moved).toBe(moved);
  });
});
