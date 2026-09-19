// (C)
// Custom themes: import a Warp theme YAML, derive a full Pluto theme (xterm
// terminal palette + chrome --phn-* CSS tokens), and export back to Warp YAML.
//
// Warp theme YAML shape (github.com/warpdotdev/themes):
//   name: "Dracula"
//   accent: "#bd93f9"
//   background: "#282a36"
//   foreground: "#f8f8f2"
//   details: "darker" | "lighter"
//   terminal_colors:
//     normal:  { black, red, green, yellow, blue, magenta, cyan, white }
//     bright:  { black, red, green, yellow, blue, magenta, cyan, white }
//
// A Pluto custom theme: { id, name, dark, xterm:{20 keys}, chrome:{--phn-*},
// source:{accent,background,foreground} }. Stored in userSt.customThemes;
// applied when st.headerSkin === "custom:<id>" (see headerSkins.js).

import yaml from "js-yaml";
import { ANSI_DARK, ANSI_LIGHT } from "./headerSkins.js";

// ── color helpers ──────────────────────────────────────────────────────────
// Strict hex check (#rgb / #rrggbb / #rrggbbaa). We reject anything else at
// import (named colors, rgb()/var()) so unvalidated strings can't reach the
// injected CSS or the xterm palette — see the audit's theme-injection finding.
function isHexColor(s) {
  return typeof s === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s.trim());
}
function hexToRgb(hex) {
  let h = String(hex || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function rgbToHex({ r, g, b }) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
// Mix a→b, t in [0,1]. Falls back to a if either is unparseable.
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  if (!A || !B) return a;
  return rgbToHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
}
function rgba(hex, alpha) {
  const c = hexToRgb(hex);
  if (!c) return hex;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}
// Relative luminance (0 dark … 1 light), no gamma — good enough for dark/light.
export function luminance(hex) {
  const c = hexToRgb(hex);
  if (!c) return 0;
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}
function readableOn(hex) {
  return luminance(hex) < 0.5 ? "#ffffff" : "#111111";
}
function slug(s) {
  return String(s || "theme").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "theme";
}

// ── Warp → Pluto ────────────────────────────────────────────────────────────
function warpXterm(w, dark) {
  const n = w.terminal_colors?.normal || {};
  const b = w.terminal_colors?.bright || {};
  const accent = w.accent || w.foreground;
  // terminal_colors is OPTIONAL in Warp YAML. A theme without it used to
  // store all 16 ANSI slots as undefined — xterm then rendered every colored
  // byte as plain foreground ("no colors in my terminal", 2026-08-13).
  // Default missing slots from the lightness-matched stock palette; the
  // theme's own colors always win. getActiveXtermTheme applies the same
  // defaulting at READ time for themes imported before this fix.
  const base = dark === false ? ANSI_LIGHT : ANSI_DARK;
  return {
    ...base,
    background: w.background,
    foreground: w.foreground,
    cursor: accent,
    cursorAccent: w.background,
    selectionBackground: rgba(accent, 0.35),
    ...Object.fromEntries(
      Object.entries({
        black: n.black, red: n.red, green: n.green, yellow: n.yellow,
        blue: n.blue, magenta: n.magenta, cyan: n.cyan, white: n.white,
        brightBlack: b.black, brightRed: b.red, brightGreen: b.green, brightYellow: b.yellow,
        brightBlue: b.blue, brightMagenta: b.magenta, brightCyan: b.cyan, brightWhite: b.white,
      }).filter(([, v]) => v != null)
    ),
  };
}

// Derive the chrome --phn-* tokens from background / foreground / accent.
//
// This map is the FIFTEENTH skin block: the custom-theme equivalent of one
// [data-phn-skin="…"] block in headerSkins.css. Anything a skin block declares
// has to be declared here too, or an imported theme falls through to the base
// skin's value, and the base skin is a built-in whose colours have nothing to
// do with the imported background.
//
// That inheritance is not theoretical, and it is worse than plain fallback:
// applyActiveTheme() sets BOTH data-phn-skin (the base skin) and
// data-phn-theme="custom" on <html>, and the injected [data-phn-theme="custom"]
// rule only wins for the properties it actually declares. So an imported LIGHT
// theme whose base skin is a dark one silently keeps that dark skin's
// --phn-text-bright (#F2F4F7) and --phn-chip-bg (#2C3037) unless they are set
// below. That is the exact shape of audit A11Y-01.
//
// headerSkins.tokens.test.js enforces the pairing: every token in the
// light-safety set must appear in all fourteen skin blocks AND here.
function deriveChrome(w, dark) {
  const bg = w.background, fg = w.foreground, accent = w.accent || w.foreground;
  const n = w.terminal_colors?.normal || {};
  const lift = dark ? "#ffffff" : "#000000"; // direction that lightens surfaces
  const emph = dark ? "#ffffff" : "#000000";
  return {
    "--phn-page-bg": bg,
    "--phn-surface-bg": mix(bg, lift, 0.06),
    "--phn-surface-alt-bg": mix(bg, lift, 0.10),
    "--phn-elevated-bg": mix(bg, lift, 0.13),
    // Light-safety set, 1 of 5. Small raised chip ON a panel. Same lift as
    // elevated, but a separate token because a skin can want them apart (OLED
    // does). Derived, never inherited: the built-in skins pin it to #2C3037,
    // which is a black box on an imported light theme.
    "--phn-chip-bg": mix(bg, lift, 0.13),
    // Light-safety set, 2 of 5. Text ON that chip. The built-in skins pin it
    // to #D3D7DD because their chip fill is a fixed neutral grey; here the
    // chip is derived from the theme's own background, so the theme's own
    // foreground is the matching pair.
    "--phn-panel-fg": fg,
    "--phn-surface-border": mix(bg, lift, 0.16),
    "--phn-text-fg": fg,
    "--phn-text-active": mix(fg, emph, 0.2),
    // Light-safety set, 3 of 5. Emphasis text. Same derivation as
    // --phn-text-active because that is what it means; it exists as a separate
    // name only because eight sites already spell it this way.
    "--phn-text-bright": mix(fg, emph, 0.2),
    "--phn-text-dim": mix(fg, bg, 0.35),
    "--phn-text-faint": mix(fg, bg, 0.55),
    "--phn-link": accent,
    "--phn-accent-hover": mix(accent, lift, 0.15),
    "--phn-accent-subtle": rgba(accent, 0.15),
    "--phn-accent-fg": readableOn(accent),
    "--phn-focus-ring": rgba(accent, 0.6),
    // Light-safety set, 4 of 5. Opaque 1px keyboard focus outline (see
    // styles.css). The accent is the right answer for an imported theme: it is
    // the one colour the theme author guaranteed reads against their bg.
    "--phn-focus-outline": accent,
    // Light-safety set, 5 of 5. `lift` is #000000 for a light theme, so
    // this is already a black wash there rather than an inverted white one.
    "--phn-hover-bg": rgba(lift, dark ? 0.06 : 0.05),
    // COMPONENT-LITERAL SET. The fourteen built-in blocks PIN these to the exact
    // hex the .jsx files hardcoded before the light skins existed, so declaring
    // them there is a no-op for all twelve dark ones. An imported theme has no
    // such history, so each is derived from the theme's own background /
    // foreground / accent and inverts for free when `dark` is false. Omitting
    // any of them is the A11Y-01 shape again: an imported LIGHT theme would keep
    // the base DARK skin's pinned value and paint white ink on white surfaces.
    // --phn-wash-rgb is an RGB TRIPLE, not a colour: sites spell it
    // rgba(var(--phn-wash-rgb), 0.08), so one token flips every alpha wash in
    // the app while each site keeps its own alpha.
    "--phn-wash-rgb": dark ? "255,255,255" : "0,0,0",
    "--phn-ink": emph,
    "--phn-ink-soft": mix(fg, emph, 0.2),
    "--phn-ink-dim": mix(fg, bg, 0.35),
    // A recessed read-only well sinks AWAY from the lift direction; a small
    // raised control on a panel moves with it. Same pair, opposite signs.
    "--phn-well-bg": mix(bg, dark ? "#000000" : "#ffffff", 0.3),
    "--phn-raised-bg": mix(bg, lift, 0.1),
    // Notice-surface text. Pushed toward the emphasis end on a light theme
    // because all three render as small text on a tinted panel, where the raw
    // accent / yellow / red a theme author chose for a dark background lands
    // around 2:1.
    "--phn-notice-accent": mix(accent, emph, dark ? 0 : 0.3),
    "--phn-notice-warn-fg": mix(n.yellow || "#E0A04F", emph, dark ? 0.12 : 0.55),
    "--phn-notice-error-fg": mix(n.red || "#E05B5B", emph, dark ? 0.12 : 0.45),
    "--phn-tabstrip-bg": mix(bg, lift, 0.03),
    "--phn-tab-bg": mix(bg, lift, 0.05),
    "--phn-tab-bg-hover": mix(bg, lift, 0.09),
    "--phn-tab-bg-active": bg,
    "--phn-tab-fg": mix(fg, bg, 0.4),
    "--phn-tab-fg-active": fg,
    "--phn-success": n.green || "#5fd75f",
    "--phn-warning": n.yellow || "#e5e510",
    "--phn-danger": n.red || "#ff5f5f",
  };
}

function warpDocToTheme(w) {
  if (!w || typeof w !== "object" || !w.background || !w.foreground) {
    throw new Error("Not a Warp theme. Needs at least `background` and `foreground`.");
  }
  // Validate every color is a real hex value before it flows into the CSS sink
  // (deriveChrome) or the xterm palette. Reject the whole theme on any bad color.
  const checks = [["background", w.background], ["foreground", w.foreground]];
  if (w.accent != null) checks.push(["accent", w.accent]);
  for (const grp of ["normal", "bright"]) {
    const c = w.terminal_colors && w.terminal_colors[grp];
    if (c && typeof c === "object") {
      for (const [k, v] of Object.entries(c)) if (v != null) checks.push([`${grp}.${k}`, v]);
    }
  }
  const bad = checks.find(([, v]) => !isHexColor(v));
  if (bad) throw new Error(`Invalid color for "${bad[0]}": ${bad[1]}. Use #rgb / #rrggbb hex.`);

  const dark = luminance(w.background) < 0.45;
  const name = (typeof w.name === "string" && w.name.trim()) || "Imported theme";
  return {
    id: `${slug(name)}-${Date.now().toString(36)}`,
    name,
    dark,
    xterm: warpXterm(w, dark),
    chrome: deriveChrome(w, dark),
    source: { accent: w.accent || w.foreground, background: w.background, foreground: w.foreground },
  };
}

// Parse one or more Warp themes from YAML text (multi-doc supported).
export function warpYamlToThemes(text) {
  const docs = yaml.loadAll(text).filter(Boolean);
  if (!docs.length) throw new Error("No YAML documents found.");
  return docs.map(warpDocToTheme);
}

// ── Pluto → Warp ─────────────────────────────────────────────────────────────
export function themeToWarpYaml(theme) {
  const xt = theme.xterm || {};
  const doc = {
    name: theme.name,
    accent: theme.source?.accent || xt.cursor || xt.foreground,
    background: xt.background,
    foreground: xt.foreground,
    details: theme.dark ? "darker" : "lighter",
    terminal_colors: {
      normal: { black: xt.black, red: xt.red, green: xt.green, yellow: xt.yellow, blue: xt.blue, magenta: xt.magenta, cyan: xt.cyan, white: xt.white },
      bright: { black: xt.brightBlack, red: xt.brightRed, green: xt.brightGreen, yellow: xt.brightYellow, blue: xt.brightBlue, magenta: xt.brightMagenta, cyan: xt.brightCyan, white: xt.brightWhite },
    },
  };
  return yaml.dump(doc, { lineWidth: -1 });
}

// A small built-in example so users can try the feature without hunting for a
// YAML file. (Dracula — the canonical Warp theme.)
export const EXAMPLE_WARP_YAML = `name: Dracula
accent: "#bd93f9"
background: "#282a36"
foreground: "#f8f8f2"
details: darker
terminal_colors:
  normal:
    black: "#21222c"
    red: "#ff5555"
    green: "#50fa7b"
    yellow: "#f1fa8c"
    blue: "#bd93f9"
    magenta: "#ff79c6"
    cyan: "#8be9fd"
    white: "#f8f8f2"
  bright:
    black: "#6272a4"
    red: "#ff6e6e"
    green: "#69ff94"
    yellow: "#ffffa5"
    blue: "#d6acff"
    magenta: "#ff92df"
    cyan: "#a4ffff"
    white: "#ffffff"
`;
