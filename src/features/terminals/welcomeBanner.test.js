import { test, expect } from "vitest";
import { buildWelcomeBanner } from "./welcomeBanner.js";

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("borderless — contains no box-frame characters (nothing to orphan on a split)", () => {
  const out = stripAnsi(buildWelcomeBanner({ paneCols: 120 }));
  for (const ch of ["│", "┌", "┐", "└", "┘"]) expect(out).not.toContain(ch);
});

test("content stays within the wrap width even when the pane is wide at boot", () => {
  // W is capped at 52 + a 2-space indent, so no printed line exceeds 54 cols —
  // a pane narrower than that just re-wraps the (borderless, left-aligned) text.
  const out = stripAnsi(buildWelcomeBanner({ paneCols: 200 }));
  for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(54);
});

test("still renders the title and docs link", () => {
  const out = stripAnsi(buildWelcomeBanner({ paneCols: 80 }));
  expect(out).toContain("Pluto's Terminal");
  expect(out).toContain("github.com/plutothedev/plutos-terminals");
});
