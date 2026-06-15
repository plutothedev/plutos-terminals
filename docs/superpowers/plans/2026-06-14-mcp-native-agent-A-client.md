# MCP Native Agent — Component A: Rust MCP client + connection manager

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> Spec: `docs/superpowers/specs/2026-06-14-mcp-native-agent-design.md`. This is **plan 1 of 3** (A=client, B=LLM tool-calling, C/D=agent loop + UI follow as their own plans).

**Goal:** A Rust MCP client that connects to app-configured MCP servers (stdio + HTTP), lists their tools (with annotations), and calls tools — exposed to the frontend as Tauri commands. Standalone-testable via a mock server; no agent/UI yet.

**Architecture:** App-managed server config in `<app_data>/mcp-servers.json` (secrets in keychain). A process-lifetime connection manager (singleton) connects enabled servers on first use and caches tool lists. Hand-rolled minimal JSON-RPC 2.0 (`initialize`/`tools/list`/`tools/call`) over a stdio child process; a reqwest-based path for HTTP servers. Tauri commands wrap it.

**Tech Stack:** Rust, Tauri v2, tokio (process + async), serde_json, reqwest (already a dep), the existing `vault.rs` keychain. `git2`/`ssh2` unaffected.

**Note on rmcp:** Task A1 spikes the official `rmcp` SDK; if it integrates cleanly with the existing tokio runtime and both transports, prefer it and adapt later tasks (the command surface in A7 stays identical). If not, proceed with the hand-rolled client specified here.

---

## File Structure
- Create `src-tauri/src/mcp/mod.rs` — module root, re-exports.
- Create `src-tauri/src/mcp/config.rs` — `ServerCfg` type + `mcp-servers.json` load/save + keychain secret refs.
- Create `src-tauri/src/mcp/jsonrpc.rs` — minimal JSON-RPC 2.0 framing (request/response, id correlation).
- Create `src-tauri/src/mcp/transport.rs` — `Transport` enum: stdio child (tokio) + http (reqwest); send/recv one JSON-RPC message.
- Create `src-tauri/src/mcp/client.rs` — `McpConn` (one server: initialize, tools/list, tools/call) + the `Tool` struct (name/desc/schema/read_only/destructive).
- Create `src-tauri/src/mcp/manager.rs` — singleton connection manager + the `#[tauri::command]` fns.
- Modify `src-tauri/src/lib.rs` — `mod mcp;` + register commands.
- Test: `src-tauri/tests/mcp_mock.rs` (or `#[cfg(test)]` in client.rs) — a mock stdio server.

---

## Task A1: Spike rmcp (decision task, timeboxed)

**Files:** none committed unless adopting rmcp.

- [ ] **Step 1: Evaluate rmcp**

With the build-env preamble (Strawberry Perl + vcvars64), in a scratch check: add `rmcp = { version = "*", features = ["client","transport-child-process"] }` to `src-tauri/Cargo.toml` and run `cargo check`. Read its docs.rs client API for: connecting a stdio child, `initialize`, `list_tools`, `call_tool`, and whether an HTTP/SSE client transport exists.

- [ ] **Step 2: Decide + record**

If rmcp compiles, exposes those four operations, and works with tokio without a conflicting runtime: ADOPT it — note the exact API in a comment block at the top of `src-tauri/src/mcp/mod.rs` (created in A2) and implement `client.rs` (A4) as a thin wrapper over rmcp instead of `jsonrpc.rs`/`transport.rs`. Keep `config.rs`, `manager.rs`, and the command surface (A7) identical regardless. If rmcp does NOT fit cleanly, REVERT the Cargo.toml change and proceed with the hand-rolled client (A3–A4). Either way, `git checkout src-tauri/Cargo.toml src-tauri/Cargo.lock` if not adopting.

- [ ] **Step 3: No commit** unless adopting (then commit the Cargo.toml dep alone: `chore(mcp): add rmcp SDK`).

> Tasks A3–A4 below specify the hand-rolled path. If rmcp is adopted, implement the same `McpConn`/`Tool` interface (A4 Step 3 signatures) over rmcp and skip A3.

---

## Task A2: Server config type + persistence

