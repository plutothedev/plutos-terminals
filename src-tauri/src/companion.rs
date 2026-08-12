// (C)
// Phone/web companion — local HTTP + WebSocket server for the remote-control
// feature (docs/phone-companion-design.md).
//
// This file: the server. It serves the self-contained companion page (the
// embedded `companion-web/index.html`, sw.js, manifest) and exposes a token-authed
// WebSocket at /ws for command-RPC + PTY event relay. It does NOT serve the
// desktop React bundle (dist/) — the phone page is self-contained, and serving the
// desktop source over the network was a disclosure hazard, so there is no
// ServeDir fallback.
//
// Reachability: binds 127.0.0.1:<port> only; Tailscale Serve fronts TLS on the
// MagicDNS name and proxies the tailnet to loopback (a secure context for the
// service worker + web push). Off by default; started explicitly from the UI.
// (Do NOT restore an 0.0.0.0 bind — that would expose the socket to the whole LAN.)
//
// Security: a random 40-char token gates the WebSocket (compared in constant time).
// A leaked token = shell access, so the token is opt-in and revocable (stop/restart
// mints a fresh one). Filesystem RPCs (list_directory) are jailed to the user's home.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use axum::Router;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use tauri::{Emitter, Listener, Manager};

/// Constant-time byte comparison for the auth token — a plain `==` short-circuits
/// on the first differing byte, leaking how many leading bytes matched (a timing
/// oracle on the sole gate to shell access). Token length is fixed/non-secret.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

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

// ── Phase 5: HTTPS (Tailscale Serve) + Web Push ──────────────────────────────

