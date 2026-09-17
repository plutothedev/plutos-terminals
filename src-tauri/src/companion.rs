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

use std::io::Read;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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

// CREATE_NO_WINDOW — suppresses the conhost.exe console flash that would
// otherwise appear (and steal focus) every time we shell out to `tailscale`.
// Local copy of the same helper commands.rs / netools.rs / share.rs each carry;
// starting and stopping the phone companion runs four of these, so without it a
// black console window flashes over the app on Windows each time (review).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Hard deadline for one `tailscale` call (audit R4). The CLI talks to
/// `tailscaled` over its LocalAPI, and that does not always answer: a daemon
/// mid-startup, mid-reauth, or wedged leaves `tailscale serve --bg` pending
/// indefinitely, and `Command::output()` has no timeout of its own. Five
/// seconds is orders of magnitude longer than a healthy call and short enough
/// that the companion toggle still resolves for the user.
const TAILSCALE_TIMEOUT: Duration = Duration::from_secs(5);

/// How often the wait loop re-checks a still-running child. Short enough that a
/// fast command is not measurably delayed, long enough not to spin a core.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// `Command::output()` with a deadline. On expiry the child is killed and an
/// error returned, so a wedged subprocess can never park the caller forever.
///
/// Both pipes are drained on their own threads instead of after the wait. That
/// is not incidental: `tailscale status --json` on a sizeable tailnet is well
/// past the ~64 KB OS pipe buffer, and a child that fills its pipe blocks until
/// something reads it. A drain-after-wait version would therefore sit until the
/// deadline and report "Tailscale unavailable" for a perfectly healthy daemon.
fn output_bounded(mut cmd: Command, timeout: Duration) -> Result<Output, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let read_out = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let read_err = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
        if Instant::now() >= deadline {
            // Kill AND reap: leaving a zombie would keep the pipes open, which
            // would in turn park both reader threads for the life of the app.
            let _ = child.kill();
            let _ = child.wait();
            let _ = read_out.join();
            let _ = read_err.join();
            return Err(format!("timed out after {}ms", timeout.as_millis()));
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    Ok(Output {
        status,
        stdout: read_out.join().unwrap_or_default(),
        stderr: read_err.join().unwrap_or_default(),
    })
}

/// One `tailscale <args>` call, window-less and time-bounded. Every shell-out in
/// this file goes through here so none of them can be the one that hangs.
fn tailscale(args: &[&str]) -> Result<Output, String> {
    let mut cmd = silent_command("tailscale");
    cmd.args(args);
    output_bounded(cmd, TAILSCALE_TIMEOUT)
}

