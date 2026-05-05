# Pluto's Terminals

Free multi-terminal desktop app for the Pluto community. Run AI agents in parallel. Save your setup. Share it.

> **Status (2026-05-05):** v0.1.0 — feature-complete v1 (Windows). Multi-panel terminal grid, prompt-pack ecosystem, settings modal, MCP installer, auto-update check. Mac/Linux installers + code-signing not yet shipped (distribution work, not features).

## What it is

A Tauri + React + xterm.js desktop app for running multiple AI agents (Claude Code, Codex, etc.) side by side in a single window. Save and share multi-panel terminal setups as `.deck.json` **prompt packs** — clone someone else's exact configuration in one click.

## Features (v0.1.0)

- **Multi-panel terminal grid** with up to 8 panels, multiple tabs per panel
- **System tray + hide-on-close** — sessions keep running in background
- **Project sidebar** — pin folders with cwd + start commands; drag projects into panels
- **Pluto Dark / Pluto Light** terminal themes
- **📚 Bundled prompt packs** — 5 packs ship with the app (`claude-code-basic`, `dual-claude-pair`, `trading-workflow`, `pluto-personal-strategist`, `example`)
- **📁 Custom pack loading** — pick any `.deck.json` from disk, or drag-drop onto the window
- **💾 Pack export** — save current panel layout as a shareable `.deck.json`
- **⚡ Quick-spawn agent grid** — 4-up Researcher / Coder / Reviewer / Journal in one click
- **🔌 MCP installer** — curated list of popular MCP servers with copy-paste install commands (filesystem, GitHub, Puppeteer, Brave Search, Fetch, Memory)
- **⚙️ Settings modal** — edit Anthropic API key, `${VAULT}` path, Discord URL, factory reset
- **API key auto-injection** — saved key flows into every new shell so `claude` works without per-shell setup
- **Templated `${VARNAME}` paths in packs** — `${USERPROFILE}` / `${HOME}` / `${VAULT}` / any process env var expand at spawn time
- **Auto-update check** — banner if a newer GitHub release is available
- **Pluto-branded icons** — terminal-window silhouette with Pluto-magenta cursor signature

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
