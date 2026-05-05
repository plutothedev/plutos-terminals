# Pluto's Terminals

> **Run AI agents in parallel. Save your setup. Share it.**

[![Latest release](https://img.shields.io/github/v/release/plutothedev/plutos-terminals?style=flat-square&color=FF0080)](https://github.com/plutothedev/plutos-terminals/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/plutothedev/plutos-terminals/total?style=flat-square&color=4DAAFC)](https://github.com/plutothedev/plutos-terminals/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/badge/discord-plutothedev-FF0080?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/3cZQVgKF)

Free multi-terminal desktop app for the Pluto community. Made for running Claude Code, Codex, and other shell-driven AI agents side by side in a single window — with an `agent view` toggle for monitoring, shareable `.deck.json` prompt packs, and a setup checker so non-devs aren't dropped into a blank terminal.

**[Download v0.1.2 ↗](https://github.com/plutothedev/plutos-terminals/releases/latest)** · Windows MSI / standalone `.exe`

> **Status (2026-05-05):** v0.1.2 — feature-complete v1 + flawless polish pass. Toast + branded confirms; agent ↔ terminal view toggle; status bar; setup checker; auto-update banner. Mac/Linux + code-signing remain (distribution, not features).

## What it is

A Tauri + React + xterm.js desktop app for running multiple AI agents (Claude Code, Codex, etc.) side by side in a single window. Save and share multi-panel terminal setups as `.deck.json` **prompt packs** — clone someone else's exact configuration in one click.

## Prerequisites

Pluto's Terminals is a **terminal app** — it expects a few things on your machine before AI agents will run:

1. **Node.js** (LTS) — install from [nodejs.org](https://nodejs.org/)
2. **Claude Code CLI** — once Node is installed, run in any terminal:
   ```
   npm install -g @anthropic-ai/claude-code
   ```
3. **Anthropic API key** — get one from [console.anthropic.com](https://console.anthropic.com/), paste it into the Pluto's Terminals welcome screen or ⚙️ settings modal

The app ships with a **🚀 setup** modal that detects all three on first launch and walks you through anything missing. It also includes a "test connection" button that makes a tiny live API call to verify your key works — no need to type `claude` and pray.

If you already have all three on your machine, the app is plug-and-play.

## Features

- **`💻 terminal` ↔ `🤖 agent` view toggle** — flip between full xterm panes and a compact card grid showing each agent's status / cost / project at a glance. PTYs stay alive across toggles.
- **Multi-panel terminal grid** with up to 8 panels, multiple tabs per panel
- **System tray + hide-on-close** — sessions keep running in background
- **Project sidebar** — pin folders with cwd + start commands; drag projects into panels
- **Pluto Dark / Pluto Light** terminal themes
- **📚 Bundled prompt packs** — 5 packs ship in the binary (`claude-code-basic`, `dual-claude-pair`, `trading-workflow`, `pluto-personal-strategist`, `example`)
- **📁 Custom pack loading** — pick any `.deck.json` from disk, or drag-and-drop onto the window
- **💾 Pack export** — save current panel layout as a shareable `.deck.json`
- **⚡ Quick-spawn agent grid** — 4-up Researcher / Coder / Reviewer / Journal in one click
- **🔌 MCP installer** — curated catalog with copy-paste install commands (filesystem, GitHub, Puppeteer, Brave Search, Fetch, Memory)
- **🚀 Setup checker** — first-launch detection of Node.js + npm + Claude Code CLI + saved API key, with copy-command buttons for anything missing + live API test
- **⚙️ Settings modal** — Anthropic API key, `${VAULT}` path, Discord URL, factory reset (with format validation + branded confirms)
- **API key auto-injection** — saved key flows into every new shell so `claude` works without per-shell setup
- **Templated `${VARNAME}` paths in packs** — `${USERPROFILE}` / `${HOME}` / `${VAULT}` / any process env var expand at spawn time
- **Status bar** — version, Claude availability, total cost, theme, GitHub + Discord links — always visible at the bottom
- **Auto-update banner** — surfaces newer GitHub releases on launch
- **Pluto-branded icons** — terminal-window silhouette with Pluto-magenta cursor signature
- **Branded toasts + confirms** — no jarring native dialogs

## Stack

- Tauri 2.10 (Rust backend)
- React 18 + Vite 8 (frontend)
- xterm.js 5.5 + addon-fit + addon-web-links
- portable-pty 0.8 (ConPTY on Windows, native PTYs elsewhere)
- MIT licensed

## Get started

```bash
cd plutos-terminals
npm install
npm run tauri dev
```

For production build:

```bash
npm run tauri build
# Output: src-tauri/target/release/bundle/msi/Pluto's Terminals_<version>_x64_en-US.msi
#         src-tauri/target/release/plutos-terminals.exe
```

## Download

Latest release: [github.com/plutothedev/plutos-terminals/releases/latest](https://github.com/plutothedev/plutos-terminals/releases/latest)

Windows MSI installer (~3 MB) or standalone `.exe` (~9 MB, no install needed).

> **SmartScreen warning:** the installer is unsigned (no code-signing cert yet). Click "More info" → "Run anyway" to install.

## Prompt packs

See [`prompt-packs/README.md`](prompt-packs/README.md) for the catalog and [`prompt-packs/SCHEMA.md`](prompt-packs/SCHEMA.md) for the `.deck.json/v0` schema. To author your own: copy `prompt-packs/example.deck.json` and edit.

## Roadmap

Tracked in the vault project at `C:\Users\pluto\Documents\pluto-mind\03 Projects\plutos-terminals\roadmap.md`.

Software features for v1 are now feature-complete. Remaining work is distribution: macOS installer (needs a Mac), Linux installer, code-signed Windows + macOS installers (cert acquisition).

## Community

Pluto Discord: [discord.gg/3cZQVgKF](https://discord.gg/3cZQVgKF)

## License

MIT — see [LICENSE](LICENSE).
