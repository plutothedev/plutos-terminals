# Pluto's Terminals

> **Run AI agents in parallel. Save your setup. Share it.**

[![Latest release](https://img.shields.io/github/v/release/plutothedev/plutos-terminals?style=flat-square&color=FF0080)](https://github.com/plutothedev/plutos-terminals/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/plutothedev/plutos-terminals/total?style=flat-square&color=4DAAFC)](https://github.com/plutothedev/plutos-terminals/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/badge/discord-plutothedev-FF0080?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/3cZQVgKF)

Free multi-terminal desktop app for the Pluto community. Made for running Claude Code, Codex, and other shell-driven AI agents side by side in a single window — with shareable `.deck.json` **prompt packs** that turn each terminal into a specialized agent (researcher, debugger, writer, tutor, …), first-class **remote sessions** (SSH with an SFTP file browser, port forwarding, an OS-keychain credential vault, and serial consoles), split panes, broadcast-to-all input, user-pickable visual skins that paint the entire app, asciinema-format session recording, multi-window support, and a `Ctrl+K` command palette.

**[Download latest release ↗](https://github.com/plutothedev/plutos-terminals/releases/latest)** · Windows MSI / standalone `.exe`

> **Status (2026-05-06):** v0.1.20 — feature-complete v1 + 6-bundle "do all of them" expansion. 10 skins · 3 densities · pure-black terminal override · 11 prompt packs · MCP one-click install · pack search · keyboard shortcuts · Cmd+K command palette · onboarding tour · session recording (`.cast` export) · multi-window. Mac/Linux + code-signing remain (distribution, not features).

## What it is

A Tauri + React + xterm.js desktop app for running multiple AI agents (Claude Code, Codex, etc.) side by side in a single window. Each terminal can ship a **`systemPrompt`** that auto-types into Claude 2 seconds after spawn — turning a generic Claude Code session into a specialized agent (codebase explorer, debugger, writing partner, language tutor, etc.) without any per-session config.

The unit of sharing is a `.deck.json` **prompt pack**: a small JSON file that describes the panel layout + cwd + start commands + system prompts. Anyone with the app can clone someone else's exact setup with one drag-and-drop or URL paste.

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

## Quick start

1. **Download** the latest [release](https://github.com/plutothedev/plutos-terminals/releases/latest) and install
2. **Welcome screen** → paste your Anthropic API key → ENTER (or skip if you'll paste per-shell)
3. **Setup checker** auto-opens if Claude CLI isn't on PATH; otherwise dismiss
4. **`Ctrl+K`** → type "find a pack" → pick `claude-code-basic`
5. Claude boots in a fresh terminal with a tuned system prompt → start typing your task

That's the whole flow.

## Features

### Agents + workflow

- **11 bundled prompt packs** — `claude-code-basic`, `dual-claude-pair` (code + plan), `codebase-explorer` (read first, recommend second), `writing-helper` (no file-edit bias), `debug-session` (root-cause chaser), `language-learning` (patient tutor), `interview-prep` (mock interviewer), `content-script-writer` (hook/body/callbacks/close), `rubber-duck` (never solves, asks clarifying questions), `trading-workflow` (Pluto Style — ICT futures), `example` (schema reference). Each pack ships a `systemPrompt` that auto-types into Claude 2s after spawn — real role-priming, not just labels.
- **Pack loading** — `📚 packs…` dropdown · `🔍 find` modal (searchable by name + description) · `📁 from file` (drag-and-drop onto window or file picker) · `🔗 from URL` (gist / GitHub raw / any HTTPS source) · `🕐 RECENT` group at the top of the dropdown remembers your last 5 packs across sessions
- **`💾 export`** — save current panel layout as a shareable `.deck.json`
- **Multi-panel terminal grid** with up to 8 panels, multiple tabs per panel, drag-to-rearrange tabs across panels
- **Pre-flight `claude` check** — if a pack invokes `claude` and the CLI isn't on PATH, you get a clear in-place error with the install command instead of silent garbage
- **Templated `${VARNAME}` paths** — `${USERPROFILE}`, `${HOME}`, or any process env var expands at spawn time so packs work cross-machine

### Remote sessions (SSH / SFTP / serial)

The v2 overhaul adds a full remote toolkit alongside local shells — every remote stream rides the same terminal pipeline (scrollback, themes, recording, MultiExec all apply):

- **SSH sessions** — save a host/user as a typed session in the sidebar; connect over SSH (libssh2). **Host keys are verified** against your `~/.ssh/known_hosts` (a changed key is refused). Auth via **password, private key, or ssh-agent**.
- **Credential vault** — opt-in "remember password" stores it in your **OS keychain** (macOS Keychain / Windows Credential Manager), never in plaintext; saved sessions then reconnect without prompting. "Forget saved password" clears it.
- **📁 SFTP file browser** — browse the remote filesystem, navigate folders, and **download / upload / rename / delete / mkdir** — transfers run natively, no shell scripting.
- **⇄ Port forwarding** — local tunnels (`127.0.0.1:port → remote:port`) with correct flow control; manage active forwards in one panel.
- **⎓ Serial console** — connect to USB/UART devices (`/dev/tty.*`) at a chosen baud rate.

### Visual customization

- **🎨 10 app skins** in ⚙️ settings — Default · Neon Cyberpunk · Pluto Magenta · Retro CRT (phosphor green) · Modern Dark (Linear-style) · Brutalist Mono · Glassmorphic (backdrop-blur) · Synthwave Sunset · Solarized Amber (Hercules vintage) · Daylight (real light theme). The skin paints the **whole app** — header, sidebar, status bar, modals, terminal background, ANSI palette. Live preview as you pick.
- **3 header densities** — Default · Compact · Spacious. Combines with skin = 30 distinct configurations.
- **🖤 Pure-black terminal override** — toggle to force classic `#000` terminal background regardless of skin.
- **Header buttons** are bracket-style (`[ label ]`, terminal aesthetic) across all skins — locked in v0.1.20 after surveying the alternatives.

### Power UX

- **`Ctrl+K` command palette** — searchable list of every action (find pack, new tab, settings, MCPs, setup, recording, reset workspace, new window, switch panel N…). Arrow-key nav, Enter to run, Esc to close.
- **Keyboard shortcuts** — `Ctrl+K` palette · `Ctrl+P` find pack · `Ctrl+,` settings · `Ctrl+Shift+T` new tab · `Ctrl+Shift+W` close tab · `Ctrl+1`–`Ctrl+8` switch panel
- **🎬 Session recording** — `Ctrl+K` → "Start recording active tab" captures terminal output with millisecond timestamps. Stop & save exports as an asciinema v2 `.cast` file (playable on [asciinema.org](https://asciinema.org), embeddable, shareable). Magenta `● rec` indicator in status bar while recording.
- **🪟 Multi-window** — `Ctrl+K` → "Open new window" spawns a fresh window with its own independent panel layout, skin, density, recent packs, and projects. Run different workflows side by side (trading in one window, code in another).
- **♻️ Reset workspace** command — clears panels back to a single empty tab without wiping your API key, skin, or projects (less destructive than factory reset).
- **🔄 Session restore** — layout, scrollback, and PTY respawn happen automatically on app launch. Confirmation toast tells you what was restored.

### Onboarding + setup

- **🚀 Setup checker** — first-launch detection of Node.js + npm + Claude Code CLI + saved API key, with copy-command buttons for anything missing + live API test (1-token throwaway call to api.anthropic.com to verify key works)
- **4-step onboarding tour** — fires once on first launch after the welcome screen. Walks through: terminals + projects, skins, prompt packs, power features (with keyboard shortcut reference card)
- **Drag-drop visual hint** — drag a `.deck.json` over the window and a full-window overlay tells you where to drop
- **Welcome screen** — paste API key, optional Discord link, prereq callout for Node + Claude CLI

### MCP + extensions

- **🔌 MCP one-click install** — curated catalog (filesystem, GitHub, Puppeteer, Brave Search, Fetch, Memory) with **install** button that runs `claude mcp add ...` for you (allowlist-guarded), or **copy** to paste manually
- **API key auto-injection** — saved key flows into every new shell as `ANTHROPIC_API_KEY` so `claude` works without per-shell setup

### App-level polish

- **System tray + hide-on-close** — closing the window hides to tray; sessions keep running in background. Tray "Quit" is the only path to truly exit.
- **Project sidebar** — pin folders with cwd + start commands; drag projects into panels
- **Status bar** — version, Claude availability, terminal-bg mode, recording indicator, total live cost, GitHub + Discord links — always visible at the bottom
- **Branded toasts + confirms** — no jarring native dialogs; both follow the active skin
- **Auto-update banner** — surfaces newer GitHub releases on launch
- **Scrollback persistence** — up to ~5 MB per tab persists to disk and replays on next launch, even if you tray→Quit or reboot. Owned by the Rust PTY reader thread so there's no IPC race on process exit.

## Stack

- Tauri 2.10 (Rust backend)
- React 18 + Vite 8 (frontend)
- xterm.js 5.5 + addon-fit + addon-web-links
- portable-pty 0.8 (ConPTY on Windows, native PTYs elsewhere)
- MIT licensed

## Get started (build from source)

```bash
git clone https://github.com/plutothedev/plutos-terminals
cd plutos-terminals
npm install
npm run tauri dev
```

For production build:

```bash
npm run tauri build
# Output:
#   src-tauri/target/release/bundle/msi/Pluto's Terminals_<version>_x64_en-US.msi
#   src-tauri/target/release/plutos-terminals.exe
```

## Download

Latest release: [github.com/plutothedev/plutos-terminals/releases/latest](https://github.com/plutothedev/plutos-terminals/releases/latest)

Windows MSI installer (~3 MB) or standalone `.exe` (~9 MB, no install needed).

> **SmartScreen warning:** the installer is unsigned (no code-signing cert yet). Click "More info" → "Run anyway" to install.

## Prompt packs

See [`prompt-packs/README.md`](prompt-packs/README.md) for the full catalog of 11 packs (10 functional + 1 reference) and [`prompt-packs/SCHEMA.md`](prompt-packs/SCHEMA.md) for the `.deck.json/v0` schema. To author your own: copy `prompt-packs/example.deck.json` and edit. To share: open a PR adding it to `prompt-packs/`, or just publish a gist and tell people to use `🔗 from URL`.

## Roadmap

- ✅ **v0** — multi-panel grid, system tray, project sidebar, themes, Pluto-branded icons, GitHub releases (shipped 2026-05-04)
- ✅ **v0.1** — settings modal, MCP installer, auto-update banner, plug-and-play setup checker, branded toast/confirm, status bar, prompt packs, systemPrompt auto-write, MCP one-click install, URL pack import, 10 app skins, 3 densities, pure-black terminal override, recent packs, pack search, command palette, keyboard shortcuts, onboarding tour, session restore, asciinema recording, multi-window (shipped through 2026-05-06, v0.1.20)
- 🔜 **v0.2** — community pack marketplace · pack signing · auto-update install (one-click vs. download-and-run)
- ❌ **Distribution blockers** — macOS installer (no Mac), Linux installer (cross-compile flaky), code-signed installers (~$400/yr cert)

## Community

Pluto Discord: [discord.gg/3cZQVgKF](https://discord.gg/3cZQVgKF) — share packs, request features, get help. Community-built packs surface in the