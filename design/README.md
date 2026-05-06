# Design artifacts

Brainstorming and visual reference materials. Not shipped in the binary; not user-facing. Useful for understanding the design space behind the choices baked into the app.

## `header-styles-preview.html`

Single-file HTML mock-up of:

- **7 header layouts** (A baseline · B grouped pills · C command palette · D icon rail · E primary CTA + overflow · F two-row · G minimal launcher)
- **10 visual skins** (default · neon · magenta · crt · linear · brutal · glass · sunset · amber · daylight)

Originally produced for v0.1.10's brainstorm pass before the skin picker shipped. Layouts B–G were never implemented; layout A is what shipped. Skins shipped in v0.1.10 and have been refined since.

The 6 button styles (default / pill / ghost / filled / bracket / chip) demoed elsewhere in development; v0.1.20 locked the canonical button style to **bracket** across all skins.

Open in a browser to compare. Useful if a future release wants to revisit any of the layout reflows or button styles.
