// (C)
// Token gate for the --phn-* design system.
//
// WHY this exists: a CSS custom property that is USED but never DECLARED does
// not error, does not warn, and does not fail eslint. It silently resolves to
// whatever literal sits in its own var(--x, FALLBACK) fallback. Every fallback
// in this codebase predates the light skins and is therefore a dark-mode
// colour, so an undeclared token is a light-mode bug that is invisible to a
// dark-mode eye and invisible to every other check in CI.
//
// That is not hypothetical. --phn-text-bright shipped used 8 times and declared
// zero times (audit A11Y-01): it froze on #F2F4F7, which put the Assistant
// textarea at 1.10:1 on moba-light's #ffffff. You typed and saw a blinking
// cursor and nothing else. The same scan turned up four more of the same shape
// (--phn-text, --phn-surface-elevated-bg, --phn-accent, --phn-border,
// --phn-fg-dim).
//
// WHY DECLARING THE NAME SOMEWHERE IS NOT ENOUGH. The first repair pass
// declared the missing names at :root, which made the gate green and broke two
// skins anyway:
//   * a :root ALIAS (--phn-x: var(--phn-y)) is fine, because the substitution
//     reads the ACTIVE skin's --phn-y, so it inverts per skin for free;
//   * a :root LITERAL is one colour for all fourteen skins, so the two LIGHT
//     skins (moba-light, daylight) inherit a dark value and invert.
// --phn-hover-bg was the live example: rgba(255,255,255,0.05) at :root with
// only moba / moba-light / oled overriding it, so `daylight` washed WHITE over
// its own near-white surfaces. Anything that then used the token at a site
// inverted with it.
//
// So this file checks four properties, not one:
//   1. every used token is declared, with an explicit, non-growing gap list;
//   2. every skin-dependent colour is declared in ALL FOURTEEN skin blocks AND
//      in deriveChrome(), not at :root;
//   3. :root carries no literal colour outside a named allowlist;
//   4. the two light skins actually got LIGHT values, measured, not asserted.
//
// The gate is a static scan, not a render: jsdom/happy-dom do not perform
// custom-property substitution, so asking a DOM for a computed token value
// proves nothing. Declaration presence is the property that actually matters,
// and it is checkable from source alone.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../", import.meta.url));

