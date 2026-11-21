// (C)
// Process-lifetime MCP connection manager + Tauri command surface. Connects
// enabled servers on first tool-list/call and caches the live connection. Secrets
// (bearer tokens, sensitive env) come from the keychain (vault.rs) by the key
// names in ServerCfg.secret_keys — account format "mcp-secret:<id>:<key>".
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
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

// Generations: what a connect, or a tool list, started from may be overtaken
// by an edit before it finishes. mcp_server_add / mcp_server_remove /
// mcp_reconnect bump the server's generation (all of them for a reconnect of
// every server) when they drop its connection and cached tools. A connect or
// a listing takes a ticket when it starts and, when it is done, keeps its
// result only if the ticket is still current: a connection built from the
// OLD command, env, url or bearer is dropped instead of put in the map (audit
// M7), a removed or disabled server is not handed to a caller that was queued
// on it, and an old tool list is not cached after the cache was cleared.
// The edits do not take a connect lock (a connect can hold it for up to the
// 30 s handshake bound).
//
// Lock order: the generation lock is a std mutex, never held across an await
// and never held while taking another lock; it is taken inside conns() or
// the tool cache lock where a check and an insert (or a bump and a removal)
// must be one step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Ticket {
    all: u64,
    one: u64,
}

#[derive(Default)]
struct Generations {
    all: u64,
    by_id: HashMap<String, u64>,
}

fn generations() -> std::sync::MutexGuard<'static, Generations> {
    static GENERATIONS: OnceLock<std::sync::Mutex<Generations>> = OnceLock::new();
    // Nothing panics while holding it, but a poisoned counter is still a
    // counter: keep using it.
    GENERATIONS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn ticket(id: &str) -> Ticket {
    let g = generations();
    Ticket { all: g.all, one: g.by_id.get(id).copied().unwrap_or(0) }
}

fn is_current(id: &str, t: Ticket) -> bool {
    ticket(id) == t
}

/// Drop a server's connection and cached tools (every server's for None)
/// and bump its generation, so a connect or listing already under way for
/// it discards what it gets. The bump and the removal happen under the map
/// lock, the same lock a connect's check-and-insert holds, so neither can
/// fall between the other's two steps. The tool cache is cleared after the
/// bump, so a listing's insert either lands before the clear or sees the
/// bump.
async fn forget(id: Option<&str>) {
    {
        let mut map = conns().lock().await;
        let mut g = generations();
        match id {
            Some(i) => {
                *g.by_id.entry(i.to_string()).or_default() += 1;
                map.remove(i);
            }
            None => {
                g.all += 1;
                map.clear();
            }
        }
    }
    let mut cache = tool_cache().lock().await;
    match id {
        Some(i) => {
            cache.remove(i);
        }
        None => cache.clear(),
    }
}

// One connect at a time per server id. After an eviction every caller that
// was queued on the dropped connection finds the server missing at once;
// without this each of them spawned its own process (or opened its own
// session) for the one server, and all but the last were dropped again.
// Callers that queued behind an attempt that FAILED return that attempt's
// error rather than retrying one after another: k callers on a server that
// never answers would otherwise wait about k x 30 s (the handshake bound).
// Lock order: a connect lock may be held while conns() is taken briefly,
// never the reverse (nothing takes a connect lock while holding conns()).
struct ConnectSlot {
    /// Attempts finished, read without the lock so a caller knows which
    /// attempts ended while it waited. Written under `last`.
    finished: AtomicU64,
    last: Mutex<LastAttempt>,
}

#[derive(Default)]
struct LastAttempt {
    finished: u64,
    /// The last attempt's error, with the ticket it ran under; None when it
    /// connected or its result was discarded as overtaken by an edit.
    failed: Option<(Ticket, String)>,
}

