# MCP for the Native Agent — Design

**Status:** Approved 2026-06-14. Branch `001-remote-sessions-parity`.
**Goal:** Give Pluto's in-app native agent (`AgentMode`) real tool-calling against MCP servers, so it can read/write files, query GitHub, search the web, etc. — not just run shell commands. Closes the Milestone-4 leftover "MCP for the native agent."

## Background / current state
- `AgentMode.jsx` is a text-protocol ReAct loop: the model emits `RUN`/`DONE`/`ASK` actions (parsed by `parseAction`), the app runs shell commands via `runAndCapture` (OSC-133 block capture) and feeds output back. A non-bypassable `DANGEROUS_PATTERNS` gate forces destructive shell commands through manual approval even in auto-run. Tools today = shell only.
- Existing "MCP" support (`McpInstaller.jsx` + Rust `mcp_install`) only runs `claude mcp add …` to configure servers for the **external `claude` CLI** — the native agent cannot use MCP.
- LLM calls go through `llm.rs` (`llm_complete`, `llm_stream` — Anthropic + OpenAI SSE) and `llmStream.js`. 17 providers routed, mostly OpenAI-schema-behind-a-baseURL or Anthropic.

## Decisions (locked in brainstorming)
1. **Config source:** App-managed — Pluto owns its MCP server list (own JSON + add/remove UI), independent of Claude Code.
2. **Transports:** stdio (spawn subprocess) **and** HTTP/SSE (remote URL + token).
3. **Tool-call mechanism:** Native provider function-calling (Anthropic + OpenAI dialects), not a text protocol.
4. **Safety:** Annotation-aware gating — read-only tools auto-run (in auto-run mode), write/destructive/unannotated tools always manually gated.
5. **Lifecycle:** Persistent Rust connection manager — connect-on-first-use, app-lifetime, cached tool lists.

## Architecture — 4 components (build A → B → C, D alongside C)

### A. Rust MCP client + connection manager — `src-tauri/src/mcp_client.rs`
- **Config storage:** server list in `<app_data>/mcp-servers.json` (Rust-owned, machine-specific, **NOT** cloud-synced — local npx paths/processes differ per machine). Each entry:
  ```json
  { "id": "filesystem", "enabled": true, "transport": "stdio",
    "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","<dir>"], "env": {"FOO":"bar"} }
  ```
  or `{ "id":"remote","transport":"http","url":"https://…" }`. **Secrets** (HTTP bearer tokens, sensitive env values like `GITHUB_PERSONAL_ACCESS_TOKEN`) live in the **OS keychain** (account `mcp-secret:<server-id>:<key>`), never in the JSON; the JSON references them by key name.
- **Connection manager:** a process-lifetime singleton (`once_cell`/`Mutex<HashMap<String, McpConn>>`). `McpConn` wraps either a stdio child (tokio process, JSON-RPC framed over stdin/stdout) or an HTTP/SSE client. Connect-on-first-use; perform the MCP `initialize` handshake, cache the `tools/list` result (name, description, JSON input schema, annotations).
- **MCP protocol:** prefer the official Rust SDK **`rmcp`** if it integrates with the existing tokio runtime + supports both transports — it implements `initialize`/`tools/list`/`tools/call` and the transports correctly. **Fallback:** hand-rolled minimal JSON-RPC 2.0 client (only `initialize`, `tools/list`, `tools/call`) over stdio + a thin SSE/HTTP path. The plan must spike `rmcp` first and fall back only if it doesn't fit.
- **Tauri commands:** `mcp_servers_list() -> [ServerCfg]`, `mcp_server_add(cfg)`, `mcp_server_remove(id)`, `mcp_list_tools() -> [Tool{server,name,description,schema,read_only,destructive}]` (connects enabled servers on first call, caches), `mcp_call_tool(server, tool, args_json) -> { content, is_error }`, `mcp_reconnect(id?)`.
- Errors (server spawn fail, connect timeout, tool error) return `Err(String)` surfaced to the agent as a tool error result (the loop can self-correct) and to the UI.

### B. LLM native tool-calling — `src-tauri/src/llm.rs` + `src/features/terminals/llmStream.js`
- Extend the request path to accept an optional `tools` array (each `{name, description, input_schema}`) and to surface `tool_calls` from the response. **Two dialects:**
  - **Anthropic:** add top-level `tools`; response/stream yields `tool_use` content blocks (`id`, `name`, `input`); the next turn sends a `tool_result` block (matching `tool_use_id`) in a `user` message.
  - **OpenAI-compatible:** add `tools` (function schema); response/stream yields `tool_calls` (with `id`, `function.name`, `function.arguments` — arguments stream as concatenated delta fragments); the next turn sends `role:"tool"` messages keyed by `tool_call_id`.
