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

## `codebase-explorer.deck.json`

**Purpose:** understand an unfamiliar codebase before changing it. Claude on the left tuned to read first / recommend second; a shell on the right for cheap inspection (git log, file listings, dep checks).

**Layout:** 2 panels × 1 tab each.

**Agents:** Claude Code (explorer-tuned systemPrompt). Right pane is a plain shell.

**When to use:** you've cloned a repo and need to map it before editing. Pairs well with `git log --oneline` and project-tree commands in the inspect pane.

**Requires:** `ANTHROPIC_API_KEY`.

---

## `writing-helper.deck.json`

**Purpose:** focused writing partner. Drafting, editing, line-level critique. The Claude session treats the conversation as the deliverable — won't pivot to file-editing unless asked.

**Layout:** 1 panel × 1 tab.

**Agents:** Claude Code (writing-tuned systemPrompt — direct, voice-matching, no filler hype).

**When to use:** blog posts, video outlines, scripts, copy, emails. Anything where you want the words back, not a plan to make the words.

**Requires:** `ANTHROPIC_API_KEY`.

---

## `debug-session.deck.json`

**Purpose:** focused debugging. Claude on the left primed to chase root causes (reproduce → hypothesize → verify → fix); a shell on the right for re-running the failing command and tailing logs.

**Layout:** 2 panels × 1 tab each.

**Agents:** Claude Code (debugger-tuned systemPrompt). Right pane is a plain shell for repro work.

**When to use:** something is broken and you need to figure out why. The Claude pane will push back on symptom-patches (try/catch, default-value, retry-loop) and ask you to articulate the root cause.

**Requires:** `ANTHROPIC_API_KEY`.

---

## `trading-workflow.deck.json` (Pluto Style)

**Purpose:** focused trading session layout. One pane for AI analysis (paste setups, ask for confluences, sanity-check theses), one Python scratch for backtests / data work, one append-only daily session journal. ICT-trader-specialized.

**Layout:** 3 panels × 1 tab each.

**Agents:** Claude Code (analysis pane only, with ICT-trader systemPrompt). Other panes are just shells.

**When to use:** you're trading futures or any market session and want the AI + analysis + log layer around your charting platform (TradingView stays in your browser; this is everything else). Non-traders: just don't load this one.

**Requires:** `ANTHROPIC_API_KEY` for the analysis pane. PowerShell on Windows for the journal pane's date-formatted file commands (default).

**Note:** the journal pane creates `session-log-YYYY-MM-DD.md` in whatever cwd it spawns in. Use `Get-Content session-log-*.md` to grep across days.

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

- **In-app pack browser** — UI to browse local + remote packs without file picker (current: `📚 packs…` dropdown for bundled, `📁 from file` for local, `🔗 from URL` for remote)
- **Click-to-load deep links** — `plutosterminals://load?pack=<base64>` URLs that the app intercepts; one-click load from a video description or social post
- **Pack signing** — community packs signed with a Pluto-controlled key for trust on third-party loads
- **MCP one-click installer** — ✅ shipped v0.1.8: `🔌 MCPs` modal `install` button runs `claude mcp add ...` for you
