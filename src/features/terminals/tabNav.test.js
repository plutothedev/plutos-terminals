// (C)
// Tab-strip navigation arithmetic (audit A11Y-05).
import { describe, it, expect } from "vitest";
import { nextTabId, tabIdAt } from "./tabNav.js";

const TABS = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("nextTabId", () => {
  it("steps forward and backward", () => {
    expect(nextTabId(TABS, "a", 1)).toBe("b");
    expect(nextTabId(TABS, "b", -1)).toBe("a");
  });

  it("wraps at both ends", () => {
    expect(nextTabId(TABS, "c", 1)).toBe("a");
    expect(nextTabId(TABS, "a", -1)).toBe("c");
  });

  it("is a no-op on a single-tab strip rather than returning null", () => {
    expect(nextTabId([{ id: "only" }], "only", 1)).toBe("only");
    expect(nextTabId([{ id: "only" }], "only", -1)).toBe("only");
  });

  it("still moves somewhere sensible when the active id is unknown", () => {
    // A stale activeTabId must not make the keystroke feel dead.
    expect(nextTabId(TABS, "gone", 1)).toBe("b");
    expect(nextTabId(TABS, undefined, -1)).toBe("c");
  });

  it("returns null for an empty or non-array strip", () => {
    expect(nextTabId([], "a", 1)).toBeNull();
    expect(nextTabId(undefined, "a", 1)).toBeNull();
    expect(nextTabId(null, "a", 1)).toBeNull();
  });

  it("survives a junk delta instead of producing a NaN index", () => {
    for (const bad of [undefined, null, NaN, "1", {}]) {
      expect(nextTabId(TABS, "b", bad)).toBe("b");
    }
  });
});

describe("tabIdAt", () => {
  it("indexes from zero", () => {
    expect(tabIdAt(TABS, 0)).toBe("a");
    expect(tabIdAt(TABS, 2)).toBe("c");
  });

  it("is a no-op past the end, it does NOT clamp to the last tab", () => {
    // Alt+9 on a 3-tab strip must do nothing. Clamping would move focus
    // somewhere the user did not ask for and could not predict.
    expect(tabIdAt(TABS, 3)).toBeNull();
    expect(tabIdAt(TABS, 8)).toBeNull();
  });

  it("rejects negative and non-integer indices", () => {
    expect(tabIdAt(TABS, -1)).toBeNull();
    expect(tabIdAt(TABS, 1.5)).toBeNull();
    expect(tabIdAt(TABS, "1")).toBeNull();
  });
});
