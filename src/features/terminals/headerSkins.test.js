// (C)
// Pins the Light skin's terminal contract. The Light skin used to ship the
// SAME dark terminal as Dark ("the toggle only changes the chrome"), which
// left a black rectangle sitting inside a light app. It is now a genuinely
// light terminal, and these tests keep it readable: ANSI colours on a
// near-white background are easy to regress into invisibility (the older
// "Pluto Light" terminal theme in themes.js maps white/brightWhite to the
// background colour itself, which is exactly the trap being avoided here).
import { describe, it, expect } from "vitest";
import { getSkinXtermTheme } from "./headerSkins.js";

// WCAG relative luminance + contrast ratio.
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const light = () => getSkinXtermTheme("moba-light", {});

describe("Light skin terminal palette", () => {
  it("is actually light: dark text on a near-white background", () => {
    const t = light();
    expect(lum(t.background)).toBeGreaterThan(0.8); // near-white
    expect(lum(t.foreground)).toBeLessThan(0.2); // dark text
  });

  it("every ANSI colour clears WCAG AA against the background", () => {
    const t = light();
    const dim = new Set(["brightBlack"]); // de-emphasized text, faint by design
    const nonText = new Set(["background", "cursor", "selectionBackground"]);
    const failures = Object.entries(t)
      .filter(([k, v]) => typeof v === "string" && v.startsWith("#") && !dim.has(k) && !nonText.has(k))
      .map(([k, v]) => [k, v, contrast(v, t.background)])
      .filter(([, , ratio]) => ratio < 4.5)
      .map(([k, v, ratio]) => `${k} ${v} @ ${ratio.toFixed(2)}`);
    expect(failures).toEqual([]);
  });

  it("white and brightWhite are not the background colour (the invisibility trap)", () => {
    const t = light();
    expect(t.white).not.toBe(t.background);
    expect(t.brightWhite).not.toBe(t.background);
    expect(contrast(t.white, t.background)).toBeGreaterThan(4.5);
  });

  it("each bright variant out-contrasts its base — on light, bright means darker", () => {
    const t = light();
    for (const base of ["red", "green", "yellow", "blue", "cyan", "white"]) {
      const bright = `bright${base[0].toUpperCase()}${base.slice(1)}`;
      expect(
        contrast(t[bright], t.background),
        `${bright} must have more contrast than ${base}`
      ).toBeGreaterThan(contrast(t[base], t.background));
    }
  });

  it("pureBlackTerminal does not paint a black background under a light skin", () => {
    // The OLED tweak forces background #000000. Applied to the light palette
    // that means dark text on black — unreadable. Light skins opt out.
    expect(getSkinXtermTheme("moba-light", { pureBlackTerminal: true }).background).toBe(
      light().background
    );
    // ...while still applying to dark skins.
    expect(getSkinXtermTheme("oled", { pureBlackTerminal: true }).background).toBe("#000000");
  });

  it("dark skins are untouched by this change", () => {
    const dark = getSkinXtermTheme("oled", {});
    expect(lum(dark.background)).toBeLessThan(0.1);
    expect(lum(dark.foreground)).toBeGreaterThan(0.4);
  });
});
