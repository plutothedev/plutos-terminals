// (C)
// Process-lifetime MCP connection manager + Tauri command surface. Connects
// enabled servers on first tool-list/call and caches the live connection. Secrets
// (bearer tokens, sensitive env) come from the keychain (vault.rs) by the key
// names in ServerCfg.secret_keys — account format "mcp-secret:<id>:<key>".
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;
use serde_json::Value;
use crate::mcp::client::{McpConn, Tool};
use crate::mcp::config::{load_configs, save_configs, config_path, ServerCfg};

// Each connection sits behind its OWN Mutex so the global map lock is held only
// for a brief lookup, never across a tool call. A slow/hung call on one server
// therefore can't stall list/call on the others. Same-server calls still
// serialize (one stdio/http connection at a time), which is the intended bound.
static CONNS: OnceLock<Mutex<HashMap<String, Arc<Mutex<McpConn>>>>> = OnceLock::new();
fn conns() -> &'static Mutex<HashMap<String, Arc<Mutex<McpConn>>>> {
    CONNS.get_or_init(|| Mutex::new(HashMap::new()))
}

// Serializes the config-file read-modify-write cycle. mcp_server_add/remove each
// load the whole list, mutate it, and save it back; two concurrent invocations
// would otherwise lost-update mcp-servers.json (both read the same base, both
// write, one edit vanishes) and could collide on the save tmp file. The
// read-only paths (list/call/reconnect) don't take this lock. Always release it
// before taking `conns()` so the two locks never nest (no deadlock ordering).
static CFG_WRITE: OnceLock<Mutex<()>> = OnceLock::new();
fn cfg_write_lock() -> &'static Mutex<()> {
    CFG_WRITE.get_or_init(|| Mutex::new(()))
}

fn secret_account(id: &str, key: &str) -> String { format!("mcp-secret:{id}:{key}") }

// Resolve a server's secrets from the keychain into (extra env, optional bearer).
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
    if conns().lock().await.contains_key(id) { return Ok(()); }
    let cfgs = load_configs(&config_path(app)?)?;
    let cfg = cfgs.into_iter().find(|c| c.id == id).ok_or_else(|| format!("no such server {id}"))?;
    if !cfg.enabled { return Err(format!("server {id} is disabled")); }
    let (env, bearer) = resolve_secrets(&cfg);
    let conn = match cfg.transport.as_str() {
        "stdio" => {
            let command = cfg.command.as_deref().ok_or("stdio server needs a command")?;
            McpConn::connect_stdio(id.to_string(), command, &cfg.args, &env).await?
        }
        "http" => {
            let url = cfg.url.clone().ok_or("http server needs a url")?;
            McpConn::connect_http(id.to_string(), &url, bearer).await?
        }
        other => return Err(format!("unknown transport {other}")),
    };
    conns().lock().await.insert(id.to_string(), Arc::new(Mutex::new(conn)));
    Ok(())
}

#[tauri::command]
pub async fn mcp_servers_list(app: tauri::AppHandle) -> Result<Vec<ServerCfg>, String> {
    load_configs(&config_path(&app)?)
}

#[tauri::command]
pub async fn mcp_server_add(app: tauri::AppHandle, cfg: ServerCfg) -> Result<(), String> {
    let id = cfg.id.clone();
    // Scope the write lock so it's dropped before conns()/the tool cache —
    // same never-nest ordering as mcp_server_remove.
    {
        let _w = cfg_write_lock().lock().await; // serialize the read-modify-write
        let path = config_path(&app)?;
        let mut cfgs = load_configs(&path)?;
        cfgs.retain(|c| c.id != cfg.id); // replace existing by id
        cfgs.push(cfg);
        save_configs(&path, &cfgs)?;
    }
    // Edit-by-replace must also drop the LIVE conn (P3-T5, audit M7): without
    // this, ensure_conn sees the id present and the tool cache refills from
    // the OLD process/env/url.
    conns().lock().await.remove(&id);
    tool_cache().lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn mcp_server_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    // Scope the write lock so it's dropped before we take conns() below — the two
    // locks must never nest (see cfg_write_lock's note on ordering).
    {
        let _w = cfg_write_lock().lock().await;
        let path = config_path(&app)?;
        let mut cfgs = load_configs(&path)?;
        cfgs.retain(|c| c.id != id);
        save_configs(&path, &cfgs)?;
    }
    conns().lock().await.remove(&id);
    tool_cache().lock().await.remove(&id);
    Ok(())
}

/// Per-server tool-list cache (P3-T5): every agent START re-queried every
/// enabled server (an HTTP round trip / stdio exchange per server per run)
/// for lists that change only on add/remove/reconnect — exactly the three
/// choke points that invalidate this.
fn tool_cache() -> &'static Mutex<HashMap<String, Vec<Tool>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<Tool>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn mcp_list_tools(app: tauri::AppHandle) -> Result<Vec<Tool>, String> {
    let cfgs = load_configs(&config_path(&app)?)?;
    let mut all = Vec::new();
    for cfg in cfgs.iter().filter(|c| c.enabled) {
        if let Some(cached) = tool_cache().lock().await.get(&cfg.id).cloned() {
            all.extend(cached);
            continue;
        }
        if ensure_conn(&app, &cfg.id).await.is_err() { continue; } // skip servers that won't connect
        let conn = conns().lock().await.get(&cfg.id).cloned(); // brief global lock: clone the Arc out
        if let Some(conn) = conn {
            if let Ok(tools) = conn.lock().await.list_tools().await {
                tool_cache().lock().await.insert(cfg.id.clone(), tools.clone());
                all.extend(tools);
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn mcp_call_tool(app: tauri::AppHandle, server: String, tool: String, args: Value) -> Result<Value, String> {
    ensure_conn(&app, &server).await?;
    let conn = conns().lock().await.get(&server).cloned().ok_or("not connected")?; // clone Arc, drop map lock
    let guard = conn.lock().await; // per-server lock held only for this call
    guard.call_tool(&tool, args).await
}

#[tauri::command]
pub async fn mcp_reconnect(_app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    {
        let mut map = conns().lock().await;
        match id.as_deref() { Some(i) => { map.remove(i); } None => map.clear() }
    }
    // Tool lists follow the conns (P3-T5 cache invalidation choke point).
    let mut cache = tool_cache().lock().await;
    match id { Some(i) => { cache.remove(&i); } None => cache.clear() }
    Ok(())
}
