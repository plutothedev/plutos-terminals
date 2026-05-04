# Pluto's Terminals

Free multi-terminal desktop app for the Pluto AI YouTube community.

> **Status (2026-05-04):** v0 codebase scaffolded. Terminals component lift from Lyfe pending. PTY backend not yet wired. First boot will show a placeholder welcome screen.

## What it is

A multi-terminal grid app (Tauri + React + xterm.js) made for the Pluto community. Run multiple AI agents (Claude Code, Codex, etc.) side by side. Save and share terminal setups as **prompt packs** so others can clone your exact configuration in seconds.

## Stack

- Tauri 2.10
- React 18 + Vite 8
- xterm.js 5.5 + addon-fit + addon-web-links
- Rust + portable-pty (PTY backend; pending lift from Lyfe)

## Get started (when scaffolded fully)

```bash
cd C:\Users\pluto\plutos-terminals
npm install
npm run tauri dev
```

## Roadmap

See `C:\Users\pluto\Documents\pluto-mind\03 Projects\plutos-terminals\roadmap.md` for v0/v1/v2 scope, kill-switch criteria, and anti-goals.

## Vault project meta

`C:\Users\pluto\Documents\pluto-mind\03 Projects\plutos-terminals\` — CLAUDE.md, COMMANDS.md, iteration-log.md, roadmap.md.

## License

TBD (likely MIT or Apache 2.0 — see `roadmap.md`).
