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
    connect_or_reuse(id, || connect_from_config(app, id)).await
}

/// Read the server's config and secrets and connect to it.
async fn connect_from_config(app: &tauri::AppHandle, id: &str) -> Result<McpConn, String> {
    let cfgs = load_configs(&config_path(app)?)?;
    let cfg = cfgs.into_iter().find(|c| c.id == id).ok_or_else(|| format!("no such server {id}"))?;
    if !cfg.enabled { return Err(format!("server {id} is disabled")); }
    let (env, bearer) = resolve_secrets(&cfg);
    match cfg.transport.as_str() {
        "stdio" => {
            let command = cfg.command.as_deref().ok_or("stdio server needs a command")?;
            McpConn::connect_stdio(id.to_string(), command, &cfg.args, &env).await
        }
        "http" => {
            let url = cfg.url.clone().ok_or("http server needs a url")?;
            McpConn::connect_http(id.to_string(), &url, bearer).await
        }
        other => Err(format!("unknown transport {other}")),
    }
}

// One connect at a time per server id. After an eviction every caller that
// was queued on the dropped connection finds the server missing at once;
// without this each of them spawned its own process (or opened its own
// session) for the one server, and all but the last were dropped again.
// Lock order: a connect lock may be held while conns() is taken briefly,
// never the reverse (nothing takes a connect lock while holding conns()).
static CONNECTING: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
async fn connect_lock(id: &str) -> Arc<Mutex<()>> {
    let mut map = CONNECTING.get_or_init(|| Mutex::new(HashMap::new())).lock().await;
    map.entry(id.to_string()).or_default().clone() // clone the Arc out, drop the map lock
}

/// Use the server's connection in the map, or run `connect` and put the new
/// one there. Split from ensure_conn so tests can drive it without a Tauri
/// AppHandle.
async fn connect_or_reuse<F, Fut>(id: &str, connect: F) -> Result<(), String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<McpConn, String>>,
{
    if conns().lock().await.contains_key(id) { return Ok(()); }
    let lock = connect_lock(id).await;
    let _connecting = lock.lock().await;
    // A caller that held the lock before us may have connected already.
    if conns().lock().await.contains_key(id) { return Ok(()); }
    let conn = connect().await?;
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
        drop_if_unusable(&cfg.id, guard).await;
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
    drop_if_unusable(&server, guard).await;
    out
}

// Every list and call is bounded in client.rs (MCP_LIST_TIMEOUT,
// MCP_CALL_TIMEOUT), so a stuck server releases its lock in the end. A
// connection that hit a bound is in an unknown state (a stdio server still
// stuck on the request, an HTTP request still open), so it is not used again:
// the caller that hit the bound drops it from the map, and a caller that was
// queued on its lock meanwhile finds it marked and reconnects instead of
// waiting out the bound a second time on the same stuck server. A connection
// whose transport closed (the server exited) is treated the same way, since
// every later request on it would fail until a manual reconnect.

/// Connect if needed and lock the server's connection, skipping one already
/// marked unusable (timed out, or its transport closed). Two tries: a fresh
/// connection that is already marked again means the server is stuck or
/// keeps exiting, and the caller gets an error.
async fn lock_live_conn(app: &tauri::AppHandle, id: &str) -> Result<OwnedMutexGuard<McpConn>, String> {
    for _ in 0..2 {
        ensure_conn(app, id).await?;
        let conn = conns().lock().await.get(id).cloned().ok_or("not connected")?; // clone Arc, drop map lock
        let guard = conn.lock_owned().await;
        if !guard.unusable() {
            return Ok(guard);
        }
        drop_if_unusable(id, guard).await;
    }
    Err(format!("mcp ({id}): the server stopped answering"))
}

