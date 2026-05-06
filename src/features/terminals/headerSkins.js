// Header skins — user-selectable visual themes for the top toolbar.
//
// Each skin is a CSS block scoped by [data-phn-skin="<id>"] on the header
// root. Inject once into <head> via injectHeaderSkinsCss(). Header element
// gets `data-phn-skin={skinId}` plus `className="phn-header"`; child elements
// use phn-title / phn-meta / phn-cost / phn-btn / phn-select / phn-muted
// classes. Inline styles handle layout (padding/gap/fontSize); skins handle
// color/border/bg/effects.
//
// Selected skin persists in localStorage state under `headerSkin`. First-launch
// + unknown values fall back to "default".

export const HEADER_SKINS = [
  {
    id: "default",
    label: "Default — flat dark, cyan accent",
    description: "The original. Subtle, gets out of the way.",
  },
  {
    id: "neon",
    label: "Neon Cyberpunk — magenta + cyan glow",
    description: "Edgy, photogenic, distinctive. Glow on hover.",
  },
  {
    id: "magenta",
    label: "Pluto Magenta — brand color",
    description: "Magenta replaces cyan as the primary accent. Brand-forward.",
  },
  {
    id: "crt",
    label: "Retro CRT — phosphor green, all caps",
    description: "Classic VT100 monochrome green-on-black. Strong aesthetic commitment.",
  },
  {
    id: "linear",
    label: "Modern Dark — refined SaaS polish",
    description: "Linear / Vercel feel. Filled buttons, gradients, micro-shadows.",
  },
  {
    id: "brutal",
    label: "Brutalist Mono — black/white, sharp",
    description: "No accent color, square corners, all caps. Confidence.",
  },
  {
    id: "glass",
    label: "Glassmorphic — translucent backdrop-blur",
    description: "macOS-style frosted glass. Best with colorful terminal output below.",
  },
  {
    id: "sunset",
    label: "Synthwave Sunset — purple→orange gradient",
    description: "80s retro-future. Hot pink title with glow.",
  },
  {
    id: "amber",
    label: "Solarized Amber — vintage monochrome",
    description: "Hercules-monitor warm amber. Easy on long sessions.",
  },
  {
    id: "daylight",
    label: "Daylight — light theme",
    description: "White bg, dark text. Only skin usable outdoors / in bright rooms.",
  },
];

export function getSkinId(stored) {
  const ids = HEADER_SKINS.map((s) => s.id);
  if (typeof stored === "string" && ids.includes(stored)) return stored;
  return "default";
}

const CSS = `
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
