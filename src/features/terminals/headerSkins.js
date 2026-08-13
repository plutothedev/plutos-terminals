// App skins — user-selectable visual themes for the entire app.
//
// Each skin scoped by [data-phn-skin="<id>"] on the app root. Inject CSS once
// via injectHeaderSkinsCss(). The skin defines:
//   - CSS rules for the header (.phn-header, .phn-title, .phn-btn, etc.)
//   - CSS rules for the page (.phn-page), status bar (.phn-statusbar),
//     sidebar (.phn-sidebar / .phn-sidebar-header)
//   - CSS variables (--phn-page-bg / --phn-surface / --phn-border / etc.)
//   - An xterm theme object (background / foreground / cursor / ANSI palette)
//
// Helpers:
//   - getSkinId(stored) → resolves to known id, defaults to "default"
//   - getSkinXtermTheme(skinId, { pureBlackTerminal }) → xterm theme object
//
// Inline styles continue to handle pure layout (padding/gap/fontSize/grid).
// Visual styling lives in CSS keyed by data-phn-skin attribute.

import "./headerSkins.css"; // static skin CSS (P4-T4) — see that file's header

const ANSI_DARK = {
  black: "#1a1a2e", red: "#ff6b6b", green: "#51cf66", yellow: "#ffd43b",
  blue: "#748ffc", magenta: "#da77f2", cyan: "#66d9e8", white: "#d4d4d4",
  brightBlack: "#555555", brightRed: "#ff8787", brightGreen: "#69db7c",
  brightYellow: "#ffe066", brightBlue: "#91a7ff", brightMagenta: "#e599f7",
  brightCyan: "#99e9f2", brightWhite: "#ffffff",
};

const ANSI_LIGHT = {
  black: "#383a42", red: "#e45649", green: "#50a14f", yellow: "#c18401",
  blue: "#4078f2", magenta: "#a626a4", cyan: "#0184bc", white: "#fafafa",
  brightBlack: "#a0a1a7", brightRed: "#e45649", brightGreen: "#50a14f",
  brightYellow: "#c18401", brightBlue: "#4078f2", brightMagenta: "#a626a4",
  brightCyan: "#0184bc", brightWhite: "#fafafa",
};