/// The device's MagicDNS name (e.g. `host.tailnet.ts.net`), trailing dot trimmed.
/// `None` when Tailscale isn't up / MagicDNS is off. Used for the `https://` URL
/// once `tailscale serve` fronts TLS.
fn magic_dns_name() -> Option<String> {
    let out = std::process::Command::new("tailscale")
        .args(["status", "--json"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let name = v
        .get("Self")?
        .get("DNSName")?
        .as_str()?
        .trim_end_matches('.')
        .trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Front the loopback companion with Tailscale Serve so the phone reaches it over
/// HTTPS — a secure context, required for the service worker + Web Push. Tailscale
/// auto-provisions and renews the MagicDNS cert. Idempotent; best-effort (logs on
/// failure). Undone by `serve_off` when the companion stops.
fn ensure_serve(port: u16) {
    match std::process::Command::new("tailscale")
        .args(["serve", "--bg", &port.to_string()])
        .output()
    {
        Ok(o) if o.status.success() => {}
        Ok(o) => log::warn!(
            "companion: `tailscale serve` failed: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Err(e) => log::warn!("companion: couldn't run `tailscale serve`: {e}"),
    }
}

/// Undo `ensure_serve`: remove the Tailscale Serve proxy for `port`. Without
/// this, stopping the companion left the external HTTPS surface up — the
/// tailnet kept a live proxy pointing at the (now closed) loopback port until
/// a manual `tailscale serve reset`. Best-effort; failures are logged.
fn serve_off(port: u16) {
    match std::process::Command::new("tailscale")
        .args(["serve", "--bg", &port.to_string(), "off"])
        .output()
    {
        Ok(o) if o.status.success() => {}
        Ok(o) => log::warn!(
            "companion: `tailscale serve off` failed: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Err(e) => log::warn!("companion: couldn't run `tailscale serve off`: {e}"),
    }
}

const KEYCHAIN_SERVICE: &str = "com.plutothedev.terminals.companion";

fn kr_get(account: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .ok()?
        .get_password()
        .ok()
}

fn kr_set(account: &str, val: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|e| e.to_string())?
        .set_password(val)
        .map_err(|e| e.to_string())
}

/// Get-or-generate the VAPID keypair, persisted in the OS keychain (never on
/// disk plaintext). Returns `(private_b64url, public_b64url)`: the public key is
/// the uncompressed P-256 point the browser uses as `applicationServerKey`; the
/// private key is the raw 32-byte scalar `web-push` signs the JWT with.
fn ensure_vapid() -> Result<(String, String), String> {
    if let (Some(priv_b64), Some(pub_b64)) = (kr_get("vapid_private"), kr_get("vapid_public")) {
        return Ok((priv_b64, pub_b64));
    }
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    let secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let priv_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret.to_bytes());
    let point = secret.public_key().to_encoded_point(false);
    let pub_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(point.as_bytes());
    kr_set("vapid_private", &priv_b64)?;
    kr_set("vapid_public", &pub_b64)?;
    Ok((priv_b64, pub_b64))
}

/// Forget all stored Web Push subscriptions. Called when the server stops and
/// when the auth token rotates (each `start` mints a fresh token): the
/// subscriptions were registered by a phone paired under the now-revoked
/// token, and push-when-closed must not keep notifying a revoked device.
fn clear_push_subscriptions() {
    match keyring::Entry::new(KEYCHAIN_SERVICE, "push_subscriptions") {
        Ok(entry) => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log::warn!("companion: couldn't clear push subscriptions: {e}"),
        },
        Err(e) => log::warn!("companion: keychain access failed clearing push subscriptions: {e}"),
    }
}

/// Append a browser PushSubscription (its `toJSON()` shape) to the stored set,
/// deduped by endpoint. Stored in the keychain alongside the VAPID keys.
fn store_subscription(sub_json: &str) -> Result<(), String> {
    let incoming: serde_json::Value =
        serde_json::from_str(sub_json).map_err(|e| e.to_string())?;
    let endpoint = incoming.get("endpoint").and_then(|v| v.as_str()).unwrap_or("");
    if endpoint.is_empty() {
        return Err("subscription missing endpoint".into());
    }
    let mut subs: Vec<serde_json::Value> = kr_get("push_subscriptions")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    subs.retain(|s| s.get("endpoint").and_then(|v| v.as_str()) != Some(endpoint));
    subs.push(incoming);
    kr_set(
        "push_subscriptions",
        &serde_json::to_string(&subs).map_err(|e| e.to_string())?,
    )
}

/// Send one Web Push to a stored subscription (async, spawned off the command
/// thread). `payload` is the JSON the service worker reads in its `push` event.
/// Best-effort: errors are logged, not surfaced.
async fn send_push(sub_json: String, vapid_priv_b64: String, payload: Vec<u8>) {
    use web_push::WebPushClient as _;
    let result: Result<(), String> = async {
        let sub: web_push::SubscriptionInfo =
            serde_json::from_str(&sub_json).map_err(|e| e.to_string())?;
        let mut sig = web_push::VapidSignatureBuilder::from_base64(&vapid_priv_b64, &sub)
            .map_err(|e| e.to_string())?;
        sig.add_claim("sub", "mailto:companion@plutos-terminals.local");
        let signature = sig.build().map_err(|e| e.to_string())?;
        let mut builder = web_push::WebPushMessageBuilder::new(&sub);
        builder.set_payload(web_push::ContentEncoding::Aes128Gcm, &payload);
        builder.set_vapid_signature(signature);
        let msg = builder.build().map_err(|e| e.to_string())?;
        let client = web_push::HyperWebPushClient::new();
        client.send(msg).await.map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = result {
        log::warn!("companion: web-push send failed: {e}");
    }
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
    // Desktop-pushed snippets (`st.snippets`) and the model catalog + active
    // selection — same reason as `sessions`: the page can't read the webview's
    // localStorage where both live. `models` carries only `hasKey` booleans per
    // provider, never the API keys themselves (those stay on the desktop).
    snippets: Mutex<String>,
    models: Mutex<String>,
    // Count of authenticated WebSocket clients currently connected. Phase 5 pushes
    // a "finished" web-push notification only when this is 0 — i.e. no phone is
    // actively viewing, so the tab is closed and the live in-page alert can't fire.
    ws_count: AtomicUsize,
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

async fn ws_handler(ws: WebSocketUpgrade, State(ctx): State<WsCtx>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, ctx))
}

/// The self-contained companion page (Phase 1). Compiled into the binary so it's
/// served even before the React app's dist/ exists / when it isn't reused yet.
async fn index() -> impl IntoResponse {
    // Strict CSP (audit 2026-06-19, vendoring done 2026-06-30): script-src 'self'
    // means NO inline script and NO CDN — xterm + the app logic are now vendored
    // and served same-origin (/vendor/*, /app.js), so a TLS-MITM or CDN compromise
    // on a hostile phone network can no longer inject script into the page that
    // holds the shell-access token (which would be desktop RCE). 'unsafe-inline' is
    // kept ONLY for style (the page has an inline <style> block + style attributes);
    // style injection is not a code-exec vector. connect-src allows the same-origin
    // WebSocket. The X-* headers stay for older clients that ignore CSP.
    const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
        img-src 'self' data:; connect-src 'self' ws: wss:; manifest-src 'self'; worker-src 'self'; \
        font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    (
        [
            (header::CONTENT_SECURITY_POLICY, CSP),
            (header::X_FRAME_OPTIONS, "DENY"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Html(include_str!("../companion-web/index.html")),
    )
}

/// Vendored xterm + addon-fit + app logic, served same-origin so the page needs
/// no CDN (see the CSP in `index`). Compiled into the binary via `include_str!`.
async fn vendor_xterm_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/javascript")],
        include_str!("../companion-web/vendor/xterm.js"),
    )
}
async fn vendor_addon_fit_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/javascript")],
        include_str!("../companion-web/vendor/addon-fit.js"),
    )
}
async fn vendor_xterm_css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css")],
        include_str!("../companion-web/vendor/xterm.css"),
    )
}
async fn app_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/javascript")],
        include_str!("../companion-web/app.js"),
    )
}

