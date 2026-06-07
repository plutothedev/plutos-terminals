// (C)
// Single source of truth for the terminal/editor monospace font stack, so the
// app-owned prompt editor and xterm render identically (no font swap when a
// typed command is echoed by the shell). Cascadia Code (ships with Windows /
// Windows Terminal) leads for a clean modern look; MesloLGS NF (bundled) is the
// fallback and also supplies powerline glyphs () via per-glyph fallback on any
// platform where Cascadia isn't present.
export const MONO_STACK =
  "'Cascadia Code', 'MesloLGS NF', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace";
