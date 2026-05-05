# Prompt Packs Catalog

A `.deck.json` prompt pack describes a multi-panel terminal layout you can clone in one click via the `📦 load pack` button in the app header. Each pack below is shipped in this folder; download the file (or clone the repo), open Pluto's Terminals, click load, point at the file. Done.

> **Quick start:** see `HOW_TO_USE.md` for the loading flow + `SCHEMA.md` for the file format. To author your own pack, copy `example.deck.json` and edit.

---

## `claude-code-basic.deck.json`

**Purpose:** simplest possible Claude Code setup. One panel, one tab, one job.

**Layout:** 1 panel × 1 tab. cwd defaults to your home dir.

**Agent:** Claude Code (single session).

**When to use:** you're learning Claude Code or doing a focused single-task session. Best starting point if you've never used the app before.

**Requires:** `ANTHROPIC_API_KEY` (auto-injected if you saved it on the welcome screen).

**Loads in:** 2 seconds.

---

## `dual-claude-pair.deck.json`

**Purpose:** parallel Claude Code sessions for split work — one for hands-on code edits, the other for planning / architecture / research. The two sessions don't share context; that's the point.

**Layout:** 2 panels × 1 tab each. Both cwd default to home.

**Agents:** Claude Code (×2). Each gets its own thread, its own token spend (watch the live `total cost` indicator in the header).

**When to use:** you're stuck on a build and want to step over to "plan" mode without losing your code session. Or doing back-and-forth between writing and reviewing.

**Requires:** `ANTHROPIC_API_KEY`.

---

## `trading-workflow.deck.json`

**Purpose:** focused trading session layout. One pane for AI analysis (paste setups, ask for confluences, sanity-check theses), one Python scratch for backtests / data work, one append-only daily session journal.

**Layout:** 3 panels × 1 tab each.

**Agents:** Claude Code (analysis pane only). Other panes are just shells.

**When to use:** you're trading futures or any market session and want the AI + analysis + log layer around your charting platform (TradingView stays in your browser; this is everything else).

**Requires:** `ANTHROPIC_API_KEY` for the analysis pane. PowerShell on Windows for the journal pane's date-formatted file commands (default).

**Note:** the journal pane creates `session-log-YYYY-MM-DD.md` in whatever cwd it spawns in. Use `Get-Content session-log-*.md` to grep across days.

---

## `pluto-personal-strategist.deck.json` (template — requires adaptation)

**Purpose:** demonstrates Pluto's actual workflow — Claude Code at home-dir level acting as "Strategist Claude" over an Obsidian-based second-brain vault, paired with a vault-root scratch shell.

**Layout:** 2 panels × 1 tab each.

**Agents:** Claude Code (Strategist) + scratch shell. The Strategist reads vault meta files on first request.

**⚠️ Requires adaptation:** the cwd paths are Pluto's machine (`C:\Users\pluto` and `C:\Users\pluto\Documents\pluto-mind`). On a fresh download those won't exist on your machine. **Edit the cwd values to your own home + your own second-brain vault path before loading.**

**When to use:** you have your own Obsidian-based second-brain (or similar) and want to run Claude as a meta-strategist over it. If you don't have a vault, load `claude-code-basic.deck.json` instead.

**Requires:** `ANTHROPIC_API_KEY` + a second-brain vault at the path you set.

---

## `example.deck.json` (schema reference)

Don't load this for real work. It exists as a schema reference — every field, with comments. Use it as a starting template when authoring your own pack. See `SCHEMA.md` for the field-by-field breakdown.

---

## Authoring your own pack

1. Copy `example.deck.json` → rename to `<your-slug>.deck.json`.
2. Edit `name` and `description`.
3. Replace `panels[]` with your actual layout.
4. Set `cwd` per tab — absolute path, or `null` to default to home.
5. Set `startCommands` per tab — array of commands run in sequence on shell spawn.
6. Add `env_hints[]` for any env vars users need to set themselves.
7. Document anything tricky in `notes[]`.

To share your pack with the community: open a PR adding it to this folder. Curation criteria TBD; for now, packs that demonstrate a useful workflow with clear documentation get merged.

## v1+ roadmap

- **In-app pack browser** — UI to browse local + remote packs without file picker
- **Click-to-load deep links** — `plutosterminals://load?pack=<base64>` URLs that the app intercepts; one-click load from a video description or social post
- **Pack signing** — community packs signed with a Pluto-controlled key for trust on third-party loads
- **Templated paths** — `${HOME}`, `${VAULT}` variables so packs work cross-machine without manual editing
- **MCP one-click installer** — `mcp_servers[]` field becomes wired; popular MCPs install from the UI
