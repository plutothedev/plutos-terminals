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

_Status (branch `001-remote-sessions-parity`): All 5 milestones essentially done — including Milestone 2's decoupled input editor (opt-in beta). Remaining is polish/P2 (Vim mode, cwd-aware path completion) + Warp Drive cloud sync (needs a backend)._

**Milestone 1 — Blocks ✅ DONE (v0.3.1)**
- [x] P0/L — Blocks UI: OSC-133 command+output as discrete units (xterm decorations: exit-status bar/wash)
- [x] P0/M — Copy command / output / both per block (right-click) + re-run
- [x] P0/S — Block color-coding by exit status (red on failure)
- [x] P1/M — Sticky command header (pins running command on scroll)
- [x] P1/S — Block Find (Ctrl+F) · Alt+↑/↓ jump between blocks (bookmark/jump)

**Milestone 2 — Input editor + autocomplete ✅ DONE (core; v0.3.4-dev)**
- [x] P0/L — Modern input editor decoupled from xterm: CodeMirror overlay owns the prompt (OSC-133-gated), multiline (Shift+Enter), soft-wrap, click-to-place; opt-in beta
- [x] P0/L — Autosuggestions: app ghost-text from history (→/End/Tab) **and** PSReadLine inline prediction on pwsh 7
- [x] P0/L — Tab completions: in-editor fuzzy menu (commands + history) **and** PSReadLine MenuComplete on pwsh 7
- [x] P1/M — Syntax highlighting in input (CodeMirror shell mode) · [x] P2/M — Vim mode · [x] P2 — cwd-aware path completion (live cwd via OSC PlutoCwd)

**Milestone 3 — Warp Drive (his pick) — mostly done**
- [x] P1/M — Workflows: Snippets → named parameterized workflows (defaults/desc, Warp-YAML import/export)
- [ ] P1/L — Settings/sync across machines (account/cloud backend; per-device localStorage today)
- [ ] P2/M — Notebooks (Monaco bundled) · [ ] P2/S — Saved Prompts library

**Milestone 4 — Native Agent Mode ✅ DONE (core)**
- [x] P0/M — NL-vs-command auto-detection + routing (at the Ask AI bar; v0.3.3)
- [x] P1/L — In-app ReAct agent loop with per-command approval + self-correction + live token streaming (v0.3.1/0.3.3)
- [ ] P2/M — MCP for the native agent · [ ] P2/M — Rules/AGENTS.md + codebase context

**Milestone 5 — Polish ✅ DONE**
- [x] P1/S — Global summon hotkey · [x] Reopen closed tab · [x] Zoom/maximize pane
- [x] P1/M — Customizable keybindings (remap UI, incl. OS summon; v0.3.3) · [x] Custom themes (Warp-YAML import + OS light/dark sync; v0.3.3)
- [x] P1/S — Ctrl+R unified fuzzy command-history search

**Later (P2/P3):** block sharing (web permalinks — phone-companion infra can seed it) · live multi-viewer session sharing · active AI recommendations/diffs · voice · theme-from-image.

## Already strong (don't rebuild — these beat Warp)
Multi-agent CLIs per worktree + one-click PR · 17-provider model routing · SSH/SFTP/RDP/VNC/serial + tunnels · session restore · broadcast typing · phone companion · AI error explainer (fires on PowerShell too).
