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
];

export function getSkinXtermTheme(skinId, opts = {}) {
  const skin = HEADER_SKINS.find((s) => s.id === skinId) || HEADER_SKINS[0];
  if (opts.pureBlackTerminal) {
    return { ...skin.xterm, background: "#000000" };
  }
  return skin.xterm;
}

export function getSkinId(stored) {
  const ids = HEADER_SKINS.map((s) => s.id);
  if (typeof stored === "string" && ids.includes(stored)) return stored;
  return "default";
}

const CSS = `
/* ── App-wide skinnable surfaces (read CSS vars set per skin below). ── */
.phn-page {
  background: var(--phn-page-bg, #0a0a0a);
  color: var(--phn-text-fg, #9D9D9D);
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
.phn-sidebar {
  background: var(--phn-surface-alt-bg, #0d0d0d);
  border-right: 1px solid var(--phn-surface-border, #2B2B2B);
  color: var(--phn-text-fg, #CCCCCC);
}
.phn-sidebar-header {
  background: var(--phn-surface-bg, #181818);
  border-bottom: 1px solid var(--phn-surface-border, #2B2B2B);
}

/* Base structural rules — apply to every skin. */
.phn-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  flex-shrink: 0;
  min-height: 32px;
  box-sizing: border-box;
  padding: 6px 10px;
  transition: background 200ms ease, border-color 200ms ease;
}
.phn-title { letter-spacing: 0.5px; font-weight: 600; }
.phn-meta-dot { opacity: 0.4; }
.phn-btn, .phn-select {
  background: transparent;
  cursor: pointer;
  padding: 3px 10px;
  border-radius: 3px;
  font-family: 'JetBrains Mono', Menlo, Monaco, monospace;
  font-size: 11px;
  outline: none;
  transition: background 100ms ease, border-color 100ms ease, color 100ms ease, box-shadow 100ms ease;
}
.phn-select { padding: 3px 6px; }
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
`;

let injected = false;
export function injectHeaderSkinsCss() {
  if (injected || typeof document === "undefined") return;
  const styleEl = document.createElement("style");
  styleEl.id = "phn-header-skins";
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
  injected = true;
}