**Files:**
- Create: `src-tauri/src/mcp/mod.rs`, `src-tauri/src/mcp/config.rs`
- Test: `#[cfg(test)]` in `config.rs`

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/mcp/config.rs` (append at bottom):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trips_config_json() {
        let dir = std::env::temp_dir().join(format!("mcp-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mcp-servers.json");
        let cfgs = vec![ServerCfg {
            id: "fs".into(), enabled: true, transport: "stdio".into(),
            command: Some("npx".into()),
            args: vec!["-y".into(), "server-filesystem".into()],
            env: Default::default(), url: None, secret_keys: vec![],
        }];
        save_configs(&path, &cfgs).unwrap();
        let back = load_configs(&path).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].id, "fs");
        assert_eq!(back[0].args, vec!["-y", "server-filesystem"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn missing_file_is_empty_list() {
        let p = std::env::temp_dir().join("does-not-exist-mcp.json");
        assert!(load_configs(&p).unwrap().is_empty());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Build env, then `cargo test mcp::config` → FAIL (module/types missing).

- [ ] **Step 3: Implement**

`src-tauri/src/mcp/mod.rs`:
```rust
// (C) MCP client for the native agent. See docs/superpowers/specs/2026-06-14-mcp-native-agent-design.md.
pub mod config;
pub mod jsonrpc;
pub mod transport;
pub mod client;
pub mod manager;
```

`src-tauri/src/mcp/config.rs`:
```rust
// (C)
// App-managed MCP server config, persisted to <app_data>/mcp-servers.json.
// Secrets (HTTP tokens, sensitive env) are NOT stored here — only the keychain
// account key names in `secret_keys`; values live in the OS keychain (vault.rs).
use std::collections::BTreeMap;
use std::path::Path;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ServerCfg {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub transport: String,           // "stdio" | "http"
    #[serde(default)]
    pub command: Option<String>,     // stdio
    #[serde(default)]
    pub args: Vec<String>,           // stdio
    #[serde(default)]
    pub env: BTreeMap<String, String>, // stdio non-secret env
    #[serde(default)]
    pub url: Option<String>,         // http
    #[serde(default)]
    pub secret_keys: Vec<String>,    // keychain key names this server needs (env name / "bearer")
}
fn default_true() -> bool { true }

pub fn load_configs(path: &Path) -> Result<Vec<ServerCfg>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}

pub fn save_configs(path: &Path, cfgs: &[ServerCfg]) -> Result<(), String> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let json = serde_json::to_string_pretty(cfgs).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
```
Also add `mod mcp;` to `src-tauri/src/lib.rs` near the other `mod` declarations (needed for the test to compile; command registration is A7).

- [ ] **Step 4: Run to verify it passes**

`cargo test mcp::config` → PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/mcp/mod.rs src-tauri/src/mcp/config.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): server config type + json persistence"
```

(Empty stub files `jsonrpc.rs`, `transport.rs`, `client.rs`, `manager.rs` must exist for `mod.rs` to compile — create them with a single `// (C) placeholder` line in this task, filled by A3–A7.)

---

## Task A3: JSON-RPC framing + stdio transport

**Files:**
- Create: `src-tauri/src/mcp/jsonrpc.rs`, `src-tauri/src/mcp/transport.rs`
- Test: `#[cfg(test)]` in `jsonrpc.rs`

(Skip this task if rmcp was adopted in A1.)

- [ ] **Step 1: Write the failing test** (jsonrpc framing is pure + unit-testable)

