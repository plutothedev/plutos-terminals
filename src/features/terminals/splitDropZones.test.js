// (C)
import { describe, it, expect } from "vitest";
import { dropZone, zoneToSplit, zonePreviewRect, EDGE_BAND } from "./splitDropZones.js";

// A 100x100 pane at (200, 300) — offsets exercise the rect-relative math.
const R = { left: 200, top: 300, width: 100, height: 100 };

describe("dropZone", () => {
  it("middle of the pane is center", () => {
    expect(dropZone(250, 350, R)).toBe("center");
  });

  it("each edge band picks its edge", () => {
    expect(dropZone(205, 350, R)).toBe("left");
    expect(dropZone(295, 350, R)).toBe("right");
    expect(dropZone(250, 305, R)).toBe("top");
    expect(dropZone(250, 395, R)).toBe("bottom");
  });

  it("corners resolve to the nearest edge", () => {
    // 10% in from the left, 5% down from the top → top is nearer.
    expect(dropZone(210, 305, R)).toBe("top");
    // 5% in from the left, 10% down from the top → left is nearer.
    expect(dropZone(205, 310, R)).toBe("left");
    // Near bottom-right, closer to right.
    expect(dropZone(297, 385, R)).toBe("right");
  });

  it("band boundary: just inside splits, just outside is center", () => {
    const inside = 200 + (EDGE_BAND - 0.01) * 100;
    const outside = 200 + (EDGE_BAND + 0.01) * 100;
    expect(dropZone(inside, 350, R)).toBe("left");
    expect(dropZone(outside, 350, R)).toBe("center");
  });

  it("outside the rect or degenerate rect is null", () => {
    expect(dropZone(150, 350, R)).toBeNull();
    expect(dropZone(250, 450, R)).toBeNull();
    expect(dropZone(0, 0, { left: 0, top: 0, width: 0, height: 50 })).toBeNull();
    expect(dropZone(0, 0, null)).toBeNull();
  });
});

describe("zoneToSplit", () => {
  it("maps edges to splitLeaf args (left/top put the incoming pane first)", () => {
    expect(zoneToSplit("left")).toEqual({ dir: "row", newFirst: true });
    expect(zoneToSplit("right")).toEqual({ dir: "row", newFirst: false });
    expect(zoneToSplit("top")).toEqual({ dir: "col", newFirst: true });
    expect(zoneToSplit("bottom")).toEqual({ dir: "col", newFirst: false });
  });

  it("center and junk are null (no split)", () => {
    expect(zoneToSplit("center")).toBeNull();
    expect(zoneToSplit(null)).toBeNull();
    expect(zoneToSplit("banana")).toBeNull();
  });
});

describe("zonePreviewRect", () => {
  it("draws the half the incoming tab will occupy", () => {
    expect(zonePreviewRect("left")).toEqual({ left: "0%", top: "0%", width: "50%", height: "100%" });
    expect(zonePreviewRect("bottom")).toEqual({ left: "0%", top: "50%", width: "100%", height: "50%" });
  });

  it("center and junk are null", () => {
    expect(zonePreviewRect("center")).toBeNull();
    expect(zonePreviewRect(undefined)).toBeNull();
  });
});
