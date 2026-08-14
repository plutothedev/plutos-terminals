// (C)
import { describe, test, expect } from "vitest";
import { pickPlacement } from "./placement.js";

const VP = { w: 1200, h: 800 };
const CARD = { w: 340, h: 180 };
const M = 12; // margin

describe("pickPlacement", () => {
  test("prefers below the target when there is room", () => {
    const t = { left: 400, top: 100, width: 120, height: 30 };
    const p = pickPlacement(t, CARD, VP);
    expect(p.side).toBe("below");
    expect(p.y).toBe(100 + 30 + M);
    expect(p.x).toBe(Math.round(400 + 120 / 2 - 340 / 2));
  });

  test("flips above when below would overflow the viewport", () => {
    const t = { left: 400, top: 700, width: 120, height: 60 };
    const p = pickPlacement(t, CARD, VP);
    expect(p.side).toBe("above");
    expect(p.y).toBe(700 - 180 - M);
  });

  test("falls to the side when neither above nor below fits", () => {
    const t = { left: 100, top: 90, width: 60, height: 620 }; // tall rail
    const p = pickPlacement(t, CARD, VP);
    expect(p.side).toBe("right");
    expect(p.x).toBe(100 + 60 + M);
  });

  test("clamps x into the viewport at corners", () => {
    const t = { left: 1150, top: 100, width: 40, height: 30 };
    const p = pickPlacement(t, CARD, VP);
    expect(p.x + CARD.w).toBeLessThanOrEqual(VP.w - M);
    expect(p.x).toBeGreaterThanOrEqual(M);
  });

  test("null target centers the card", () => {
    const p = pickPlacement(null, CARD, VP);
    expect(p.side).toBe("center");
    expect(p.x).toBe(Math.round((1200 - 340) / 2));
    expect(p.y).toBe(Math.round((800 - 180) / 2));
  });
});
