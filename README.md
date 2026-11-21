# Pluto's Terminal

> **The next-generation MobaXterm — a workstation for running AI agents, SSH, and remote desktops side by side.**

[![Latest release](https://img.shields.io/github/v/release/plutothedev/plutos-terminals?style=flat-square&color=FF0080)](https://github.com/plutothedev/plutos-terminals/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/plutothedev/plutos-terminals/total?style=flat-square&color=4DAAFC)](https://github.com/plutothedev/plutos-terminals/releases)
[![License: Proprietary](https://img.shields.io/badge/license-Proprietary-555?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/badge/discord-plutothedev-FF0080?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/yy9QCnUsde)

A free desktop workstation for developers who live in the terminal and run AI
agents. One dense window holds a saved-session tree, a multi-tab terminal grid,
a built-in AI assistant and agent mode across 15 LLM providers and any OpenAI-compatible endpoint, a Warp-style
prompt editor, an SFTP file browser, a live system monitor, SSH/serial sessions,
port forwarding, and remote desktops (RDP/VNC) — all in the same place.

**[⬇ Download the latest release](https://github.com/plutothedev/plutos-terminals/releases/latest)** — macOS `.dmg` · Windows `.msi`

---

## What it is

Pluto's Terminal is built for the modern AI-agent development loop: run Claude
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
- **15 LLM providers, 60+ models, plus any OpenAI-compatible endpoint** — bring your own key for Anthropic, OpenAI,
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

## How the agent works

Agent Mode is a tool-calling agent built into the app, not a wrapper around an agent CLI. You give
it a goal; it calls tools until the goal is done, and you approve what it runs.

### The loop

- **Native function calling in both provider dialects.** Anthropic `tool_use` / `tool_result`
  and OpenAI-compatible `tool_calls` / `tool_call_id`, including arguments that stream in as
  fragments. Code: [`src-tauri/src/llm.rs`](src-tauri/src/llm.rs),
  [`src-tauri/src/llm_tools.rs`](src-tauri/src/llm_tools.rs),
  [`src/features/terminals/llmTools.js`](src/features/terminals/llmTools.js).
- **One loop for every tool.** Each run collects the built-in `run_command` tool plus every tool
  from your connected MCP servers, calls the model, gates and runs each tool call, sends the
  results back, and repeats until the model answers without calling a tool. Code:
  [`src/features/terminals/agentLoop.js`](src/features/terminals/agentLoop.js),
  [`src/features/terminals/AgentMode.jsx`](src/features/terminals/AgentMode.jsx).
- **It cannot spin forever.** A run stops at 14 steps (`MAX_STEPS`), and the Stop button ends it
  at any point. Cleanup runs in a `finally`, so a tool that throws cannot leave the agent stuck.
- **Shell commands run in your real terminal pane.** Output is captured per command through
  OSC 133 command blocks, so the model sees exactly what that command printed.
- **15 providers, 61 models,** plus a custom slot for any OpenAI-compatible endpoint. Code:
  [`src/features/terminals/providers.js`](src/features/terminals/providers.js).

### MCP client

- **Built on the official Rust MCP SDK (`rmcp`).** Two transports: stdio servers, spawned as child
  processes from an argument list with no shell in between, and streamable HTTP servers. Code:
  [`src-tauri/src/mcp/`](src-tauri/src/mcp/).
- **One connection per server for the app's lifetime.** Servers connect on first use and their
  tool lists are cached.
- **Server secrets live in the OS keychain.** HTTP tokens and sensitive environment values are
  referenced by name in the config and read from the keychain at connect time.
- **The bearer token never follows a bad redirect.** The HTTP client refuses redirects to another
  host or port, and any redirect from https down to http.

### Safety is enforced in code, not in the prompt

Tool output goes back into the next prompt, so anything a tool reads can try to steer the model.
The gates below do not depend on the model behaving.

- **Every shell command waits for your approval,** even with auto-run on. You can edit the
  command before it runs, and known destructive patterns get a warning.
- **MCP tools auto-run only when the server marks them read-only.** A tool with no annotation is
  treated as destructive and waits for approval.
- **Tool output is trimmed, capped and secret-masked** before it goes back to the model. Only the
  text parts of an MCP result are sent.
- **Project rules files are data, not instructions.** `AGENTS.md` and `CLAUDE.md` each need a
  one-time approval of their exact content. The whole context block is masked before it is cut
  to size, so a secret on the cut line cannot slip through as a fragment.

### Tests

- Agent loop, tool gating, tool-call parsing and context building:
  [`agentLoop.test.js`](src/features/terminals/agentLoop.test.js),
  [`agentTools.test.js`](src/features/terminals/agentTools.test.js),
  [`llmTools.test.js`](src/features/terminals/llmTools.test.js),
  [`agentContext.test.js`](src/features/terminals/agentContext.test.js).
- MCP client against a mock MCP server:
  [`src-tauri/tests/mcp_mock.rs`](src-tauri/tests/mcp_mock.rs), with the server in
  [`src-tauri/tests/fixtures/mock_mcp_server.mjs`](src-tauri/tests/fixtures/mock_mcp_server.mjs).

Design write-up:
[`docs/superpowers/specs/2026-06-14-mcp-native-agent-design.md`](docs/superpowers/specs/2026-06-14-mcp-native-agent-design.md).

## Install

1. Go to the **[Releases page](https://github.com/plutothedev/plutos-terminals/releases/latest)**.
2. Download the file for your OS:
   - **macOS** — `.dmg` (Apple Silicon + Intel universal)
   - **Windows** — `.msi` installer
3. Install and launch.

> **Linux isn't in this release.** It had never been exercised end to end, so
> rather than ship a build nobody had ever run, it's held back until it gets a
> real boot test and a verified credential store. Watch the repo for it.

**First launch on an unsigned build:**

- **macOS** — Gatekeeper blocks unsigned apps. On **macOS 15 (Sequoia) and
  later** the old Control-click → Open shortcut no longer works: open
  **System Settings → Privacy & Security**, scroll down to the message naming
  Pluto's Terminal, click **Open Anyway**, then authenticate. On **macOS 14 and
  earlier**, Control-click the app → **Open** → **Open**. If macOS still refuses
  ("damaged" / "can't be opened"), clear the quarantine flag in Terminal:
  `xattr -dr com.apple.quarantine "/Applications/Pluto's Terminal.app"`.
- **Windows** — SmartScreen may show "Windows protected your PC". The **Run
  anyway** button is hidden behind the **More info** link — click that only
  after you've verified the checksum below.

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

**Updates.** From this release on, the app checks for updates on launch and can
install them in place — update payloads are cryptographically signed and are
verified against a key built into the app before anything runs, so the download
host is not trusted with what gets executed. If you're on an older build you'll
need to install this one by hand first. Details: [`docs/updater.md`](docs/updater.md).

## Getting AI agents running

Pluto's Terminal is a terminal — it runs the tools you already have:
1. Install **Node.js** (LTS) from [nodejs.org](https://nodejs.org/).
2. Install an agent CLI, e.g. `npm install -g @anthropic-ai/claude-code`.
3. Open the **Models** picker (toolbar) and add your provider + API key, or paste
   a key into a shell. That's it.

## Community

Join the Pluto Discord: **[discord.gg/yy9QCnUsde](https://discord.gg/yy9QCnUsde)** —
request features, report bugs, and get help.

## License

Pluto's Terminal is **proprietary software**, free to download and use. The
source code is not open for copying, redistribution, modification, or reverse
engineering — see [LICENSE](LICENSE). "Pluto's Terminal" and "Pluto" are marks
of the copyright holder. (Earlier versions previously published under MIT remain
MIT for those specific versions.)

© 2026 Michael T. Cinnamon (plutothedev). All rights reserved.
