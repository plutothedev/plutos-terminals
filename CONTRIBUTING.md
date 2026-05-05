# Contributing to Pluto's Terminals

Thanks for considering a contribution. The project is run by [@plutothedev](https://github.com/plutothedev) and the [Pluto community](https://discord.gg/3cZQVgKF) — code, prompt packs, and bug reports are all welcome.

## Quick contribution paths

1. **Submit a prompt pack** — open a PR adding a `.deck.json` to `prompt-packs/`. See pack-submission template under [issue templates](.github/ISSUE_TEMPLATE) for the format. Bundled with the next release.
2. **Report a bug** — open an issue using the bug-report template.
3. **Suggest a feature** — open an issue using the feature-request template.
4. **Ship code** — pick an open issue or propose a change. PRs go through review.

## Build from source

```bash
git clone https://github.com/plutothedev/plutos-terminals.git
cd plutos-terminals
npm install
npm run tauri dev   # dev build with hot-reload
npm run tauri build # production build → src-tauri/target/release/bundle/msi/
```

**Prerequisites:** Node.js LTS, Rust 1.77+ (via [rustup](https://rustup.rs/)), Visual Studio Build Tools 2019+ on Windows.

First `cargo build` is slow (~3 min) because Tauri pulls many crates. Subsequent builds are incremental and fast (~30-60 sec).

## Project layout

- `src/` — React frontend
  - `App.jsx` — entry shell + Welcome screen + state management
  - `features/terminals/` — multi-terminal grid component (lifted from Lyfe with rebrand sweep)
  - `features/terminals/AgentView.jsx` — agent-view card grid (alternative rendering of `state.panels`)
  - `components/` — shared modals + toast + confirm + setup checker + MCP installer + update banner
- `src-tauri/` — Rust backend
  - `src/lib.rs` — Tauri app entry, tray icon, command registration
  - `src/pty.rs` — PTY session management (portable-pty)
  - `src/commands.rs` — filesystem store, project helpers, scrollback persistence, setup-check helpers
- `prompt-packs/` — bundled `.deck.json` packs + `SCHEMA.md` + `HOW_TO_USE.md` + `README.md` catalog
- `scripts/generate_icon.py` — Pillow-based app-icon generator
- `releases/` — per-version release notes + launch content drafts

## Authoring a prompt pack

The fastest path: configure your terminal layout in the running app, click **💾 export**, edit the resulting JSON if needed.

By hand: copy `prompt-packs/example.deck.json` and edit `name`, `description`, `panels[]`. Schema lives at `prompt-packs/SCHEMA.md` (`plutos-terminals/deck.json/v0`).

To submit: open a PR adding your `.deck.json` to `prompt-packs/`. Curation criteria for the bundled set:
- Has a clear `name` + `description` (1-3 sentences explaining the use case)
- Uses templated `${USERPROFILE}` / `${HOME}` / `${VAULT}` rather than hardcoded paths (cross-machine)
- `notes[]` documents any prerequisites or gotchas
- Doesn't reference private resources (pack should work for any user)

Packs that don't meet bundling criteria can still be shared via the [Pluto Discord](https://discord.gg/3cZQVgKF) `#packs` channel — community-curated rather than bundled.

## Code conventions

- **Components** — functional + hooks, no class components. Keep them under ~300 lines; split when they grow.
- **Styles** — inline via the existing brand-color constants in each component. No CSS-in-JS framework. Keep brand colors consistent: `#0a0a0a` background, `#4DAAFC` accent (action), `#FF0080` Pluto magenta (signature / destructive).
- **Tauri commands** — snake_case in Rust, camelCase in JS invoke calls (Tauri auto-renames). Keep parameter signatures stable.
- **Toast/Confirm** — use `useToast()` and `useConfirm()` instead of `window.alert/confirm` for any user-facing dialog.
- **No new dependencies without discussion** — open an issue first.

## License

All contributions are MIT-licensed. By submitting a PR you agree to the project license.