/// Service worker (Phase 5) — handles `push` events to show a notification even
/// when the page/tab is closed. Served at root scope so it controls the page.
async fn sw_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/javascript")],
        include_str!("../companion-web/sw.js"),
    )
}

/// Installable-PWA manifest (Phase 5).
async fn manifest() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/manifest+json")],
        include_str!("../companion-web/manifest.webmanifest"),
    )
}

async fn handle_socket(socket: WebSocket, ctx: WsCtx) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // First frame must be the auth token; anything else drops the connection.
    match ws_rx.next().await {
        Some(Ok(Message::Text(t))) if ct_eq(t.as_str().trim().as_bytes(), ctx.token.as_bytes()) => {}
        _ => return,
    }

    // Authenticated. Count this client so Phase 5 pushes only when none are
    // connected (i.e. the phone tab is closed and the in-page alert can't fire).
    if let Some(st) = ctx.app.try_state::<CompanionState>() {
        st.ws_count.fetch_add(1, Ordering::SeqCst);
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
    // Deduped by channel name (re-subscribing would register a second listener
    // and double every relayed frame) and capped so a misbehaving client can't
    // grow the listener set without bound for the life of the connection.
    let mut subs: Vec<tauri::EventId> = Vec::new();
    let mut sub_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    const MAX_SUBS: usize = 64;

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
                // Dispatch on the blocking pool: scrollback_load reads files up
                // to ~10MB, pty_write/system_stats also block — running them
                // inline would stall the shared tokio runtime (every other
                // socket + the PTY event relay) for the duration.
                let app = ctx.app.clone();
                let result = tokio::task::spawn_blocking(move || dispatch(&app, &cmd, args))
                    .await
                    .unwrap_or_else(|e| Err(format!("dispatch task failed: {e}")));
                let frame = match result {
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
                    // Least-privilege event relay: only the live PTY streams the
                    // page actually consumes. Tauri's `app.emit` fans out to EVERY
                    // `app.listen` listener regardless of channel, so without this
                    // gate a token holder could subscribe to channels the command
                    // allow-list deliberately excludes — e.g. `vnc-frame://` /
                    // `rdp-frame://` (live remote-desktop pixels). Mirror the
                    // command allow-list's least-privilege intent for the relay.
                    if ch.starts_with("pty://") || ch.starts_with("pty-exit://") {
                        if sub_names.contains(ch) {
                            // Already relaying this channel — ignore the duplicate.
                        } else if sub_names.len() >= MAX_SUBS {
                            let _ = out_tx.send(
                                r#"{"type":"error","error":"subscription limit (64) reached"}"#
                                    .to_string(),
                            );
                        } else {
                            sub_names.insert(ch.to_string());
                            let channel = ch.to_string();
                            let ch_json =
                                serde_json::to_string(&channel).unwrap_or_else(|_| "\"\"".into());
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
                }
            }
            _ => {}
        }
    }

    for id in subs {
        ctx.app.unlisten(id);
    }
    sender.abort();
    if let Some(st) = ctx.app.try_state::<CompanionState>() {
        st.ws_count.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Read one of the desktop-pushed JSON stashes out of `CompanionState`. Returns
/// the raw string (empty when unset / state missing).
fn stash_str(app: &tauri::AppHandle, sel: fn(&CompanionState) -> &Mutex<String>) -> String {
    app.try_state::<CompanionState>()
        .and_then(|s| sel(&s).lock().ok().map(|g| g.clone()))
        .unwrap_or_default()
}

/// Parse a stashed string as a JSON array (empty/garbage → `[]`).
fn parse_array(raw: &str) -> serde_json::Value {
    let t = raw.trim();
    serde_json::from_str(if t.is_empty() { "[]" } else { t }).unwrap_or_else(|_| serde_json::json!([]))
}

/// Parse a stashed string as an arbitrary JSON value (empty/garbage → `null`).
fn parse_value(raw: &str) -> serde_json::Value {
    let t = raw.trim();
    serde_json::from_str(if t.is_empty() { "null" } else { t }).unwrap_or(serde_json::Value::Null)
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
        // Sync core, not the async command wrapper — this dispatcher already
        // runs on the blocking pool (P1-T6; also caps the payload at the
        // 256KB replay tail instead of the old up-to-10MB whole file).
        "scrollback_load" => Ok(
            match crate::commands::scrollback_load_sync(app, &s("tabId")?) {
                Some(v) => serde_json::Value::String(v),
                None => serde_json::Value::Null,
            },
        ),
        "default_shell" => Ok(serde_json::Value::String(crate::pty::default_shell())),
        // Read-only local file browser. Returns [resolvedPath, [entries…]].
        // CONFINED to the user's home tree: unlike the desktop-local Tauri command,
        // a leaked token must not enumerate the entire filesystem (.ssh recon,
        // Downloads/*.pem, kubeconfig, etc.). Reject anything that resolves outside
        // $HOME after canonicalization.
        "list_directory" => {
            let home = crate::commands::local_home();
            let requested = match args.get("path").and_then(|v| v.as_str()) {
                Some(p) if !p.trim().is_empty() => PathBuf::from(p),
                _ => home.clone(),
            };
            // Fail CLOSED: if a path can't be canonicalized, reject it rather than
            // falling back to the raw (un-resolved) path, which would let a crafted
            // `..` sequence pass the component-based starts_with check and escape the
            // home jail once the OS resolves it.
            let canon = std::fs::canonicalize(&requested)
                .map_err(|_| "path is not accessible".to_string())?;
            let home_canon = std::fs::canonicalize(&home)
                .map_err(|_| "home directory not accessible".to_string())?;
            if !canon.starts_with(&home_canon) {
                return Err("path outside the allowed home directory".into());
            }
            crate::commands::list_directory(Some(canon.to_string_lossy().into_owned()))
                .and_then(|t| serde_json::to_value(t).map_err(|e| e.to_string()))
        }
        // Ask the desktop to open a new session. The phone can't spawn a PTY
        // directly — it would have no desktop tab/scrollback/UI — so we emit an
        // event the React app handles by adding a tab (which then spawns + flows
        // back into `list_sessions`). Local shell only for now (SSH needs an
        // interactive credential prompt that doesn't fit the phone path).
        "new_session" => {
            let kind = args
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("local")
                .to_string();
            app.emit(
                "companion://new-session",
                serde_json::json!({ "kind": kind }),
            )
            .map(|_| serde_json::Value::Null)
            .map_err(|e| e.to_string())
        }
        // The desktop's current session list, pushed via `companion_set_sessions`.
        // Returned as a parsed array so the page can render tabs without re-parsing.
        "list_sessions" => Ok(parse_array(&stash_str(app, |s| &s.sessions))),
        // The desktop's saved snippets, pushed via `companion_set_snippets`. Same
        // reason as the session list (page can't read the webview's localStorage).
        // Read-only: the phone inserts a snippet's command into the active session
        // via `pty_write`; it never edits the snippet set.
        "list_snippets" => Ok(parse_array(&stash_str(app, |s| &s.snippets))),
        // The model catalog + active selection, pushed via `companion_set_models`.
        // Each provider carries only `{id,label,models,hasKey}` — never API keys.
        "list_models" => Ok(parse_value(&stash_str(app, |s| &s.models))),
        // Set the active provider/model for NEXT-spawned shells. Emits an event the
        // desktop validates (known provider WITH a key configured) and applies via
        // `saveUser` — a single field, NOT `write_store`: a leaked token can't
        // touch the persisted layout, the snippet set, or read/write the API keys.
        "set_active_model" => {
            let provider_id = s("providerId")?;
            let model = s("model")?;
            app.emit(
                "companion://set-active-model",
                serde_json::json!({ "providerId": provider_id, "model": model }),
            )
            .map(|_| serde_json::Value::Null)
            .map_err(|e| e.to_string())
        }
        // Phase 5 web push. The page fetches the VAPID public key (its
        // applicationServerKey), subscribes via pushManager, and sends the
        // resulting subscription back to be stored for push-when-closed.
        "vapid_public_key" => ensure_vapid().map(|(_, pubk)| serde_json::Value::String(pubk)),
        "push_subscribe" => {
            let sub = args
                .get("subscription")
                .ok_or_else(|| "missing arg 'subscription'".to_string())?;
            store_subscription(&sub.to_string()).map(|_| serde_json::Value::Null)
        }
        "system_stats" => {
            // Sync core — this dispatcher already runs on the blocking pool.
            serde_json::to_value(crate::sysstats::system_stats_sync()).map_err(|e| e.to_string())
        }
        "pty_write" => crate::pty::pty_write_sync(app.state(), s("id")?, s("data")?)
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
            crate::pty::pty_resize_sync(app.state(), s("id")?, cols, rows)
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
    // Token rotation: any push subscriptions registered under a previous token
    // (e.g. after a crash that skipped stop()) die with it.
    clear_push_subscriptions();
    let ctx = WsCtx {
        token: token.clone(),
        app: app.clone(),
    };
    let router = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/vendor/xterm.js", get(vendor_xterm_js))
        .route("/vendor/addon-fit.js", get(vendor_addon_fit_js))
        .route("/vendor/xterm.css", get(vendor_xterm_css))
        .route("/ws", get(ws_handler))
        .route("/sw.js", get(sw_js))
        .route("/manifest.webmanifest", get(manifest))
        // No ServeDir fallback: the companion page is the self-contained embedded
        // index.html. Serving the desktop React bundle (dist/) here would disclose
        // the full client source to anyone who can reach the port. Unknown paths 404.
        .fallback(|| async { (StatusCode::NOT_FOUND, "not found") })
        .with_state(ctx);

    // Phase 5: bind loopback only — Tailscale Serve fronts TLS and proxies the
    // tailnet to 127.0.0.1 (a secure context for the service worker + web push).
    // This also drops the old all-interfaces (0.0.0.0) exposure.
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
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

    // Front loopback with Tailscale Serve (HTTPS on the MagicDNS name). The host
    // for the URL is the MagicDNS name when available (→ https, no port), else the
    // best direct host (→ http fallback; only reachable if Tailscale is down and a
    // future non-serve path is used).
    ensure_serve(port);
    let host = magic_dns_name().unwrap_or_else(best_host);
    *guard = Some(Running {
        port,
        token: token.clone(),
        host: host.clone(),
        shutdown: tx,
    });
    Ok((port, token, host))
}

/// Stop the running server (fires graceful shutdown). Also tears down the
/// Tailscale Serve proxy and forgets push subscriptions — stop must revoke the
/// whole external surface, not just the loopback socket. No-op if not running.
pub fn stop(state: &CompanionState) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(r) = guard.take() {
        let _ = r.shutdown.send(());
        serve_off(r.port);
        clear_push_subscriptions();
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
    // Tailscale Serve fronts TLS on the MagicDNS name (port 443) → https, no port.
    // Otherwise fall back to the direct http URL (host:port).
    let url = if host.ends_with(".ts.net") {
        format!("https://{host}/#{token}")
    } else {
        format!("http://{host}:{port}/#{token}")
    };
    serde_json::json!({
        "running": true,
        "port": port,
        "token": token,
        "host": host,
        "url": url,
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

/// Receive the desktop's saved snippets (a JSON array of `{id, name, command}`)
/// for the `list_snippets` RPC. Pushed whenever `st.snippets` changes. Stored
/// even while the server is stopped, so it's ready the moment it starts.
#[tauri::command]
pub fn companion_set_snippets(
    state: tauri::State<'_, CompanionState>,
    snippets: String,
) -> Result<(), String> {
    let mut guard = state.snippets.lock().map_err(|e| e.to_string())?;
    *guard = snippets;
    Ok(())
}

/// Receive the desktop's model catalog + active selection (JSON
/// `{ active, providers: [{id, label, models, hasKey}] }`) for the `list_models`
/// RPC. `hasKey` is a boolean — the API keys themselves never leave the desktop.
#[tauri::command]
pub fn companion_set_models(
    state: tauri::State<'_, CompanionState>,
    models: String,
) -> Result<(), String> {
    let mut guard = state.models.lock().map_err(|e| e.to_string())?;
    *guard = models;
    Ok(())
}

/// Phase 5 (push-when-closed): the desktop calls this when a command/agent
/// finishes in a backgrounded session (it already detects this for its own "done"
/// cue). If the server is running, NO phone is currently connected (so the tab is
/// closed and the in-page alert can't fire), and a push subscription + VAPID key
/// exist, send a Web Push so the phone is notified anyway. Best-effort + silent.
#[tauri::command]
pub fn companion_notify_finish(
    state: tauri::State<'_, CompanionState>,
    label: String,
    exit: Option<i64>,
) {
    if state.inner.lock().map(|g| g.is_none()).unwrap_or(true) {
        return; // server not running
    }
    if state.ws_count.load(Ordering::SeqCst) > 0 {
        return; // a phone is connected — its in-page alert already covers this
    }
    let subs: Vec<serde_json::Value> = match kr_get("push_subscriptions")
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(v) => v,
        None => return,
    };
    if subs.is_empty() {
        return;
    }
    let vapid_priv = match ensure_vapid() {
        Ok((priv_b64, _)) => priv_b64,
        Err(_) => return,
    };
    let ok = exit.map(|e| e == 0).unwrap_or(true);
    let title = format!("{} {}", if ok { "✓" } else { "✗" }, label);
    let body = match exit {
        Some(e) if e != 0 => format!("exited {e}"),
        _ => "finished".to_string(),
    };
    let payload = serde_json::json!({ "title": title, "body": body })
        .to_string()
        .into_bytes();
    for sub in subs {
        tauri::async_runtime::spawn(send_push(sub.to_string(), vapid_priv.clone(), payload.clone()));
    }
}

#[cfg(test)]
mod companion_assets_tests {
    // Lock the companion-page security invariant (audit 2026-06-19 item #2):
    // the page must load xterm + its app logic SAME-ORIGIN, never from a CDN, so a
    // strict script-src 'self' CSP holds and a hostile-network MITM can't inject
    // script into the token-bearing page. These assert the embedded assets only;
    // the visual render (xterm actually drawing from the vendored UMD) is a manual
    // browser smoke — see docs/autonomous-session checklist item D/F.
    const INDEX: &str = include_str!("../companion-web/index.html");
    const APP_JS: &str = include_str!("../companion-web/app.js");
    const XTERM_JS: &str = include_str!("../companion-web/vendor/xterm.js");
    const ADDON_FIT_JS: &str = include_str!("../companion-web/vendor/addon-fit.js");
    const XTERM_CSS: &str = include_str!("../companion-web/vendor/xterm.css");

    #[test]
    fn no_cdn_references_anywhere() {
        for (name, src) in [("index.html", INDEX), ("app.js", APP_JS)] {
            assert!(!src.contains("jsdelivr"), "{name} still references a CDN");
            assert!(!src.contains("cdn."), "{name} still references a CDN");
            assert!(!src.contains("https://"), "{name} loads an external resource");
        }
    }

    #[test]
    fn index_loads_vendored_assets_same_origin() {
        assert!(INDEX.contains("/vendor/xterm.css"), "css not vendored");
        assert!(INDEX.contains(r#"src="/vendor/xterm.js""#), "xterm.js not vendored");
        assert!(INDEX.contains(r#"src="/vendor/addon-fit.js""#), "addon-fit not vendored");
        assert!(INDEX.contains(r#"src="/app.js""#), "app.js not externalized");
        // No inline executable <script> block (only external src= tags). The page
        // must satisfy script-src 'self' with no 'unsafe-inline'.
        assert!(!INDEX.contains("import {"), "an ESM import survived in the page");
    }

    #[test]
    fn app_js_uses_umd_globals_not_esm() {
        assert!(!APP_JS.contains("import "), "app.js still uses an ESM import");
        // UMD global instantiation (xterm exposes `Terminal`, addon-fit the
        // `FitAddon` namespace whose `.FitAddon` is the class).
        assert!(APP_JS.contains("new Terminal("), "Terminal global not used");
        assert!(APP_JS.contains("new FitAddon.FitAddon("), "FitAddon UMD namespace not used");
    }

    #[test]
    fn vendored_libs_are_the_expected_umd_bundles() {
        // sanity: non-trivial size + a UMD marker, so a truncated/empty copy fails CI.
        assert!(XTERM_JS.len() > 100_000, "xterm.js looks truncated");
        assert!(XTERM_JS.contains("define.amd"), "xterm.js is not the UMD build");
        assert!(ADDON_FIT_JS.contains("FitAddon"), "addon-fit.js missing its export");
        assert!(XTERM_CSS.contains(".xterm"), "xterm.css looks wrong");
    }
}
