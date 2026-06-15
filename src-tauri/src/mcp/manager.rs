// (C)
// Process-lifetime MCP connection manager + Tauri command surface. Connects
// enabled servers on first tool-list/call and caches the live connection. Secrets
// (bearer tokens, sensitive env) come from the keychain (vault.rs) by the key
// names in ServerCfg.secret_keys — account format "mcp-secret:<id>:<key>".
use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;
use tokio::sync::Mutex;
use serde_json::Value;
use crate::mcp::client::{McpConn, Tool};
use crate::mcp::config::{load_configs, save_configs, config_path, ServerCfg};

static CONNS: OnceLock<Mutex<HashMap<String, McpConn>>> = OnceLock::new();
fn conns() -> &'static Mutex<HashMap<String, McpConn>> {
    CONNS.get_or_init(|| Mutex::new(HashMap::new()))
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
    conns().lock().await.insert(id.to_string(), conn);
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
    conns().lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn mcp_list_tools(app: tauri::AppHandle) -> Result<Vec<Tool>, String> {
    let cfgs = load_configs(&config_path(&app)?)?;
    let mut all = Vec::new();
    for cfg in cfgs.iter().filter(|c| c.enabled) {
        if ensure_conn(&app, &cfg.id).await.is_err() { continue; } // skip servers that won't connect
        let map = conns().lock().await;
        if let Some(conn) = map.get(&cfg.id) {
            if let Ok(tools) = conn.list_tools().await { all.extend(tools); }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn mcp_call_tool(app: tauri::AppHandle, server: String, tool: String, args: Value) -> Result<Value, String> {
    ensure_conn(&app, &server).await?;
    let map = conns().lock().await;
    let conn = map.get(&server).ok_or("not connected")?;
    conn.call_tool(&tool, args).await
}

#[tauri::command]
pub async fn mcp_reconnect(_app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    let mut map = conns().lock().await;
    match id { Some(i) => { map.remove(&i); } None => map.clear() }
    Ok(())
}