In `jsonrpc.rs` bottom:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builds_request_with_id() {
        let r = request(7, "tools/list", serde_json::json!({}));
        assert_eq!(r["jsonrpc"], "2.0");
        assert_eq!(r["id"], 7);
        assert_eq!(r["method"], "tools/list");
    }
    #[test]
    fn parses_result_by_id() {
        let line = r#"{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}"#;
        let (id, res) = parse_response(line).unwrap();
        assert_eq!(id, Some(7));
        assert!(res.unwrap().get("tools").is_some());
    }
    #[test]
    fn parses_error_response() {
        let line = r#"{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"nope"}}"#;
        let (id, res) = parse_response(line).unwrap();
        assert_eq!(id, Some(7));
        assert!(res.is_err());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

`cargo test mcp::jsonrpc` → FAIL.

- [ ] **Step 3: Implement**

`src-tauri/src/mcp/jsonrpc.rs`:
```rust
// (C)
// Minimal JSON-RPC 2.0 helpers for the MCP stdio transport. MCP frames each
// message as a single line of JSON over stdout (newline-delimited).
use serde_json::Value;

pub fn request(id: u64, method: &str, params: Value) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

pub fn notification(method: &str, params: Value) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

/// Parse one response line → (id, Ok(result) | Err(message)). Returns Err(String)
/// only if the line itself isn't valid JSON-RPC.
pub fn parse_response(line: &str) -> Result<(Option<u64>, Result<Value, String>), String> {
    let v: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    let id = v.get("id").and_then(|i| i.as_u64());
    if let Some(err) = v.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("rpc error").to_string();
        return Ok((id, Err(msg)));
    }
    Ok((id, Ok(v.get("result").cloned().unwrap_or(Value::Null))))
}
```

`src-tauri/src/mcp/transport.rs`:
```rust
// (C)
// MCP transports. Stdio spawns the server as a child process and exchanges
// newline-delimited JSON-RPC over its stdin/stdout. Http posts JSON-RPC to a URL
// (optionally with a bearer token) and reads the JSON response.
use std::collections::BTreeMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use serde_json::Value;

pub enum Transport {
    Stdio { child: Child, stdin: ChildStdin, lines: Lines<BufReader<ChildStdout>> },
    Http { client: reqwest::Client, url: String, bearer: Option<String> },
}

impl Transport {
    pub async fn spawn_stdio(command: &str, args: &[String], env: &BTreeMap<String, String>) -> Result<Transport, String> {
        let mut cmd = Command::new(command);
        cmd.args(args).envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); } // CREATE_NO_WINDOW
        let mut child = cmd.spawn().map_err(|e| format!("spawn {command}: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let lines = BufReader::new(stdout).lines();
        Ok(Transport::Stdio { child, stdin, lines })
    }

    pub fn http(url: String, bearer: Option<String>) -> Transport {
        Transport::Http { client: reqwest::Client::new(), url, bearer }
    }

    /// Send one JSON-RPC message and (for requests) await the next response line.
    /// For Http, posts and returns the response body parsed as JSON.
    pub async fn send(&mut self, msg: &Value, expect_reply: bool) -> Result<Option<Value>, String> {
        match self {
            Transport::Stdio { stdin, lines, .. } => {
                let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
                line.push('\n');
                stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
                stdin.flush().await.map_err(|e| e.to_string())?;
                if !expect_reply { return Ok(None); }
                match lines.next_line().await.map_err(|e| e.to_string())? {
                    Some(l) => Ok(Some(serde_json::from_str(&l).map_err(|e| e.to_string())?)),
                    None => Err("server closed stdout".into()),
                }
            }
            Transport::Http { client, url, bearer } => {
                let mut req = client.post(url.as_str()).json(msg);
                if let Some(b) = bearer { req = req.bearer_auth(b); }
                let resp = req.send().await.map_err(|e| e.to_string())?;
                if !resp.status().is_success() { return Err(format!("http {}", resp.status())); }
                if !expect_reply { return Ok(None); }
                Ok(Some(resp.json().await.map_err(|e| e.to_string())?))
            }
        }
    }
}
```
Note: the stdio `send` assumes the next line is the reply to a request — correct for the synchronous one-request-at-a-time use here (initialize, then tools/list, then sequential tools/call). It skips JSON-RPC notifications interleaving; acceptable for v1 (MCP servers don't push unsolicited notifications mid-handshake for our calls). Document this assumption in a comment.

- [ ] **Step 4: Run to verify it passes**

`cargo test mcp::jsonrpc` → PASS (3 tests). `cargo check` compiles transport.rs.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/mcp/jsonrpc.rs src-tauri/src/mcp/transport.rs
git commit -m "feat(mcp): json-rpc framing + stdio/http transport"
```

---

## Task A4: McpConn — initialize, tools/list, tools/call

**Files:**
- Create: `src-tauri/src/mcp/client.rs`
- Test: covered by the mock-server integration test in A7 (this task = compile + the typed interface).

- [ ] **Step 1: Implement the connection + Tool type**

`src-tauri/src/mcp/client.rs`:
```rust
// (C)
// One live MCP server connection. Performs the MCP initialize handshake, lists
// tools (capturing readOnlyHint/destructiveHint annotations), and calls tools.
use serde::Serialize;
use serde_json::{json, Value};
use crate::mcp::transport::Transport;
use crate::mcp::jsonrpc::{request, notification, parse_response};

#[derive(Clone, Debug, Serialize)]
pub struct Tool {
    pub server: String,
    pub name: String,
    pub description: String,
    pub schema: Value,        // JSON Schema for inputs
    pub read_only: bool,      // MCP annotations.readOnlyHint
    pub destructive: bool,    // MCP annotations.destructiveHint (default true when unknown -> caller decides)
}

pub struct McpConn {
    pub server_id: String,
    transport: Transport,
    next_id: u64,
}

impl McpConn {
    pub async fn connect(server_id: String, mut transport: Transport) -> Result<McpConn, String> {
        // initialize
        let init = request(1, "initialize", json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "plutos-terminals", "version": "1" }
        }));
        let reply = transport.send(&init, true).await?.ok_or("no initialize reply")?;
        let (_, res) = parse_response(&serde_json::to_string(&reply).unwrap())?;
        res.map_err(|e| format!("initialize failed: {e}"))?;
        // initialized notification (no reply)
        transport.send(&notification("notifications/initialized", json!({})), false).await?;
        Ok(McpConn { server_id, transport, next_id: 2 })
    }

    fn nid(&mut self) -> u64 { let n = self.next_id; self.next_id += 1; n }

    pub async fn list_tools(&mut self) -> Result<Vec<Tool>, String> {
        let id = self.nid();
        let reply = self.transport.send(&request(id, "tools/list", json!({})), true).await?
            .ok_or("no tools/list reply")?;
        let (_, res) = parse_response(&serde_json::to_string(&reply).unwrap())?;
        let result = res.map_err(|e| format!("tools/list: {e}"))?;
        let arr = result.get("tools").and_then(|t| t.as_array()).cloned().unwrap_or_default();
        let sid = self.server_id.clone();
        Ok(arr.iter().map(|t| {
            let ann = t.get("annotations");
            let read_only = ann.and_then(|a| a.get("readOnlyHint")).and_then(|b| b.as_bool()).unwrap_or(false);
            // destructive defaults to TRUE unless the server explicitly says false (fail safe)
            let destructive = ann.and_then(|a| a.get("destructiveHint")).and_then(|b| b.as_bool()).unwrap_or(!read_only);
            Tool {
                server: sid.clone(),
                name: t.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
                description: t.get("description").and_then(|d| d.as_str()).unwrap_or_default().to_string(),
                schema: t.get("inputSchema").cloned().unwrap_or(json!({"type":"object"})),
                read_only,
                destructive,
            }
        }).collect())
    }

    pub async fn call_tool(&mut self, name: &str, args: Value) -> Result<Value, String> {
        let id = self.nid();
        let reply = self.transport.send(&request(id, "tools/call", json!({ "name": name, "arguments": args })), true).await?
            .ok_or("no tools/call reply")?;
        let (_, res) = parse_response(&serde_json::to_string(&reply).unwrap())?;
        res.map_err(|e| format!("tools/call {name}: {e}"))
    }
}
```

- [ ] **Step 2: Verify it compiles**

Build env, `cargo check` → compiles.

- [ ] **Step 3: Commit**
```bash
git add src-tauri/src/mcp/client.rs
git commit -m "feat(mcp): McpConn initialize/list_tools/call_tool"
```

---

## Task A5: Connection manager + Tauri commands

**Files:**
- Create: `src-tauri/src/mcp/manager.rs`
- Modify: `src-tauri/src/lib.rs` (register commands)
- Modify: `src-tauri/src/mcp/config.rs` (add `config_path(app)` helper)

- [ ] **Step 1: Add the config-path helper to config.rs**
```rust
// append to config.rs
use tauri::Manager;
pub fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("mcp-servers.json"))
}
```

- [ ] **Step 2: Implement the manager + commands**

`src-tauri/src/mcp/manager.rs`:
```rust
// (C)
// Process-lifetime MCP connection manager + the Tauri command surface. Connects
// enabled servers on first tool-list/call and caches the live connection. Secrets
// (bearer tokens, sensitive env) are pulled from the keychain (vault.rs) by the
// key names in ServerCfg.secret_keys — account format "mcp-secret:<id>:<key>".
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use once_cell::sync::Lazy;
use tokio::sync::Mutex;
use serde_json::Value;
use crate::mcp::client::{McpConn, Tool};
use crate::mcp::config::{load_configs, save_configs, config_path, ServerCfg};
use crate::mcp::transport::Transport;

