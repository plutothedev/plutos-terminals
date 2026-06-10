<!-- (C) Claude research synthesis for redesign round 2, 2026-06-09 -->
# Round-2 Redesign Research Brief

Web research conducted 2026-06-09 across terminal apps (Warp, Wave, Ghostty, Termius, Tabby, WezTerm, Zellij, iTerm2, Hyper, VS Code, Zed, cmux) and dark pro-tool design systems (Linear, Raycast, Vercel Geist, GitHub Primer, Zed, Arc, Figma — including CSS-level teardowns).

## The headline findings

**Layout.** The current 5–6 permanent chrome regions (menubar + ribbon + tree + right dock + status bar + F-key bar) is the exact anatomy Termius publicly deleted in their redesign ("cumbersome… cluttered") and reviewers punish. The modern budget: **one top row + one collapsible rail; everything else transient** (palette, toasts, overlays). Command palettes (Warp ⌘P, Termius ⌘J/⌘T) have replaced session-tree scanning as primary navigation. cmux proves the strongest pattern for multi-agent use: **vertical session cards with live metadata (branch, cost, agent state) + attention rings + jump-to-unread** — the feature people switch terminals for. Zellij validates `.deck.json` (declarative layout files) and contributes the contextual keybinding hint bar (ship the 1-row compact form). Wave generalizes panes to "blocks" (terminal/editor/browser/AI as widgets on a tiled canvas) — the most natural home for prompt packs. VS Code contributes gutter command-decorations (lite Warp blocks) and the right-docked vertical terminal list.

**Anti-patterns:** the everything-sidebar; permanent multi-row chrome; unvirtualized lists (Tabby's 1,100-profile meltdown); AI creep blurring identity ("nobody knows what Warp is anymore"); settings buried in modal mazes.

**Visual.** 2026 flagship dark = off-black canvas (#08–#12 band, never #000) + **elevation via luminance ladder, not shadows** + alpha-white hairline borders (rgba(255,255,255,.05–.16)) + **exactly one chromatic accent on chrome** + 4 enforced text tiers + Inter/Geist-class sans with OpenType flags + a real mono as second voice (Berkeley Mono is the premium signal; JetBrains/Geist Mono the free standard) + sub-200ms ease-out motion. Linear's 2026 refresh: warmer grays, **dimmed sidebar** ("don't compete for attention you haven't earned"), softer separators ("structure should be felt, not seen"). Raycast: zero shadows, white-pill primary actions, keycap micro-gradients. Vercel: true-neutral grays with strict role assignment (steps 1–3 fills, 4–6 borders, 9–10 text). Amateur tells: #000+#fff, drop shadows on dark, accent sprayed everywhere, mixed gray temperatures, bold 700 type + heavy borders.

## The four round-2 concepts (mockups 17–20)

| # | File | Layout archetype | Visual recipe |
|---|------|------------------|---------------|
| 17 | `17-agent-cockpit.html` | **Agent Cockpit** (cmux × VS Code): left rail of live session status cards, one slim top bar, palette-first, attention rings, no menubar/ribbon/F-bar | "Void Precision" — Linear lineage: #08090a ladder, indigo #5e6ad2, Inter 510, hairlines |
| 18 | `18-zen-prompt.html` | **Zen Shell** (Ghostty × Warp): titlebar-fused tabs, zero sidebar, sticky bottom prompt editor, palette overlay shown, 1-row hint bar | "Studio Mono" — Vercel lineage: #0a0a0a true neutral, white-pill actions, Geist-style mono-forward chrome |
| 19 | `19-block-canvas.html` | **Block Workspace** (Wave): tab = tiled canvas of blocks (terminal/files/AI/browser), right widget rail, magnify, deck-as-canvas | "Charcoal Tactile" — Raycast lineage: #07080a, keycap gradients, one warm signature accent |
| 20 | `20-dock-workbench.html` | **Dock Workbench** (Zed/VS Code): terminals as center editor-tabs, collapsible left/right/bottom docks, vertical terminal list, thin status bar | Linear-2026 warm variant: warmer graphite, dimmed nav docks, content area wins |

Recommendation going in: **17 as default identity + 18's focus mode as a toggle** — the audience (parallel Claude Code sessions) maps directly onto the cmux pattern, and 17/18 share a token system so both can ship as one skin.

Full source list lives in the session transcript; key references: warp.dev/blog/block-model-behind-warps-agentic-development-environment · github.com/manaflow-ai/cmux · termius.com/blog/termius-x · zellij.dev/documentation/creating-a-layout · zed.dev/blog/new-panel-system · linear.app/now/behind-the-latest-design-refresh · github.com/VoltAgent/awesome-design-md (Linear + Raycast CSS teardowns) · vercel.com/geist/colors · primer.style/foundations/color
