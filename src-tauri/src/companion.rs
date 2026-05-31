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
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use rand::Rng;
use tauri::Manager;
use tower_http::services::ServeDir;

/// Live-server handle: the bound port, the auth token, and a graceful-shutdown
/// trigger (firing it ends `axum::serve`).
struct Running {
    port: u16,
    token: String,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

/// Tauri-managed companion state: `None` when stopped, `Some` when running.
#[derive(Default)]
pub struct CompanionState {
    inner: Mutex<Option<Running>>,
}

/// Per-connection context handed to the WS handler (the auth token to check).
#[derive(Clone)]
struct WsCtx {
    token: String,
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

async fn handle_socket(mut socket: WebSocket, ctx: WsCtx) {
    // First frame must be the auth token; anything else drops the connection.
    match socket.recv().await {
        Some(Ok(Message::Text(t))) if t.as_str().trim() == ctx.token => {}
        _ => return,
    }
    let _ = socket.send(Message::Text(String::from("ok").into())).await;
    // Phase 1c: real RPC + PTY event relay. Scaffold stub: echo.
    while let Some(Ok(msg)) = socket.recv().await {
        match msg {
            Message::Text(t) => {
                let _ = socket
                    .send(Message::Text(format!("echo:{}", t.as_str()).into()))
                    .await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}

/// Start the companion server on `port`. Returns `(port, token)`. Errors if a
/// server is already running or the bind fails (e.g. port in use).
pub fn start(
    app: tauri::AppHandle,
    state: &CompanionState,
    port: u16,
) -> Result<(u16, String), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("companion already running".into());
    }
    let token = random_token();
    let ctx = WsCtx {
        token: token.clone(),
    };
    let router = Router::new()
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

    *guard = Some(Running {
        port,
        token: token.clone(),
        shutdown: tx,
    });
    Ok((port, token))
}

/// Stop the running server (fires graceful shutdown). No-op if not running.
pub fn stop(state: &CompanionState) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(r) = guard.take() {
        let _ = r.shutdown.send(());
    }
    Ok(())
}

/// Current (port, token) if running.
pub fn status(state: &CompanionState) -> Option<(u16, String)> {
    let guard = state.inner.lock().ok()?;
    guard.as_ref().map(|r| (r.port, r.token.clone()))
}

// ── Tauri commands ──────────────────────────────────────────────────────────

const DEFAULT_PORT: u16 = 8390;

#[tauri::command]
pub fn companion_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, CompanionState>,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let (port, token) = start(app, &state, port.unwrap_or(DEFAULT_PORT))?;
    Ok(serde_json::json!({ "running": true, "port": port, "token": token }))
}

#[tauri::command]
pub fn companion_stop(state: tauri::State<'_, CompanionState>) -> Result<(), String> {
    stop(&state)
}

#[tauri::command]
pub fn companion_status(state: tauri::State<'_, CompanionState>) -> serde_json::Value {
    match status(&state) {
        Some((port, token)) => {
            serde_json::json!({ "running": true, "port": port, "token": token })
        }
        None => serde_json::json!({ "running": false }),
    }
}