static CONNS: Lazy<Arc<Mutex<HashMap<String, McpConn>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

fn secret_account(id: &str, key: &str) -> String { format!("mcp-secret:{id}:{key}") }

// Resolve a server's secrets from the keychain into an env map + optional bearer.
fn resolve_secrets(cfg: &ServerCfg) -> (BTreeMap<String, String>, Option<String>) {
    let mut env = cfg.env.clone();
    let mut bearer = None;
    for key in &cfg.secret_keys {
        if let Ok(Some(val)) = crate::vault::secret_get(secret_account(&cfg.id, key)) {
            if key == "bearer" { bearer = Some(val); } else { env.insert(key.clone(), val); }
        }
    }
    (env, bearer)
}

async fn ensure_conn(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    {
        let map = CONNS.lock().await;
        if map.contains_key(id) { return Ok(()); }
    }
    let cfgs = load_configs(&config_path(app)?)?;
    let cfg = cfgs.into_iter().find(|c| c.id == id).ok_or_else(|| format!("no such server {id}"))?;
    if !cfg.enabled { return Err(format!("server {id} is disabled")); }
    let (env, bearer) = resolve_secrets(&cfg);
    let transport = match cfg.transport.as_str() {
        "stdio" => {
            let command = cfg.command.as_deref().ok_or("stdio server needs a command")?;
            Transport::spawn_stdio(command, &cfg.args, &env).await?
        }
        "http" => {
            let url = cfg.url.clone().ok_or("http server needs a url")?;
            Transport::http(url, bearer)
        }
        other => return Err(format!("unknown transport {other}")),
    };
    let conn = McpConn::connect(id.to_string(), transport).await?;
    CONNS.lock().await.insert(id.to_string(), conn);
    Ok(())
}

