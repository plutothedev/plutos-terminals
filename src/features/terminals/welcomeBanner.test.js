import { test, expect } from "vitest";
import { buildWelcomeBanner } from "./welcomeBanner.js";

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Full-box contract (2026-08-14 — pluto: "colorful ascii box like mobaxterm").
// Every content row must be padded to the exact same width so the right
// border aligns; corners and rules must be present and coloured.

test("renders a well-formed box: uniform width, aligned side borders, corners", () => {
  for (const paneCols of [80, 120, 200, 40]) {
    const out = stripAnsi(buildWelcomeBanner({ paneCols }));
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    expect(lines[0].trim().startsWith("┌")).toBe(true);
    expect(lines[0].trim().endsWith("┐")).toBe(true);
    expect(lines[lines.length - 1].trim().startsWith("└")).toBe(true);
    expect(lines[lines.length - 1].trim().endsWith("┘")).toBe(true);
    const width = lines[0].length;
    for (const l of lines) {
      expect(l.length, `row width drift at cols=${paneCols}: "${l}"`).toBe(width);
      const t = l.trim();
      if (!t.startsWith("┌") && !t.startsWith("└")) {
        expect(t.startsWith("│")).toBe(true);
        expect(t.endsWith("│")).toBe(true);
      }
    }
  }
});

test("box fits the pane: no printed line exceeds the boot-time column count", () => {
  for (const paneCols of [40, 60, 80, 200]) {
    const out = stripAnsi(buildWelcomeBanner({ paneCols }));
    for (const line of out.split("\n")) {
      expect(line.length, `overflow at cols=${paneCols}`).toBeLessThanOrEqual(Math.max(paneCols, 28));
    }
  }
});

test("the border is coloured (magenta SGR wraps the frame)", () => {
  const raw = buildWelcomeBanner({ paneCols: 80 });
  expect(raw).toContain("\x1b[1;35m┌");
  expect(raw).toContain("\x1b[1;35m│");
});

test("still renders the title and docs link", () => {
  const out = stripAnsi(buildWelcomeBanner({ paneCols: 80 }));
  expect(out).toContain("Pluto's Terminal");
  expect(out).toContain("github.com/plutothedev/plutos-terminals");
});