/// Best host for the phone to dial: the Tailscale IP if available (the intended
/// reach), else the primary LAN IP, else localhost. Computed once at start.
fn best_host() -> String {
    if let Ok(out) = tailscale(&["ip", "-4"]) {
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
    let out = tailscale(&["status", "--json"]).ok()?;
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
    match tailscale(&["serve", "--bg", &port.to_string()]) {
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
    match tailscale(&["serve", "--bg", &port.to_string(), "off"]) {
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

/// Outbound frame queue depth per connected client (audit R5). Sized to ride
/// out an ordinary network stall. A busy PTY emits coalesced 8 ms / 64 KB
/// chunks, so this is a couple of seconds of headroom, while capping the
/// desktop's exposure to one lagging phone at a few MB rather than unbounded.
const OUT_QUEUE: usize = 256;

/// The outbound frame queue for one connected client. A function, not an inline
/// `mpsc::channel(...)` call, so the boundedness the R5 fix depends on is one
/// named thing the tests can construct exactly as `handle_socket` does. The
/// return type is the guard: `unbounded_channel()` yields `UnboundedSender` /
/// `UnboundedReceiver` and will not satisfy this signature.
fn out_channel() -> (
    tokio::sync::mpsc::Sender<String>,
    tokio::sync::mpsc::Receiver<String>,
) {
    tokio::sync::mpsc::channel(OUT_QUEUE)
}

/// The single "you missed N frames" marker the sender task emits once the queue
/// drains. The companion page ignores message types it does not know, so this
/// is safe to send to an older page; the point is that the gap is *stated*
/// rather than the phone silently rendering spliced-together output.
///
/// The CURRENT page states it: `companion-web/app.js` carries an
/// `m.type === "dropped"` branch that writes a marker into the xterm buffer.
/// That branch is a hand-written duplicate of this format across a language
/// boundary, so `the_companion_page_handles_the_dropped_marker` derives both the
/// type string and the field name from THIS function and asserts app.js reads
/// them. Without it the marker is JSON.parsed and thrown away, and a phone on a
/// weak link shows a contiguous-looking terminal quietly missing output.
fn dropped_marker(frames: usize) -> String {
    format!(r#"{{"type":"dropped","frames":{frames}}}"#)
}

/// Channels a companion client is allowed to relay.
///
/// Least-privilege, and it is load-bearing: Tauri's `app.emit` fans out to EVERY
/// `app.listen` listener regardless of channel, so without this gate a token
/// holder could subscribe to channels the RPC allow-list deliberately excludes:
/// `vnc-frame://` and `rdp-frame://` carry live remote-desktop pixels. Named and
/// separate so the boundary is one testable predicate rather than a condition
/// buried in the message loop.
fn relay_channel_allowed(channel: &str) -> bool {
    channel.starts_with("pty://") || channel.starts_with("pty-exit://")
}

/// Queue one relayed EVENT frame for a connected client. Never awaits and never
/// blocks the producer: a full queue means the phone is not draining, so the
/// frame is dropped and counted instead.
///
/// Scoped to the event relay on purpose. That producer is an `app.listen`
/// callback, which is SYNC and runs on the emitting thread, so an awaiting send
/// there would stall the PTY event fan-out for every other listener including
/// the desktop webview's own, and it is the only producer whose rate is set by
/// the PTY rather than by the client, which is what made the old unbounded
/// queue grow without limit. RPC replies are one per client request and so are
/// already bounded; they await instead, because the companion page has no RPC
/// timeout and a dropped reply would hang its promise until a reload.
///
/// Returns whether the frame was queued.
fn relay_try_send(
    tx: &tokio::sync::mpsc::Sender<String>,
    dropped: &AtomicUsize,
    frame: String,
) -> bool {
    use tokio::sync::mpsc::error::TrySendError;
    match tx.try_send(frame) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) => {
            dropped.fetch_add(1, Ordering::Relaxed);
            false
        }
        // Closed means the sender task already exited (socket torn down). That
        // is not backpressure, so it must not inflate the dropped-frame marker.
        Err(TrySendError::Closed(_)) => false,
    }
}

/// One relayed EVENT frame, in exactly the shape `companion-web/app.js` decodes
/// (`m.type === "event"` -> `subs[m.channel](m.payload)`).
///
/// `ch_json` is the channel name ALREADY JSON-encoded and `payload` is the raw
/// JSON Tauri handed the listener, so neither is escaped a second time. Split
/// out of the `app.listen` closure because that closure needs a live AppHandle
/// and a connected socket: nothing in a test can reach it, so the wire shape
/// was the one part of the relay no assertion could see.
fn event_frame(ch_json: &str, payload: &str) -> String {
    format!(r#"{{"type":"event","channel":{ch_json},"payload":{payload}}}"#)
}

/// What the message loop must do with one `subscribe` request.
///
/// The gate, the dedup and the cap are ONE function rather than three nested
/// `if`s in the message loop because the order between them is itself the
/// property worth pinning: a denied channel must not be able to consume one of
/// the `MAX_SUBS` slots, and neither must a duplicate. Inline in the loop that
/// ordering was unreachable from any test, since `handle_socket` needs a live
/// WebSocket and AppHandle.
#[derive(Debug, PartialEq, Eq)]
enum SubscribeDecision {
    /// Register an `app.listen` relay for this channel.
    Accept,
    /// Already relaying it. Re-listening would register a SECOND listener and
    /// double every frame for the life of the connection.
    Duplicate,
    /// Not a channel a companion client may relay. See `relay_channel_allowed`.
    Denied,
    /// The per-connection listener cap is full.
    LimitReached,
}

fn subscribe_decision(
    channel: &str,
    active: &std::collections::HashSet<String>,
    max_subs: usize,
) -> SubscribeDecision {
    // Least privilege first: an unauthorized channel is rejected before it can
    // affect the cap or be mistaken for a duplicate.
    if !relay_channel_allowed(channel) {
        return SubscribeDecision::Denied;
    }
    if active.contains(channel) {
        return SubscribeDecision::Duplicate;
    }
    if active.len() >= max_subs {
        return SubscribeDecision::LimitReached;
    }
    SubscribeDecision::Accept
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
    //
    // BOUNDED, and every producer uses `try_send` (audit R5). This queue used to
    // be unbounded, and `ws_tx.send().await` pends for as long as the client's
    // TCP receive window is full, so a phone that locked its screen mid-`cat`
    // left the desktop queueing every PTY frame as a JSON String with no cap.
    // A lagging phone must lose output, not grow desktop RSS: the frames are
    // terminal bytes it can no longer display in time anyway.
    let (out_tx, mut out_rx) = out_channel();
    // Frames refused since the last successful write. The sender task flushes it
    // as ONE marker per drain burst, so the page can show a gap instead of
    // silently rendering truncated output. Same drop-and-count shape as
    // `Coalescer::enforce_cap` and the SSH 4 MB outbound cap.
    let dropped = Arc::new(AtomicUsize::new(0));
    // Goes into an empty queue, so try_send cannot refuse it; not counted as a
    // lost frame either way, since the counter means "terminal output you did
    // not receive".
    let _ = out_tx.try_send(r#"{"type":"ready"}"#.to_string());
    let sender_dropped = dropped.clone();
    let sender = tokio::spawn(async move {
        while let Some(s) = out_rx.recv().await {
            if ws_tx.send(Message::Text(s.into())).await.is_err() {
                break;
            }
            let n = sender_dropped.swap(0, Ordering::Relaxed);
            if n > 0 && ws_tx.send(Message::Text(dropped_marker(n).into())).await.is_err() {
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
                // Awaits rather than dropping: see `relay_try_send`. Bounded,
                // because a reply exists only because this client asked for it.
                let _ = out_tx.send(frame.to_string()).await;
            }
            // Relay a backend event channel (e.g. "pty://<id>") to this client. The
            // chunks are the SAME ones the desktop webview gets — app.listen sees
            // app.emit — so no change to the PTY reader threads is needed.
            Some("subscribe") => {
                if let Some(ch) = val.get("channel").and_then(|v| v.as_str()) {
                    // Least-privilege event relay: only the live PTY streams the
                    // page actually consumes. The whole decision lives in
                    // `subscribe_decision`; this loop must never re-derive it,
                    // because a gate the loop stops consulting is not a gate.
                    match subscribe_decision(ch, &sub_names, MAX_SUBS) {
                        // Both silent on purpose: a duplicate is a harmless
                        // client retry, and confirming to an unauthorized caller
                        // that a channel exists is free reconnaissance.
                        SubscribeDecision::Denied | SubscribeDecision::Duplicate => {}
                        SubscribeDecision::LimitReached => {
                            let _ = out_tx.try_send(
                                r#"{"type":"error","error":"subscription limit (64) reached"}"#
                                    .to_string(),
                            );
                        }
                        SubscribeDecision::Accept => {
                            sub_names.insert(ch.to_string());
                            let channel = ch.to_string();
                            let ch_json =
                                serde_json::to_string(&channel).unwrap_or_else(|_| "\"\"".into());
                            let tx = out_tx.clone();
                            let lag = dropped.clone();
                            let id = ctx.app.listen(channel, move |ev| {
                                // try_send, never await: this callback runs on the
                                // emitting thread (audit R5). `event_frame` owns
                                // the wire shape; `relay_try_send` owns the
                                // drop-and-count policy.
                                relay_try_send(&tx, &lag, event_frame(&ch_json, ev.payload()));
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
        // Read-only local file browser. Returns [resolvedPath, [entries…], truncated]
        // (the trailing bool is true when the listing hit the entry cap; the phone
        // page ignores the extra element).
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
            crate::commands::list_directory_sync(Some(canon.to_string_lossy().into_owned()))
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
    let mut guard = state.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
    let mut guard = state.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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

/// Audit R4: these two were non-async `#[tauri::command]`s, which tauri-macros
/// compiles to `ExecutionContext::Blocking`: the body runs INLINE on the
/// webview's UI event-loop thread. Both shell out to `tailscale` (start runs up
/// to three of those, stop one), so toggling the companion while `tailscaled`
/// was starting or wedged froze the entire window, every tab and pane with it,
/// with no recovery but killing the app. Same fix as H6's `ssh_key_generate`.
///
/// `CompanionState` is re-acquired from the AppHandle inside the closure rather
/// than taken as a `tauri::State<'_, _>` parameter: the borrow cannot cross into
/// `spawn_blocking`. It is injected either way, so the JS call shape is
/// unchanged.
#[tauri::command]
pub async fn companion_start(
    app: tauri::AppHandle,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<CompanionState>()
            .ok_or("companion state unavailable")?;
        let (port, token, host) = start(app.clone(), &state, port)?;
        Ok(info_json(port, &token, &host))
    })
    .await
    .map_err(|e| format!("companion start task failed: {e}"))?
}

#[tauri::command]
pub async fn companion_stop(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<CompanionState>()
            .ok_or("companion state unavailable")?;
        stop(&state)
    })
    .await
    .map_err(|e| format!("companion stop task failed: {e}"))?
}

/// Audit R4, second pass: this was a sync `#[tauri::command]`, so its body ran
/// INLINE on the UI event loop, and its first act is to take the same `inner`
/// mutex `start()` holds across up to three bounded `tailscale` calls. Polling
/// status while the toggle was in flight therefore froze the window for as long
/// as tailscale took. Returns the same JSON shape either way, so the JS call is
/// unchanged; `unwrap_or_else` keeps it non-rejecting like the sync version.
#[tauri::command]
pub async fn companion_status(app: tauri::AppHandle) -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || {
        match app.try_state::<CompanionState>().and_then(|s| status(&s)) {
            Some((port, token, host)) => info_json(port, &token, &host),
            None => serde_json::json!({ "running": false }),
        }
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({ "running": false }))
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
    let mut guard = state.sessions.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
    let mut guard = state.snippets.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
    let mut guard = state.models.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = models;
    Ok(())
}

/// Phase 5 (push-when-closed): the desktop calls this when a command/agent
/// finishes in a backgrounded session (it already detects this for its own "done"
/// cue). If the server is running, NO phone is currently connected (so the tab is
/// closed and the in-page alert can't fire), and a push subscription + VAPID key
/// exist, send a Web Push so the phone is notified anyway. Best-effort + silent.
///
/// Async for the same reason as `companion_status` (audit R4, second pass), and
/// more urgently: TerminalPane fires this every time a command finishes in a
/// backgrounded session, so it is reachable WHILE the companion toggle is in
/// flight. As a sync command its first line took the `inner` mutex on the UI
/// event loop, and it then reads the OS keychain (`kr_get`, `ensure_vapid`),
/// which blocks on its own account.
#[tauri::command]
pub async fn companion_notify_finish(app: tauri::AppHandle, label: String, exit: Option<i64>) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let state = match app.try_state::<CompanionState>() {
            Some(s) => s,
            None => return,
        };
        notify_finish_blocking(&state, label, exit);
    })
    .await;
}

/// The blocking body of `companion_notify_finish`. Separate so the command
/// itself is nothing but the `spawn_blocking` hop, which is what keeps the
/// keychain reads and the `inner` lock off the UI event loop.
fn notify_finish_blocking(state: &CompanionState, label: String, exit: Option<i64>) {
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
mod source_pinned_contract_tests {
    //! Properties of this file that NO runtime assertion can observe, so they
    //! are pinned against the source instead, the same move
    //! `reserved_names_match_js_mirror` (commands.rs) makes for a cross-language
    //! duplicate, and for the same reason: the alternative is not a better test,
    //! it is no test.
    //!
    //! 1. Whether a `#[tauri::command]` runs on the UI event loop is decided by
    //!    tauri-macros at compile time from the presence of `async`. Nothing at
    //!    runtime can tell the two apart.
    //! 2. `Command::output()` has no deadline. Its absence is what makes the
    //!    bound in `output_bounded` unbypassable, and absence is not observable.
    //! 3. Whether `handle_socket` still CALLS the predicates that guard it.
    //!    Reaching that message loop needs a live WebSocket, an AppHandle and a
    //!    running Tauri app, so `relay_backpressure_tests` can drive the
    //!    predicates but nothing can drive their call sites. A predicate the
    //!    loop has stopped consulting keeps every one of its own tests green
    //!    while the boundary it is named for is gone: the exact shape of audit
    //!    TQ-1 one level up.
    //!
    //! Audit R4 exists because exactly this regression already shipped once: the
    //! 2026-08-14 H6 pass converted `ssh_key_generate` and missed every command
    //! in this file. The second R4 pass then converted the toggle pair and
    //! missed `companion_status` and `companion_notify_finish`, which is why
    //! there is now a sweep here and not just a list of names.

    /// Only the shipping half of the file. Test modules legitimately spawn their
    /// own subprocesses, and this module's own assertions contain the very
    /// needles being searched for.
    ///
    /// Line endings are normalized because this repo runs with `core.autocrlf`
    /// on: the same source is LF in the working tree here and CRLF on a fresh
    /// Windows checkout, which is what CI's cargo job builds. A `\n`-anchored
    /// needle would then stop matching, and a source-scanning test whose needle
    /// stops matching does not fail, it passes vacuously forever, which is the
    /// exact failure mode this module exists to catch.
    fn shipping() -> String {
        include_str!("companion.rs")
            .split_once("#[cfg(test)]")
            .expect("companion.rs has no test modules any more")
            .0
            .replace("\r\n", "\n")
    }

    /// One top-level fn of the shipping half, from its signature to the closing
    /// brace at column 0. Needed so a call site is pinned INSIDE the function
    /// that has to make it: a `contains` over the whole file would still pass
    /// when the only surviving mention is the definition itself.
    ///
    /// Both `find`s panic rather than return an empty slice, so this helper
    /// cannot make its callers vacuous either.
    fn shipping_fn(signature: &str) -> String {
        let src = shipping();
        let start = src
            .find(signature)
            .unwrap_or_else(|| panic!("`{signature}` is gone from companion.rs"));
        let rest = &src[start..];
        let end = rest
            .find("\n}\n")
            .unwrap_or_else(|| panic!("`{signature}` has no closing brace at column 0"));
        rest[..end].to_string()
    }

    #[test]
    fn the_commands_that_reach_the_companion_lock_are_async() {
        // Every command whose body can end up waiting on `state.inner`. `start()`
        // holds that mutex across up to three bounded `tailscale` calls (~15s
        // worst case), and a sync #[tauri::command] body runs INLINE on the UI
        // event loop, so any of these going sync freezes the whole window, every
        // tab and pane with it, for the length of a wedged tailscale call.
        let src = shipping();
        for decl in [
            "pub async fn companion_start(",
            "pub async fn companion_stop(",
            "pub async fn companion_status(",
            "pub async fn companion_notify_finish(",
        ] {
            assert!(
                src.contains(decl),
                "`{decl}` is gone. A sync #[tauri::command] runs INLINE on the UI \
                 event loop and freezes every tab for as long as the companion \
                 lock is held (R4)"
            );
        }
    }

    #[test]
    fn no_sync_command_in_this_file_touches_the_lifecycle_lock() {
        // The named list above cannot see a command added later; this can. Any
        // #[tauri::command] whose body reaches `.inner` must be async. Chunks run
        // from one attribute to the next, so a trailing helper counts toward the
        // command above it. That is what makes `notify_finish_blocking` count
        // toward `companion_notify_finish`, and it errs toward demanding async
        // rather than toward missing a case.
        //
        // The three `companion_set_*` commands stay sync deliberately: they take
        // `sessions` / `snippets` / `models`, each held for one assignment.
        //
        // Gating on `.inner` (which is what this test did when it was written)
        // checked exactly ONE of the seven commands, because only
        // `companion_notify_finish` names that field literally. `start`, `stop`
        // and `status` reach the same lock through helpers, so reverting any of
        // them to sync, which is the precise R4 regression, left this test green.
        // Invert it instead: async is REQUIRED, and the only sync commands are
        // the three named below. A new command is covered the day it is added,
        // and dropping `async` from an existing one fails here.
        const DELIBERATELY_SYNC: [&str; 3] = [
            "companion_set_sessions",
            "companion_set_snippets",
            "companion_set_models",
        ];
        let src = shipping();
        let chunks: Vec<&str> = src.split("\n#[tauri::command]\n").skip(1).collect();
        // Corpus floor. Without it, a split that stops matching (an attribute
        // reformatted onto the same line, a checkout with different line
        // endings) leaves zero chunks and this test passes having checked
        // nothing.
        assert!(
            chunks.len() >= 7,
            "only {} `#[tauri::command]` declarations found in companion.rs. The \
             split has stopped matching, so this test was about to check nothing",
            chunks.len()
        );
        let mut checked = 0usize;
        for chunk in chunks {
            let decl = chunk.lines().next().unwrap_or("").trim();
            if DELIBERATELY_SYNC.iter().any(|n| decl.contains(n)) {
                continue;
            }
            checked += 1;
            assert!(
                decl.contains("async fn"),
                "`{decl}` is a sync #[tauri::command]. Its body runs INLINE on the \
                 UI event loop, and the companion lifecycle lock is held across \
                 `tailscale` subprocesses for seconds, so this freezes every tab \
                 (R4). Make it `async fn` + `spawn_blocking`, or add it to \
                 DELIBERATELY_SYNC with the reason it cannot block."
            );
        }
        // Every exemption must still exist. A renamed or deleted `companion_set_*`
        // would otherwise silently shrink the corpus back toward the one-command
        // coverage this test was rewritten to escape.
        assert_eq!(
            checked,
            7 - DELIBERATELY_SYNC.len(),
            "expected to check {} commands, checked {checked}. Either a command \
             was added or removed, or an entry in DELIBERATELY_SYNC no longer \
             matches anything",
            7 - DELIBERATELY_SYNC.len()
        );
    }

    #[test]
    fn no_subprocess_in_this_file_waits_without_a_deadline() {
        assert!(
            !shipping().contains(".output()"),
            "a `Command::output()` came back into companion.rs. It waits forever \
             on a wedged tailscaled. Route it through `tailscale()` / \
             `output_bounded` instead (R4)"
        );
    }

    #[test]
    fn the_message_loop_still_asks_subscribe_decision() {
        // `subscribe_decision` is exercised for real in `relay_backpressure_tests`,
        // but a gate the message loop no longer consults is worth nothing: swap
        // this for `if !ch.is_empty()` and every one of those tests stays green
        // while a token holder can subscribe to `vnc-frame://<id>` and
        // `rdp-frame://<id>` and stream the user's live remote-desktop pixels,
        // which the RPC allow-list deliberately excludes.
        //
        // The whole call is pinned, not just the name: `contains("subscribe_decision(")`
        // still passes when the result is bound and then ignored in favour of an
        // inlined open gate, which a mutation run proved is a survivable edit.
        // Being brittle to a reformat is the right direction here, because a
        // needle that stops matching fails loudly instead of passing vacuously.
        assert!(
            shipping_fn("async fn handle_socket(")
                .contains("match subscribe_decision(ch, &sub_names, MAX_SUBS) {"),
            "handle_socket no longer branches on subscribe_decision's result. The \
             relay gate is a gate only for as long as the loop both asks it AND \
             acts on the answer."
        );
    }

    #[test]
    fn the_message_loop_never_mints_its_own_subscribe_decision() {
        // The structural half of the rule above, and the part a reformat cannot
        // weaken: inside `handle_socket` a `SubscribeDecision` may only be
        // matched, never constructed. Constructing one is how the gate gets
        // re-derived (and quietly widened) in the loop while
        // `subscribe_decision`'s own tests stay green.
        const V: &str = "SubscribeDecision::";
        let body = shipping_fn("async fn handle_socket(");
        let sites: Vec<usize> = body.match_indices(V).map(|(i, _)| i).collect();
        // Floor: four match arms today. Zero would mean the enum is gone from the
        // loop entirely, which this test must not report as success.
        assert!(
            sites.len() >= 4,
            "only {} SubscribeDecision sites in handle_socket; the subscribe \
             branch has been restructured and this test is checking nothing",
            sites.len()
        );
        for i in sites {
            let tail = &body[i + V.len()..];
            let after = tail
                .trim_start_matches(|c: char| c.is_alphanumeric() || c == '_')
                .trim_start();
            assert!(
                after.starts_with("=>") || after.starts_with('|'),
                "handle_socket CONSTRUCTS a SubscribeDecision instead of only \
                 matching one. Every decision must come from `subscribe_decision`, \
                 or the channel gate it owns can be re-derived inside the loop \
                 with none of its tests noticing."
            );
        }
    }

    #[test]
    fn relayed_frames_still_go_through_relay_try_send() {
        // Same shape one level down. A bare `tx.try_send(...)` here keeps the
        // memory bound (that is `out_channel`'s return type, a compile-time
        // guard) but silences the counter: refused frames stop being counted, the
        // sender task never emits a marker, and the phone renders spliced output
        // with no notice (audit R5). Pinned as the whole call for the same reason
        // as above.
        assert!(
            shipping_fn("async fn handle_socket(")
                .contains("relay_try_send(&tx, &lag, event_frame(&ch_json, ev.payload()));"),
            "the event-relay callback stopped routing frames through \
             relay_try_send / event_frame, so dropped frames are no longer \
             counted and no marker is ever emitted"
        );
    }
}

#[cfg(test)]
mod subprocess_timeout_tests {
    //! Audit R4. `companion_start`/`companion_stop` are now async + spawn_blocking,
    //! but moving the freeze off the UI thread only relocates it: an untimed
    //! `tailscale` call would still park a blocking-pool thread and leave the
    //! toggle spinning forever. `output_bounded` is the part that makes the call
    //! itself terminate, so it is what these exercise: the real function, via
    //! `use super::`, not a copy of its logic.
    use super::{output_bounded, TAILSCALE_TIMEOUT};
    use std::process::Command;
    use std::time::{Duration, Instant};

    /// A child that prints `hi` and exits immediately.
    fn quick() -> Command {
        #[cfg(target_os = "windows")]
        {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write('hi')"]);
            c
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut c = Command::new("sh");
            c.args(["-c", "printf hi"]);
            c
        }
    }

    /// A child that outlives any deadline these tests set.
    fn slow() -> Command {
        #[cfg(target_os = "windows")]
        {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"]);
            c
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut c = Command::new("sh");
            c.args(["-c", "sleep 30"]);
            c
        }
    }

    /// A child whose stdout is far past the ~64 KB OS pipe buffer.
    fn chatty() -> Command {
        #[cfg(target_os = "windows")]
        {
            let mut c = Command::new("powershell");
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write('x' * 400000)",
            ]);
            c
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut c = Command::new("sh");
            c.args(["-c", "yes xxxxxxxxx | head -c 400000"]);
            c
        }
    }

    #[test]
    fn healthy_command_returns_its_output() {
        let out = output_bounded(quick(), Duration::from_secs(30)).expect("quick child failed");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi");
    }

    #[test]
    fn wedged_command_is_killed_at_the_deadline() {
        // The failure this pins: `Command::output()` waits forever, so a
        // `tailscale serve --bg` against a wedged tailscaled never returns and
        // the companion toggle never resolves. Bound is 500ms against a 30s
        // child, so a version that waits for the child cannot pass by accident.
        let started = Instant::now();
        let err = output_bounded(slow(), Duration::from_millis(500))
            .expect_err("a 30s child must not complete inside a 500ms deadline");
        let waited = started.elapsed();
        assert!(err.contains("timed out"), "unexpected error: {err}");
        assert!(
            waited < Duration::from_secs(10),
            "returned only after {waited:?}, so the deadline is not being enforced"
        );
    }

    #[test]
    fn output_larger_than_the_pipe_buffer_does_not_deadlock() {
        // `tailscale status --json` on a real tailnet exceeds the pipe buffer.
        // Draining after the wait (rather than on reader threads) blocks the
        // child forever, which surfaces as a spurious timeout, i.e. "Tailscale
        // unavailable" for a perfectly healthy daemon. Ten seconds is generous
        // for a ~400 KB write and still fails fast if the pipes are not drained.
        let out = output_bounded(chatty(), Duration::from_secs(10))
            .expect("large output must not be mistaken for a hang");
        assert!(out.status.success());
        assert!(
            out.stdout.len() >= 400_000,
            "stdout truncated to {} bytes",
            out.stdout.len()
        );
    }

    #[test]
    fn tailscale_deadline_is_short_enough_to_be_a_ui_deadline() {
        // companion_start makes up to three of these back to back. The point of
        // the constant is that the worst case stays inside a few seconds, so a
        // later "let's be generous" bump to minutes gets review.
        assert!(TAILSCALE_TIMEOUT <= Duration::from_secs(10));
    }
}

#[cfg(test)]
mod relay_backpressure_tests {
    //! Audit R5. These drive the REAL producer path: `out_channel()` is the same
    //! constructor `handle_socket` uses and `relay_try_send` is the same function
    //! its `app.listen` relay callback calls. Nothing here reimplements the
    //! policy.
    //!
    //! Not covered here: the sender task's per-burst marker flush, which needs a
    //! live WebSocket sink, and `handle_socket` itself, which needs a running
    //! Tauri app. `dropped_marker`'s wire shape is pinned below, on both sides of
    //! the language boundary; that these functions are still the ones the message
    //! loop calls is pinned in `source_pinned_contract_tests`.
    use super::{
        dropped_marker, event_frame, out_channel, relay_try_send, subscribe_decision,
        SubscribeDecision, OUT_QUEUE,
    };
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// The channels a client has already been granted.
    fn active(names: &[&str]) -> HashSet<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    /// A full subscription set of DISTINCT allowed channels.
    fn full(max: usize) -> HashSet<String> {
        (0..max).map(|i| format!("pty://s{i}")).collect()
    }

    #[test]
    fn the_outbound_queue_is_finite_and_drops_the_overflow() {
        let (tx, _rx) = out_channel();
        let dropped = AtomicUsize::new(0);
        // Nothing is draining `_rx`, so this is the locked-phone case exactly.
        for i in 0..OUT_QUEUE {
            assert!(relay_try_send(&tx, &dropped, format!("f{i}")), "frame {i} refused early");
        }
        assert_eq!(dropped.load(Ordering::Relaxed), 0, "dropped below capacity");
        for i in 0..10 {
            assert!(!relay_try_send(&tx, &dropped, format!("over{i}")), "queue accepted past its cap");
        }
        assert_eq!(dropped.load(Ordering::Relaxed), 10);
    }

    #[test]
    fn the_oldest_frames_survive_and_the_new_ones_are_the_ones_lost() {
        // Which end gets dropped is the whole user-visible difference: keeping
        // the head means the phone shows a contiguous prefix and then a gap,
        // rather than a stream spliced out of the middle.
        let (tx, mut rx) = out_channel();
        let dropped = AtomicUsize::new(0);
        for i in 0..OUT_QUEUE {
            relay_try_send(&tx, &dropped, format!("f{i}"));
        }
        relay_try_send(&tx, &dropped, "lost".to_string());
        assert_eq!(rx.try_recv().unwrap(), "f0");
        assert_eq!(rx.try_recv().unwrap(), "f1");
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn draining_the_queue_makes_room_again() {
        // A phone that comes back into range must resume, not stay wedged.
        let (tx, mut rx) = out_channel();
        let dropped = AtomicUsize::new(0);
        for i in 0..OUT_QUEUE {
            relay_try_send(&tx, &dropped, format!("f{i}"));
        }
        assert!(!relay_try_send(&tx, &dropped, "over".to_string()));
        rx.try_recv().unwrap();
        assert!(relay_try_send(&tx, &dropped, "after-drain".to_string()));
        assert_eq!(dropped.load(Ordering::Relaxed), 1, "the drain must not clear the counter");
    }

    #[test]
    fn a_closed_socket_is_not_counted_as_backpressure() {
        // Otherwise every teardown would inflate the marker and tell the user
        // they lost output they never lost.
        let (tx, rx) = out_channel();
        drop(rx);
        let dropped = AtomicUsize::new(0);
        assert!(!relay_try_send(&tx, &dropped, "frame".to_string()));
        assert_eq!(dropped.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn the_relay_stays_gated_to_pty_channels() {
        use super::relay_channel_allowed;
        assert!(relay_channel_allowed("pty://abc123"));
        assert!(relay_channel_allowed("pty-exit://abc123"));
        // The two that must never be reachable with a leaked token: live
        // remote-desktop pixels. `app.emit` fans out to every listener, so this
        // predicate is the only thing standing between a companion client and
        // the user's RDP/VNC screen contents.
        assert!(!relay_channel_allowed("vnc-frame://s1"));
        assert!(!relay_channel_allowed("rdp-frame://s1"));
        // Prefix matching, not substring: a channel that merely CONTAINS the
        // allowed scheme is a bypass ("evil://pty://x" would relay evil://).
        assert!(!relay_channel_allowed("evil://pty://x"));
        assert!(!relay_channel_allowed("companion://set-active-model"));
        assert!(!relay_channel_allowed("pty"));
        assert!(!relay_channel_allowed(""));
    }

    #[test]
    fn the_marker_is_valid_json_carrying_the_count() {
        // The companion page JSON.parses every frame and ignores types it does
        // not know, so a malformed marker would be dropped silently by `catch`.
        let v: serde_json::Value = serde_json::from_str(&dropped_marker(7)).expect("marker is not JSON");
        assert_eq!(v["type"], "dropped");
        assert_eq!(v["frames"], 7);
    }

    #[test]
    fn the_companion_page_handles_the_dropped_marker() {
        // A cross-language duplicate, pinned the way `reserved_names_match_js_mirror`
        // (commands.rs) pins RESERVED_NAMES. Both needles are DERIVED from
        // `dropped_marker` rather than typed in, so renaming the type string or
        // the count field on the Rust side fails here instead of shipping a
        // marker the page silently discards. Emitting the marker is only half of
        // R5; the user-visible half is the page saying so.
        const APP_JS: &str = include_str!("../companion-web/app.js");
        let marker: serde_json::Value =
            serde_json::from_str(&dropped_marker(3)).expect("marker is not JSON");
        let obj = marker.as_object().expect("marker is not a JSON object");
        let ty = obj["type"].as_str().expect("marker `type` is not a string");
        let count_field = obj
            .keys()
            .find(|k| *k != "type")
            .expect("marker carries no count field");
        assert!(
            APP_JS.contains(&format!(r#"m.type === "{ty}""#)),
            "companion-web/app.js has no `m.type === \"{ty}\"` branch, so the \
             backpressure marker is parsed and thrown away and the phone shows a \
             contiguous-looking terminal that is missing output"
        );
        assert!(
            APP_JS.contains(&format!("m.{count_field}")),
            "app.js handles the marker but never reads `m.{count_field}`, so the \
             gap it draws cannot say how much was lost"
        );
    }

    #[test]
    fn an_event_frame_carries_the_channel_and_the_raw_payload() {
        // The page does `subs[m.channel](m.payload)` and hands the payload
        // straight to xterm, so `payload` must arrive as the JSON Tauri emitted,
        // not as a re-escaped string of it, and the channel must survive a quote.
        let ch = serde_json::to_string("pty://a\"b").expect("channel encode");
        let v: serde_json::Value = serde_json::from_str(&event_frame(&ch, r#"{"n":1}"#))
            .expect("event frame is not JSON");
        assert_eq!(v["type"], "event");
        assert_eq!(v["channel"], "pty://a\"b");
        assert_eq!(v["payload"]["n"], 1, "payload was not embedded raw");
    }

    #[test]
    fn only_pty_channels_are_accepted_for_subscription() {
        assert_eq!(
            subscribe_decision("pty://abc", &active(&[]), 64),
            SubscribeDecision::Accept
        );
        assert_eq!(
            subscribe_decision("pty-exit://abc", &active(&[]), 64),
            SubscribeDecision::Accept
        );
        assert_eq!(
            subscribe_decision("vnc-frame://s1", &active(&[]), 64),
            SubscribeDecision::Denied
        );
        assert_eq!(
            subscribe_decision("rdp-frame://s1", &active(&[]), 64),
            SubscribeDecision::Denied
        );
    }

    #[test]
    fn a_denied_channel_is_denied_before_the_cap_can_disguise_it() {
        // Order matters, and this is why the three checks are one function. If
        // the cap were consulted first, a full subscription set would turn every
        // `vnc-frame://` attempt into a "limit reached" reply, which reads as a
        // capacity problem in a log rather than as an attempt to reach the
        // user's remote desktop.
        assert_eq!(
            subscribe_decision("vnc-frame://s1", &full(64), 64),
            SubscribeDecision::Denied
        );
    }

    #[test]
    fn re_subscribing_is_a_duplicate_rather_than_a_second_listener() {
        // `app.listen` twice on one channel registers TWO listeners and doubles
        // every relayed frame for the life of the connection, so the dedup is a
        // correctness guard, not politeness. It also has to outrank the cap: a
        // client re-sending a channel it already holds must not be told the
        // limit is reached once its set is full.
        assert_eq!(
            subscribe_decision("pty://abc", &active(&["pty://abc"]), 64),
            SubscribeDecision::Duplicate
        );
        let mut at_cap = full(63);
        at_cap.insert("pty://abc".to_string());
        assert_eq!(at_cap.len(), 64);
        assert_eq!(
            subscribe_decision("pty://abc", &at_cap, 64),
            SubscribeDecision::Duplicate
        );
    }

    #[test]
    fn the_last_slot_is_usable_and_the_one_after_it_is_not() {
        // Off-by-one on the cap either wastes a slot or lets the listener set
        // grow past it for the life of the connection.
        assert_eq!(
            subscribe_decision("pty://new", &full(63), 64),
            SubscribeDecision::Accept
        );
        assert_eq!(
            subscribe_decision("pty://new", &full(64), 64),
            SubscribeDecision::LimitReached
        );
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
