<!-- (C) -->
# Warp-Parity Roadmap — make Pluto's Terminals a Warp replacement

**Goal:** Michael drops Warp and uses Pluto's Terminals for everything — Warp feature parity, polished, bug-free, on Windows. Iterate live via `npm run tauri dev` (hot reload); cut an MSI only for milestones.

**His priorities (chosen):** Blocks UI · Autosuggestions+autocomplete · Warp Drive. Daily work: AI coding agents, git+dev servers, SSH, general shell — a broad power user.

## Where Pluto stands (gap analysis: 98 Warp features vs 66 Pluto features)

Pluto is already a deep MobaXterm-class terminal that **beats Warp on breadth**: SSH/SFTP/RDP/VNC/serial, tunnels/jump hosts, multi-agent orchestration (worktrees, agent dashboard, one-click PR), 17-provider LLM routing, broadcast typing, phone companion, session restore. Windows is solid (PowerShell gets the powerline prompt + OSC-133 + history).

**But it's not yet a Warp daily-driver**, because the three things that DEFINE Warp are absent:
1. **Blocks UI** — command+output as selectable/copyable units with per-block actions (Pluto parses OSC-133 only to flag failures; renders nothing block-like).
2. **Modern input editor + autosuggestions + completions** — Pluto forwards keystrokes to raw xterm: no ghost-text, no completion menu, no multiline/syntax-highlight.
3. **Native Agent Mode** — `llm_complete` is a single round-trip; "agentic" = shelling to the external `claude` CLI.
Plus no **Warp Drive** (sync/notebooks/workflows/secrets).

> Closing Blocks + Autocomplete/input-editor is the whole ballgame for switching.

## Build order (weighted to his picks)

**Milestone 1 — Blocks (in progress)**
- [ ] P0/L — Blocks UI: render OSC-133 command+output as discrete units (overlay over xterm; markers already fire incl. PowerShell)
- [ ] P0/M — Copy command / output / both per block
- [ ] P0/S — Block color-coding by exit status (red on failure; exit already known)
- [ ] P1/M — Sticky command header (pin running command while scrolling)
- [ ] P1/S — Block Find (Ctrl+F across blocks, regex) · P2/S — bookmark/jump blocks

**Milestone 2 — Input editor + autocomplete (his pick)**
- [ ] P0/L — Modern input editor decoupled from xterm (multiline, click-to-place, soft-wrap)
- [ ] P0/L — Autosuggestions (fish-style ghost text; Windows via PSReadLine PredictionSource)
- [ ] P0/L — Tab completions (fuzzy menu: cmds/paths/flags; Windows via PSReadLine completion bridge)
- [ ] P1/M — Syntax + error highlighting in input · P2/M — Vim mode

**Milestone 3 — Warp Drive (his pick)**
- [ ] P1/M — Workflows: promote Snippets → named parameterized workflows (defaults/desc, YAML import/export)
- [ ] P1/L — Settings/sync across machines (account/cloud; everything is per-device localStorage today)
- [ ] P2/M — Notebooks (Monaco already bundled) · P2/S — Saved Prompts library

**Milestone 4 — Native Agent Mode**
- [ ] P0/M — NL-vs-command auto-detection + routing (plain English → agent; needs input editor)
- [ ] P1/L — In-app streaming, tool-using agent loop with self-correction (grow `llm_complete`)
- [ ] P2/M — MCP for the native agent · P2/M — Rules/AGENTS.md + codebase context

**Milestone 5 — Polish (table-stakes Warp users tune day one)**
- [ ] P1/S — Global summon hotkey (Tauri global-shortcut) · P1/S — Reopen closed tab · P1/S — Zoom/maximize pane
- [ ] P1/M — Customizable keybindings (remap UI) · P1/M — Custom themes (YAML import, OS light/dark sync)
- [ ] P1/S — Bind Ctrl+R to unified fuzzy command search (history+workflows)

**Later (P2/P3):** block sharing (web permalinks — phone-companion infra can seed it) · live multi-viewer session sharing · active AI recommendations/diffs · voice · theme-from-image.

## Already strong (don't rebuild — these beat Warp)
Multi-agent CLIs per worktree + one-click PR · 17-provider model routing · SSH/SFTP/RDP/VNC/serial + tunnels · session restore · broadcast typing · phone companion · AI error explainer (fires on PowerShell too).
