// (C)
// Phone/web companion — local HTTP + WebSocket server for the remote-control
// feature (docs/phone-companion-design.md).
//
// Phase 1b (this file): the server scaffold. It static-serves the built frontend
// (dist/) and exposes a token-authed WebSocket at /ws. The real command-RPC +
// PTY event relay land in Phase 1c; for now the socket authenticates then echoes,
// proving the transport + auth loop end-to-end.
//
// Reachability: binds 0.0.0.0:<port> so the user can reach it over their
// Tailscale tailnet (no relay to host, nothing exposed publicly — the tailnet is
// private). Off by default; started explicitly from the desktop UI.
//
// Security: a random device token gates the WebSocket. A leaked token = shell
// access, so the token is opt-in and revocable (stop/restart mints a fresh one).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Mutex;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use tauri::{Listener, Manager};
use tower_http::services::ServeDir;

/// Live-server handle: the bound port, the auth token, and a graceful-shutdown
/// trigger (firing it ends `axum::serve`).
struct Running {
    port: u16,
    token: String,
    host: String,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

/// Best host for the phone to dial: the Tailscale IP if available (the intended
/// reach), else the primary LAN IP, else localhost. Computed once at start.
fn best_host() -> String {
    if let Ok(out) = std::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
    {
        if out.status.success() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let ip = line.trim();
                if !ip.is_empty() {
                    return ip.to_string();
                }
            }
        }
    }
    // Primary LAN IP: bind a UDP socket and ask the OS which local address it
    // would use to reach a public host (no packet is actually sent).
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "localhost".to_string()
}

/// Tauri-managed companion state: `None` when stopped, `Some` when running.
/// `sessions` holds the desktop's current session list as a JSON string (pushed
/// from the React app via `companion_set_sessions`). The companion page can't
/// read the webview's localStorage where the panel/tab layout lives, and the PTY
/// channel ids are minted per-spawn and held only in each live `TerminalPane`,
/// so the desktop is the only source of the `{id, tabId, label, active}` list.
#[derive(Default)]
pub struct CompanionState {
    inner: Mutex<Option<Running>>,
    sessions: Mutex<String>,
}

/// Per-connection context handed to the WS handler: the auth token to check and
/// the app handle (to call commands + subscribe to events).
#[derive(Clone)]
struct WsCtx {
    token: String,
    app: tauri::AppHandle,
}

/// 40 chars of base36 randomness — enough entropy for a bearer token.
fn random_token() -> String {
    let mut rng = rand::thread_rng();
    (0..40)
        .map(|_| char::from_digit(rng.gen_range(0u32..36), 36).unwrap())
        .collect()
}

/// Resolve the built frontend directory (dist/). Bundled resource first (prod),
/// then the dev project root (src-tauri/../dist). Best-effort for the scaffold.
fn dist_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let d = res.join("dist");
        if d.is_dir() {
            return d;
        }
    }
    PathBuf::from("../dist")
}

async fn ws_handler(ws: WebSocketUpgrade, State(ctx): State<WsCtx>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, ctx))
}

/// The self-contained companion page (Phase 1). Compiled into the binary so it's
/// served even before the React app's dist/ exists / when it isn't reused yet.
async fn index() -> Html<&'static str> {
    Html(include_str!("../companion-web/index.html"))
}

async fn handle_socket(socket: WebSocket, ctx: WsCtx) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // First frame must be the auth token; anything else drops the connection.
    match ws_rx.next().await {
        Some(Ok(Message::Text(t))) if t.as_str().trim() == ctx.token => {}
        _ => return,
    }

    // A WebSocket sink can't be shared, so a single task owns it and drains an
    // mpsc queue. Both RPC replies and the event-relay listeners push frames here.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let _ = out_tx.send(r#"{"type":"ready"}"#.to_string());
    let sender = tokio::spawn(async move {
        while let Some(s) = out_rx.recv().await {
            if ws_tx.send(Message::Text(s.into())).await.is_err() {
                break;
            }
        }
    });

    // Active event subscriptions — unlistened on disconnect so we don't leak.
    let mut subs: Vec<tauri::EventId> = Vec::new();

    while let Some(Ok(msg)) = ws_rx.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let val: serde_json::Value = match serde_json::from_str(text.as_str()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match val.get("type").and_then(|v| v.as_str()) {
            Some("rpc") => {
                let id = val.get("id").cloned().unwrap_or(serde_json::Value::Null);
                let cmd = val
                    .get("cmd")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let args = val.get("args").cloned().unwrap_or(serde_json::Value::Null);
                let frame = match dispatch(&ctx.app, &cmd, args) {
                    Ok(v) => serde_json::json!({ "type": "rpc-result", "id": id, "ok": v }),
                    Err(e) => serde_json::json!({ "type": "rpc-result", "id": id, "err": e }),
                };
                let _ = out_tx.send(frame.to_string());
            }
            // Relay a backend event channel (e.g. "pty://<id>") to this client. The
            // chunks are the SAME ones the desktop webview gets — app.listen sees
            // app.emit — so no change to the PTY reader threads is needed.
            Some("subscribe") => {
                if let Some(ch) = val.get("channel").and_then(|v| v.as_str()) {
                    let channel = ch.to_string();
                    let ch_json = serde_json::to_string(&channel).unwrap_or_else(|_| "\"\"".into());
                    let tx = out_tx.clone();
                    let id = ctx.app.listen(channel, move |ev| {
                        // ev.payload() is already JSON — embed it raw as `payload`.
                        let _ = tx.send(format!(
                            r#"{{"type":"event","channel":{},"payload":{}}}"#,
                            ch_json,
                            ev.payload()
                        ));
                    });
                    subs.push(id);
                }
            }
            _ => {}
        }
    }

    for id in subs {
        ctx.app.unlisten(id);
    }
    sender.abort();
}