export const HEADER_SKINS = [
  {
    id: "default",
    label: "Default — flat dark, cyan accent",
    description: "The original. Subtle, gets out of the way.",
    xterm: {
      background: "#0a0a0a", foreground: "#d4d4d4", cursor: "#f8f8f2",
      selectionBackground: "rgba(248,248,242,0.2)",
      ...ANSI_DARK,
    },
  },
  {
    id: "neon",
    label: "Neon Cyberpunk — magenta + cyan glow",
    description: "Edgy, photogenic, distinctive. Glow on hover.",
    xterm: {
      background: "#0a0a14", foreground: "#00fff7", cursor: "#FF0080",
      selectionBackground: "rgba(255,0,128,0.3)",
      ...ANSI_DARK, cyan: "#00fff7", brightCyan: "#7fffff", magenta: "#FF0080", brightMagenta: "#ff66b3",
    },
  },
  {
    id: "magenta",
    label: "Pluto Magenta — brand color",
    description: "Magenta replaces cyan as the primary accent. Brand-forward.",
    xterm: {
      background: "#0a0a0a", foreground: "#d4d4d4", cursor: "#FF0080",
      selectionBackground: "rgba(255,0,128,0.25)",
      ...ANSI_DARK,
    },
  },
  {
    id: "crt",
    label: "Retro CRT — phosphor green, all caps",
    description: "Classic VT100 monochrome green-on-black. Strong aesthetic commitment.",
    xterm: {
      background: "#001408", foreground: "#33ff66", cursor: "#33ff66",
      selectionBackground: "rgba(51,255,102,0.3)",
      black: "#001408", red: "#33ff66", green: "#33ff66", yellow: "#66ff99",
      blue: "#33ff66", magenta: "#33ff66", cyan: "#66ff99", white: "#99ffaa",
      brightBlack: "#1a8033", brightRed: "#66ff99", brightGreen: "#66ff99",
      brightYellow: "#99ffaa", brightBlue: "#66ff99", brightMagenta: "#66ff99",
      brightCyan: "#99ffaa", brightWhite: "#ccffdd",
    },
  },
  {
    id: "linear",
    label: "Modern Dark — refined SaaS polish",
    description: "Linear / Vercel feel. Filled buttons, gradients, micro-shadows.",
    xterm: {
      background: "#18181b", foreground: "#fafafa", cursor: "#fafafa",
      selectionBackground: "rgba(255,255,255,0.15)",
      ...ANSI_DARK,
    },
  },
  {
    id: "brutal",
    label: "Brutalist Mono — black/white, sharp",
    description: "No accent color, square corners, all caps. Confidence.",
    xterm: {
      background: "#000000", foreground: "#ffffff", cursor: "#ffffff",
      selectionBackground: "rgba(255,255,255,0.3)",
      black: "#000000", red: "#ffffff", green: "#ffffff", yellow: "#ffffff",
      blue: "#ffffff", magenta: "#ffffff", cyan: "#ffffff", white: "#ffffff",
      brightBlack: "#888888", brightRed: "#ffffff", brightGreen: "#ffffff",
      brightYellow: "#ffffff", brightBlue: "#ffffff", brightMagenta: "#ffffff",
      brightCyan: "#ffffff", brightWhite: "#ffffff",
    },
  },
  {
    id: "glass",
    label: "Glassmorphic — translucent backdrop-blur",
    description: "macOS-style frosted glass. Header floats over a subtly-tinted page.",
    xterm: {
      background: "#0a0a14", foreground: "#e0e0e8", cursor: "#ffffff",
      selectionBackground: "rgba(255,255,255,0.2)",
      ...ANSI_DARK,
    },
  },
  {
    id: "sunset",
    label: "Synthwave Sunset — purple→orange gradient",
    description: "80s retro-future. Hot pink title with glow.",
    xterm: {
      background: "#1a0530", foreground: "#ffd0e8", cursor: "#ff6ec7",
      selectionBackground: "rgba(255,110,199,0.3)",
      black: "#1a0530", red: "#ff6ec7", green: "#69ff94", yellow: "#ffd700",
      blue: "#a78bfa", magenta: "#ff6ec7", cyan: "#7fffff", white: "#ffd0e8",
      brightBlack: "#5a3470", brightRed: "#ff8fd6", brightGreen: "#85ffaa",
      brightYellow: "#ffe066", brightBlue: "#c4a9ff", brightMagenta: "#ff8fd6",
      brightCyan: "#9affff", brightWhite: "#ffffff",
    },
  },
  {
    id: "amber",
    label: "Solarized Amber — vintage monochrome",
    description: "Hercules-monitor warm amber. Easy on long sessions.",
    xterm: {
      background: "#1a0f00", foreground: "#ffb000", cursor: "#ffb000",
      selectionBackground: "rgba(255,176,0,0.3)",
      black: "#1a0f00", red: "#ffb000", green: "#ffd966", yellow: "#ffd966",
      blue: "#ffb000", magenta: "#ffb000", cyan: "#ffd966", white: "#ffd966",
      brightBlack: "#805500", brightRed: "#ffc14d", brightGreen: "#ffe699",
      brightYellow: "#ffe699", brightBlue: "#ffc14d", brightMagenta: "#ffc14d",
      brightCyan: "#ffe699", brightWhite: "#fff2cc",
    },
  },
  {
    id: "daylight",
    label: "Daylight — light theme",
    description: "White bg, dark text. Only skin usable outdoors / in bright rooms.",
    xterm: {
      background: "#fafafa", foreground: "#383a42", cursor: "#526fff",
      selectionBackground: "rgba(82,111,255,0.2)",
      ...ANSI_LIGHT,
    },
  },
  {
    id: "pro",
    label: "Pro — Linear-inspired dark",
    description: "Clean, precise, modern. Professional terminal-emulator aesthetic (Termius / Linear).",
    xterm: {
      background: "#08090a",
      foreground: "#b4b8c0",
      cursor: "#5e6ad2",
      selectionBackground: "rgba(94,106,210,0.3)",
      black: "#1a1a1b", red: "#ef4444", green: "#10b981", yellow: "#f59e0b",
      blue: "#5e6ad2", magenta: "#a78bfa", cyan: "#22d3ee", white: "#b4b8c0",
      brightBlack: "#4b4b4d", brightRed: "#f87171", brightGreen: "#34d399",
      brightYellow: "#fbbf24", brightBlue: "#828fff", brightMagenta: "#c4b5fd",
      brightCyan: "#67e8f9", brightWhite: "#f7f8f8",
    },
  },
  // ── The core chrome themes (v5): Dark, Light, and OLED Black. Dark/Light
  //    keep the terminal near-black — the toggle only repaints the chrome;
  //    OLED turns every surface (chrome AND terminal) true #000.
  {
    id: "moba",
    label: "Dark",
    description: "Refined dark chrome, hairline borders, periwinkle accent (mockup 23).",
    xterm: {
      background: "#0c0d0e",
      foreground: "#c6c8cc",
      cursor: "#c6c8cc",
      selectionBackground: "rgba(124,156,245,0.30)",
      black: "#26282b", red: "#e08784", green: "#7fbf8a", yellow: "#d2b36b",
      blue: "#7c9cf5", magenta: "#c49ad1", cyan: "#6fbcc9", white: "#c6c8cc",
      brightBlack: "#67696e", brightRed: "#eda3a0", brightGreen: "#9bd3a5",
      brightYellow: "#e3ca8e", brightBlue: "#9cb5f7", brightMagenta: "#d7b3e2",
      brightCyan: "#8fd0db", brightWhite: "#eceef0",
    },
  },
  {
    id: "moba-light",
    label: "Light",
    description: "Light chrome and a matching light terminal.",
    // `light` marks a skin whose terminal is light-on-dark-text. It suppresses
    // the pure-black terminal override (an OLED tweak that would otherwise
    // paint a black background under this palette's dark text — unreadable).
    light: true,
    // Light terminal palette so the shell matches the chrome instead of sitting
    // as a dark rectangle inside a light app. Hues follow the One Light family
    // already shipped as the "Pluto Light" terminal theme (themes.js), which is
    // tuned for contrast against a near-white background.
    //
    // ANSI white/brightWhite deliberately do NOT map to near-white here: on a
    // light background that renders them invisible (the existing Pluto Light
    // theme has that flaw — both are #fafafa, the background colour). They map
    // to greys instead, and every bright* variant is DARKER than its base,
    // since on a light background more contrast — not more luminance — is what
    // "bright" has to mean.
    //
    // Hues come from the One Light family, then each was darkened until it
    // cleared WCAG AA (4.5:1) against the background, with bright variants at
    // 5.5:1 so they stay distinguishable from their base. The stock One Light
    // values sit at 3.0-3.9 against white — fine for a marketing page, thin for
    // terminal-sized text (yellow was the worst at 3.06). brightBlack stays
    // deliberately faint: it is what tools use for de-emphasized text.
    xterm: {
      background: "#fafafa",
      foreground: "#383a42",
      cursor: "#526fff",
      selectionBackground: "rgba(82,111,255,0.20)",
      black: "#383a42", red: "#c44b3f", green: "#407e3f", yellow: "#976801",
      blue: "#3a6edd", magenta: "#a626a4", cyan: "#0178ac", white: "#6f737b",
      brightBlack: "#a0a1a7", brightRed: "#ad4337", brightGreen: "#3a7239",
      brightYellow: "#865c01", brightBlue: "#315fbe", brightMagenta: "#8e1b8c",
      brightCyan: "#016b98", brightWhite: "#60646a",
    },
  },
  {
    id: "oled",
    label: "OLED Black",
    description: "True #000 everywhere — chrome, panels, terminal. Separation comes from hairlines, not luminance.",
    // Dark's readable palette over a true-black well; on OLED panels every
    // background pixel is literally off.
    xterm: {
      background: "#000000",
      foreground: "#c6c8cc",
      cursor: "#c6c8cc",
      selectionBackground: "rgba(124,156,245,0.30)",
      black: "#26282b", red: "#e08784", green: "#7fbf8a", yellow: "#d2b36b",
      blue: "#7c9cf5", magenta: "#c49ad1", cyan: "#6fbcc9", white: "#c6c8cc",
      brightBlack: "#67696e", brightRed: "#eda3a0", brightGreen: "#9bd3a5",
      brightYellow: "#e3ca8e", brightBlue: "#9cb5f7", brightMagenta: "#d7b3e2",
      brightCyan: "#8fd0db", brightWhite: "#eceef0",
    },
  },
];

