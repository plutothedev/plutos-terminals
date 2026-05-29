# Changelog

## v0.2.0 — Workstation overhaul (2026-05-28)

A ground-up UI overhaul into a MobaXterm-style "industrial-navy" workstation,
plus a built-in AI assistant, a live system monitor, and a multi-provider model
picker.

### Added
- **Workstation layout** matching the locked `industrial-navy` design: macOS-style
  menu bar with brand + active session/model, a lean stroke-icon toolbar grouped
  into Connect / Workspace / AI·Tools, a permanent session tree, a tabbed
  terminal grid, a right tools dock, a segmented status bar, and an F-key bar.
- **Right tools dock with three tabs** — **SFTP** (breadcrumb + Name/Size/Mod
  columns + colored file-type icons; local browser when no SSH tab), **Assistant**
  (built-in AI chat against your active model, with run/insert on commands), and
  **Monitor** (live CPU/MEM/DISK gauges + open-session list).
- **Multi-LLM provider picker** — ~40 models across Anthropic, OpenAI, Google,
  Groq, Mistral, OpenRouter, Moonshot/Kimi and more, with env-var injection at
  shell spawn (bring your own key).
- **Colored, labeled toolbox icons** per the design (Local/SSH/Serial,
  Split/MultiX/Tunnel, Ask AI/Models/Snippets/Agents).
- Local file browser gained a modified-time ("Mod") column.

### Changed
- Both side panels (session tree + tools dock) are now **always open** and can't
  be accidentally closed; Snippets/Agents open as a secondary panel beside the
  tree instead of replacing it.
- Flat terminal tabs (`● name ×`) with a blue active top-border; removed the old
  rounded "Chrome tabs", the house button, tab numbering, and the animated
  rainbow panel border.
- Status bar de-duplicated: one model indicator, no repeated "claude"; CPU/MEM/
  DISK moved to the Monitor tab.
- Multi-platform release builds (macOS / Windows / Linux) via GitHub Actions.

### Removed
- The faint "Quick tips" overlay behind the terminal.

### Notes
- Distribution moved to a hybrid model: source is developed privately, compiled
  installers are published publicly. Licensing changed from MIT to proprietary
  for this and future versions (prior MIT versions remain MIT).
