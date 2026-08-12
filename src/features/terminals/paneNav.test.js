// (C)
import { describe, it, expect } from "vitest";
import { leafRects, navigatePane } from "./paneNav.js";
import { equalizeRatios, splitLeaf } from "./splitTree.js";

// A | B side by side.
const row = (a, b, ratio = 0.5, id = "s1") => ({ id, dir: "row", ratio, a, b });
const col = (a, b, ratio = 0.5, id = "s1") => ({ id, dir: "col", ratio, a, b });
const L = (id) => ({ id });

describe("leafRects", () => {
  it("splits 0-100 space by ratio", () => {
    const rects = leafRects(row(L("a"), L("b"), 0.25));
    expect(rects).toEqual([
      { id: "a", rect: { left: 0, top: 0, width: 25, height: 100 } },
      { id: "b", rect: { left: 25, top: 0, width: 75, height: 100 } },
    ]);
  });

  it("nests rows and cols like the on-screen layout", () => {
    // A | (B over C)
    const tree = row(L("a"), col(L("b"), L("c"), 0.5, "s2"));
    const byId = Object.fromEntries(leafRects(tree).map((r) => [r.id, r.rect]));
    expect(byId.a).toEqual({ left: 0, top: 0, width: 50, height: 100 });
    expect(byId.b).toEqual({ left: 50, top: 0, width: 50, height: 50 });
    expect(byId.c).toEqual({ left: 50, top: 50, width: 50, height: 50 });
  });

  it("single leaf fills the space", () => {
    expect(leafRects(L("only"))).toEqual([
      { id: "only", rect: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
  });
});

describe("navigatePane", () => {
  it("moves right/left across a row split and stops at edges", () => {
    const tree = row(L("a"), L("b"));
    expect(navigatePane(tree, "a", "right")).toBe("b");
    expect(navigatePane(tree, "b", "left")).toBe("a");
    expect(navigatePane(tree, "a", "left")).toBeNull();
    expect(navigatePane(tree, "b", "right")).toBeNull();
    expect(navigatePane(tree, "a", "up")).toBeNull();
    expect(navigatePane(tree, "a", "down")).toBeNull();
  });

  it("prefers the pane containing the from-pane's center line", () => {
    // A (full height) | B over C. From A going right, A's center (y=50) sits
    // exactly on the B/C boundary; B and C tie on distance, overlap breaks the
    // tie deterministically. Nudge the boundary so the intuitive answers are
    // unambiguous: B takes the top 70%.
    const tree = row(L("a"), col(L("b"), L("c"), 0.7, "s2"));
    expect(navigatePane(tree, "a", "right")).toBe("b"); // y=50 inside B's 0-70
    // From B or C going left, A is the only candidate.
    expect(navigatePane(tree, "b", "left")).toBe("a");
    expect(navigatePane(tree, "c", "left")).toBe("a");
    // B and C are stacked: down from B is C, up from C is B.
    expect(navigatePane(tree, "b", "down")).toBe("c");
    expect(navigatePane(tree, "c", "up")).toBe("b");
    // Nothing right of B/C.
    expect(navigatePane(tree, "b", "right")).toBeNull();
  });

  it("2x2 grid: lateral moves stay in the same visual row", () => {
    // (A over C) | (B over D)
    const tree = row(col(L("a"), L("c"), 0.5, "s2"), col(L("b"), L("d"), 0.5, "s3"));
    expect(navigatePane(tree, "a", "right")).toBe("b");
    expect(navigatePane(tree, "c", "right")).toBe("d");
    expect(navigatePane(tree, "d", "left")).toBe("c");
    expect(navigatePane(tree, "b", "down")).toBe("d");
    expect(navigatePane(tree, "a", "down")).toBe("c");
  });

  it("nearer pane wins over a farther one in the same direction", () => {
    // (A | B) | C  → from A going right, B (adjacent) beats C (far side).
    const tree = row(row(L("a"), L("b"), 0.5, "s2"), L("c"), 0.5, "s1");
    expect(navigatePane(tree, "a", "right")).toBe("b");
    expect(navigatePane(tree, "b", "right")).toBe("c");
    expect(navigatePane(tree, "c", "left")).toBe("b");
  });

  it("unknown from-pane returns null", () => {
    expect(navigatePane(row(L("a"), L("b")), "nope", "right")).toBeNull();
  });
});

describe("equalizeRatios / splitLeaf newFirst (splitTree additions)", () => {
  it("equalizeRatios resets every split to 0.5 without touching leaves", () => {
    const tree = row(col(L("a"), L("c"), 0.83, "s2"), L("b"), 0.14, "s1");
    const eq = equalizeRatios(tree);
    expect(eq.ratio).toBe(0.5);
    expect(eq.a.ratio).toBe(0.5);
    expect(eq.a.a).toEqual(L("a")); // leaves unchanged
    expect(tree.ratio).toBe(0.14); // input not mutated
  });

  it("splitLeaf newFirst places the incoming node on the a-side", () => {
    const after = splitLeaf(L("a"), "a", "row", L("new"), "s9", false);
    expect(after.a.id).toBe("a");
    expect(after.b.id).toBe("new");
    const before = splitLeaf(L("a"), "a", "row", L("new"), "s9", true);
    expect(before.a.id).toBe("new");
    expect(before.b.id).toBe("a");
  });

  it("splitLeaf can insert a whole subtree (drag-to-split merge)", () => {
    const sub = col(L("x"), L("y"), 0.5, "sx");
    const after = splitLeaf(row(L("a"), L("b"), 0.5, "s1"), "b", "col", sub, "s9");
    expect(after.b.b).toEqual(sub);
    expect(after.b.a).toEqual(L("b"));
  });
});