// A use: the var() function referencing a --phn-* name. Its fallback, if any,
// is irrelevant here: the fallback firing IS the bug.
const USE = /var\(\s*(--phn-[A-Za-z0-9_-]+)/g;
// A CSS declaration: --phn-NAME: … at the start of a declaration. Anchored on
// {, ;, a comment close or a line start so that a var() reference inside a
// value can never be mistaken for a declaration of the token it references.
const CSS_DECL = /(?:^|[;{}]|\*\/)\s*(--phn-[A-Za-z0-9_-]+)\s*:/gm;
// A JS declaration: an object key, which is how deriveChrome() in
// customThemes.js builds the token map for user-imported themes.
const JS_DECL = /["'](--phn-[A-Za-z0-9_-]+)["']\s*:/g;

// Test files are excluded on purpose: this very file names tokens in strings,
// and a fixture is not a surface a user ever sees.
const SCANNED = /\.(css|js|jsx)$/;
const IS_TEST = /\.test\.(js|jsx)$/;

// The fourteen built-in skins. Hard-coded rather than derived from the file, so
// that DELETING a skin block fails here instead of silently shrinking the
// coverage matrix. Two of them are LIGHT, which is the whole reason this file
// exists; a pass that only checked moba/oled/moba-light is what let the
// daylight inversion through.
const SKINS = [
  "amber", "brutal", "crt", "daylight", "default", "glass", "linear",
  "magenta", "moba", "moba-light", "neon", "oled", "pro", "sunset",
];
const LIGHT_SKINS = ["moba-light", "daylight"];

// Colours whose correct value depends on the background behind them, so they
// MUST be declared per skin. Adding a name here without adding it to all
// fourteen blocks (and to deriveChrome) fails.
const SKIN_SCOPED = [
  "--phn-page-bg", "--phn-surface-bg", "--phn-surface-alt-bg",
  "--phn-surface-border", "--phn-text-fg", "--phn-text-active",
  "--phn-text-dim", "--phn-link",
  "--phn-hover-bg", "--phn-text-bright", "--phn-chip-bg", "--phn-panel-fg",
  "--phn-focus-outline",
  // The accent wash. Declared in moba/oled/moba-light only until 2026-09-17;
  // the other eleven skins fell through to whatever literal each use site
  // carried, which the "declares every token" test cannot see because it
  // only asks whether a name is declared SOMEWHERE.
  "--phn-accent-subtle",
  // The COMPONENT-LITERAL set: nine names for colours that lived as hardcoded
  // hex inside .jsx files until the light skins made them wrong. Same rule, and
  // the same reason it has to be enforced rather than trusted: the twelve dark
  // blocks pin the exact old hex, so a MISSING declaration is invisible on a
  // dark skin and inverts on a light one.
  "--phn-wash-rgb", "--phn-ink", "--phn-ink-soft", "--phn-ink-dim",
  "--phn-well-bg", "--phn-raised-bg",
  "--phn-notice-accent", "--phn-notice-warn-fg", "--phn-notice-error-fg",
];

// The tab strip. These are NOT skin-scoped in the sense above: their site
// fallbacks (#24272D strip, #1b1c1f active body, #eceef0 label) are correct for
// a dark skin, so the ten dark skins that omit them render right by accident and
// nothing is gained by pinning them. A LIGHT skin that omits them gets a
// near-black tab chip on a white UI, which is what put the tab-rename input at
// 1.13:1 on daylight. So the requirement is light-only.
const TAB_SCOPED = [
  "--phn-tabstrip-bg", "--phn-tab-bg", "--phn-tab-bg-hover",
  "--phn-tab-bg-active", "--phn-tab-fg", "--phn-tab-fg-active",
];

// Colours allowed to live at :root as a literal, each because it means the same
// thing on any background. Anything else must be per-skin. Keep the reasons:
// they are the argument, and the next person will want to add a sixth.
const ROOT_LITERAL_ALLOWLIST = {
  "--phn-accent-fg": "text ON the accent fill, so its background is --phn-link, not the page",
  "--phn-success": "status green, read against a surface only as an icon/label tint",
  "--phn-warning": "status amber, same",
  "--phn-danger": "status red, same",
  "--phn-focus-ring": "translucent alpha for box-shadow rings; composites over whatever is behind",
};

// Tokens that are USED but deliberately still undeclared. This list may only
// shrink. It is asserted by exact equality, so a NEW undeclared token fails,
// and so does leaving a stale row here after one is actually fixed.
const KNOWN_GAPS = [
  // Three names that are misspellings of canonical tokens, spread across two
  // owners (terminals.css and KeybindingsSection.jsx). They cannot be repaired
  // by declaring them: the two use-site groups carry DIFFERENT fallbacks
  // (#7c9cf5 in terminals.css versus #6cf / #222 / #888 in
  // KeybindingsSection.jsx), so no single per-skin value leaves both groups
  // rendering what they render today. And they cannot be repaired by renaming
  // to --phn-link / --phn-surface-border / --phn-text-dim either, because each
  // of those is a different colour in 12 of the 14 skins, so the rename
  // recolours ten dark skins in order to fix two light ones. Closing this needs
  // one owner deciding for all five sites at once, most likely by splitting the
  // name in two.
  "--phn-accent",
  "--phn-border",
  "--phn-fg-dim",
];

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (SCANNED.test(entry.name) && !IS_TEST.test(entry.name)) out.push(full);
  }
  return out;
}