- `llm_stream` SSE parsing handles both tool-call delta shapes (Anthropic `content_block_delta`/`input_json_delta`; OpenAI `choices[].delta.tool_calls[]`). Returns the assembled tool_calls + any text. `llmStream.js` exposes them to the loop.
- A capability flag per provider/model: if tool-calling isn't supported, offer no tools (agent falls back to shell-only via the built-in tool, or plain reasoning).

### C. AgentMode loop → native tools + approval — `AgentMode.jsx` (+ a small `agentTools.js` helper)
- **Unify the loop on tool-calls.** Shell execution becomes a **built-in tool** `run_command({command})` exposed alongside MCP tools. The loop:
  1. On run start, `mcp_list_tools()` + the built-in `run_command` → assemble the `tools` array (+ annotations map).
  2. Call the LLM with `tools`. Stream text (existing live rendering) + collect tool_calls.
  3. For each tool_call → **approval gate** → execute → produce a tool_result.
  4. Send tool_results back; repeat until the model returns final text with no tool_call (= done) or the step cap / Stop hits.
- **Execution routing:** `run_command` → existing `runAndCapture(tabId, cmd)` (keeps Blocks/OSC-133 capture, transcript). MCP tool → `mcp_call_tool(server, name, args)`.
- **Approval (annotation-aware), in code not prompt:**
  - Default (auto-run OFF): every tool_call shows server.tool + args, approve/skip/edit.
  - Auto-run ON: a tool auto-executes **only if** it is read-only — `run_command` passing the existing `isDangerousCommand` check, or an MCP tool with `readOnlyHint === true` and not `destructiveHint`. Everything else (writes, unannotated MCP tools, dangerous shell) is forced back to manual approval. Tool results are attacker-influenced text → this gate is never bypassed by model/tool output.
- Keep the existing Stop, step cap, live token streaming, and per-step UI; render tool_calls + results as steps.

### D. Config UI — extend `McpInstaller.jsx`
- From copy-paste discovery to real app registration. For each curated server (and a custom "add your own"): an **Add to Pluto** action that writes a `ServerCfg` via `mcp_server_add` (prompting for the stdio dir/args or the http url, and routing token/secret fields to the keychain). Show enabled toggle, live tool count (from `mcp_list_tools`), remove, and reconnect. The existing `claude mcp add` copy-paste stays for users who also want the external CLI to have it.

## Data flow
```
agent run
  -> mcp_list_tools() + built-in run_command  => tools[]
  -> LLM(prompt, tools)  => text (streamed) + tool_calls[]
  -> for each tool_call: approval gate (annotation/dangerous)
       run_command -> runAndCapture ; mcp tool -> mcp_call_tool
     => tool_result
  -> LLM(history + tool_results, tools) ...loop...
  -> final text, no tool_call => DONE
```

## Security model
- **Secrets** (MCP HTTP tokens, sensitive server env) → OS keychain only (accounts `mcp-secret:<id>:<key>`), never the config JSON or localStorage.
- **Approval gate is a code control, not a prompt instruction** — write/destructive/unannotated tools and dangerous shell always require human approval, even in auto-run, because each tool result is fed back into the next prompt (prompt-injection surface).
- **Config not synced** — MCP server defs are machine-specific and excluded from cloud sync (don't add to `SOURCES`).
- stdio servers are spawned with the user's configured command/args/env only — no shell interpolation; args passed as an argv vector (like the existing `mcp_install` which runs argv directly, no shell).

## Testing
- **Rust (`mcp_client.rs`):** mock stdio MCP server (a small test binary / script emitting canned `initialize` + `tools/list` + `tools/call` JSON-RPC) — assert connect, tool listing (incl. annotations), tool call result, and error surfacing; keychain secret round-trip for a token-bearing server.
- **LLM dialect (`llm.rs`/`llmStream.js`):** serialize a tools array per dialect; parse `tool_use` (Anthropic) and `tool_calls` (OpenAI) from canned streaming chunks into a uniform `{id,name,args}`.
- **Agent loop (JS):** drive the loop with a fake `mcp_list_tools`/`mcp_call_tool` to completion; assert approval gating — read-only MCP tool auto-runs in auto-run mode, a `destructiveHint` tool and a dangerous shell command are forced to manual approval.

## Out of scope (YAGNI)
- MCP **resources**/**prompts** (only tools in v1).
- MCP server **OAuth** flows (token paste only for HTTP servers).
- Syncing MCP config across machines.
- One-click npx install/version management (user provides the command; we spawn it).
- Parallel/concurrent tool-call execution (sequential in v1; the loop handles one tool_call batch at a time).

## Build notes
- New deps: `rmcp` (if adopted) in `src-tauri/Cargo.toml`; build env per the perl/vcvars notes. New keychain accounts `mcp-secret:*`.
- `llm.rs`/`llmStream.js` tool-calling must not regress the existing no-tools `llm_complete`/`llm_stream` paths (AskBar, error explainer, agent-without-MCP) — tools are optional and omitted when none configured.
