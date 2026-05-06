# `.deck.json` Schema (v0 draft)

A prompt pack is a JSON file that describes one shareable terminal setup — multi-panel layout, starting commands, environment hints, and (in v1+) MCP server installs. Anyone can save a pack and share it with the Pluto community.

> **v0 status:** schema is defined; no auto-loader UI yet. Users open the file manually or hand-load via a setup script. v1 adds an in-app pack browser + click-to-load flow.

## Top-level shape

```json
{
  "schema": "plutos-terminals/deck.json/v0",
  "name": "Human-readable pack name",
  "description": "One-paragraph what-this-does",
  "created": "YYYY-MM-DD",
  "panels": [...],
  "mcp_servers": [...],
  "env_hints": [...],
  "notes": [...]
}
```

## `panels[]`

One entry per terminal panel that should open. Order is preserved.

```json
{
  "label": "panel-key",
  "tabs": [
    {
      "label": "Tab name",
      "cwd": "absolute/path/or/null",
      "startCommands": ["claude"],
      "systemPrompt": "You are a research assistant. Default mode: synthesize sources I provide..."
    }
  ]
}
```

### `systemPrompt` (v0.1.8+)

If a tab has a `systemPrompt` string AND its `startCommands` launches an interactive REPL like `claude`, the app waits 2 seconds after the start commands run (giving `claude` time to boot), then types the system prompt as the first user message. This is what turns packs from "tabs with labels" into actual specialized agents — Researcher, Coder, Reviewer, etc. each prefixed with role-specific guidance Claude treats as its operating context.

Keep system prompts concise (1-3 sentences). Long prompts work but add to your token cost on every Claude turn.

## `mcp_servers[]` (v1)

Reserved for the v1 one-click MCP installer. Each entry will include:

```json
{
  "name": "filesystem",
  "package": "@modelcontextprotocol/server-filesystem",
  "args": ["--root", "/some/path"],
  "auto_install": true
}
```

In v0, this array is informational — install is manual.

## `env_hints[]`

Things the user should set in their shell. v0 surfaces these as a checklist on pack-load (NOT yet implemented; v1).

```json
{
  "key": "ANTHROPIC_API_KEY",
  "purpose": "Required for Claude Code"
}
```

## Versioning

`schema` field is the version pinning point. v0 = `plutos-terminals/deck.json/v0`. Breaking schema changes bump the version; the app rejects packs from a future version with a clear error rather than silently misloading.

## Signing (v1)

v1 will sign packs with a Pluto-controlled key so users can trust packs loaded from third-party URLs. v0 packs are unsigned — only load packs you trust.

## Optional fields

Pack authors can add `source_url`, `author`, `tags`, or other arbitrary fields. v0 ignores unknown fields; v1 may surface specific ones in the in-app browser.
