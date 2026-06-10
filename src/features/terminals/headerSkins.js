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
    description: "Light grey chrome, same dark terminal as Dark.",
    // Same terminal palette as Dark — the toggle only changes the chrome.
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
  if (opts.pureBlackTerminal) {
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
  // v4.0: "moba" (MobaXterm classic toolbox) is the new default aesthetic.
  // Explicitly-picked skins are kept (stored is a valid id); only the unset
  // case falls through to moba. (Pro remains selectable.)
  return "moba";
}

const CSS = `
/* v3.0: UI chrome uses a modern sans-serif everywhere (every skin); terminals
   + code stay monospace. Single source of truth for the chrome font. */
:root {
  --phn-ui-font: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --phn-mono-font: 'JetBrains Mono', Menlo, Monaco, monospace;

  /* ── Design tokens (skin-independent) — one intentional system across the
     whole app, so spacing/rhythm/elevation/type are consistent everywhere
     instead of each component improvising its own values. 4px base grid. ── */
  --phn-sp-1: 4px;
  --phn-sp-2: 8px;
  --phn-sp-3: 12px;
  --phn-sp-4: 16px;
  --phn-sp-5: 20px;
  --phn-sp-6: 24px;
  --phn-sp-8: 32px;

  --phn-r-sm: 4px;
  --phn-r-md: 6px;
  --phn-r-lg: 8px;
  --phn-r-xl: 12px;
  --phn-r-pill: 999px;

  /* Type scale — dense but with clear hierarchy. Tight line-height for UI. */
  --phn-fs-2xs: 10px;
  --phn-fs-xs: 11px;
  --phn-fs-sm: 12px;
  --phn-fs-base: 13px;
  --phn-fs-md: 14px;
  --phn-fs-lg: 16px;
  --phn-fs-xl: 20px;
  --phn-lh-tight: 1.35;
  --phn-lh: 1.55;

  /* Elevation — layered shadows (real depth, not a flat drop). Tuned for dark. */
  --phn-shadow-1: 0 1px 2px rgba(0,0,0,0.45);
  --phn-shadow-2: 0 4px 12px rgba(0,0,0,0.45), 0 1px 3px rgba(0,0,0,0.35);
  --phn-shadow-3: 0 18px 50px rgba(0,0,0,0.58), 0 4px 14px rgba(0,0,0,0.42);
  --phn-ring: 0 0 0 2px var(--phn-focus-ring, rgba(77,163,255,0.45));

  --phn-dur: 0.15s;
  --phn-ease: cubic-bezier(0.4, 0, 0.2, 1);

  /* Sensible fallbacks for the extended semantic colors so non-refined skins
     still render the new primitives correctly (each skin can override). */
  --phn-elevated-bg: var(--phn-surface-bg, #181818);
  --phn-text-faint: var(--phn-text-dim, #555);
  --phn-accent-hover: var(--phn-link, #4DAAFC);
  --phn-accent-fg: #06121f;
  --phn-success: #3FB950;
  --phn-warning: #D29922;
  --phn-danger: #F06D70;
  --phn-focus-ring: rgba(77,163,255,0.45);
  --phn-hover-bg: rgba(255,255,255,0.05);
}

/* ── App-wide skinnable surfaces (read CSS vars set per skin below). ── */
.phn-page {
  background: var(--phn-page-bg, #0a0a0a);
  color: var(--phn-text-fg, #9D9D9D);
  font-family: var(--phn-ui-font);
}
/* Mono stays opt-in: terminals set their own font; these keep code legible. */
.phn-snippet-command, .phn-mono, code, pre, kbd, samp {
  font-family: var(--phn-mono-font) !important;
}
.phn-statusbar {
  background: var(--phn-surface-bg, #181818);
  border-top: 1px solid var(--phn-surface-border, #2B2B2B);
  color: var(--phn-text-dim, #555555);
}
.phn-statusbar-divider { color: var(--phn-text-dim, #555555); opacity: 0.4; }
.phn-statusbar-active { color: var(--phn-text-active, #E6E6E6); }
.phn-statusbar-link {
  color: var(--phn-link, #4DAAFC);
  text-decoration: none;
  transition: opacity 100ms ease;
}
.phn-statusbar-link:hover { opacity: 0.7; }
/* F-key quick-action bar (workstation look) */
.phn-fnbar {
  display: flex;
  flex-shrink: 0;
  height: 26px;
  background: var(--phn-page-bg, #16181C);
  border-top: 1px solid var(--phn-surface-border, #34383F);
}
.phn-fn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: none;
  border-right: 1px solid var(--phn-surface-border, #34383F);
  background: transparent;
  color: var(--phn-text-dim, #8A909A);
  font-family: var(--phn-mono-font);
  font-size: 10.5px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.phn-fn:last-child { border-right: none; }
.phn-fn:hover { background: var(--phn-surface-bg, #24272D); color: var(--phn-text-active, #F2F4F7); }
.phn-fn b { color: var(--phn-text-faint, #586068); font-weight: 700; font-size: 9.5px; }
.phn-fn:hover b { color: var(--phn-link, #4D8FE0); }
/* Right dock (SFTP / files) + styled splitter — workstation layout */
.moba-splitter {
  width: 5px; flex-shrink: 0; cursor: col-resize;
  background: var(--phn-surface-alt-bg, #1E2125);
  border-left: 1px solid var(--phn-surface-border, #34383F);
  border-right: 1px solid var(--phn-surface-border, #34383F);
  display: flex; align-items: center; justify-content: center;
}
.moba-grip { display: flex; flex-direction: column; gap: 3px; }
.moba-grip i { width: 2px; height: 2px; background: var(--phn-text-faint, #586068); }
.moba-rightdock {
  width: 320px; flex-shrink: 0; min-height: 0;
  display: flex; flex-direction: column;
  background: var(--phn-surface-bg, #24272D);
  border-left: 1px solid var(--phn-surface-border, #34383F);
}
.moba-rd-tabs {
  display: flex; align-items: stretch; height: 32px;
  background: var(--phn-surface-alt-bg, #1E2125);
  border-bottom: 1px solid var(--phn-surface-border, #34383F);
}
.moba-rd-tab {
  display: flex; align-items: center; gap: 6px; padding: 0 12px;
  color: var(--phn-text-dim, #8A909A); font-size: 11px; cursor: pointer;
  border-right: 1px solid var(--phn-surface-border, #34383F);
  border-top: 2px solid transparent;
}
.moba-rd-tab.active {
  color: var(--phn-text-active, #F2F4F7);
  background: var(--phn-surface-bg, #24272D);
  border-top-color: var(--phn-link, #4D8FE0);
}
.moba-rd-close {
  margin-left: auto; background: transparent; border: none; cursor: pointer;
  color: var(--phn-text-dim, #8A909A); font-size: 16px; padding: 0 11px;
}
.moba-rd-close:hover { color: var(--phn-text-active, #F2F4F7); }
.moba-rd-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.phn-sidebar {
  background: var(--phn-surface-alt-bg, #0d0d0d);
  border-right: 1px solid var(--phn-surface-border, #2B2B2B);
  color: var(--phn-text-fg, #CCCCCC);
}
.phn-sidebar-header {
  background: var(--phn-surface-bg, #181818);
  border-bottom: 1px solid var(--phn-surface-border, #2B2B2B);
}

/* ── Modals — driven by global data-phn-skin on <html>. ── */
.phn-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.62);
  z-index: 9990;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}
.phn-modal {
  background: var(--phn-elevated-bg, #1A1D22);
  border: 1px solid var(--phn-surface-border, #2B2B2B);
  border-radius: var(--phn-r-lg, 8px);
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  box-sizing: border-box;
  font-family: var(--phn-ui-font);
  color: var(--phn-text-fg, #C9CDD4);
  font-size: var(--phn-fs-sm, 12px);
  padding: 0;
  box-shadow: var(--phn-shadow-3);
}
.phn-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--phn-sp-3, 12px) var(--phn-sp-5, 20px);
  border-bottom: 1px solid var(--phn-surface-border, #2B2B2B);
}
.phn-modal-title {
  font-size: var(--phn-fs-md, 14px);
  font-weight: 600;
  color: var(--phn-text-active, #F2F4F7);
  letter-spacing: -0.01em;
}
.phn-modal-close {
  background: transparent;
  border: none;
  color: var(--phn-text-dim, #9D9D9D);
  cursor: pointer;
  font-size: 18px;
  padding: 0 4px;
  line-height: 1;
}
.phn-modal-close:hover { color: var(--phn-text-active, #E6E6E6); }
.phn-modal-body { padding: var(--phn-sp-5, 20px); }
.phn-modal-body input,
.phn-modal-body select,
.phn-modal-body textarea {
  background: var(--phn-page-bg, #0a0a0a);
  border: 1px solid var(--phn-surface-border, #2B2B2B);
  color: var(--phn-text-active, #E6E6E6);
}
.phn-modal-body code {
  background: var(--phn-page-bg, #0a0a0a);
  color: var(--phn-link, #4DAAFC);
}

/* ───────────────────────── Design-system primitives ─────────────────────────
   Shared Button / Input / Field / Chip / Kbd, driven by the design tokens. One
   source of truth so every dialog reads as the same intentional system (real
   :hover / :focus-visible states, not JS hover juggling). See components/ui.jsx. */
.phn-ui-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--phn-sp-2, 8px);
  font-family: var(--phn-ui-font); font-size: var(--phn-fs-sm, 12px); font-weight: 550;
  line-height: 1; white-space: nowrap; cursor: pointer; user-select: none;
  padding: 0 var(--phn-sp-3, 12px); height: 30px; border-radius: var(--phn-r-md, 6px);
  border: 1px solid transparent; background: transparent; color: var(--phn-text-fg, #C9CDD4);
  transition: background var(--phn-dur,.15s) var(--phn-ease), border-color var(--phn-dur,.15s) var(--phn-ease), color var(--phn-dur,.15s) var(--phn-ease), box-shadow var(--phn-dur,.15s) var(--phn-ease);
}
.phn-ui-btn:focus-visible { outline: none; box-shadow: var(--phn-ring); }
.phn-ui-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.phn-ui-btn--sm { height: 26px; font-size: var(--phn-fs-xs, 11px); padding: 0 var(--phn-sp-2, 8px); }
.phn-ui-btn--primary { background: var(--phn-link, #4DA3FF); color: var(--phn-accent-fg, #07121f); border-color: var(--phn-link, #4DA3FF); font-weight: 600; }
.phn-ui-btn--primary:hover:not(:disabled) { background: var(--phn-accent-hover, #6BB4FF); border-color: var(--phn-accent-hover, #6BB4FF); }
.phn-ui-btn--ghost { border-color: var(--phn-surface-border, #24262C); }
.phn-ui-btn--ghost:hover:not(:disabled) { background: var(--phn-hover-bg, rgba(255,255,255,0.045)); border-color: var(--phn-text-dim, #868D98); }
.phn-ui-btn--subtle { color: var(--phn-text-dim, #868D98); }
.phn-ui-btn--subtle:hover:not(:disabled) { background: var(--phn-hover-bg, rgba(255,255,255,0.045)); color: var(--phn-text-active, #F2F4F7); }
.phn-ui-btn--danger { color: var(--phn-danger, #F06D70); border-color: color-mix(in srgb, var(--phn-danger, #F06D70) 45%, transparent); }
.phn-ui-btn--danger:hover:not(:disabled) { background: color-mix(in srgb, var(--phn-danger, #F06D70) 14%, transparent); border-color: var(--phn-danger, #F06D70); }

.phn-ui-input {
  width: 100%; box-sizing: border-box; height: 32px; padding: 0 var(--phn-sp-3, 12px);
  background: var(--phn-page-bg, #0B0C0E); color: var(--phn-text-active, #F2F4F7);
  border: 1px solid var(--phn-surface-border, #24262C); border-radius: var(--phn-r-md, 6px);
  font-family: var(--phn-ui-font); font-size: var(--phn-fs-sm, 12px); outline: none;
  transition: border-color var(--phn-dur,.15s) var(--phn-ease), box-shadow var(--phn-dur,.15s) var(--phn-ease);
}
.phn-ui-input::placeholder { color: var(--phn-text-faint, #5A606B); }
.phn-ui-input:focus { border-color: var(--phn-link, #4DA3FF); box-shadow: var(--phn-ring); }
.phn-ui-input--mono { font-family: var(--phn-mono-font); font-size: var(--phn-fs-xs, 11px); }
textarea.phn-ui-input { height: auto; padding: var(--phn-sp-2, 8px) var(--phn-sp-3, 12px); line-height: var(--phn-lh, 1.55); resize: vertical; }

.phn-ui-field { display: flex; flex-direction: column; gap: var(--phn-sp-2, 8px); margin-bottom: var(--phn-sp-4, 16px); }
.phn-ui-label { font-size: var(--phn-fs-2xs, 10px); letter-spacing: 0.06em; text-transform: uppercase; color: var(--phn-text-dim, #868D98); font-weight: 600; }
.phn-ui-hint { font-size: var(--phn-fs-xs, 11px); line-height: var(--phn-lh, 1.55); color: var(--phn-text-dim, #868D98); }

.phn-ui-chip {
  display: inline-flex; align-items: center; gap: var(--phn-sp-1, 4px);
  padding: 3px var(--phn-sp-2, 8px); border-radius: var(--phn-r-sm, 4px); cursor: pointer;
  font-family: var(--phn-mono-font); font-size: var(--phn-fs-xs, 11px); line-height: 1.4;
  background: var(--phn-page-bg, #0B0C0E); color: var(--phn-text-fg, #C9CDD4);
  border: 1px solid var(--phn-surface-border, #24262C);
  transition: background var(--phn-dur,.15s) var(--phn-ease), border-color var(--phn-dur,.15s) var(--phn-ease), color var(--phn-dur,.15s) var(--phn-ease);
}
.phn-ui-chip:hover { border-color: var(--phn-text-dim, #868D98); }
.phn-ui-chip--active { background: var(--phn-link, #4DA3FF); color: var(--phn-accent-fg, #07121f); border-color: var(--phn-link, #4DA3FF); }
.phn-ui-chip:focus-visible { outline: none; box-shadow: var(--phn-ring); }

.phn-ui-kbd {
  display: inline-block; padding: 1px 5px; border-radius: var(--phn-r-sm, 4px);
  background: var(--phn-surface-bg, #15171B); border: 1px solid var(--phn-surface-border, #24262C);
  border-bottom-width: 2px; color: var(--phn-text-dim, #868D98);
  font-family: var(--phn-mono-font); font-size: var(--phn-fs-2xs, 10px); line-height: 1.5;
}
.phn-toast {
  /* base styling lives inline; this class is just a hook for future skin overrides */
}

/* ── Drag-drop pack overlay — appears when user drags a file over window. ── */
.phn-drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 9985;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  animation: phn-drop-in 120ms ease-out;
}
.phn-drop-overlay-card {
  border: 2px dashed var(--phn-link, #4DAAFC);
  border-radius: 12px;
  padding: 36px 56px;
  background: var(--phn-surface-bg, #181818);
  color: var(--phn-text-active, #E6E6E6);
  font-family: 'JetBrains Mono', Menlo, Monaco, monospace;
  text-align: center;
  box-shadow: 0 0 32px rgba(77,170,252,0.15);
}
.phn-drop-overlay-title {
  font-size: 16px;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
.phn-drop-overlay-subtitle {
  font-size: 11px;
  color: var(--phn-text-dim, #9D9D9D);
}
.phn-drop-overlay-subtitle code {
  background: var(--phn-page-bg, #0a0a0a);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--phn-link, #4DAAFC);
}
@keyframes phn-drop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ── Glass skin: extend backdrop-filter to all surfaces, not just header. ── */
[data-phn-skin="glass"] .phn-statusbar,
[data-phn-skin="glass"] .phn-sidebar,
[data-phn-skin="glass"] .phn-sidebar-header,
[data-phn-skin="glass"] .phn-modal,
[data-phn-skin="glass"] .phn-toast {
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
}
[data-phn-skin="glass"] .phn-modal-overlay {
  background: rgba(0,0,0,0.35);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

/* Base structural rules — apply to every skin (v3.0 "Pro" chrome: sans-serif,
   taller header, pill buttons, more breathing room). */
.phn-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--phn-ui-font);
  font-size: 12px;
  flex-shrink: 0;
  min-height: 42px;
  box-sizing: border-box;
  padding: 7px 14px;
  transition: background 200ms ease, border-color 200ms ease;
}
.phn-title { letter-spacing: 0.2px; font-weight: 700; font-size: 13px; }
.phn-meta-dot { opacity: 0.4; }
.phn-btn, .phn-select {
  background: transparent;
  cursor: pointer;
  padding: 5px 11px;
  border-radius: 7px;
  font-family: var(--phn-ui-font);
  font-size: 12px;
  font-weight: 500;
  outline: none;
  transition: background 100ms ease, border-color 100ms ease, color 100ms ease, box-shadow 100ms ease;
}
.phn-select { padding: 5px 8px; }
.phn-btn:disabled {
  cursor: not-allowed !important;
  opacity: 0.4;
}

/* ── default ─────────────────────────────────────────────── */
[data-phn-skin="default"].phn-header {
  background: #181818;
  border-bottom: 1px solid #2B2B2B;
  color: #9D9D9D;
}
[data-phn-skin="default"] .phn-title { color: #E6E6E6; }
[data-phn-skin="default"] .phn-meta { color: #555555; }
[data-phn-skin="default"] .phn-cost { color: #34D399; }
[data-phn-skin="default"] .phn-btn,
[data-phn-skin="default"] .phn-select {
  border: 1px solid #2B2B2B;
  color: #4DAAFC;
}
[data-phn-skin="default"] .phn-muted { color: #9D9D9D !important; }
[data-phn-skin="default"] .phn-btn:hover:not(:disabled),
[data-phn-skin="default"] .phn-select:hover {
  background: rgba(77,170,252,0.08);
}

/* ── neon ─────────────────────────────────────────────────── */
[data-phn-skin="neon"].phn-header {
  background: linear-gradient(180deg, #050510 0%, #0a0a14 100%);
  border-bottom: 1px solid rgba(255,0,128,0.5);
  box-shadow: inset 0 -1px 0 rgba(0,255,247,0.2), 0 0 12px rgba(255,0,128,0.1);
  color: rgba(0,255,247,0.7);
}
[data-phn-skin="neon"] .phn-title {
  color: #00fff7;
  text-shadow: 0 0 8px rgba(0,255,247,0.6);
  letter-spacing: 2px;
}
[data-phn-skin="neon"] .phn-meta { color: rgba(0,255,247,0.5); }
[data-phn-skin="neon"] .phn-cost { color: #FF0080; text-shadow: 0 0 4px rgba(255,0,128,0.4); }
[data-phn-skin="neon"] .phn-btn,
[data-phn-skin="neon"] .phn-select {
  border: 1px solid rgba(255,0,128,0.4);
  color: #FF0080;
  text-shadow: 0 0 4px rgba(255,0,128,0.4);
  background: rgba(255,0,128,0.04);
}
[data-phn-skin="neon"] .phn-muted { color: rgba(0,255,247,0.7) !important; border-color: rgba(0,255,247,0.3) !important; }
[data-phn-skin="neon"] .phn-btn:hover:not(:disabled),
[data-phn-skin="neon"] .phn-select:hover {
  border-color: #00fff7;
  color: #00fff7;
  background: rgba(0,255,247,0.06);
  text-shadow: 0 0 8px rgba(0,255,247,0.7);
  box-shadow: 0 0 12px rgba(0,255,247,0.3);
}

/* ── magenta ──────────────────────────────────────────────── */
[data-phn-skin="magenta"].phn-header {
  background: #181818;
  border-bottom: 1px solid #2B2B2B;
  color: #9D9D9D;
}
[data-phn-skin="magenta"] .phn-title { color: #E6E6E6; }
[data-phn-skin="magenta"] .phn-meta { color: #555555; }
[data-phn-skin="magenta"] .phn-cost { color: #34D399; }
[data-phn-skin="magenta"] .phn-btn,
[data-phn-skin="magenta"] .phn-select {
  border: 1px solid rgba(255,0,128,0.35);
  color: #FF0080;
}
[data-phn-skin="magenta"] .phn-muted { color: #9D9D9D !important; border-color: #2B2B2B !important; }
[data-phn-skin="magenta"] .phn-btn:hover:not(:disabled),
[data-phn-skin="magenta"] .phn-select:hover {
  background: rgba(255,0,128,0.10);
  border-color: #FF0080;
  color: #FF40A0;
}

/* ── crt ──────────────────────────────────────────────────── */
[data-phn-skin="crt"].phn-header {
  background: #001408;
  border-bottom: 1px dashed #33ff66;
  color: rgba(51,255,102,0.7);
  font-family: 'Courier New', 'Courier', monospace;
}
[data-phn-skin="crt"] .phn-title {
  color: #33ff66;
  text-shadow: 0 0 6px rgba(51,255,102,0.6);
  text-transform: uppercase;
  letter-spacing: 3px;
}
[data-phn-skin="crt"] .phn-meta { color: rgba(51,255,102,0.5); text-transform: uppercase; }
[data-phn-skin="crt"] .phn-cost { color: #66ff99; text-shadow: 0 0 4px rgba(102,255,153,0.5); }
[data-phn-skin="crt"] .phn-btn,
[data-phn-skin="crt"] .phn-select {
  background: transparent;
  border: 1px dashed rgba(51,255,102,0.6);
  color: #33ff66;
  text-shadow: 0 0 4px rgba(51,255,102,0.4);
  text-transform: uppercase;
  font-family: 'Courier New', monospace;
  letter-spacing: 0.5px;
}
[data-phn-skin="crt"] .phn-muted { color: rgba(51,255,102,0.85) !important; }
[data-phn-skin="crt"] .phn-btn:hover:not(:disabled),
[data-phn-skin="crt"] .phn-select:hover {
  background: rgba(51,255,102,0.12);
  border-style: solid;
}

/* ── linear ───────────────────────────────────────────────── */
[data-phn-skin="linear"].phn-header {
  background: linear-gradient(180deg, #1c1c20 0%, #18181b 100%);
  border-bottom: 1px solid #27272a;
  box-shadow: inset 0 1px 0 0 rgba(255,255,255,0.04);
  padding: 8px 14px;
  color: #a1a1aa;
}
[data-phn-skin="linear"] .phn-title {
  color: #fafafa;
  font-weight: 500;
  letter-spacing: 0.3px;
}
[data-phn-skin="linear"] .phn-meta { color: #71717a; }
[data-phn-skin="linear"] .phn-cost { color: #4ade80; }
[data-phn-skin="linear"] .phn-btn,
[data-phn-skin="linear"] .phn-select {
  background: #27272a;
  border: 1px solid #3f3f46;
  color: #d4d4d8;
  border-radius: 5px;
  padding: 5px 11px;
  box-shadow: inset 0 1px 0 0 rgba(255,255,255,0.05);
  font-weight: 500;
}
[data-phn-skin="linear"] .phn-muted { color: #a1a1aa !important; }
[data-phn-skin="linear"] .phn-btn:hover:not(:disabled),
[data-phn-skin="linear"] .phn-select:hover {
  background: #3f3f46;
  color: #fafafa;
  border-color: #52525b;
}

/* ── brutal ───────────────────────────────────────────────── */
[data-phn-skin="brutal"].phn-header {
  background: #000;
  border-bottom: 2px solid #fff;
  padding: 8px 12px;
  color: #888;
}
[data-phn-skin="brutal"] .phn-title {
  color: #fff;
  font-weight: 700;
  letter-spacing: 2.5px;
  text-transform: uppercase;
}
[data-phn-skin="brutal"] .phn-meta { color: #888; text-transform: uppercase; letter-spacing: 1px; }
[data-phn-skin="brutal"] .phn-cost { color: #fff; }
[data-phn-skin="brutal"] .phn-btn,
[data-phn-skin="brutal"] .phn-select {
  background: #000;
  border: 2px solid #fff;
  color: #fff;
  border-radius: 0;
  padding: 3px 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  font-size: 10px;
}
[data-phn-skin="brutal"] .phn-muted { color: #fff !important; }
[data-phn-skin="brutal"] .phn-btn:hover:not(:disabled),
[data-phn-skin="brutal"] .phn-select:hover {
  background: #fff;
  color: #000;
}

/* ── glass ────────────────────────────────────────────────── */
[data-phn-skin="glass"].phn-header {
  background: rgba(20, 20, 30, 0.55);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border-bottom: 1px solid rgba(255,255,255,0.10);
  color: rgba(255,255,255,0.7);
}
[data-phn-skin="glass"] .phn-title { color: rgba(255,255,255,0.95); letter-spacing: 0.5px; }
[data-phn-skin="glass"] .phn-meta { color: rgba(255,255,255,0.5); }
[data-phn-skin="glass"] .phn-cost { color: rgba(52,211,153,0.95); }
[data-phn-skin="glass"] .phn-btn,
[data-phn-skin="glass"] .phn-select {
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.15);
  color: rgba(255,255,255,0.85);
  backdrop-filter: blur(8px);
}
[data-phn-skin="glass"] .phn-muted { color: rgba(255,255,255,0.7) !important; }
[data-phn-skin="glass"] .phn-btn:hover:not(:disabled),
[data-phn-skin="glass"] .phn-select:hover {
  background: rgba(255,255,255,0.14);
  border-color: rgba(255,255,255,0.30);
  color: #fff;
}

/* ── sunset ───────────────────────────────────────────────── */
[data-phn-skin="sunset"].phn-header {
  background: linear-gradient(135deg, #2a0845 0%, #6441a5 50%, #ff4500 100%);
  border-bottom: 1px solid rgba(255,110,199,0.5);
  box-shadow: 0 2px 12px rgba(255,110,199,0.25);
  color: rgba(255,255,255,0.85);
}
[data-phn-skin="sunset"] .phn-title {
  color: #ff6ec7;
  text-shadow: 0 0 8px rgba(255,110,199,0.7), 0 0 2px rgba(255,255,255,0.5);
  letter-spacing: 1.5px;
}
[data-phn-skin="sunset"] .phn-meta { color: rgba(255,255,255,0.65); }
[data-phn-skin="sunset"] .phn-cost { color: #ffd700; text-shadow: 0 0 4px rgba(255,215,0,0.5); }
[data-phn-skin="sunset"] .phn-btn,
[data-phn-skin="sunset"] .phn-select {
  background: rgba(0,0,0,0.25);
  border: 1px solid rgba(255,110,199,0.5);
  color: #ffd0e8;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}
[data-phn-skin="sunset"] .phn-muted { color: rgba(255,255,255,0.85) !important; }
[data-phn-skin="sunset"] .phn-btn:hover:not(:disabled),
[data-phn-skin="sunset"] .phn-select:hover {
  background: rgba(255,110,199,0.25);
  border-color: #ff6ec7;
  color: #fff;
}

/* ── amber ────────────────────────────────────────────────── */
[data-phn-skin="amber"].phn-header {
  background: #1a0f00;
  border-bottom: 1px solid #663300;
  color: rgba(255,176,0,0.6);
}
[data-phn-skin="amber"] .phn-title {
  color: #ffb000;
  text-shadow: 0 0 6px rgba(255,176,0,0.45);
  letter-spacing: 0.8px;
}
[data-phn-skin="amber"] .phn-meta { color: rgba(255,176,0,0.5); }
[data-phn-skin="amber"] .phn-cost { color: #ffd966; text-shadow: 0 0 3px rgba(255,217,102,0.4); }
[data-phn-skin="amber"] .phn-btn,
[data-phn-skin="amber"] .phn-select {
  background: transparent;
  border: 1px solid rgba(255,176,0,0.45);
  color: #ffb000;
  text-shadow: 0 0 3px rgba(255,176,0,0.35);
}
[data-phn-skin="amber"] .phn-muted { color: rgba(255,176,0,0.85) !important; }
[data-phn-skin="amber"] .phn-btn:hover:not(:disabled),
[data-phn-skin="amber"] .phn-select:hover {
  background: rgba(255,176,0,0.10);
  border-color: #ffb000;
}

/* ── daylight ─────────────────────────────────────────────── */
[data-phn-skin="daylight"].phn-header {
  background: #f5f5f7;
  border-bottom: 1px solid #d1d1d6;
  color: #6e6e73;
}
[data-phn-skin="daylight"] .phn-title {
  color: #1d1d1f;
  font-weight: 600;
  letter-spacing: 0.3px;
}
[data-phn-skin="daylight"] .phn-meta { color: #6e6e73; }
[data-phn-skin="daylight"] .phn-cost { color: #007a4d; }
[data-phn-skin="daylight"] .phn-btn,
[data-phn-skin="daylight"] .phn-select {
  background: #ffffff;
  border: 1px solid #d1d1d6;
  color: #0066cc;
  box-shadow: 0 1px 0 rgba(0,0,0,0.04);
}
[data-phn-skin="daylight"] .phn-muted { color: #1d1d1f !important; }
[data-phn-skin="daylight"] .phn-btn:hover:not(:disabled),
[data-phn-skin="daylight"] .phn-select:hover {
  background: #f0f0f3;
  border-color: #0066cc;
}
[data-phn-skin="daylight"] option { background: #ffffff; color: #1d1d1f; }

/* ── pro — Linear-inspired dark ───────────────────────────── */
[data-phn-skin="pro"] .phn-header {
  background: #08090a;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
[data-phn-skin="pro"] .phn-title {
  color: #f7f8f8;
  font-weight: 600;
  letter-spacing: 0.02em;
  font-size: 13px;
}
[data-phn-skin="pro"] .phn-meta { color: #8a8f98; }
[data-phn-skin="pro"] .phn-cost { color: #10b981; }
[data-phn-skin="pro"] .phn-btn,
[data-phn-skin="pro"] .phn-select {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.06);
  color: #b4b8c0;
  border-radius: 6px;
}
[data-phn-skin="pro"] .phn-btn:hover:not(:disabled),
[data-phn-skin="pro"] .phn-select:hover {
  background: rgba(255,255,255,0.06);
  border-color: rgba(255,255,255,0.10);
  color: #f7f8f8;
}
[data-phn-skin="pro"] .phn-muted { color: #62666d !important; }
[data-phn-skin="pro"] option { background: #0f1011; color: #b4b8c0; }

/* ── moba — refined dark chrome (mockup 23), hairlines, pill controls ──── */
[data-phn-skin="moba"] .phn-header {
  background: #101113;
  border-bottom: 1px solid rgba(255,255,255,0.07);
}
[data-phn-skin="moba"] .phn-title {
  color: #eceef0;
  font-weight: 600;
  letter-spacing: 0.02em;
  font-size: 12px;
}
[data-phn-skin="moba"] .phn-meta { color: #9a9da3; }
[data-phn-skin="moba"] .phn-cost { color: #9a9da3; }
[data-phn-skin="moba"] .phn-btn,
[data-phn-skin="moba"] .phn-select {
  background: #1b1c1f;
  border: 1px solid rgba(255,255,255,0.07);
  color: #d6d8dc;
  border-radius: 6px;
}
[data-phn-skin="moba"] .phn-btn:hover:not(:disabled),
[data-phn-skin="moba"] .phn-select:hover {
  background: #222327;
  border-color: rgba(255,255,255,0.12);
  color: #eceef0;
}
[data-phn-skin="moba"] .phn-muted { color: #67696e !important; }
[data-phn-skin="moba"] option { background: #1b1c1f; color: #d6d8dc; }

/* ── oled — pitch-black chrome; every surface #000, hairlines do the work ── */
[data-phn-skin="oled"] .phn-header {
  background: #000000;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
[data-phn-skin="oled"] .phn-title {
  color: #eceef0;
  font-weight: 600;
  letter-spacing: 0.02em;
  font-size: 12px;
}
[data-phn-skin="oled"] .phn-meta { color: #9a9da3; }
[data-phn-skin="oled"] .phn-cost { color: #9a9da3; }
[data-phn-skin="oled"] .phn-btn,
[data-phn-skin="oled"] .phn-select {
  background: #000000;
  border: 1px solid rgba(255,255,255,0.10);
  color: #d6d8dc;
  border-radius: 6px;
}
[data-phn-skin="oled"] .phn-btn:hover:not(:disabled),
[data-phn-skin="oled"] .phn-select:hover {
  background: #101113;
  border-color: rgba(255,255,255,0.16);
  color: #eceef0;
}
[data-phn-skin="oled"] .phn-muted { color: #67696e !important; }
[data-phn-skin="oled"] option { background: #000000; color: #d6d8dc; }

/* ── moba-light — light Windows chrome (the Light toggle state) ───────── */
[data-phn-skin="moba-light"] .phn-header {
  background: #ececec;
  border-bottom: 1px solid #bdbdbd;
}
[data-phn-skin="moba-light"] .phn-title {
  color: #000000;
  font-weight: 600;
  letter-spacing: 0.02em;
  font-size: 12px;
}
[data-phn-skin="moba-light"] .phn-meta { color: #555555; }
[data-phn-skin="moba-light"] .phn-cost { color: #1f8a3a; }
[data-phn-skin="moba-light"] .phn-btn,
[data-phn-skin="moba-light"] .phn-select {
  background: #ffffff;
  border: 1px solid #bdbdbd;
  color: #2a2a2a;
  border-radius: 3px;
}
[data-phn-skin="moba-light"] .phn-btn:hover:not(:disabled),
[data-phn-skin="moba-light"] .phn-select:hover {
  background: #e6f0fa;
  border-color: #1170cc;
  color: #000000;
}
[data-phn-skin="moba-light"] .phn-muted { color: #777777 !important; }
[data-phn-skin="moba-light"] option { background: #ffffff; color: #2a2a2a; }

/* ────────── Per-skin CSS variables — drive .phn-page / .phn-statusbar /
   .phn-sidebar / .phn-sidebar-header without per-skin specific rules. ─── */

[data-phn-skin="default"] {
  --phn-page-bg: #0a0a0a;
  --phn-surface-bg: #181818;
  --phn-surface-alt-bg: #0d0d0d;
  --phn-surface-border: #2B2B2B;
  --phn-text-fg: #9D9D9D;
  --phn-text-active: #E6E6E6;
  --phn-text-dim: #555555;
  --phn-link: #4DAAFC;
}

[data-phn-skin="neon"] {
  --phn-page-bg: #0a0a14;
  --phn-surface-bg: linear-gradient(180deg, #050510 0%, #0a0a14 100%);
  --phn-surface-alt-bg: #050510;
  --phn-surface-border: rgba(255,0,128,0.4);
  --phn-text-fg: rgba(0,255,247,0.7);
  --phn-text-active: #00fff7;
  --phn-text-dim: rgba(0,255,247,0.4);
  --phn-link: #FF0080;
}

[data-phn-skin="magenta"] {
  --phn-page-bg: #0a0a0a;
  --phn-surface-bg: #181818;
  --phn-surface-alt-bg: #0d0d0d;
  --phn-surface-border: #2B2B2B;
  --phn-text-fg: #9D9D9D;
  --phn-text-active: #E6E6E6;
  --phn-text-dim: #555555;
  --phn-link: #FF0080;
}

[data-phn-skin="crt"] {
  --phn-page-bg: #001408;
  --phn-surface-bg: #001408;
  --phn-surface-alt-bg: #000a04;
  --phn-surface-border: rgba(51,255,102,0.4);
  --phn-text-fg: rgba(51,255,102,0.7);
  --phn-text-active: #33ff66;
  --phn-text-dim: rgba(51,255,102,0.4);
  --phn-link: #66ff99;
}

[data-phn-skin="linear"] {
  --phn-page-bg: #18181b;
  --phn-surface-bg: linear-gradient(180deg, #1c1c20 0%, #18181b 100%);
  --phn-surface-alt-bg: #131316;
  --phn-surface-border: #27272a;
  --phn-text-fg: #a1a1aa;
  --phn-text-active: #fafafa;
  --phn-text-dim: #71717a;
  --phn-link: #a1a1aa;
}

[data-phn-skin="brutal"] {
  --phn-page-bg: #000000;
  --phn-surface-bg: #000000;
  --phn-surface-alt-bg: #000000;
  --phn-surface-border: #ffffff;
  --phn-text-fg: #ffffff;
  --phn-text-active: #ffffff;
  --phn-text-dim: #888888;
  --phn-link: #ffffff;
}

[data-phn-skin="glass"] {
  --phn-page-bg: radial-gradient(circle at 20% 30%, rgba(77,170,252,0.10) 0%, transparent 50%), radial-gradient(circle at 85% 75%, rgba(255,0,128,0.08) 0%, transparent 50%), #0a0a14;
  --phn-surface-bg: rgba(20,20,30,0.55);
  --phn-surface-alt-bg: rgba(15,15,22,0.6);
  --phn-surface-border: rgba(255,255,255,0.10);
  --phn-text-fg: rgba(255,255,255,0.7);
  --phn-text-active: rgba(255,255,255,0.95);
  --phn-text-dim: rgba(255,255,255,0.5);
  --phn-link: rgba(255,255,255,0.85);
}

[data-phn-skin="sunset"] {
  --phn-page-bg: linear-gradient(135deg, #1a0530 0%, #2a0845 50%, #4a1840 100%);
  --phn-surface-bg: linear-gradient(135deg, #2a0845 0%, #6441a5 50%, #ff4500 100%);
  --phn-surface-alt-bg: #1a0530;
  --phn-surface-border: rgba(255,110,199,0.4);
  --phn-text-fg: rgba(255,255,255,0.7);
  --phn-text-active: #ff6ec7;
  --phn-text-dim: rgba(255,255,255,0.5);
  --phn-link: #ffd0e8;
}

[data-phn-skin="amber"] {
  --phn-page-bg: #1a0f00;
  --phn-surface-bg: #1a0f00;
  --phn-surface-alt-bg: #110800;
  --phn-surface-border: rgba(255,176,0,0.4);
  --phn-text-fg: rgba(255,176,0,0.6);
  --phn-text-active: #ffb000;
  --phn-text-dim: rgba(255,176,0,0.4);
  --phn-link: #ffd966;
}

[data-phn-skin="daylight"] {
  --phn-page-bg: #ffffff;
  --phn-surface-bg: #f5f5f7;
  --phn-surface-alt-bg: #eeeef0;
  --phn-surface-border: #d1d1d6;
  --phn-text-fg: #6e6e73;
  --phn-text-active: #1d1d1f;
  --phn-text-dim: #6e6e73;
  --phn-link: #0066cc;
}

[data-phn-skin="pro"] {
  --phn-page-bg: #08090a;
  --phn-surface-bg: #0f1011;
  --phn-surface-alt-bg: #141516;
  --phn-surface-border: rgba(255,255,255,0.06);
  --phn-text-fg: #8a8f98;
  --phn-text-active: #f7f8f8;
  --phn-text-dim: #62666d;
  --phn-link: #828fff;
}

[data-phn-skin="moba"] {
  /* Refined dark (mockup 23): luminance-ladder chrome over a near-black
     terminal well, alpha-white hairline dividers, one restrained periwinkle
     accent (#7c9cf5). Pill tabs; selection = white-alpha wash + accent bar. */
  --phn-page-bg: #101113;        /* chrome behind panels */
  --phn-surface-bg: #101113;     /* menu / toolbar / status */
  --phn-surface-alt-bg: #141517; /* sidebar / docked tree + SFTP — slightly lifted */
  --phn-elevated-bg: #1b1c1f;    /* modals / popovers / inputs / raised */
  --phn-surface-border: rgba(255,255,255,0.07); /* hairline dividers */
  --phn-text-fg: #d6d8dc;        /* body */
  --phn-text-active: #eceef0;    /* headings / emphasis */
  --phn-text-dim: #9a9da3;       /* secondary / captions */
  --phn-text-faint: #67696e;     /* placeholder / disabled */
  --phn-link: #7c9cf5;           /* periwinkle accent */
  --phn-accent-hover: #93aff7;
  --phn-accent-subtle: rgba(124,156,245,0.16);
  --phn-accent-fg: #0e1018;      /* text on the accent fill */
  --phn-success: #7fbf8a;
  --phn-warning: #d2b36b;
  --phn-danger: #e08784;
  --phn-focus-ring: rgba(124,156,245,0.50);
  --phn-hover-bg: rgba(255,255,255,0.05);
  --phn-tabstrip-bg: #101113;    /* strip matches the chrome; tabs are pills */
  /* Pill tabs (see .moba-tab): inactive transparent, active elevated */
  --phn-tab-bg: transparent;
  --phn-tab-bg-hover: rgba(255,255,255,0.04);
  --phn-tab-bg-active: #1b1c1f;
  --phn-tab-fg: #9a9da3;
  --phn-tab-fg-active: #eceef0;
}

/* OLED — true black on every surface. No luminance ladder: the page, chrome,
   sidebar, tab strip, and terminal are all #000; structure is carried entirely
   by alpha-white hairlines, slightly stronger than Dark's so edges survive on
   a panel where black pixels are off. Modals/popovers get the faintest lift
   (#0a0a0c) so they read as a layer; tab/hover states are the only lit fills. */
[data-phn-skin="oled"] {
  --phn-page-bg: #000000;
  --phn-surface-bg: #000000;
  --phn-surface-alt-bg: #000000;
  --phn-elevated-bg: #0a0a0c;
  --phn-surface-border: rgba(255,255,255,0.09);
  --phn-text-fg: #d6d8dc;
  --phn-text-active: #eceef0;
  --phn-text-dim: #9a9da3;
  --phn-text-faint: #67696e;
  --phn-link: #7c9cf5;
  --phn-accent-hover: #93aff7;
  --phn-accent-subtle: rgba(124,156,245,0.16);
  --phn-accent-fg: #0e1018;
  --phn-success: #7fbf8a;
  --phn-warning: #d2b36b;
  --phn-danger: #e08784;
  --phn-focus-ring: rgba(124,156,245,0.50);
  --phn-hover-bg: rgba(255,255,255,0.06);
  --phn-tabstrip-bg: #000000;
  --phn-tab-bg: transparent;
  --phn-tab-bg-hover: rgba(255,255,255,0.05);
  --phn-tab-bg-active: #101113;
  --phn-tab-fg: #9a9da3;
  --phn-tab-fg-active: #eceef0;
}

/* Light CHROME — the toggle's other state. Everything but the terminal turns
   light Windows-grey; the terminal stays pure black (same xterm palette). */
[data-phn-skin="moba-light"] {
  --phn-page-bg: #d9d9d9;        /* behind panels */
  --phn-surface-bg: #ececec;     /* menu / toolbar / status — light grey */
  --phn-surface-alt-bg: #ffffff; /* sidebar / docked file browser — white */
  --phn-surface-border: #bdbdbd;
  --phn-text-fg: #2a2a2a;
  --phn-text-active: #000000;
  --phn-text-dim: #6e6e6e;
  --phn-link: #1170cc;           /* Windows-blue accent */
  --phn-accent-subtle: rgba(17,112,204,0.13);
  --phn-hover-bg: rgba(0,0,0,0.07);
  --phn-tabstrip-bg: #c4c4c4;    /* light strip behind the tabs */
  /* Chrome-style tabs on the light strip: white active, grey inactive */
  --phn-tab-bg: #d6d6d6;
  --phn-tab-bg-hover: #e6e6e6;
  --phn-tab-bg-active: #ffffff;
  --phn-tab-fg: #555555;
  --phn-tab-fg-active: #000000;
}

/* ════════════════════════════════════════════════════════════════════════
   HEADER BUTTON STYLES — orthogonal to skins. Set on <html> via data-phn-
   btn-style. Placed AFTER skin rules so they win order-based ties at equal
   specificity. Use !important sparingly (only where skin :hover bg would
   otherwise override an intentional opacity / transparency).
   ════════════════════════════════════════════════════════════════════════ */

/* ── pill ── */
[data-phn-btn-style="pill"] .phn-btn,
[data-phn-btn-style="pill"] .phn-select {
  border-radius: 999px;
  padding: 4px 14px;
  background: color-mix(in srgb, currentColor 6%, transparent);
  transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
}
[data-phn-btn-style="pill"] .phn-btn:hover:not(:disabled),
[data-phn-btn-style="pill"] .phn-select:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0,0,0,0.25);
}

/* ── ghost ── */
[data-phn-btn-style="ghost"] .phn-btn,
[data-phn-btn-style="ghost"] .phn-select {
  border: none !important;
  border-radius: 0;
  padding: 5px 8px;
  background: transparent !important;
  position: relative;
  text-shadow: none;
}
[data-phn-btn-style="ghost"] .phn-btn::after {
  content: "";
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 2px;
  height: 1px;
  background: currentColor;
  opacity: 0;
  transition: opacity 100ms ease;
}
[data-phn-btn-style="ghost"] .phn-btn:hover:not(:disabled)::after {
  opacity: 0.7;
}
[data-phn-btn-style="ghost"] .phn-btn:hover:not(:disabled),
[data-phn-btn-style="ghost"] .phn-select:hover {
  background: transparent !important;
  box-shadow: none;
}

/* ── filled ── */
[data-phn-btn-style="filled"] .phn-btn,
[data-phn-btn-style="filled"] .phn-select {
  background: var(--phn-link, #4DAAFC) !important;
  border: 1px solid var(--phn-link, #4DAAFC) !important;
  color: var(--phn-page-bg, #0a0a0a) !important;
  font-weight: 600;
  text-shadow: none;
  transition: filter 120ms ease, transform 120ms ease;
}
[data-phn-btn-style="filled"] .phn-btn:hover:not(:disabled),
[data-phn-btn-style="filled"] .phn-select:hover {
  filter: brightness(1.18);
  transform: translateY(-1px);
}
[data-phn-btn-style="filled"] .phn-muted {
  background: transparent !important;
  border: 1px solid var(--phn-surface-border, #2B2B2B) !important;
  color: var(--phn-text-fg, #9D9D9D) !important;
  font-weight: normal;
}

/* ── bracket ── */
[data-phn-btn-style="bracket"] .phn-btn,
[data-phn-btn-style="bracket"] .phn-select {
  border: none !important;
  background: transparent !important;
  padding: 3px 4px;
  position: relative;
  text-shadow: none;
}
[data-phn-btn-style="bracket"] .phn-btn::before {
  content: "[ ";
  opacity: 0.45;
  transition: opacity 100ms ease;
}
[data-phn-btn-style="bracket"] .phn-btn::after {
  content: " ]";
  opacity: 0.45;
  transition: opacity 100ms ease;
}
[data-phn-btn-style="bracket"] .phn-btn:hover:not(:disabled) {
  background: transparent !important;
}
[data-phn-btn-style="bracket"] .phn-btn:hover:not(:disabled)::before,
[data-phn-btn-style="bracket"] .phn-btn:hover:not(:disabled)::after {
  opacity: 1;
}

/* ── chip ── */
[data-phn-btn-style="chip"] .phn-btn,
[data-phn-btn-style="chip"] .phn-select {
  border-radius: 6px;
  padding: 4px 11px;
  box-shadow: 0 1px 0 0 rgba(255,255,255,0.04) inset, 0 1px 2px rgba(0,0,0,0.2);
  background: color-mix(in srgb, currentColor 8%, transparent);
  transition: transform 100ms ease, box-shadow 100ms ease, background 100ms ease;
}
[data-phn-btn-style="chip"] .phn-btn:hover:not(:disabled),
[data-phn-btn-style="chip"] .phn-select:hover {
  transform: translateY(-1px);
  box-shadow: 0 1px 0 0 rgba(255,255,255,0.06) inset, 0 4px 10px rgba(0,0,0,0.3);
}

/* ════════════════════════════════════════════════════════════════════════
   HEADER LAYOUT DENSITY — third axis (sizing/spacing). Set on <html> via
   data-phn-layout. Combines with skin (colors) + btn-style (shape).
   ════════════════════════════════════════════════════════════════════════ */

[data-phn-layout="compact"] .phn-header {
  gap: 4px;
  padding: 3px 8px;
  min-height: 26px;
  font-size: 10px;
}
[data-phn-layout="compact"] .phn-btn,
[data-phn-layout="compact"] .phn-select {
  padding: 2px 6px;
  font-size: 10px;
}

[data-phn-layout="spacious"] .phn-header {
  gap: 10px;
  padding: 9px 14px;
  min-height: 42px;
  font-size: 12px;
}
[data-phn-layout="spacious"] .phn-btn,
[data-phn-layout="spacious"] .phn-select {
  padding: 6px 14px;
  font-size: 12px;
}
`;

export function injectHeaderSkinsCss() {
  if (typeof document === "undefined") return;
  // Reuse the existing tag if present so a hot-reload / re-call refreshes the
  // CSS in place rather than leaving a stale copy (or appending duplicates).
  let styleEl = document.getElementById("phn-header-skins");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "phn-header-skins";
    document.head.appendChild(styleEl);
  }
  if (styleEl.textContent !== CSS) styleEl.textContent = CSS;
}

// Dev: hot-reload skin palette edits instantly. injectHeaderSkinsCss otherwise
// only runs on mount, so a CSS edit here wouldn't repaint a running app until
// relaunch. import.meta.hot is undefined in production builds (no-op there).
if (import.meta.hot) {
  import.meta.hot.accept((mod) => { mod?.injectHeaderSkinsCss?.(); });
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
    return osDark ? (userSt.themeDark || "moba") : (userSt.themeLight || "moba-light");
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
    const skins = document.getElementById("phn-header-skins");
    if (skins) skins.after(el); // ensure source order beats the skins CSS
    else document.head.appendChild(el);
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
}
