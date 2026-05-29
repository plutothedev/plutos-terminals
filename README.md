# Pluto's Terminals

> **The next-generation MobaXterm — a workstation for running AI agents, SSH, and remote desktops side by side.**

[![Latest release](https://img.shields.io/github/v/release/plutothedev/plutos-terminals?style=flat-square&color=FF0080)](https://github.com/plutothedev/plutos-terminals/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/plutothedev/plutos-terminals/total?style=flat-square&color=4DAAFC)](https://github.com/plutothedev/plutos-terminals/releases)
[![License: Proprietary](https://img.shields.io/badge/license-Proprietary-555?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/badge/discord-plutothedev-FF0080?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/3cZQVgKF)

A free desktop workstation for developers who live in the terminal and run AI
agents. One dense, industrial window holds a saved-session tree, a multi-tab
terminal grid, a built-in AI assistant and ~40 LLM providers, an SFTP file
browser, a live system monitor, SSH/serial sessions, port forwarding, and
remote desktops (RDP/VNC) — all in the same place.

**[⬇ Download the latest release](https://github.com/plutothedev/plutos-terminals/releases/latest)** — macOS `.dmg` · Windows `.msi`/`.exe` · Linux `.AppImage`/`.deb`

---

## What it is

Pluto's Terminals is built for the modern AI-agent development loop: run Claude
Code, Codex, and other shell-driven agents in parallel, connect to your servers
over SSH, browse and edit remote files, and keep an eye on everything from one
workstation. The layout is modeled on MobaXterm — a permanent session tree on
the left, a tabbed terminal grid in the middle, and a docked tools panel on the
right — re-skinned into a crisp industrial-navy theme.

## Highlights

### Workstation layout
- **Permanent session tree** (left) — saved local / SSH / serial / RDP / VNC
  sessions, grouped into folders, with colored per-platform icons and live SSH
  latency.
- **Tabbed terminal grid** (center) — multiple panels, multiple tabs per panel,
  split panes (side-by-side / stacked), drag tabs between panels.
- **Right tools dock** with three tabs:
  - **SFTP** — breadcrumb + Name/Size/Mod columns, colored file-type icons,
    download/upload/rename/delete; a local file browser when no SSH tab is active.
  - **Assistant** — a built-in AI chat that uses your active model; when it
    replies with a command you get one-click **run** / **insert** buttons.
  - **Monitor** — live CPU / MEM / DISK gauges plus a list of every open session
    and its activity.
- **Command palette** (`⌘K`), F-key quick-action bar, and a segmented status bar.

### AI, your way
- **~40 LLM providers** — bring your own key for Anthropic, OpenAI, Google,
  Groq, Mistral, OpenRouter, Moonshot/Kimi, and more. The picker injects the
  right env vars at shell spawn so `claude`, `codex`, etc. just work.
- **Ask AI** — turn plain English into a shell command, review it, then run.
- **One-click Fix** — when a command fails, get an AI-suggested fix you can run.
- **AI error explainer** and **session summaries**.

### Remote toolkit
- **SSH** (libssh2) with `~/.ssh/known_hosts` host-key verification; password,
  private-key, or ssh-agent auth; import from `~/.ssh/config`; jump hosts.
- **Credential vault** — optional "remember password" stored in your OS keychain
  (macOS Keychain / Windows Credential Manager), never plaintext.
- **SFTP** transfers, **port forwarding** (local + dynamic SOCKS), **serial
  consoles**, and embedded **RDP / VNC** remote desktops.
- **Broadcast (MultiExec)** — type once, send to every visible terminal.

### Power UX
- Parameterized **snippets**, **command-history search** (`⌘R`), named
  **workspaces / saved layouts**, **tab colors**, **broadcast groups**, session
  **recording** (asciinema `.cast`), **multi-window**, persistent **scrollback**,
  system tray + hide-on-close, and multiple terminal **themes**.

## Install

1. Go to the **[Releases page](https://github.com/plutothedev/plutos-terminals/releases/latest)**.
2. Download the file for your OS:
   - **macOS** — `.dmg` (Apple Silicon + Intel universal)
   - **Windows** — `.msi` installer or standalone `.exe`
   - **Linux** — `.AppImage` (portable) or `.deb`
3. Install and launch.

> **Unsigned builds:** until code-signing certificates are in place, your OS may
> warn on first launch. **macOS:** right-click the app → Open → Open. **Windows:**
> SmartScreen → More info → Run anyway.

## Getting AI agents running

Pluto's Terminals is a terminal — it runs the tools you already have:
1. Install **Node.js** (LTS) from [nodejs.org](https://nodejs.org/).
2. Install an agent CLI, e.g. `npm install -g @anthropic-ai/claude-code`.
3. Open the **Models** picker (toolbar) and add your provider + API key, or paste
   a key into a shell. That's it.

## Community

Join the Pluto Discord: **[discord.gg/3cZQVgKF](https://discord.gg/3cZQVgKF)** —
request features, report bugs, and get help.

## License

Pluto's Terminals is **proprietary software**, free to download and use. The
source code is not open for copying, redistribution, modification, or reverse
engineering — see [LICENSE](LICENSE). "Pluto's Terminals" and "Pluto" are marks
of the copyright holder. (Earlier versions previously published under MIT remain
MIT for those specific versions.)

© 2026 Michael T. Cinnamon (plutothedev). All rights reserved.