static CONNECTING: OnceLock<Mutex<HashMap<String, Arc<ConnectSlot>>>> = OnceLock::new();
async fn connect_slot(id: &str) -> Arc<ConnectSlot> {
    let mut map = CONNECTING.get_or_init(|| Mutex::new(HashMap::new())).lock().await;
    map.entry(id.to_string())
        .or_insert_with(|| Arc::new(ConnectSlot { finished: AtomicU64::new(0), last: Mutex::new(LastAttempt::default()) }))
        .clone() // clone the Arc out, drop the map lock
}

/// Use the server's connection in the map, or run `connect` and put the new
/// one there. Split from lock_live_conn so tests can drive it without a Tauri
/// AppHandle.
async fn connect_or_reuse<F, Fut>(id: &str, connect: F) -> Result<(), String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<McpConn, String>>,
{
    if conns().lock().await.contains_key(id) { return Ok(()); }
    let slot = connect_slot(id).await;
    let arrived = slot.finished.load(Ordering::SeqCst);
    let mut last = slot.last.lock().await;
    // A caller that held the lock before us may have connected already.
    if conns().lock().await.contains_key(id) { return Ok(()); }
    // Or failed while we waited: share its error unless the server's settings
    // changed since (then this caller tries the new ones).
    if last.finished > arrived {
        if let Some((t, e)) = &last.failed {
            if is_current(id, *t) {
                return Err(e.clone());
            }
        }
    }
    // Taken before `connect` reads the config, so an edit that lands after
    // the read is always seen.
    let started = ticket(id);
    let out = match connect().await {
        Err(e) => {
            last.failed = Some((started, e.clone()));
            Err(e)
        }
        Ok(conn) => {
            last.failed = None;
            let mut map = conns().lock().await;
            if is_current(id, started) {
                map.insert(id.to_string(), Arc::new(Mutex::new(conn)));
                Ok(())
            } else {
                drop(map);
                drop(conn); // built from settings that have since changed
                Err(format!("mcp ({id}): the server's settings changed while it was connecting; try again"))
            }
        }
    };
    last.finished += 1;
    slot.finished.store(last.finished, Ordering::SeqCst);
    out
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
    // this, a later use finds the id present and the tool cache refills from
    // the OLD process/env/url. forget also discards a connect or listing
    // already under way from the old settings.
    forget(Some(&id)).await;
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
    forget(Some(&id)).await;
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
        let Ok((guard, started)) = lock_live_conn(&app, &cfg.id).await else { continue };
        let listed = guard.list_tools().await;
        if let Some(tools) = keep_listing(&cfg.id, guard, started, listed).await {
            all.extend(tools);
        }
    }
    Ok(all)
}

/// What a listing on `guard` (locked under ticket `started`) yields: its
/// tools, cached for the next agent run only while they still describe the
/// server. Not cached when the connection became unusable during the list
/// (its server exited or a bound ran out: the next use reconnects and must
/// read the tools and annotations again), and neither cached nor used when
/// the server was edited, removed or reconnected meanwhile.
async fn keep_listing(
    id: &str,
    guard: OwnedMutexGuard<McpConn>,
    started: Ticket,
    listed: Result<Vec<Tool>, String>,
) -> Option<Vec<Tool>> {
    // Read before drop_if_unusable releases the connection.
    let usable = !guard.unusable();
    drop_if_unusable(id, guard).await;
    let tools = listed.ok()?;
    let mut cache = tool_cache().lock().await;
    if !is_current(id, started) {
        return None;
    }
    if usable {
        cache.insert(id.to_string(), tools.clone());
    }
    Some(tools)
}

