# Pluto's Terminals — Codebase

Multi-terminal desktop app (Tauri 2 + React 18 + Vite + xterm.js) being built as a free community gift for the Pluto community (Discord, audience, social). v0 ships as a free MIT-licensed downloadable.

> **Vault meta lives at:** `C:\Users\pluto\Documents\pluto-mind\03 Projects\plutos-terminals\` (CLAUDE.md, roadmap.md, iteration-log.md). Read those first for the strategic context, kill-switch criteria, and v0/v1/v2 scope split.

## Two-Claude protocol

Per the vault-root [[CLAUDE.md]] convention:
- **Strategist Claude** runs in `C:\Users\pluto\` Claude Code terminal — generates design decisions, scopes, retrospectives. Reads the vault's project meta to stay aligned.
- **Executor Claude** (this session, when spawned in the codebase) implements code, runs builds, debugs. Reads this file + the vault meta on session start.

When pluto asks for a build change here, this Executor session handles it. When pluto asks for a strategic call (kill switch, v0 → v1 transition, scope cut), Strategist drives.

## What the codebase does (v0)

Lifts Lyfe's `src/features/terminals/` component as the foundation:
- **Multi-panel terminal grid** — up to N panels visible at once (see `grid.js MAX_PANELS`); each panel has tabs; each tab is a PTY-backed shell.
- **Project sidebar** — pin projects with cwd + start commands; click to open in active panel; drag to drop into a specific panel.
- **PTY backend** in `src-tauri/src/pty.rs` (portable-pty: ConPTY on Windows, native PTYs elsewhere). Sessions registered in `pty::SessionRegistry` (Tauri-managed state). RunEvent::ExitRequested → `kill_all` so no orphan shells.
- **Scrollback persistence** — tab unmount writes last 500 lines to `data/terminals/scrollback/<tab_id>.txt`. Replays on remount.
- **Session transcripts** — ANSI-stripped output appended to `data/terminals/transcripts/<date>/<name>.md` every 5s (or 8KB).
- **Claude /cost token tracking** — TerminalPane scans output for `total cost: $X` and aggregates across tabs.
- **Auto-approve for Claude permission prompts** — opt-in per project; when the project tab is backgrounded and Claude pauses for tool-use confirmation, the app sends "1" (Yes).
- **System tray + hide-on-close** — closing window hides; tray icon brings back; "Quit (kill all sessions)" tray item is the only path to actually exit.
- **Themes** — multiple xterm color themes (`themes.js`); Pluto Dark is default.

## What's NOT in v0 (per `roadmap.md`)

- In-app prompt-pack browser + click-to-load (v1) — v0 has a sample pack at `prompt-packs/example.deck.json` and the schema spec but no UI to load packs; user opens manually.
- Agent grid panel (v1) — Moon Dev's differentiator; pluto-terminals v0 is just the multi-terminal grid (matches Moon Dev table-stakes).
- One-click Anthropic API key config / MCP installer (v1) — v0 welcome screen has an API key field but does NOT persist; user pastes it into shell sessions.
- Drag-and-drop project organization across panels (lifted from Lyfe but may need v1 polish).
- Signed installers, GitHub releases, downloadable distributables — happens AFTER `cargo tauri dev` proves the binary works.

## Stack

- **Frontend:** React 18, Vite 8, xterm.js 5.5 + addon-fit + addon-web-links
- **Backend:** Rust 2021, Tauri 2.10.3, portable-pty 0.8, rfd 0.15 (folder picker), chrono 0.4
- **Persistence:** localStorage (UI state) + filesystem via `commands::write_store`/`read_store` (scrollback, transcripts)
- **Identifier:** `com.plutothedev.terminals`
- **Dev URL:** `http://localhost:5310`

## Get started

```powershell
cd C:\Users\pluto\plutos-terminals
npm install
npm run tauri dev
```

First run shows the Pluto's Terminals welcome screen with the API key prompt. Click ENTER → terminal grid loads with one default panel + one tab running `pwsh.exe` (or PowerShell 5 fallback) on Windows.

## Build issues to expect (first run)

- **Rust toolchain** — needs `rustup` + the MSVC toolchain on Windows. If `cargo build` fails with linker errors, install Visual Studio Build Tools.
- **Tauri prereqs** — see https://tauri.app/start/prerequisites/ if `npm run tauri dev` errors on the Rust side.
- **portable-pty 0.8** — should compile cleanly on Windows; if it breaks, the issue is usually `winapi-rs` version mismatch and `cargo update` may help.
- **Icons** — `src-tauri/icons/` was copy-paste placeholders from Lyfe. Tauri build expects all 5 icon files; if any are missing, build fails with "icon path not found." Replace with Pluto-branded icons via `cargo tauri icon assets/pluto-icon.png` once a real source icon exists.

## Lifted from Lyfe

The terminals component is a near-verbatim lift from `C:\Users\pluto\Downloads\command-center\lyfe\src\features\terminals\` (active development on Lyfe is gated; lifting its terminals component into a separate codebase doesn't violate the gate). Rebrand sweep done: 7 "Lyfe" → "Pluto's Terminals" string replacements across TerminalPane.jsx, ProjectDialog.jsx, OnboardingOverlay.jsx, TerminalsTab.jsx, themes.js. Theme labels: "Lyfe Dark" → "Pluto Dark" / "Lyfe Light" → "Pluto Light".

If Lyfe ships terminal improvements during pluto-terminals v0/v1, decision gate: cherry-pick or diverge. Default cherry-pick for non-UX changes (PTY robustness, performance), diverge for UX (Pluto's Terminals has its own brand voice).

## Rules & conventions

- **`(C)` marker** — Claude-authored files include `<!-- (C) -->` comment near top, or the equivalent `// (C)` in source files.
- **No editing pluto's own writing** — per vault-root [[CLAUDE.md]] rule.
- **v0-first** — no v1/v2 features here until v0 is a working dev binary on pluto's machine + pushed to GitHub.
- **Brain/operations boundary** — operational state (PTY sessions, scrollback files) lives at `data/` next to `package.json` in dev, or `%APPDATA%/com.plutothedev.terminals/` in production. The vault project meta does NOT mirror code state.

## Files of note

- `src/App.jsx` — entry shell + welcome screen + localStorage `{ st, save }` wrapper for `TerminalsTab`
- `src/features/terminals/TerminalsTab.jsx` — main terminal grid (491 lines lifted from Lyfe)
- `src/features/terminals/TerminalPane.jsx` — xterm + PTY IPC + Claude /cost tracking + auto-approve scanning
- `src-tauri/src/lib.rs` — Tauri app entry, tray icon, hide-on-close, command registration
- `src-tauri/src/pty.rs` — PTY session registry + spawn/write/resize/kill commands
- `src-tauri/src/commands.rs` — store + folder picker + git status + npm scripts + scrollback + transcripts + recent files
- `src-tauri/tauri.conf.json` — productName "Pluto's Terminals", identifier `com.plutothedev.terminals`, dev port 5310

## Roadmap pointer

Don't start v1 features (agent grid, prompt-pack auto-loader, MCP installer) until v0's kill-switch criteria are measured. See `C:\Users\pluto\Documents\pluto-mind\03 Projects\plutos-terminals\roadmap.md`. The kill-switch is real — don't sunk-cost v1 if v0 doesn't pull community engagement.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->