/// Release the per-server lock and, if that connection is unusable (it hit a
/// bound, or its transport closed), drop it from the map (only if the map
/// still holds this same one: a reconnect may already have replaced it) along
/// with its cached tool list, so the reconnect, possibly to a newer server,
/// reads its tools and annotations again (the approval gate's read_only /
/// destructive flags). A replacement's own cached list is left alone. The
/// per-server lock is released before the map lock is taken, and the map lock
/// before the tool cache lock: one lock at a time, never nested.
async fn drop_if_unusable(id: &str, guard: OwnedMutexGuard<McpConn>) {
    let unusable = guard.unusable();
    let conn = OwnedMutexGuard::mutex(&guard).clone();
    drop(guard);
    if unusable {
        let removed = {
            let mut map = conns().lock().await;
            let same = map.get(id).is_some_and(|c| Arc::ptr_eq(c, &conn));
            if same {
                map.remove(id);
            }
            same
        };
        if removed {
            tool_cache().lock().await.remove(id);
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
    // file), so these drive the eviction it relies on directly, and
    // connect_or_reuse with a connector in place of the config read, against
    // the stdio mock server (needs node on PATH, as tests/mcp_mock.rs does).
    use super::{connect_or_reuse, conns, drop_if_unusable, tool_cache};
    use crate::mcp::client::McpConn;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Mutex;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mock_mcp_server.mjs");
    /// The call bound for a mock told to hang: short, so the test is quick.
    const HANG: Duration = Duration::from_millis(300);
    /// The call bound for a mock that answers: long enough that a loaded
    /// machine never turns a finished call into a timeout.
    const ANSWERS: Duration = Duration::from_secs(10);

    async fn spawn_mock(id: &str, flag: Option<&str>) -> McpConn {
        let mut args = vec![FIXTURE.to_string()];
        args.extend(flag.map(str::to_string));
        McpConn::connect_stdio(id.into(), "node", &args, &Default::default())
            .await
            .expect("connect mock (needs node on PATH)")
    }

    async fn mock(id: &str, flag: Option<&str>) -> Arc<Mutex<McpConn>> {
        let conn = Arc::new(Mutex::new(spawn_mock(id, flag).await));
        conns().lock().await.insert(id.to_string(), conn.clone());
        conn
    }

    async fn call(conn: &Arc<Mutex<McpConn>>, id: &str, bound: Duration) {
        let guard = conn.clone().lock_owned().await;
        let _ = guard.call_tool_within("echo", serde_json::json!({}), bound).await;
        drop_if_unusable(id, guard).await;
    }

    async fn cache_a_tool_list(id: &str) {
        tool_cache().lock().await.insert(id.to_string(), Vec::new());
    }

    #[tokio::test]
    async fn a_connection_whose_call_timed_out_is_dropped() {
        let conn = mock("evict-hung", Some("--hang-call")).await;
        cache_a_tool_list("evict-hung").await;
        call(&conn, "evict-hung", HANG).await;
        assert!(conn.lock().await.timed_out());
        assert!(!conns().lock().await.contains_key("evict-hung"), "a timed-out connection stayed in use");
        // A reconnect may reach a newer server: its tools and annotations (the
        // approval gate's read_only / destructive) are read again.
        assert!(!tool_cache().lock().await.contains_key("evict-hung"), "the old tool list outlived its connection");
    }

    #[tokio::test]
    async fn a_connection_whose_call_finished_is_kept() {
        let conn = mock("evict-live", None).await;
        cache_a_tool_list("evict-live").await;
        call(&conn, "evict-live", ANSWERS).await;
        assert!(!conn.lock().await.timed_out());
        let kept = conns().lock().await.get("evict-live").cloned();
        assert!(kept.is_some_and(|c| Arc::ptr_eq(&c, &conn)));
        assert!(tool_cache().lock().await.contains_key("evict-live"), "a live connection lost its tool list");
        conns().lock().await.remove("evict-live");
        tool_cache().lock().await.remove("evict-live");
    }

    #[tokio::test]
    async fn a_reconnect_that_already_replaced_it_is_not_dropped() {
        // The timed-out connection is no longer the one in the map (a queued
        // caller reconnected first): the newer one, and the tool list it
        // cached, must survive.
        let old = mock("evict-replaced", Some("--hang-call")).await;
        let newer = mock("evict-replaced", None).await;
        cache_a_tool_list("evict-replaced").await;
        call(&old, "evict-replaced", HANG).await;
        let kept = conns().lock().await.get("evict-replaced").cloned();
        assert!(kept.is_some_and(|c| Arc::ptr_eq(&c, &newer)), "the replacement was dropped");
        assert!(tool_cache().lock().await.contains_key("evict-replaced"), "the replacement's tool list was dropped");
        conns().lock().await.remove("evict-replaced");
        tool_cache().lock().await.remove("evict-replaced");
    }

    #[tokio::test]
    async fn a_connection_whose_server_exited_is_dropped() {
        // The child exits on the call: every later call would fail the same
        // way until a manual reconnect, so it is dropped like a timeout.
        let conn = mock("evict-exited", Some("--exit-on-call")).await;
        cache_a_tool_list("evict-exited").await;
        call(&conn, "evict-exited", ANSWERS).await;
        assert!(!conns().lock().await.contains_key("evict-exited"), "a dead connection stayed in use");
        assert!(!tool_cache().lock().await.contains_key("evict-exited"));
    }

    #[tokio::test]
    async fn concurrent_connects_for_one_server_start_one_process() {
        // After an eviction every queued caller finds the server missing at
        // once. Only one of them may spawn it; the rest reuse that connection.
        let spawned = Arc::new(AtomicUsize::new(0));
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let spawned = spawned.clone();
                tokio::spawn(async move {
                    connect_or_reuse("connect-race", || async move {
                        spawned.fetch_add(1, Ordering::SeqCst);
                        // Hold the window open so every caller is inside it.
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        Ok(spawn_mock("connect-race", None).await)
                    })
                    .await
                })
            })
            .collect();
        for t in tasks {
            t.await.unwrap().expect("connect_or_reuse");
        }
        assert_eq!(spawned.load(Ordering::SeqCst), 1, "one server, several processes");
        assert!(conns().lock().await.contains_key("connect-race"));
        conns().lock().await.remove("connect-race");
    }

    #[tokio::test]
    async fn a_failed_connect_lets_the_next_caller_try_again() {
        let err = connect_or_reuse("connect-fails", || async { Err::<McpConn, _>("no".to_string()) }).await;
        assert_eq!(err.unwrap_err(), "no");
        assert!(!conns().lock().await.contains_key("connect-fails"));
        connect_or_reuse("connect-fails", || async { Ok(spawn_mock("connect-fails", None).await) })
            .await
            .expect("a second try connects");
        assert!(conns().lock().await.contains_key("connect-fails"));
        conns().lock().await.remove("connect-fails");
    }
}
