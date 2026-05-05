# How to use prompt packs

A `.deck.json` prompt pack describes a multi-panel terminal layout you can clone in one click. v0.1.1 makes loading + authoring easy and includes a setup checker to verify your machine is ready.

## First time? Run the setup check (`🚀 setup`)

Before loading any pack, click **🚀 setup** in the header. The modal verifies:
- ✅ Node.js installed
- ✅ npm available
- ✅ Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)
- ✅ Anthropic API key saved (paste in the welcome screen or ⚙️ settings)
- ✅ Live API test passes (1-token throwaway call to verify your key)

If any step's missing, the modal shows the exact install command + a copy button. The setup modal auto-opens on first launch if `claude` isn't on your PATH; re-open anytime via the header button.

## Three ways to load a pack

### 1. Bundled packs dropdown (`📚 packs…`)

The simplest path. Click the **📚 packs…** dropdown in the app header. Pick any of the 5 bundled packs. Confirm the replace prompt. Done.

Bundled packs in v0.1.0:
- `claude-code-basic` — single Claude Code pane
- `dual-claude-pair` — code pane + plan pane
- `trading-workflow` — Claude analysis + Python scratch + dated journal
- `pluto-personal-strategist` — cross-machine template using `${USERPROFILE}` + `${VAULT}`
- `example` — schema reference, don't actually load this

### 2. From file (`📁 from file`)

Click **📁 from file** in the header → pick any `.deck.json` from your disk. Use this for packs you downloaded from someone else, exported from another machine, or hand-authored.

### 3. Drag-and-drop

Drag a `.deck.json` file from File Explorer / Finder onto the app window. Loads immediately.

## Save your own setup as a pack (`💾 export`)

After configuring panels + tabs the way you like:

1. Click **💾 export** in the header.
2. Type a pack name (e.g. "Trading Morning Setup").
3. Type an optional description.
4. The file downloads to your Downloads folder as `<your-slug>.deck.json`.

Share it on Discord, GitHub, anywhere. Anyone with Pluto's Terminals can drag it in or load via 📁 from file.

## Settings (`⚙️`)

Click the **⚙️** button in the header for the settings modal:

- **Anthropic API key** — auto-injected as `ANTHROPIC_API_KEY` into every spawned shell. `claude` just works without per-shell setup.
- **${VAULT} path** — the path that `${VAULT}` resolves to in pack `cwd` strings. Set this to your second-brain / Obsidian vault location to use packs like `pluto-personal-strategist` cross-machine.
- **Pluto Discord URL** — edit the welcome screen's "Join Pluto Discord" button target.
- **Factory reset** — wipes ALL state (panels, projects, scrollback, API key, vault path, theme, welcome flag). Useful for testing or clean reinstall.

## MCP servers (`🔌 MCPs`)

Click **🔌 MCPs** for a curated list of popular MCP (Model Context Protocol) servers — filesystem, GitHub, Puppeteer, Brave Search, Fetch, Memory. Each shows the install command for Claude Code; click **copy command**, paste into any terminal pane, run.

One-click install (no copy-paste) is on the roadmap. Today's UX is curated discovery + safe copy-paste.

## Quick-spawn agent grid (`⚡ agent grid`)

One click → 4-panel layout: Researcher / Coder / Reviewer / Journal. Each panel runs its own Claude Code session with a role hint. Useful for parallel multi-agent workflows.

## Templated paths (`${VARNAME}`)

Pack `cwd` values can include `${VARNAME}` placeholders that expand at spawn time:

- `${USERPROFILE}` — Windows home directory (auto-set by Windows)
- `${HOME}` — Mac/Linux home directory
- `${VAULT}` — your second-brain vault path (set in ⚙️ settings)
- Any other process env variable

Resolution order: settings (VAULT, etc.) → process env → empty string for unknowns.

This is what makes packs cross-machine. `pluto-personal-strategist.deck.json` uses `${USERPROFILE}` and `${VAULT}` so the same pack works for everyone.

## Authoring a pack

Easiest path: configure your setup in the app, click **💾 export**, edit the resulting JSON if needed.

Hand-authoring: copy `example.deck.json` → rename → edit `name`, `description`, `panels[]`. See `SCHEMA.md` for the full schema.

To share with the community: open a PR adding your pack to this folder. Curation criteria TBD; for now, packs that demonstrate a useful workflow with clear documentation get merged.
