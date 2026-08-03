# Pluto's Terminals

> **The next-generation MobaXterm — a workstation for running AI agents, SSH, and remote desktops side by side.**

[![Latest release](https://img.shields.io/github/v/release/plutothedev/plutos-terminals?style=flat-square&color=FF0080)](https://github.com/plutothedev/plutos-terminals/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/plutothedev/plutos-terminals/total?style=flat-square&color=4DAAFC)](https://github.com/plutothedev/plutos-terminals/releases)
[![License: Proprietary](https://img.shields.io/badge/license-Proprietary-555?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/badge/discord-plutothedev-FF0080?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/3cZQVgKF)

A free desktop workstation for developers who live in the terminal and run AI
agents. One dense window holds a saved-session tree, a multi-tab terminal grid,
a built-in AI assistant and agent mode across 16+ LLM providers, a Warp-style
prompt editor, an SFTP file browser, a live system monitor, SSH/serial sessions,
port forwarding, and remote desktops (RDP/VNC) — all in the same place.

**[⬇ Download the latest release](https://github.com/plutothedev/plutos-terminals/releases/latest)** — macOS `.dmg` · Windows `.msi`/`.exe` · Linux `.AppImage`/`.deb`

---

## What it is

Pluto's Terminals is built for the modern AI-agent development loop: run Claude
Code, Codex, and other shell-driven agents in parallel, connect to your servers
over SSH, browse and edit remote files, and keep an eye on everything from one
workstation. The layout is modeled on MobaXterm — a permanent session tree on
the left, a tabbed terminal grid in the middle, and a docked tools panel on the
right — in a refined dark theme with a single accent, hairline borders, and
monochrome stroke icons (plus importable custom themes).

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
- **16+ LLM providers, ~40 models** — bring your own key for Anthropic, OpenAI,
  Google, Groq, Mistral, OpenRouter, Moonshot/Kimi, and more. The picker injects
  the right env vars at shell spawn so `claude`, `codex`, etc. just work.
- **Ask AI** (`Ctrl+I`) — turn plain English into a shell command, review it,
  then run. Auto-detects whether you typed a command or a request.
- **Agent Mode** (`Ctrl+Shift+A`) — describe a goal; an in-app agent runs the
  commands in your terminal, streaming its reasoning live.
- **Project-aware agents** — before its first turn, Agent Mode can read your
  repo's `AGENTS.md` / `CLAUDE.md` rules, git branch and dirty state, top-level
  dirs, and npm scripts. Every rule file needs a one-time approval of its exact
  content (and re-approval when that content changes), the whole block is capped
  and secret-scanned before it reaches the model, and rule files are treated as
  data — they cannot authorize destructive actions or enable auto-run.
- **Saved prompts** — a reusable prompt library that syncs across your machines.
  Type `/` in the assistant or the agent goal box to fuzzy-search and insert one.
- **One-click Fix** — when a command fails, get an AI-suggested fix you can run.
- **AI error explainer** and **session summaries**.

### Notebooks
- **Runnable markdown documents**, as a tab type. Shell blocks get a Run button
  that sends the command to a terminal pane you pick, then writes the captured
  output back into the document as an `output` fence (a rerun overwrites it).
- **Plain `.md` files** in an app-data folder — git-friendly, atomic saves, 2s
  autosave. Monaco editor, with a plain-textarea fallback.
- **Nothing runs without an explicit click.** v1 runs single-line commands;
  multi-line blocks are shown but not run yet.

### Sharing
- **Share a command block or a whole session transcript** as a GitHub gist,
  straight from the right-click menu.
- **You see exactly what uploads.** The preview is byte-for-byte the upload,
  secret-scanned and masked first, so API keys, tokens, JWTs and private-key
  material are hidden before anything leaves your machine. Secret gists by
  default — note that means unlisted, not private.
- **"My shares"** lists and revokes what you have published. That history stays
  on the machine that made it and never syncs.

### Private & local-first
- **Your machine, your data.** No account, no sign-up, no telemetry. Your sessions,
  snippets, and themes live in local storage on your own computer.
- **Credentials stay in the OS keychain.** Provider API keys and saved passwords go
  into the Windows Credential Manager / macOS Keychain and are stripped from
  plaintext storage, never written to disk in the clear, and never sent anywhere but
  the provider you chose.
- **Verify what you run.** Every release ships a `SHA256SUMS` file so you can confirm
  your download is intact before launching it (see [Install](#install)).

### Modern terminal experience
- **Command blocks** — every command/output pair is a block with ✓/✗ status.
- **Prompt editor (beta)** — a Warp-style app-owned input line: syntax
  highlighting, multiline composing, ghost-text autosuggest from history, fuzzy
  tab completions, cwd-aware path completion — with automatic passthrough for
  vim/less/REPLs. Off = the classic terminal, byte-for-byte.
- **Workflows** — saved parameterized commands, with Warp-YAML import/export.
- **Custom themes** — import any Warp theme YAML; themes the terminal palette
  and the whole app chrome, with optional OS light/dark auto-switch.
- **Customizable keybindings** — remap every shortcut, including the system-wide
  summon hotkey (default ``Ctrl+Shift+` ``).

### Remote toolkit
- **SSH** (libssh2) with `~/.ssh/known_hosts` host-key verification; password,
  private-key, or ssh-agent auth; import from `~/.ssh/config`; jump hosts.
- **Credential vault** — optional "remember password" stored in your OS keychain
  (macOS Keychain / Windows Credential Manager), never plaintext.
- **SFTP** transfers, **port forwarding** (local + dynamic SOCKS), **serial
  consoles**, and embedded **RDP / VNC** remote desktops.
- **Broadcast (MultiExec)** — type once, send to every visible terminal.

### Power UX
- **Command-history search** (`⌘R`), named **workspaces / saved layouts**,
  **tab colors**, **broadcast groups**, session **recording** (asciinema
  `.cast`), **keystroke macros**, **multi-window**, persistent **scrollback**,
  a **master-password lock screen**, network tools (ping · traceroute · ports ·
  DNS), and system tray + hide-on-close.
- **Phone remote control** — run a private companion server (Tailscale-friendly)
  to view and type into your terminals from your phone.

## Install

1. Go to the **[Releases page](https://github.com/plutothedev/plutos-terminals/releases/latest)**.
2. Download the file for your OS:
   - **macOS** — `.dmg` (Apple Silicon + Intel universal)
   - **Windows** — `.msi` installer or standalone `.exe`
   - **Linux** — `.AppImage` (portable) or `.deb`
3. Install and launch.

**First launch on an unsigned build:**

- **macOS** — Gatekeeper blocks unsigned apps. Right-click (or Control-click) the
  app → **Open**, then **Open** again in the dialog. If macOS still refuses
  ("damaged" / "can't be opened"), clear the quarantine flag in Terminal:
  `xattr -dr com.apple.quarantine "/Applications/Pluto's Terminal.app"`.
- **Windows** — SmartScreen may show "Windows protected your PC". Click
  **More info → Run anyway** (only after you've verified the checksum below).

> **Verify your download (builds are not yet code-signed).** Because these
> installers aren't signed yet, your OS may warn on first launch. Don't bypass the
> warning blindly: verify the file against the `SHA256SUMS` published with every
> release. Compute your download's hash and confirm it matches before running:
>
> - **Windows (PowerShell):** `Get-FileHash .\<file>.msi -Algorithm SHA256`
> - **macOS / Linux:** `shasum -a 256 <file>`
>
> If the value matches the matching line in `SHA256SUMS` on the release page, the
> download is intact. Code signing is planned; until then this checksum check is the
> integrity guarantee.

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
