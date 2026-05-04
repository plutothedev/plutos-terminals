# How to use prompt packs (v0)

> **v0 reality:** there's no in-app loader yet. You read the `.deck.json`, and you configure the running app to match. The schema exists today so v1 can wire click-to-load. Manual is clunky but the format is canonical — once you set up a pack manually, you don't have to think about it again until you change the workflow.

## The five-minute manual flow

1. **Set your API key.** Most packs need `ANTHROPIC_API_KEY`. In a PowerShell session run:
   ```powershell
   $env:ANTHROPIC_API_KEY = "sk-ant-..."
   ```
   Set it system-wide (so every pane inherits it) via:
   ```powershell
   [Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")
   ```
   Restart Pluto's Terminals after setting at user-level so spawned shells see it.

2. **Open the pack file** in any text editor and look at the `panels[]` array.

3. **For each panel in `panels[]`:** click `+ pane` in the Pluto's Terminals header to add a panel. (The first panel is already there from app start, so for a 2-panel pack you only click `+ pane` once.)

4. **For each `tabs[]` entry inside a panel:** if it has a `cwd`, register a project: click `+ Add project` in the left sidebar → paste the cwd path → set the start commands from `tab.startCommands` → save → click the project to open it in the active panel.

   If the tab has no `cwd`, just open a fresh tab in the panel (`+ tab` in the panel header) and run the start commands manually by pasting them into the terminal.

5. **Run `claude` (or whatever the pack calls for)** in the panes that need it. The first start command in most packs is just an `echo` reminder of what the pane is for — actual `claude` invocation comes after you confirm your env is set.

That's it. Once configured, your panel/tab state persists across app restarts (the PTY children respawn fresh; scrollback replays from disk).

## Available packs (v0.0.2)

- **`example.deck.json`** — schema reference, shows all the fields. Don't actually use it — go to one of the practical packs below.
- **`claude-code-basic.deck.json`** — single Claude Code pane. Simplest possible setup.
- **`dual-claude-pair.deck.json`** — two panes: code + plan. Splits hands-on edits from architecture/research.
- **`trading-workflow.deck.json`** — three panes: Claude analysis + Python scratch + dated session journal. AI + analysis layer around your charting platform (which stays in your browser).
- **`pluto-mind-strategist.deck.json`** — Pluto's own setup for vault-level meta work. Strategist Claude in `C:\Users\pluto` reading the pluto-mind vault. Adapt the cwd paths to your own second-brain.

## Where this is going (v1)

- **In-app pack browser** — UI surface to browse local + remote `.deck.json` packs.
- **Click-to-load** — opening a pack file in your browser triggers `plutosterminals://load?pack=<base64>` deep link; the app intercepts, asks for confirmation, configures all panels + tabs in one click.
- **Pack signing** — community packs signed with a Pluto-controlled key; the app verifies before loading from third-party URLs.
- **MCP one-click installer** — `mcp_servers[]` field becomes wired; popular MCPs install from the UI.

## Authoring your own pack

Copy `example.deck.json` → rename → edit `name`, `description`, `panels[]`, `env_hints[]`, `notes[]`. Schema is at `SCHEMA.md`. Keep packs small and focused — one workflow per pack, not "everything I ever do." Share via PR to this repo's `prompt-packs/` folder if you want it shipped to the community (curation criteria TBD; for v0.0.2 just open an issue describing the pack).
