// (C)
// Process-lifetime MCP connection manager + Tauri command surface. Connects
// enabled servers on first tool-list/call and caches the live connection. Secrets
// (bearer tokens, sensitive env) come from the keychain (vault.rs) by the key
// names in ServerCfg.secret_keys — account format "mcp-secret:<id>:<key>".
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, OnceLock};
use tokio::sync::{Mutex, OwnedMutexGuard};
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
        if let Ok(Some(val)) = crate::vault::secret_get_sync(secret_account(&cfg.id, key)) {
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
        // Skip servers that won't connect.
        let Ok(guard) = lock_live_conn(&app, &cfg.id).await else { continue };
        let listed = guard.list_tools().await;
        drop_if_timed_out(&cfg.id, guard).await;
        if let Ok(tools) = listed {
            tool_cache().lock().await.insert(cfg.id.clone(), tools.clone());
            all.extend(tools);
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn mcp_call_tool(app: tauri::AppHandle, server: String, tool: String, args: Value) -> Result<Value, String> {
    let guard = lock_live_conn(&app, &server).await?; // per-server lock held only for this call
    let out = guard.call_tool(&tool, args).await;
    drop_if_timed_out(&server, guard).await;
    out
}

// Every list and call is bounded in client.rs (MCP_LIST_TIMEOUT,
// MCP_CALL_TIMEOUT), so a stuck server releases its lock in the end. A
// connection that hit a bound is in an unknown state (a stdio server still
// stuck on the request, an HTTP request still open), so it is not used again:
// the caller that hit the bound drops it from the map, and a caller that was
// queued on its lock meanwhile finds it marked and reconnects instead of
// waiting out the bound a second time on the same stuck server.

/// Connect if needed and lock the server's connection, skipping one already
/// marked timed out. Two tries: a fresh connection that is already marked
/// again means the server is stuck, and the caller gets an error.
async fn lock_live_conn(app: &tauri::AppHandle, id: &str) -> Result<OwnedMutexGuard<McpConn>, String> {
    for _ in 0..2 {
        ensure_conn(app, id).await?;
        let conn = conns().lock().await.get(id).cloned().ok_or("not connected")?; // clone Arc, drop map lock
        let guard = conn.lock_owned().await;
        if !guard.timed_out() {
            return Ok(guard);
        }
        drop_if_timed_out(id, guard).await;
    }
    Err(format!("mcp ({id}): the server stopped answering"))
}

/// Release the per-server lock and, if that connection hit a bound, drop it
/// from the map (only if the map still holds this same one: a reconnect may
/// already have replaced it). The per-server lock is released before the map
/// lock is taken, so the two never nest.
async fn drop_if_timed_out(id: &str, guard: OwnedMutexGuard<McpConn>) {
    let timed_out = guard.timed_out();
    let conn = OwnedMutexGuard::mutex(&guard).clone();
    drop(guard);
    if timed_out {
        let mut map = conns().lock().await;
        if map.get(id).is_some_and(|c| Arc::ptr_eq(c, &conn)) {
            map.remove(id);
        }
    }
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

#[cfg(test)]
mod timeout_eviction_tests {
    // lock_live_conn needs a Tauri AppHandle (ensure_conn reads the config
    // file), so these drive the eviction it relies on directly, against the
    // stdio mock server (needs node on PATH, as tests/mcp_mock.rs does).
    use super::{conns, drop_if_timed_out};
    use crate::mcp::client::McpConn;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Mutex;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mock_mcp_server.mjs");

    async fn mock(id: &str, hang_call: bool) -> Arc<Mutex<McpConn>> {
        let mut args = vec![FIXTURE.to_string()];
        if hang_call {
            args.push("--hang-call".into());
        }
        let conn = McpConn::connect_stdio(id.into(), "node", &args, &Default::default())
            .await
            .expect("connect mock (needs node on PATH)");
        let conn = Arc::new(Mutex::new(conn));
        conns().lock().await.insert(id.to_string(), conn.clone());
        conn
    }

    async fn call(conn: &Arc<Mutex<McpConn>>, id: &str) {
        let guard = conn.clone().lock_owned().await;
        let _ = guard.call_tool_within("echo", serde_json::json!({}), Duration::from_millis(300)).await;
        drop_if_timed_out(id, guard).await;
    }

    #[tokio::test]
    async fn a_connection_whose_call_timed_out_is_dropped() {
        let conn = mock("evict-hung", true).await;
        call(&conn, "evict-hung").await;
        assert!(conn.lock().await.timed_out());
        assert!(!conns().lock().await.contains_key("evict-hung"), "a timed-out connection stayed in use");
    }

    #[tokio::test]
    async fn a_connection_whose_call_finished_is_kept() {
        let conn = mock("evict-live", false).await;
        call(&conn, "evict-live").await;
        assert!(!conn.lock().await.timed_out());
        let kept = conns().lock().await.get("evict-live").cloned();
        assert!(kept.is_some_and(|c| Arc::ptr_eq(&c, &conn)));
        conns().lock().await.remove("evict-live");
    }

    #[tokio::test]
    async fn a_reconnect_that_already_replaced_it_is_not_dropped() {
        // The timed-out connection is no longer the one in the map (a queued
        // caller reconnected first): the newer one must survive.
        let old = mock("evict-replaced", true).await;
        let newer = mock("evict-replaced", false).await;
        call(&old, "evict-replaced").await;
        let kept = conns().lock().await.get("evict-replaced").cloned();
        assert!(kept.is_some_and(|c| Arc::ptr_eq(&c, &newer)), "the replacement was dropped");
        conns().lock().await.remove("evict-replaced");
    }
}