#[tauri::command]
pub async fn mcp_servers_list(app: tauri::AppHandle) -> Result<Vec<ServerCfg>, String> {
    load_configs(&config_path(&app)?)
}

#[tauri::command]
pub async fn mcp_server_add(app: tauri::AppHandle, cfg: ServerCfg) -> Result<(), String> {
    let path = config_path(&app)?;
    let mut cfgs = load_configs(&path)?;
    cfgs.retain(|c| c.id != cfg.id); // replace existing by id
    cfgs.push(cfg);
    save_configs(&path, &cfgs)
}

#[tauri::command]
pub async fn mcp_server_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = config_path(&app)?;
    let mut cfgs = load_configs(&path)?;
    cfgs.retain(|c| c.id != id);
    save_configs(&path, &cfgs)?;
    CONNS.lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn mcp_list_tools(app: tauri::AppHandle) -> Result<Vec<Tool>, String> {
    let cfgs = load_configs(&config_path(&app)?)?;
    let mut all = Vec::new();
    for cfg in cfgs.iter().filter(|c| c.enabled) {
        if ensure_conn(&app, &cfg.id).await.is_err() { continue; } // skip servers that won't connect
        let mut map = CONNS.lock().await;
        if let Some(conn) = map.get_mut(&cfg.id) {
            if let Ok(tools) = conn.list_tools().await { all.extend(tools); }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn mcp_call_tool(app: tauri::AppHandle, server: String, tool: String, args: Value) -> Result<Value, String> {
    ensure_conn(&app, &server).await?;
    let mut map = CONNS.lock().await;
    let conn = map.get_mut(&server).ok_or("not connected")?;
    conn.call_tool(&tool, args).await
}

#[tauri::command]
pub async fn mcp_reconnect(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    let mut map = CONNS.lock().await;
    match id { Some(i) => { map.remove(&i); } None => map.clear() }
    drop(map);
    let _ = app; // reconnection is lazy on next list/call
    Ok(())
}
```
If `once_cell` is not already a dep, add `once_cell = "1"` to `src-tauri/Cargo.toml` (check first — it is commonly present transitively; add an explicit dep). Confirm `vault::secret_get` signature is `pub fn secret_get(account: String) -> Result<Option<String>, String>` (it is, per vault.rs) and call it accordingly (`secret_get(secret_account(...))`).

- [ ] **Step 3: Register commands in lib.rs**

In `src-tauri/src/lib.rs` `generate_handler![ ... ]`, after the sync_git lines, add:
```rust
            mcp::manager::mcp_servers_list,
            mcp::manager::mcp_server_add,
            mcp::manager::mcp_server_remove,
            mcp::manager::mcp_list_tools,
            mcp::manager::mcp_call_tool,
            mcp::manager::mcp_reconnect,
```

- [ ] **Step 4: Verify it compiles**

Build env, `cargo check` → compiles, no unused warnings for the commands.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/mcp/manager.rs src-tauri/src/mcp/config.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(mcp): connection manager + tauri commands"
```

---

## Task A6: Mock-server integration test

**Files:**
- Create: `src-tauri/tests/mcp_mock.rs`
- Create: `src-tauri/tests/fixtures/mock_mcp_server.mjs` (a tiny Node stdio MCP server)

- [ ] **Step 1: Write the mock server**

`src-tauri/tests/fixtures/mock_mcp_server.mjs` — a minimal newline-delimited JSON-RPC MCP server that answers `initialize`, `tools/list` (one read-only tool `echo`), and `tools/call` (returns the args):
```js
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
function send(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "1" } } });
  } else if (msg.method === "notifications/initialized") {
    // no reply
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "echoes args", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false } }
    ] } });
  } else if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(msg.params.arguments) }], isError: false } });
  } else if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
```

- [ ] **Step 2: Write the test**

`src-tauri/tests/mcp_mock.rs`:
```rust
// Integration test: connect to the Node mock MCP server over stdio, list tools, call one.
use plutos_terminals_lib::mcp::client::McpConn;     // adjust crate name if different (see lib name in Cargo.toml)
use plutos_terminals_lib::mcp::transport::Transport;

#[tokio::test]
async fn connects_lists_and_calls_mock_server() {
    let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mock_mcp_server.mjs");
    let t = Transport::spawn_stdio("node", &[fixture.to_string()], &Default::default()).await
        .expect("spawn mock (needs node on PATH)");
    let mut conn = McpConn::connect("mock".into(), t).await.expect("initialize");
    let tools = conn.list_tools().await.expect("list");
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "echo");
    assert!(tools[0].read_only);
    assert!(!tools[0].destructive);
    let out = conn.call_tool("echo", serde_json::json!({"hi": 1})).await.expect("call");
    let text = out["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("\"hi\""));
}
```
The test needs the lib exposed for integration tests: confirm `src-tauri/Cargo.toml` has a `[lib]` with a `name` (Tauri projects expose `<name>_lib`). Use that exact crate name in the `use` path; if the modules are private, add `pub mod mcp;` visibility in lib.rs (it already is `mod mcp;` → change to `pub mod mcp;` and ensure `pub` on the `client`/`transport` mods in mcp/mod.rs — they already are `pub mod`). Requires `node` on PATH (the dev box has it).

- [ ] **Step 3: Run**

Build env, `cargo test --test mcp_mock` → PASS. If the crate name in the `use` path is wrong, read the compiler error for the real `<name>_lib` and fix.

- [ ] **Step 4: Commit**
```bash
git add src-tauri/tests/mcp_mock.rs src-tauri/tests/fixtures/mock_mcp_server.mjs src-tauri/src/lib.rs src-tauri/src/mcp/mod.rs
git commit -m "test(mcp): stdio mock-server connect/list/call integration test"
```

---

## Self-Review (Component A vs spec)
- App-managed config in `mcp-servers.json`, not synced → A2 (`config.rs`). ✓
- Secrets in keychain (`mcp-secret:<id>:<key>`), not in JSON → A2 (`secret_keys`) + A5 (`resolve_secrets`). ✓
- stdio transport (subprocess, no shell — argv vector, CREATE_NO_WINDOW) → A3. ✓
- HTTP transport (url + bearer) → A3 (`Transport::Http`) + A5 (resolve bearer). ✓
- initialize / tools/list (with readOnlyHint/destructiveHint) / tools/call → A4. ✓ destructive defaults TRUE when unknown (fail-safe), matching the spec's "unannotated = unsafe." ✓
- Persistent connect-on-first-use manager, cached conns, reconnect → A5. ✓
- Tauri command surface (list/add/remove/list_tools/call_tool/reconnect) → A5. ✓
- Testable standalone via mock server → A6. ✓
- rmcp spike-first with identical command surface → A1. ✓

**Deferred to later plans (correctly out of scope here):** native LLM tool-calling (Component B), AgentMode loop + approval gating + UI (Component C/D). Component A ships a usable, tested MCP client with no agent dependency.

**Type consistency:** `ServerCfg` fields identical across A2/A5; `Tool` struct from A4 is what `mcp_list_tools` (A5) returns; `Transport`/`McpConn` signatures consistent A3→A4→A5→A6.