#[tauri::command]
pub async fn mcp_call_tool(app: tauri::AppHandle, server: String, tool: String, args: Value) -> Result<Value, String> {
    let (guard, _) = lock_live_conn(&app, &server).await?; // per-server lock held only for this call
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
/// marked unusable (timed out, or its transport closed) and one that was
/// edited, removed or reconnected while this caller waited for its lock.
/// Two tries: a fresh connection that is already marked again means the
/// server is stuck or keeps exiting, and the caller gets an error. Returns
/// the ticket the connection was current under.
async fn lock_live_conn(app: &tauri::AppHandle, id: &str) -> Result<(OwnedMutexGuard<McpConn>, Ticket), String> {
    lock_live_conn_with(id, || connect_from_config(app, id)).await
}

/// `lock_live_conn` with the connect as a parameter: the test seam.
async fn lock_live_conn_with<F, Fut>(id: &str, connect: F) -> Result<(OwnedMutexGuard<McpConn>, Ticket), String>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<McpConn, String>>,
{
    for _ in 0..2 {
        connect_or_reuse(id, &connect).await?;
        // The ticket is read with the map entry, under the map lock: the
        // connection in the map is current as of this ticket.
        let (conn, started) = {
            let map = conns().lock().await;
            (map.get(id).cloned(), ticket(id))
        };
        let conn = conn.ok_or("not connected")?; // the Arc is cloned; the map lock is dropped
        let guard = conn.lock_owned().await;
        if guard.unusable() {
            drop_if_unusable(id, guard).await;
            continue;
        }
        if !is_current(id, started) {
            // Edited, removed or reconnected while this caller queued behind
            // a call on it: look again. A removed or disabled server is then
            // refused by the connect, an edited one reached with its new
            // settings.
            drop(guard);
            continue;
        }
        return Ok((guard, started));
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
    // Tool lists follow the conns (P3-T5 cache invalidation choke point).
    forget(id.as_deref()).await;
    Ok(())
}

#[cfg(test)]
mod timeout_eviction_tests {
    // lock_live_conn needs a Tauri AppHandle (its connect reads the config
    // file), so these drive the eviction it relies on directly, and
    // connect_or_reuse / lock_live_conn_with with a connector in place of the
    // config read, against the stdio mock server (needs node on PATH, as
    // tests/mcp_mock.rs does). Every test uses its own server id: the maps
    // are process-wide and the tests run at once.
    use super::{
        connect_or_reuse, conns, drop_if_unusable, forget, keep_listing, lock_live_conn_with, ticket, tool_cache,
    };
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

    // An edit (mcp_server_add / remove / reconnect, all through forget)
    // overtakes work already under way for the server.

    #[tokio::test]
    async fn a_connect_that_an_edit_overtook_is_discarded() {
        // The connect read the OLD settings; the edit lands before it is put
        // in the map. Keeping it would undo the edit (audit M7).
        let out = connect_or_reuse("race-connect", || async {
            let conn = spawn_mock("race-connect", None).await;
            forget(Some("race-connect")).await;
            Ok(conn)
        })
        .await;
        let e = out.expect_err("a connection from the old settings was kept");
        assert!(e.contains("settings changed"), "{e}");
        assert!(!conns().lock().await.contains_key("race-connect"), "the old connection went into the map");
    }

    #[tokio::test]
    async fn a_caller_queued_on_a_removed_server_does_not_get_it() {
        // A call is running on the server; another caller is queued on its
        // lock. The server is removed (or disabled) meanwhile: the queued
        // caller must not be handed the old connection when the call ends.
        let conn = mock("race-removed", None).await;
        let busy = conn.clone().lock_owned().await;
        let connects = Arc::new(AtomicUsize::new(0));
        let c = connects.clone();
        let queued = tokio::spawn(async move {
            lock_live_conn_with("race-removed", move || {
                let c = c.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    Err::<McpConn, _>("server race-removed is disabled".to_string())
                }
            })
            .await
            .map(|_| ())
        });
        // Let it find the connection and queue on its lock.
        tokio::time::sleep(Duration::from_millis(300)).await;
        forget(Some("race-removed")).await;
        drop(busy);
        let out = queued.await.unwrap();
        assert_eq!(out.unwrap_err(), "server race-removed is disabled", "the removed server's connection was handed out");
        assert_eq!(connects.load(Ordering::SeqCst), 1, "the queued caller did not look the server up again");
    }

    #[tokio::test]
    async fn a_listing_that_an_edit_overtook_is_not_cached_or_used() {
        let conn = mock("race-list", None).await;
        let guard = conn.clone().lock_owned().await;
        let started = ticket("race-list");
        let listed = guard.list_tools_within(ANSWERS).await;
        assert!(listed.is_ok(), "{listed:?}");
        forget(Some("race-list")).await;
        let kept = keep_listing("race-list", guard, started, listed).await;
        assert!(kept.is_none(), "the old server's tools were used after the edit");
        assert!(!tool_cache().lock().await.contains_key("race-list"), "an old tool list was cached after the edit");
    }

    #[tokio::test]
    async fn a_current_listing_is_cached() {
        let conn = mock("list-current", None).await;
        let guard = conn.clone().lock_owned().await;
        let started = ticket("list-current");
        let listed = guard.list_tools_within(ANSWERS).await;
        let kept = keep_listing("list-current", guard, started, listed).await;
        assert_eq!(kept.map(|t| t.len()), Some(1));
        assert!(tool_cache().lock().await.contains_key("list-current"));
        forget(Some("list-current")).await;
    }

    #[tokio::test]
    async fn a_listing_whose_connection_died_is_used_but_not_cached() {
        // The server answered the list and exited. The tools are real, but
        // the next use reconnects, possibly to a newer server, and must read
        // the tools and annotations again rather than find them cached.
        let conn = mock("list-died", Some("--exit-after-list")).await;
        let guard = conn.clone().lock_owned().await;
        let started = ticket("list-died");
        let listed = guard.list_tools_within(ANSWERS).await;
        assert!(listed.is_ok(), "{listed:?}");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !guard.unusable() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(guard.unusable(), "the server exited but its connection still looks usable");
        let kept = keep_listing("list-died", guard, started, listed).await;
        assert_eq!(kept.map(|t| t.len()), Some(1), "the listing it answered was thrown away");
        assert!(!tool_cache().lock().await.contains_key("list-died"), "a dead connection's tool list was cached");
        assert!(!conns().lock().await.contains_key("list-died"), "the dead connection stayed in the map");
    }

    // Callers queued on a connect that fails.

    async fn failing_connects(id: &'static str, callers: usize, edit_midway: bool) -> (Vec<Result<(), String>>, usize) {
        let attempts = Arc::new(AtomicUsize::new(0));
        let tasks: Vec<_> = (0..callers)
            .map(|_| {
                let attempts = attempts.clone();
                tokio::spawn(async move {
                    connect_or_reuse(id, || async move {
                        let n = attempts.fetch_add(1, Ordering::SeqCst);
                        // A server that never answers, cut short.
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        if edit_midway && n == 0 {
                            forget(Some(id)).await;
                        }
                        Err::<McpConn, _>(format!("attempt {n} failed"))
                    })
                    .await
                })
            })
            .collect();
        let mut out = Vec::new();
        for t in tasks {
            out.push(t.await.unwrap());
        }
        (out, attempts.load(Ordering::SeqCst))
    }

    #[tokio::test]
    async fn callers_queued_behind_a_failed_connect_get_its_error() {
        // k callers on a server that never answers waited about k x 30 s, one
        // handshake bound each, one after another.
        let (out, attempts) = failing_connects("fail-shared", 4, false).await;
        assert_eq!(attempts, 1, "each queued caller tried the failing server again");
        for o in out {
            assert_eq!(o.unwrap_err(), "attempt 0 failed");
        }
    }

    #[tokio::test]
    async fn callers_queued_behind_a_failed_connect_retry_after_an_edit() {
        // The settings changed while the attempt ran: the new ones get one
        // try, and the callers behind that try share its result.
        let (out, attempts) = failing_connects("fail-edited", 4, true).await;
        assert_eq!(attempts, 2, "the new settings were not tried, or were tried once per caller");
        assert_eq!(out[0].as_ref().unwrap_err(), "attempt 0 failed");
        for o in &out[1..] {
            assert_eq!(o.as_ref().unwrap_err(), "attempt 1 failed");
        }
    }
}
