// (C)
// The tab-strip / pane focus handshake (audit A11Y-05 follow-up).
//
// Two halves are checked here. The window arithmetic is unit-tested against the
// real module with an injected clock, and the CONSUMER is checked by parsing
// TerminalPane.jsx, because the alternative is a mock that reproduces the
// reveal effect and then asserts on its own reproduction. That is the failure
// mode `ipcContract.test.js` was written against and TQ-1/TQ-3 already have:
// a test that passes because the copy agrees with itself while production has
// drifted. Parsing the real file cannot drift; it is exactly as strong as the
// claim it makes ("the guard is at the call site") and no stronger.
import { describe, test, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  armTabStripFocus,
  releaseTabStripFocus,
  shouldPaneTakeFocus,
  TAB_STRIP_FOCUS_WINDOW_MS,
} from "./tabStripFocus.js";

beforeEach(() => releaseTabStripFocus());

describe("tabStripFocus window", () => {
  test("an unarmed strip lets the pane take focus, which is the mouse path", () => {
    expect(shouldPaneTakeFocus()).toBe(true);
  });

  test("the pane's 30ms reveal steal falls inside the armed window", () => {
    // The number that matters: the steal is scheduled 30ms after the switch
    // commits, so if this were ever false the whole guard would be decorative.
    armTabStripFocus(1_000);
    expect(shouldPaneTakeFocus(1_030)).toBe(false);
  });

  test("the window expires on its own, so a missed release cannot wedge the app", () => {
    armTabStripFocus(1_000);
    expect(shouldPaneTakeFocus(1_000 + TAB_STRIP_FOCUS_WINDOW_MS - 1)).toBe(false);
    expect(shouldPaneTakeFocus(1_000 + TAB_STRIP_FOCUS_WINDOW_MS)).toBe(true);
    expect(shouldPaneTakeFocus(9_999_999)).toBe(true);
  });

  test("releasing hands the next reveal straight back to the pane", () => {
    armTabStripFocus(1_000);
    releaseTabStripFocus();
    expect(shouldPaneTakeFocus(1_010)).toBe(true);
  });

  test("re-arming slides the window forward rather than stacking", () => {
    armTabStripFocus(1_000);
    armTabStripFocus(1_400);
    // 1_600 is past the first arm's expiry and inside the second's: holding a
    // key down has to keep the strip, not hand it back mid-repeat.
    expect(shouldPaneTakeFocus(1_600)).toBe(false);
  });
});

describe("the consumer is wired (TerminalPane's reveal effect)", () => {
  const src = readFileSync(fileURLToPath(new URL("./TerminalPane.jsx", import.meta.url)), "utf8");

  test("TerminalPane imports the guard from this module", () => {
    expect(src).toMatch(/import\s*\{[^}]*\bshouldPaneTakeFocus\b[^}]*\}\s*from\s*["']\.\/tabStripFocus\.js["']/);
  });

  test("the only focus-on-reveal call in TerminalPane is guarded by it", () => {
    // Slice the reveal effect: it is the one that runs on `visible` and ends at
    // the `}, [visible]);` dependency list. Asserting inside that slice rather
    // than over the whole 2,200-line file is what stops an unrelated
    // shouldPaneTakeFocus() elsewhere from satisfying this by accident.
    const start = src.indexOf("// When a hidden pane becomes visible");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("}, [visible]);", start);
    expect(end).toBeGreaterThan(start);
    const effect = src.slice(start, end);

    expect(effect).toContain("termRef.current?.focus()");
    const focusLine = effect
      .split("\n")
      .findIndex((l) => l.includes("termRef.current?.focus()"));
    // The guard is the `if` immediately above the focus call, so look at the
    // two lines before it rather than anywhere in the effect: a
    // shouldPaneTakeFocus() sitting in the refit branch would not save anyone.
    const guardWindow = effect.split("\n").slice(Math.max(0, focusLine - 2), focusLine).join("\n");
    expect(guardWindow).toContain("shouldPaneTakeFocus()");
    expect(guardWindow).toContain("activeRef.current");
  });
});