export function getSkinXtermTheme(skinId, opts = {}) {
  const skin = HEADER_SKINS.find((s) => s.id === skinId) || HEADER_SKINS[0];
  // pureBlackTerminal is an OLED power tweak; forcing it onto a light skin
  // would paint a black background under dark text, so light skins opt out.
  if (opts.pureBlackTerminal && !skin.light) {
    return { ...skin.xterm, background: "#000000" };
  }
  return skin.xterm;
}

// Header button styles — orthogonal axis to skins. Skin sets colors;
// button-style sets shape / border / padding / hover behavior. Combine any
// skin with any button-style. Default keeps current bordered-rectangle look.
export const HEADER_BUTTON_STYLES = [
  {
    id: "default",
    label: "Default — bordered rectangle",
    description: "Current button look. Subtle, gets out of the way.",
  },
  {
    id: "pill",
    label: "Pill — fully rounded with soft fill",
    description: "Rounded ends, subtle filled background, lift on hover. Friendlier feel.",
  },
  {
    id: "ghost",
    label: "Ghost — underline only on hover",
    description: "No border at rest, underline appears on hover. Most minimal.",
  },
  {
    id: "filled",
    label: "Filled — solid accent CTA",
    description: "Every button reads as a primary action. Loud, confident.",
  },
  {
    id: "bracket",
    label: "Bracket — terminal [label] aesthetic",
    description: "No borders, text wrapped in [brackets]. Pure terminal feel.",
  },
  {
    id: "chip",
    label: "Chip — rounded with shadow",
    description: "Soft corners, subtle drop-shadow, slight elevation. Modern SaaS.",
  },
];