function scan() {
  const used = new Map(); // token -> Set of relative paths
  const declared = new Map();
  const add = (map, token, rel) => {
    if (!map.has(token)) map.set(token, new Set());
    map.get(token).add(rel);
  };
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    for (const m of text.matchAll(USE)) add(used, m[1], rel);
    for (const m of text.matchAll(CSS_DECL)) add(declared, m[1], rel);
    // .js/.jsx can hold both shapes: an object-literal token map and CSS text
    // inside a template literal. Check both rather than guessing by extension.
    if (!file.endsWith(".css")) for (const m of text.matchAll(JS_DECL)) add(declared, m[1], rel);
  }
  return { used, declared };
}

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// The declaration body of one selector's block, comments removed. Matches the
// WHOLE selector, so `[data-phn-skin="default"].phn-header` is never mistaken
// for the `[data-phn-skin="default"]` token block.
function blockBody(css, selector) {
  const clean = stripComments(css);
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = clean.match(new RegExp("(?:^|\\})\\s*" + esc + "\\s*\\{([^}]*)\\}", "m"));
  return m ? m[1] : null;
}
function declMap(body) {
  const out = new Map();
  if (body == null) return out;
  for (const m of body.matchAll(/(--phn-[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

// WCAG relative luminance, so "is this a light value" is measured rather than
// eyeballed. Alpha colours composite over the supplied backdrop first.
function parseColor(s) {
  if (!s) return null;
  const v = s.trim();
  let m = v.match(/^#([0-9a-fA-F]{3})$/);
  if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 1];
  m = v.match(/^#([0-9a-fA-F]{6})$/);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  return null;
}
function luminance(c) {
  const f = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function contrast(fgRaw, bgRaw) {
  const bg = parseColor(bgRaw);
  let fg = parseColor(fgRaw);
  if (!bg || !fg) return null;
  if (fg[3] < 1) fg = [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("--phn-* token gate", () => {
  it("finds tokens at all (guards against a scanner that silently matches nothing)", () => {
    const { used, declared } = scan();
    // A regex that stops matching would make every other assertion here pass
    // vacuously, which is the failure mode that makes a green gate dangerous.
    expect(used.size).toBeGreaterThan(40);
    expect(declared.size).toBeGreaterThan(40);
    expect(declared.has("--phn-text-active")).toBe(true);
    expect(used.has("--phn-text-active")).toBe(true);
  });

  it("declares every --phn-* token any source file uses, except the named gaps", () => {
    const { used, declared } = scan();
    const undeclared = [...used.keys()].filter((t) => !declared.has(t)).sort();
    expect(
      undeclared,
      "the set of undeclared --phn-* tokens changed.\n" +
        `expected exactly: ${[...KNOWN_GAPS].sort().join(", ")}\n` +
        `found:            ${undeclared.join(", ") || "(none)"}\n` +
        "Fix by pointing the use site at a token declared in all fourteen skin\n" +
        "blocks, or by declaring the name there. Do NOT declare it at :root as a\n" +
        "literal (see the :root literal-colour rule below)."
    ).toEqual([...KNOWN_GAPS].sort());
  });
});

describe("skin coverage", () => {
  const css = read("features/terminals/headerSkins.css");

  it("has a token block for each of the fourteen built-in skins", () => {
    for (const skin of SKINS) {
      const body = blockBody(css, `[data-phn-skin="${skin}"]`);
      expect(body, `no [data-phn-skin="${skin}"] token block`).not.toBeNull();
      expect(declMap(body).size, `${skin}'s block declares nothing`).toBeGreaterThan(5);
    }
  });

  it("declares every skin-scoped colour in ALL fourteen blocks", () => {
    // The check that would have caught the --phn-hover-bg trap before it
    // shipped: only 3 of the 14 blocks declared it, and the 11 that inherited
    // included a light skin.
    const missing = [];
    for (const skin of SKINS) {
      const decls = declMap(blockBody(css, `[data-phn-skin="${skin}"]`));
      for (const token of SKIN_SCOPED) if (!decls.has(token)) missing.push(`${skin} is missing ${token}`);
    }
    expect(missing, `skin blocks missing a skin-scoped colour:\n${missing.join("\n")}`).toEqual([]);
  });

  it("declares every skin-scoped colour in deriveChrome() too (the 15th block)", () => {
    // Custom themes land as [data-phn-theme="custom"] on the SAME element as the
    // base skin's [data-phn-skin] and only win for the properties they declare.
    // A token missing from deriveChrome() means an imported LIGHT theme silently
    // keeps the base DARK skin's value for it.
    const js = read("features/terminals/customThemes.js");
    const missing = SKIN_SCOPED.filter((t) => !new RegExp(`"${t}"\\s*:`).test(js));
    expect(missing, `deriveChrome() is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("declares the tab-strip tokens in the two LIGHT skins", () => {
    // Light-only on purpose (see TAB_SCOPED). Without these, daylight painted a
    // #1b1c1f active tab body carrying #eceef0 label text on a white UI, and the
    // tab-rename input, which inherits that chip as its backdrop, measured
    // 1.13:1 there. The dark skins are correct via their site fallbacks.
    const missing = [];
    for (const skin of LIGHT_SKINS) {
      const decls = declMap(blockBody(css, `[data-phn-skin="${skin}"]`));
      for (const token of TAB_SCOPED) if (!decls.has(token)) missing.push(`${skin} is missing ${token}`);
    }
    expect(missing, `light skins missing a tab-strip token:\n${missing.join("\n")}`).toEqual([]);
  });

  it("pins the component-literal set to the pre-skin hex in all twelve DARK blocks", () => {
    // The invariant that makes this whole family safe to introduce: every dark
    // skin must resolve to EXACTLY what the .jsx literal rendered before, so
    // adding the tokens is provably a no-op for twelve of the fourteen. The
    // previous attempt at these sites pointed them at --phn-text-active /
    // --phn-hover-bg / --phn-chip-bg instead, which is a different colour in
    // most dark skins, and it silently recoloured ten of them.
    const PINNED = {
      "--phn-wash-rgb": "255,255,255",   // was rgba(255,255,255,α) at every wash site
      "--phn-ink": "#ffffff",            // was #fff
      "--phn-ink-soft": "#E6E6E6",       // was #E6E6E6
      "--phn-ink-dim": "#9D9D9D",        // was #9D9D9D
      "--phn-well-bg": "#0e1114",        // was #0e1114
      "--phn-raised-bg": "#23272d",      // was #23272d
      "--phn-notice-accent": "#7c9cf5",  // was #7c9cf5
      "--phn-notice-warn-fg": "#E0A04F", // was #E0A04F
      "--phn-notice-error-fg": "#E05B5B", // was #E05B5B
    };
    const wrong = [];
    for (const skin of SKINS.filter((s) => !LIGHT_SKINS.includes(s))) {
      const decls = declMap(blockBody(css, `[data-phn-skin="${skin}"]`));
      for (const [token, want] of Object.entries(PINNED)) {
        const got = decls.get(token);
        if (got !== want) wrong.push(`${skin} ${token}: ${got} (want ${want})`);
      }
    }
    expect(wrong, `a dark skin drifted off the pinned pre-skin value:\n${wrong.join("\n")}`).toEqual([]);
  });

  it("gives both LIGHT skins a black wash and dark ink for that same set", () => {
    for (const skin of LIGHT_SKINS) {
      const d = declMap(blockBody(css, `[data-phn-skin="${skin}"]`));
      expect(d.get("--phn-wash-rgb"), `${skin} wash is not black`).toBe("0,0,0");
      for (const token of ["--phn-ink", "--phn-ink-soft", "--phn-ink-dim",
        "--phn-notice-accent", "--phn-notice-warn-fg", "--phn-notice-error-fg"]) {
        const c = parseColor(d.get(token));
        expect(c, `${skin} ${token} is not a plain colour`).not.toBeNull();
        expect(luminance(c), `${skin} ${token} is a LIGHT value on a light skin`).toBeLessThan(0.4);
      }
      for (const token of ["--phn-well-bg", "--phn-raised-bg"]) {
        const c = parseColor(d.get(token));
        expect(c, `${skin} ${token} is not a plain colour`).not.toBeNull();
        expect(luminance(c), `${skin} ${token} is a DARK fill on a light skin`).toBeGreaterThan(0.6);
      }
    }
  });
});

describe(":root literal-colour rule", () => {
  const css = read("features/terminals/headerSkins.css");

  it("declares no literal colour at :root outside the named allowlist", () => {
    // THE rule the first repair pass violated. An alias at :root is fine; a
    // literal is one colour for fourteen skins and hands the light ones a dark
    // value. Flags hex and rgb()/rgba() literals; ignores aliases, gradients,
    // fonts, sizes and shadows.
    const decls = declMap(blockBody(css, ":root"));
    const offenders = [];
    for (const [token, value] of decls) {
      if (/^var\(/.test(value)) continue;                        // alias: skin-neutral
      if (!/^(#[0-9a-fA-F]{3,8}|rgba?\()/.test(value)) continue;  // not a flat colour
      if (token in ROOT_LITERAL_ALLOWLIST) continue;
      offenders.push(`${token}: ${value}`);
    }
    expect(
      offenders,
      "literal colour(s) declared only at :root. Every skin, including the two\n" +
        "LIGHT ones, inherits this exact value. Declare it in all fourteen\n" +
        "[data-phn-skin] blocks instead, or add it to ROOT_LITERAL_ALLOWLIST with\n" +
        `a reason it is background-independent:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("keeps the allowlist honest (no stale entries)", () => {
    const decls = declMap(blockBody(css, ":root"));
    const stale = Object.keys(ROOT_LITERAL_ALLOWLIST).filter((t) => !decls.has(t));
    expect(stale, `allowlisted but no longer declared at :root: ${stale.join(", ")}`).toEqual([]);
  });
});

describe("the two light skins really are light", () => {
  const css = read("features/terminals/headerSkins.css");
  const decls = Object.fromEntries(
    SKINS.map((s) => [s, declMap(blockBody(css, `[data-phn-skin="${s}"]`))])
  );

  it("gives each light skin a BLACK-alpha hover wash and each dark skin a white one", () => {
    // The CRITICAL, stated as a property. A white alpha over a near-white
    // surface is the inversion, and it is exactly what --phn-hover-bg did to
    // daylight for as long as daylight inherited it from :root.
    for (const skin of LIGHT_SKINS) {
      const v = decls[skin].get("--phn-hover-bg");
      expect(v, `${skin} has no --phn-hover-bg`).toBeTruthy();
      expect(v, `${skin} hover wash "${v}" is a white alpha over a light surface`)
        .toMatch(/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/);
    }
    for (const skin of SKINS.filter((s) => !LIGHT_SKINS.includes(s))) {
      expect(decls[skin].get("--phn-hover-bg"), `${skin} lost its white hover wash`)
        .toMatch(/^rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/);
    }
  });

  it("gives each light skin dark emphasis/chip text, and each dark skin light", () => {
    for (const skin of SKINS) {
      const light = LIGHT_SKINS.includes(skin);
      for (const token of ["--phn-text-bright", "--phn-panel-fg"]) {
        const c = parseColor(decls[skin].get(token));
        expect(c, `${skin} ${token} is not a plain colour`).not.toBeNull();
        const l = luminance(c);
        if (light) expect(l, `${skin} ${token} is a LIGHT value on a light skin`).toBeLessThan(0.4);
        else expect(l, `${skin} ${token} is a DARK value on a dark skin`).toBeGreaterThan(0.4);
      }
    }
  });

  it("validates moba-light's text tiers against its OWN page background", () => {
    // The regression this replaced: both tiers were tuned on --phn-surface-bg
    // (#ececec) and then painted on --phn-page-bg (#d9d9d9) by the F-key bar,
    // where they scored 4.07 and 2.80. Validating on the lighter surface and
    // then painting on the darker one can only lose contrast.
    const d = decls["moba-light"];
    const page = d.get("--phn-page-bg");
    for (const token of ["--phn-text-dim", "--phn-text-faint"]) {
      const ratio = contrast(d.get(token), page);
      expect(ratio, `moba-light ${token} on its page bg ${page} is unmeasurable`).not.toBeNull();
      expect(ratio, `moba-light ${token} scores ${ratio && ratio.toFixed(2)} on ${page}, under AA`)
        .toBeGreaterThanOrEqual(4.5);
    }
    // The hierarchy the two tiers exist for: dim stays darker than faint.
    expect(luminance(parseColor(d.get("--phn-text-dim"))))
      .toBeLessThan(luminance(parseColor(d.get("--phn-text-faint"))));
  });

  it("keeps each light skin's focus outline over the 3:1 non-text floor", () => {
    for (const skin of LIGHT_SKINS) {
      const d = decls[skin];
      const ratio = contrast(d.get("--phn-focus-outline"), d.get("--phn-page-bg"));
      expect(ratio, `${skin} focus outline scores ${ratio && ratio.toFixed(2)} on its page bg`)
        .toBeGreaterThanOrEqual(3);
    }
  });
});

describe("skin-aware base layer", () => {
  const css = read("features/terminals/headerSkins.css");

  it("keeps the F-key bar on --phn-page-bg, distinct from the hover fill", () => {
    // It was briefly repainted with --phn-surface-bg to buy the light skin
    // contrast. That moved 7 of the 12 dark skins and collapsed .phn-fn:hover,
    // which fills with surface-bg, into the bar colour in all fourteen. The
    // contrast problem belonged to moba-light's token VALUES, not to the bar.
    const clean = stripComments(css);
    const bar = clean.match(/\.phn-fnbar\s*\{[^}]*\}/);
    expect(bar).not.toBeNull();
    expect(bar[0]).toMatch(/background:\s*var\(--phn-page-bg/);
    const hover = clean.match(/\.phn-fn:hover\s*\{[^}]*\}/);
    expect(hover).not.toBeNull();
    expect(hover[0], "hover fill must differ from the bar fill").toMatch(/background:\s*var\(--phn-surface-bg/);
  });

  it("themes body and the global focus ring instead of hardcoding dark values", () => {
    // styles.css loads for every window including the pre-React frame, so a
    // literal here shows through as black behind a light UI, near-white
    // inherited text, and a focus ring at 1.88:1 on the light page.
    const sheet = read("styles.css");
    const body = sheet.match(/\bbody\s*\{[^}]*\}/);
    expect(body).not.toBeNull();
    expect(body[0]).toMatch(/background:\s*var\(--phn-page-bg/);
    expect(body[0]).toMatch(/color:\s*var\(--phn-text-fg/);
    const focus = sheet.match(/button:focus[^{]*\{[^}]*\}/);
    expect(focus).not.toBeNull();
    // --phn-focus-outline, not --phn-link: --phn-link is a different colour in
    // 12 of the 14 skins, so it would recolour the ring on ten dark skins.
    expect(focus[0]).toMatch(/outline:\s*1px solid var\(--phn-focus-outline/);
  });
});