/// Execute a backend command for the companion. A small, explicit allow-list (the
/// commands the Phase-1 page needs) — calls the existing Tauri command fns by
/// providing the managed state / app handle ourselves. Unknown commands error so
/// nothing outside the list is reachable over the socket.
fn dispatch(
    app: &tauri::AppHandle,
    cmd: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let s = |k: &str| -> Result<String, String> {
        args.get(k)
            .and_then(|v| v.as_str())
            .map(|x| x.to_string())
            .ok_or_else(|| format!("missing arg '{k}'"))
    };
    match cmd {
        // Read-only commands the phone page needs. No `write_store`: the companion
        // never overwrites the desktop's persisted layout (least privilege — a
        // leaked token is already shell access, no need to also hand it the store).
        "scrollback_load" => Ok(
            match crate::commands::scrollback_load(app.clone(), s("tabId")?) {
                Some(v) => serde_json::Value::String(v),
                None => serde_json::Value::Null,
            },
        ),
        "default_shell" => Ok(serde_json::Value::String(crate::pty::default_shell())),
        // The desktop's current session list, pushed via `companion_set_sessions`.
        // Returned as a parsed array so the page can render tabs without re-parsing.
        "list_sessions" => {
            let raw = app
                .try_state::<CompanionState>()
                .and_then(|s| s.sessions.lock().ok().map(|g| g.clone()))
                .unwrap_or_default();
            let trimmed = raw.trim();
            Ok(
                serde_json::from_str(if trimmed.is_empty() { "[]" } else { trimmed })
                    .unwrap_or_else(|_| serde_json::json!([])),
            )
        }
        "system_stats" => {
            serde_json::to_value(crate::sysstats::system_stats()).map_err(|e| e.to_string())
        }
        "pty_write" => crate::pty::pty_write(app.state(), s("id")?, s("data")?)
            .map(|_| serde_json::Value::Null),
        "pty_resize" => {
            let cols = args
                .get("cols")
                .and_then(|v| v.as_u64())
                .ok_or("missing arg 'cols'")? as u16;
            let rows = args
                .get("rows")
                .and_then(|v| v.as_u64())
                .ok_or("missing arg 'rows'")? as u16;
            crate::pty::pty_resize(app.state(), s("id")?, cols, rows)
                .map(|_| serde_json::Value::Null)
        }
        other => Err(format!("unsupported command: {other}")),
    }
}

/// Start the companion server on `port`. Returns `(port, token)`. Errors if a
/// server is already running or the bind fails (e.g. port in use).
pub fn start(
    app: tauri::AppHandle,
    state: &CompanionState,
    port: u16,
) -> Result<(u16, String, String), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("companion already running".into());
    }
    let token = random_token();
    let ctx = WsCtx {
        token: token.clone(),
        app: app.clone(),
    };
    let router = Router::new()
        .route("/", get(index))
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new(dist_dir(&app)))
        .with_state(ctx);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    // Bind synchronously so a bind failure surfaces to the caller now.
    let std_listener =
        std::net::TcpListener::bind(addr).map_err(|e| format!("bind {addr}: {e}"))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                log::error!("companion: listener: {e}");
                return;
            }
        };
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });

    let host = best_host();
    *guard = Some(Running {
        port,
        token: token.clone(),
        host: host.clone(),
        shutdown: tx,
    });
    Ok((port, token, host))
}

/// Stop the running server (fires graceful shutdown). No-op if not running.
pub fn stop(state: &CompanionState) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(r) = guard.take() {
        let _ = r.shutdown.send(());
    }
    Ok(())
}

/// Current (port, token, host) if running.
pub fn status(state: &CompanionState) -> Option<(u16, String, String)> {
    let guard = state.inner.lock().ok()?;
    guard
        .as_ref()
        .map(|r| (r.port, r.token.clone(), r.host.clone()))
}

// ── Tauri commands ──────────────────────────────────────────────────────────

const DEFAULT_PORT: u16 = 8390;

/// `{ running, port, token, host, url }` — the URL embeds the token in the hash
/// so opening it (or scanning the QR) auto-connects the companion page.
fn info_json(port: u16, token: &str, host: &str) -> serde_json::Value {
    serde_json::json!({
        "running": true,
        "port": port,
        "token": token,
        "host": host,
        "url": format!("http://{host}:{port}/#{token}"),
    })
}

#[tauri::command]
pub fn companion_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, CompanionState>,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let (port, token, host) = start(app, &state, port.unwrap_or(DEFAULT_PORT))?;
    Ok(info_json(port, &token, &host))
}

#[tauri::command]
pub fn companion_stop(state: tauri::State<'_, CompanionState>) -> Result<(), String> {
    stop(&state)
}

#[tauri::command]
pub fn companion_status(state: tauri::State<'_, CompanionState>) -> serde_json::Value {
    match status(&state) {
        Some((port, token, host)) => info_json(port, &token, &host),
        None => serde_json::json!({ "running": false }),
    }
}

/// Receive the desktop's current session list (a JSON array of
/// `{id, tabId, label, active}`) and stash it for the `list_sessions` RPC. The
/// React app pushes this whenever the live PTY set or active tab changes, so the
/// companion page always mirrors what the desktop is actually showing. Stored
/// even while the server is stopped, so the list is ready the moment it starts.
#[tauri::command]
pub fn companion_set_sessions(
    state: tauri::State<'_, CompanionState>,
    sessions: String,
) -> Result<(), String> {
    let mut guard = state.sessions.lock().map_err(|e| e.to_string())?;
    *guard = sessions;
    Ok(())
}