export function getButtonStyleId(stored) {
  const ids = HEADER_BUTTON_STYLES.map((s) => s.id);
  if (typeof stored === "string" && ids.includes(stored)) return stored;
  return "default";
}

// Apply button style globally on <html> alongside data-phn-skin so button
// shape/border/padding rules cascade everywhere (header, modals, etc.).
export function applyGlobalButtonStyle(styleId) {
  if (typeof document === "undefined") return;
  const id = HEADER_BUTTON_STYLES.find((s) => s.id === styleId) ? styleId : "default";
  document.documentElement.dataset.phnBtnStyle = id;
}

// Layout density — third axis. Skin sets colors, button-style sets shape,
// layout sets sizing/spacing of the header row. Three options for v0.1.15.
export const HEADER_LAYOUTS = [
  {
    id: "default",
    label: "Default — standard density",
    description: "Current spacing. Balanced for typical use.",
  },
  {
    id: "compact",
    label: "Compact — tight density (more buttons fit)",
    description: "Smaller padding, tighter gap, smaller font. Good for narrow windows or when you want all controls visible without crowding.",
  },
  {
    id: "spacious",
    label: "Spacious — generous density (easier to click)",
    description: "Larger padding and gap. Easier touch targets, more breathing room, slightly bigger text.",
  },
];

export function getLayoutId(stored) {
  const ids = HEADER_LAYOUTS.map((s) => s.id);
  if (typeof stored === "string" && ids.includes(stored)) return stored;
  return "default";
}

export function applyGlobalLayout(layoutId) {
  if (typeof document === "undefined") return;
  const id = HEADER_LAYOUTS.find((s) => s.id === layoutId) ? layoutId : "default";
  document.documentElement.dataset.phnLayout = id;
}

export function getSkinId(stored) {
  const ids = HEADER_SKINS.map((s) => s.id);
  if (typeof stored === "string" && ids.includes(stored)) return stored;
  // v0.4.3: OLED Black is the default aesthetic (pluto's call — replaces the
  // v0.4.0 refined-dark "moba" default). Explicitly-picked skins are kept
  // (stored is a valid id); only the unset case falls through. App.jsx also
  // runs a one-time migration converting stored "moba" → "oled".
  return "oled";
}



// Apply the active skin globally on <html> so portaled / sibling elements
// (toasts, modals rendered above the TerminalsTab subtree) inherit the
// CSS vars. Safe to call repeatedly; idempotent.
export function applyGlobalSkin(skinId) {
  if (typeof document === "undefined") return;
  const id = HEADER_SKINS.find((s) => s.id === skinId) ? skinId : "default";
  document.documentElement.dataset.phnSkin = id;
}

// ── Custom themes ────────────────────────────────────────────────────────────
// A custom theme is referenced by a stored value of "custom:<id>" and lives in
// userSt.customThemes. It reuses a base skin's structural CSS (moba/moba-light)
// but overrides every color token via an injected stylesheet scoped to
// [data-phn-theme="custom"], placed AFTER #phn-header-skins so its equal-
// specificity rules win on source order. The terminal palette comes straight
// from the theme's xterm object.

export const CUSTOM_PREFIX = "custom:";

// The skin value to actually apply. When the user enables OS sync, the live
// prefers-color-scheme picks their chosen dark vs light theme; otherwise the
// explicit per-window selection (st.headerSkin) wins.
export function effectiveSkinValue(st, userSt, osDark) {
  if (userSt?.themeFollowOS) {
    return osDark ? (userSt.themeDark || "oled") : (userSt.themeLight || "moba-light");
  }
  return st?.headerSkin;
}

export function findCustomTheme(stored, customThemes) {
  if (typeof stored !== "string" || !stored.startsWith(CUSTOM_PREFIX)) return null;
  const id = stored.slice(CUSTOM_PREFIX.length);
  return (customThemes || []).find((t) => t && t.id === id) || null;
}

// Base built-in skin used for structural CSS under an active custom theme.
function customBaseSkin(theme) {
  return theme && theme.dark === false ? "moba-light" : "moba";
}

// Effective built-in skin id for DOM/component CSS, given a stored value that
// may be a custom:<id> reference.
export function resolveBaseSkinId(stored, customThemes) {
  const custom = findCustomTheme(stored, customThemes);
  if (custom) return customBaseSkin(custom);
  return getSkinId(stored);
}

// Pure: the xterm theme object for the active selection (built-in or custom).
export function getActiveXtermTheme(stored, customThemes, opts = {}) {
  const custom = findCustomTheme(stored, customThemes);
  if (custom) {
    return opts.pureBlackTerminal ? { ...custom.xterm, background: "#000000" } : custom.xterm;
  }
  return getSkinXtermTheme(getSkinId(stored), opts);
}

function customThemeStyleEl() {
  let el = document.getElementById("phn-custom-theme");
  if (!el) {
    el = document.createElement("style");
    el.id = "phn-custom-theme";
    // Appended to <head>, which lands AFTER the skins stylesheet in source
    // order (vite injects headerSkins.css at startup, long before any theme
    // is applied) — so custom-theme vars always win the cascade. The old
    // #phn-header-skins anchor died with the runtime injector (P4-T4).
    document.head.appendChild(el);
  }
  return el;
}
// Defense-in-depth against CSS injection: this <style> is built by string
// concatenation, so a value like `#000;} body{...}` would break out of the rule.
// Themes are validated at import (customThemes.parseColor), but sanitize again
// here — only emit declarations whose key is a --phn-* custom property and whose
// value is a plain color/number token (no `;`, `{`, `}`, `:`, url(), etc.).
const SAFE_CSS_VALUE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s%]+\)|hsla?\([\d.,\s%]+\)|[a-zA-Z]+|[\d.]+(px|em|rem|%)?)$/;
function setCustomThemeCss(chrome) {
  const decls = Object.entries(chrome || {})
    .filter(([k, v]) => /^--phn-[a-z0-9-]+$/.test(k) && typeof v === "string" && SAFE_CSS_VALUE.test(v.trim()))
    .map(([k, v]) => `  ${k}: ${v.trim()};`)
    .join("\n");
  customThemeStyleEl().textContent = `[data-phn-theme="custom"]{\n${decls}\n}`;
}
function clearCustomThemeCss() {
  const el = document.getElementById("phn-custom-theme");
  if (el) el.textContent = "";
}

// Side-effecting: apply the active theme to <html>. Built-in → data-phn-skin
// only; custom → base skin + data-phn-theme="custom" + the injected overrides.
export function applyActiveTheme(stored, customThemes) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const custom = findCustomTheme(stored, customThemes);
  if (custom) {
    root.dataset.phnSkin = customBaseSkin(custom);
    root.dataset.phnTheme = "custom";
    setCustomThemeCss(custom.chrome);
  } else {
    delete root.dataset.phnTheme;
    clearCustomThemeCss();
    const id = getSkinId(stored);
    root.dataset.phnSkin = HEADER_SKINS.find((s) => s.id === id) ? id : "default";
  }
  // Boot-flash contract (Tier-1 review W1): index.html's pre-paint script
  // reads ONE per-window key holding the RESOLVED page background — written
  // here, the single place themes apply — instead of re-deriving skin logic
  // pre-paint (the derived version silently missed light skins like
  // "daylight" and would drift with every new skin). Computed AFTER the
  // dataset lands so custom themes and future skins are covered for free.
  try {
    const bg = getComputedStyle(root).getPropertyValue("--phn-page-bg").trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(bg)) {
      const w = new URLSearchParams(location.search).get("w");
      localStorage.setItem("plutos-terminals:boot-bg" + (w ? ":" + w : ""), bg);
    }
  } catch { /* blocked storage: next boot keeps the dark default */ }
}
