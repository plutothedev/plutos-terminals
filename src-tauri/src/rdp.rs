// (C)
// RDP remote-desktop client (IronRDP). Like VNC/SSH, the session lives on one
// worker thread; the registry holds an mpsc sender for input. Streams the
// framebuffer to the webview as rdp-frame://{id} events (RGBA dirty-rects,
// base64) + rdp-exit. Connect sequence: TCP → connect_begin → native-tls
// handshake (+ extract server SPKI) → connect_finalize (CredSSP/NLA) →
// ActiveStage loop. v1: input is applied between server PDUs (read is blocking).

use crate::session::{b64, new_id};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use ironrdp_connector::{ClientConnector, Config, DesktopSize, ServerName};
use ironrdp_session::image::DecodedImage;
use ironrdp_session::ActiveStage;
use ironrdp_blocking::{connect_begin, connect_finalize, mark_as_upgraded, Framed};

/// Input → the RDP worker thread, in `ironrdp_input` terms.
enum RdpCtrl {
    Op(ironrdp_input::Operation),
}

pub struct RdpHandle {
    ctrl: mpsc::Sender<RdpCtrl>,
}

#[derive(Default)]
pub struct RdpRegistry {
    sessions: Mutex<HashMap<String, RdpHandle>>,
}

#[derive(Serialize, Clone)]
struct RdpFrame {
    x: u16,
    y: u16,
    w: u16,
    h: u16,
    data: String, // RGBA, base64
}

/// Default IronRDP client config for a username/password connection.
fn make_config(
    username: String,
    password: String,
    domain: Option<String>,
    w: u16,
    h: u16,
) -> Config {
    use ironrdp_connector::Credentials as C;
    Config {
        desktop_size: DesktopSize {
            width: w,
            height: h,
        },
        // Single monitor at the size asked for; each None/false below keeps
        // what the 0.14 connector sent before these fields existed (bitmap
        // is the exception, below).
        monitor_layout: None,
        desktop_scale_factor: 0,
        desktop_physical_size: None,
        desktop_orientation: None,
        device_scale_factor: None,
        monitor_extended_layout: None,
        relative_mouse_input: false,
        enable_tls: true,
        enable_credssp: true,
        enable_standard_rdp_security: false,
        credentials: C::UsernamePassword { username, password },
        domain,
        client_build: 0,
        client_name: "plutos-terminals".to_owned(),
        keyboard_type: ironrdp_pdu::gcc::KeyboardType::IBM_ENHANCED,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0,
        connection_type: ironrdp_pdu::gcc::ConnectionType::Lan,
        ime_file_name: String::new(),
        // The 0.14 connector read None as "the default codec list" (RemoteFX,
        // surface commands, frame acknowledge), lossless, 32 bpp; the 0.12
        // one reads None as no codecs at all, which sends a Windows server
        // back to legacy bitmaps. Spelled out to keep what was sent.
        bitmap: Some(ironrdp_connector::BitmapConfig {
            lossy_compression: false,
            color_depth: 32,
            codecs: ironrdp_pdu::rdp::capability_sets::client_codecs_capabilities(&[])
                .expect("the default codec list"),
        }),
        dig_product_id: String::new(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        remote_application_mode: false,
        rail_support_level: ironrdp_pdu::rdp::capability_sets::RailSupportLevel::empty(),
        platform: ironrdp_pdu::rdp::capability_sets::MajorPlatformType::WINDOWS,
        hardware_id: None,
        request_data: None,
        autologon: true,
        enable_audio_playback: false,
        enable_audio_capture: false,
        performance_flags: ironrdp_pdu::rdp::client_info::PerformanceFlags::empty(),
        license_cache: None,
        timezone_info: Default::default(),
        compression_type: None,
        enable_server_pointer: false,
        pointer_software_rendering: true,
        multitransport_flags: None,
        // Advertising EGFX without a registered processor leaves the desktop
        // blank (ironrdp-connector's own warning); this client has none.
        support_dyn_vc_gfx_protocol: false,
    }
}

/// The server's public key as CredSSP binds to it: the certificate's
/// subjectPublicKey, the bytes inside the SPKI's BIT STRING (for RSA, the DER
/// RSAPublicKey), not the whole SubjectPublicKeyInfo ([MS-CSSP] 3.1.5,
/// pubKeyAuth). Until 2026-10-29 this returned the whole SPKI, so the
/// client's pubKeyAuth never matched a server's and every NLA sign-in failed.
/// Also returned: the whole SPKI DER, which the trust-on-first-use pin hashes
/// (unchanged, so pins recorded before stay valid).
fn server_public_key(cert_der: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    use x509_cert::der::{Decode, Encode};
    let cert =
        x509_cert::Certificate::from_der(cert_der).map_err(|e| format!("parse cert: {e}"))?;
    let spki = &cert.tbs_certificate.subject_public_key_info;
    let key = spki
        .subject_public_key
        .as_bytes()
        .ok_or("server public key has unused bits")?
        .to_vec();
    let spki_der = spki.to_der().map_err(|e| format!("encode SPKI: {e}"))?;
    Ok((key, spki_der))
}

/// Trust-on-first-use pinning for the RDP server's TLS identity — the same
/// model the SSH transport uses for host keys (pty.rs::verify_host_key).
/// RDP servers are almost always self-signed, so chain validation is off
/// (`danger_accept_invalid_certs`); this pin is the actual trust layer. The
/// SHA-256 fingerprint of the server's SPKI is recorded per host:port in
/// `rdp-known-hosts.txt` (app data dir) on first connect; a later mismatch
/// refuses the connection (possible man-in-the-middle).
fn verify_rdp_pin(app: &AppHandle, host: &str, port: u16, spki: &[u8]) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    // Serialize the read-check-append so two concurrent first-connects to the
    // same never-seen host (double-clicked Connect, two tabs auto-reconnecting)
    // can't both pass the "not found" branch and race to pin — under an active
    // MITM the attacker's cert could otherwise win the append and get durably
    // trusted. One process-wide lock is enough: there's a single app instance.
    static PIN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    // Recover from poisoning rather than failing closed forever: the lock guards
    // only file-write serialization (no invariant-bearing in-memory state), so a
    // prior panic in the short critical section must not permanently disable RDP
    // pinning for the rest of the app's lifetime.
    let _pin_guard = PIN_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let fp: String = Sha256::digest(spki)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let entry_key = format!("{}:{}", host.to_ascii_lowercase(), port);
    let path = crate::commands::get_data_dir(app).join("rdp-known-hosts.txt");

    if let Ok(content) = std::fs::read_to_string(&path) {
        for line in content.lines() {
            let mut parts = line.split_whitespace();
            let (Some(k), Some(stored)) = (parts.next(), parts.next()) else {
                continue;
            };
            if k != entry_key {
                continue;
            }
            if stored.eq_ignore_ascii_case(&fp) {
                return Ok(());
            }
            return Err(format!(
                "RDP host certificate changed for {entry_key}: expected {stored}, got {fp} — \
                 remove the pinned entry from {} to trust the new cert.",
                path.display()
            ));
        }
    }

    // First sight: pin the fingerprint so a later change is caught.
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("record RDP host pin: {e}"))?;
    writeln!(f, "{entry_key} {fp}").map_err(|e| format!("record RDP host pin: {e}"))?;
    Ok(())
}

/// CredSSP NetworkClient stub. Only Kerberos uses the network; for NTLM
/// (username/password) it's never called, so we report no protocol support.
struct NoNetworkClient;
impl sspi::network_client::NetworkClient for NoNetworkClient {
    fn send(&self, _request: &sspi::generator::NetworkRequest) -> sspi::Result<Vec<u8>> {
        Err(sspi::Error::new(
            sspi::ErrorKind::UnsupportedFunction,
            "network client not available (NTLM only)",
        ))
    }
}

#[tauri::command]
pub async fn rdp_connect(
    app: AppHandle,
    state: State<'_, RdpRegistry>,
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
) -> Result<(String, u16, u16), String> {
    let port = if port == 0 { 3389 } else { port };
    // Connect + TLS + NLA are fully blocking and now run OFF the tokio runtime
    // (review). The per-phase deadlines added below turn "parked forever" into
    // "parked up to ~40s", but this is an async Tauri command, so even a bounded
    // park holds one of num_cpus workers: several reconnects after a VPN drop
    // queue every other async command (pty_kill, sftp_*, secret_get) behind
    // them. Mirrors what ssh_spawn and forward.rs already do.
    // `state` deliberately does NOT cross the boundary — it is a borrowed
    // State<'_> (not 'static), and it is only needed afterwards for the fast
    // registry insert, which stays here on the async side.
    let app_c = app.clone();
    let (tls_framed, connection_result) = tauri::async_runtime::spawn_blocking(move || {
        rdp_connect_blocking(app_c, host, port, username, password, domain)
    })
    .await
    .map_err(|e| format!("rdp connect task failed: {e}"))??;

    let id = new_id("rdp");
    let (ctrl_tx, ctrl_rx) = mpsc::channel::<RdpCtrl>();
    let (w, h) = (
        connection_result.desktop_size.width,
        connection_result.desktop_size.height,
    );
    state
        .sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(id.clone(), RdpHandle { ctrl: ctrl_tx });

    let id_t = id.clone();
    let app_t = app.clone();
    std::thread::spawn(move || {
        rdp_worker(tls_framed, connection_result, ctrl_rx, app_t, id_t, w, h)
    });

    Ok((id, w, h))
}

/// Blocking half of `rdp_connect`: TCP connect, TLS upgrade, TOFU pin check and
/// the CredSSP/NLA negotiation. Split out so all of it runs on the blocking pool
/// instead of parking a tokio worker (review). Returns the negotiated stream and
/// connection result for the caller to register and hand to the worker thread.
#[allow(clippy::type_complexity)]
fn rdp_connect_blocking(
    app: AppHandle,
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
) -> Result<
    (
        Framed<native_tls::TlsStream<TcpStream>>,
        ironrdp_connector::ConnectionResult,
    ),
    String,
> {
    connect_session(host, port, username, password, domain, |host, port, spki| {
        verify_rdp_pin(&app, host, port, spki)
    })
}

/// The connect sequence itself, with the trust-on-first-use check handed in
/// (`pin`, verify_rdp_pin in the app) so a test can drive this exact code
/// against a local server without an AppHandle.
#[allow(clippy::type_complexity)]
fn connect_session(
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    pin: impl FnOnce(&str, u16, &[u8]) -> Result<(), String>,
) -> Result<
    (
        Framed<native_tls::TlsStream<TcpStream>>,
        ironrdp_connector::ConnectionResult,
    ),
    String,
> {
    let (req_w, req_h) = (1280u16, 800u16);

    // Bound the TCP connect (a dead host otherwise parks this worker ~21s on Windows);
    // try each resolved address with a 10s per-address timeout, first success wins.
    let tcp = {
        let addrs = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| format!("resolve {host}:{port}: {e}"))?;
        let mut last = String::from("no address resolved");
        let mut sock = None;
        for addr in addrs {
            match TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(10)) {
                Ok(s) => { sock = Some(s); break; }
                Err(e) => last = e.to_string(),
            }
        }
        sock.ok_or_else(|| format!("connect {host}:{port}: {last}"))?
    };
    let client_addr: SocketAddr = tcp.local_addr().map_err(|e| e.to_string())?;

    // Phase 1 of the socket deadline: bound every pre-session read/write BEFORE
    // the first byte moves. The TCP connect above is bounded, but connect_begin,
    // the TLS handshake and connect_finalize (CredSSP/NLA) all read blocking with
    // no deadline, so a host that completed the TCP handshake and then went
    // silent parked this tokio worker permanently. rdp_connect is an async Tauri
    // command, so a few attempts against a tarpit host stalled every async IPC
    // command in the app while the UI still painted. Mirrors the VNC transport's
    // pre-handshake bound (vncclient.rs:134-137); 30s rather than VNC's 15s
    // because CredSSP/NLA takes more round trips than an RFB handshake and can
    // be slow over a bad link. The deadline applies per read/write call, so a
    // legitimately slow negotiation still completes; only a silent peer trips it.
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .map_err(|e| format!("set rdp handshake read timeout: {e}"))?;
    tcp.set_write_timeout(Some(std::time::Duration::from_secs(30)))
        .map_err(|e| format!("set rdp handshake write timeout: {e}"))?;

    let config = make_config(username, password, domain, req_w, req_h);
    let mut connector = ClientConnector::new(config, client_addr);

    let mut framed = Framed::new(tcp);
    let should_upgrade =
        connect_begin(&mut framed, &mut connector).map_err(|e| format!("connect_begin: {e}"))?;
    let (initial_stream, _leftover) = framed.into_inner();

    // TLS upgrade. RDP servers are usually self-signed, so chain validation
    // stays off — the trust layer is the TOFU pin check below (verify_rdp_pin),
    // mirroring the SSH transport's known-hosts model.
    let tls_connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| format!("tls builder: {e}"))?;
    let tls = tls_connector
        .connect(&host, initial_stream)
        .map_err(|e| format!("tls handshake: {e}"))?;
    let cert_der = tls
        .peer_certificate()
        .map_err(|e| e.to_string())?
        .ok_or("server presented no TLS certificate")?
        .to_der()
        .map_err(|e| e.to_string())?;
    let (pubkey, spki_der) = server_public_key(&cert_der)?;

    // Trust-on-first-use: refuse if this host's pinned cert fingerprint changed.
    pin(&host, port, &spki_der)?;

    let upgraded = mark_as_upgraded(should_upgrade, &mut connector);
    let mut tls_framed = Framed::new(tls);
    let mut net = NoNetworkClient;
    let connection_result = connect_finalize(
        upgraded,
        connector,
        &mut tls_framed,
        &mut net,
        ServerName::new(&host),
        pubkey,
        None,
    )
    .map_err(|e| format!("connect_finalize (NLA/TLS): {e}"))?
    // A Server Redirection PDU (load-balanced farms) asks for a new connection
    // elsewhere; this client never followed one, and now says so by name.
    .into_connected()
    .map_err(|e| format!("connect_finalize: {e}"))?;

    // Phase 2 of the socket deadline: tighten the generous 30s handshake read
    // bound set above down to a short idle tick now that negotiation is done.
    // The worker loop needs read_pdu to return periodically so it can observe a
    // disconnect (the ctrl sender dropped by rdp_disconnect) instead of parking
    // forever in read_pdu on an idle remote, which leaked the thread + socket +
    // TLS session until the server happened to send a PDU. The tighten happens
    // only AFTER connect_finalize so the (potentially slow) NLA/TLS handshake
    // reads aren't cut short by a 500ms tick; the handshake phase is bounded by
    // its own longer deadline rather than by no deadline at all. Partial frames
    // are buffered inside Framed, so a mid-PDU timeout loses nothing. The 30s
    // write deadline is deliberately left in place for the steady-state session:
    // it keeps a wedged peer with a full TCP window from parking the worker
    // thread inside write_all, and is far longer than any real input frame needs.
    tls_framed
        .get_inner_mut()
        .0
        .get_ref()
        .set_read_timeout(Some(std::time::Duration::from_millis(500)))
        .map_err(|e| format!("set rdp read timeout: {e}"))?;

    Ok((tls_framed, connection_result))
}

/// The session's ActiveStage, built from what the connection negotiated
/// (ironrdp-session 0.13 replaced ActiveStage::new with this builder).
fn active_stage(cr: ironrdp_connector::ConnectionResult) -> ActiveStage {
    let mut active = ironrdp_session::ActiveStageBuilder {
        static_channels: cr.static_channels,
        user_channel_id: cr.user_channel_id,
        io_channel_id: cr.io_channel_id,
        message_channel_id: cr.message_channel_id,
        share_id: cr.share_id,
        compression_type: cr.compression_type,
        enable_server_pointer: cr.enable_server_pointer,
        pointer_software_rendering: cr.pointer_software_rendering,
    }
    .build();
    active.set_window_support_level(cr.window_support_level);
    active
}

fn emit_rect(
    app: &AppHandle,
    id: &str,
    image: &DecodedImage,
    rect: &ironrdp_pdu::geometry::InclusiveRectangle,
) {
    let img_w = image.width() as usize;
    let img_h = image.height() as usize;
    // Guard a malformed server rect: right<left / bottom<top would underflow the u16
    // subtraction below (panic in debug; a ~65535 wrap -> multi-GB Vec::with_capacity
    // OOM-abort in release), and a rect past the framebuffer would read out of bounds.
    // Drop the degenerate case and clamp the span to the decoded image.
    if rect.right < rect.left || rect.bottom < rect.top {
        return;
    }
    let left = (rect.left as usize).min(img_w);
    let top = (rect.top as usize).min(img_h);
    let rw = ((rect.right - rect.left) as usize + 1).min(img_w - left);
    let rh = ((rect.bottom - rect.top) as usize + 1).min(img_h - top);
    let data = image.data();
    let stride = img_w * 4;
    let mut out = Vec::with_capacity(rw * rh * 4);
    for row in 0..rh {
        let start = (top + row) * stride + left * 4;
        let end = start + rw * 4;
        if end <= data.len() {
            out.extend_from_slice(&data[start..end]);
        }
    }
    let _ = app.emit(
        &format!("rdp-frame://{}", id),
        RdpFrame {
            // Emit the CLAMPED origin so x/y stay consistent with w/h and the
            // extracted pixels (raw rect.left/top would mis-position a tile whose
            // origin was clamped to the framebuffer). Equal to rect.left/top in
            // the normal, non-degenerate case.
            x: left as u16,
            y: top as u16,
            w: rw as u16,
            h: rh as u16,
            data: b64(&out),
        },
    );
}

/// Apply any queued input ops to the active session, writing fastpath input
/// frames back to the server. Returns true if the control channel's sender was
/// dropped (rdp_disconnect / app exit) → the worker should tear down.
fn drain_rdp_ctrl<S: Read + Write>(
    ctrl_rx: &mpsc::Receiver<RdpCtrl>,
    active: &mut ActiveStage,
    image: &mut DecodedImage,
    input_db: &mut ironrdp_input::Database,
    framed: &mut Framed<S>,
) -> bool {
    use ironrdp_session::ActiveStageOutput;
    let mut ops = Vec::new();
    loop {
        match ctrl_rx.try_recv() {
            Ok(RdpCtrl::Op(op)) => ops.push(op),
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => return true,
        }
    }
    if !ops.is_empty() {
        let events = input_db.apply(ops);
        if let Ok(out) = active.process_fastpath_input(image, &events) {
            let frames = out.into_iter().filter_map(|o| match o {
                ActiveStageOutput::ResponseFrame(frame) => Some(frame),
                _ => None,
            });
            if write_response_frames(framed, frames) {
                return true;
            }
        }
    }
    false
}

/// Write fastpath response frames, reporting true if the peer write FAILED so
/// the caller tears the session down.
///
/// A write error here must never be discarded (review). The steady-state session
/// keeps a 30s write deadline, and `write_all` only retries on `Interrupted` — so
/// a `TimedOut`/`WouldBlock` from SO_SNDTIMEO returns `Err` after a PARTIAL
/// write. Swallowing that left half a PDU on the wire and kept feeding frames
/// into a desynchronized stream, which the peer then reads as garbage. The
/// sibling write site in `rdp_worker` already terminates on error; this matches.
///
/// Split out of `drain_rdp_ctrl` so the property is unit-testable: that function
/// needs an `ActiveStage`, which requires a real post-handshake `ConnectionResult`
/// and so cannot be constructed in a test. Takes an iterator (not a slice) to
/// keep this allocation-free on the input hot path.
fn write_response_frames<S: Read + Write, I: IntoIterator<Item = Vec<u8>>>(
    framed: &mut Framed<S>,
    frames: I,
) -> bool {
    for frame in frames {
        if framed.write_all(&frame).is_err() {
            return true;
        }
    }
    false
}

fn rdp_worker<S: Read + Write>(
    mut framed: Framed<S>,
    connection_result: ironrdp_connector::ConnectionResult,
    ctrl_rx: mpsc::Receiver<RdpCtrl>,
    app: AppHandle,
    id: String,
    w: u16,
    h: u16,
) {
    use ironrdp_session::ActiveStageOutput;
    let mut image = DecodedImage::new(
        ironrdp_graphics::image_processing::PixelFormat::RgbA32,
        w,
        h,
    );
    // What the server lets the client ask for when a bitmap had to be dropped.
    let (refresh_rect, suppress_output) = (
        connection_result.refresh_rect_support,
        connection_result.suppress_output_support,
    );
    let mut active = active_stage(connection_result);
    let mut input_db = ironrdp_input::Database::new();

    loop {
        // Read one PDU. The socket has a read timeout (set in rdp_connect), so
        // an idle remote surfaces as WouldBlock/TimedOut instead of blocking
        // forever — letting us notice a disconnect and flush queued input.
        let (action, payload) = match framed.read_pdu() {
            Ok(v) => v,
            Err(ref e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                // Idle tick: no PDU within the timeout. Partial frames are
                // buffered inside Framed (lossless); service queued input and
                // notice shutdown, then wait again.
                if drain_rdp_ctrl(
                    &ctrl_rx,
                    &mut active,
                    &mut image,
                    &mut input_db,
                    &mut framed,
                ) {
                    break;
                }
                continue;
            }
            Err(_) => break,
        };
        // The read time feeds the server's bandwidth measurement (Framed
        // keeps it per frame).
        let outputs = match active.process(&mut image, action, &payload, framed.last_read_at()) {
            Ok(o) => o,
            Err(_) => break,
        };
        let mut terminate = false;
        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(frame) => {
                    if framed.write_all(&frame).is_err() {
                        terminate = true;
                    }
                }
                ActiveStageOutput::GraphicsUpdate(rect) => emit_rect(&app, &id, &image, &rect),
                ActiveStageOutput::Terminate(_) => terminate = true,
                _ => {}
            }
        }
        if terminate {
            break;
        }
        // ironrdp-session 0.13 drops a truncated or out-of-bounds bitmap
        // instead of ending the session (0.8 ended it), and leaves the
        // client to ask for a redraw; without one the screen stays stale.
        // (The crate asserts a nonzero size in debug builds; a server that
        // reported 0x0 gets no redraw rather than a panic.)
        if active.take_bitmap_recovery_request() && w > 0 && h > 0 {
            match active.request_full_redraw(w, h, refresh_rect, suppress_output) {
                Ok(frames) => {
                    if write_response_frames(&mut framed, frames) {
                        break;
                    }
                }
                Err(e) => log::warn!("rdp: full redraw request failed: {e}"),
            }
        }

        // Apply any queued input between PDUs; tear down if the ctrl sender dropped.
        if drain_rdp_ctrl(
            &ctrl_rx,
            &mut active,
            &mut image,
            &mut input_db,
            &mut framed,
        ) {
            break;
        }
    }
    // Server-initiated disconnect: drop our own registry entry (the input mpsc
    // sender) before signalling exit, so a closed session doesn't linger in the map
    // until rdp_disconnect (mirrors the pty reader's cleanup at pty.rs:569).
    let _ = app.state::<RdpRegistry>().sessions.lock().map(|mut s| s.remove(&id));
    let _ = app.emit(&format!("rdp-exit://{}", id), ());
}

#[tauri::command]
pub fn rdp_pointer(
    state: State<'_, RdpRegistry>,
    id: String,
    x: u16,
    y: u16,
    button: Option<u8>,
    down: bool,
) -> Result<(), String> {
    use ironrdp_input::{MouseButton, MousePosition, Operation};
    let sessions = state
        .sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(h) = sessions.get(&id) {
        if let Some(b) = button {
            let mb = match b {
                0 => MouseButton::Left,
                1 => MouseButton::Middle,
                2 => MouseButton::Right,
                _ => MouseButton::Left,
            };
            let op = if down {
                Operation::MouseButtonPressed(mb)
            } else {
                Operation::MouseButtonReleased(mb)
            };
            let _ = h.ctrl.send(RdpCtrl::Op(op));
        } else {
            let _ = h
                .ctrl
                .send(RdpCtrl::Op(Operation::MouseMove(MousePosition { x, y })));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn rdp_key(
    state: State<'_, RdpRegistry>,
    id: String,
    scancode: u16,
    down: bool,
) -> Result<(), String> {
    use ironrdp_input::{Operation, Scancode};
    let sessions = state
        .sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(h) = sessions.get(&id) {
        let sc = Scancode::from(scancode);
        let op = if down {
            Operation::KeyPressed(sc)
        } else {
            Operation::KeyReleased(sc)
        };
        let _ = h.ctrl.send(RdpCtrl::Op(op));
    }
    Ok(())
}

#[tauri::command]
pub fn rdp_disconnect(state: State<'_, RdpRegistry>, id: String) -> Result<(), String> {
    state
        .sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&id);
    Ok(())
}

#[cfg(test)]
mod write_frame_teardown_tests {
    // Locks in the regression this closes: a failed peer write must report
    // teardown, never be silently swallowed. drain_rdp_ctrl itself is not
    // constructible in a test (ActiveStage needs a real post-handshake
    // ConnectionResult), so the extracted write helper carries the property.
    use super::write_response_frames;
    use ironrdp_blocking::Framed;
    use std::io::{self, Read, Write};

    /// Accepts `ok_writes` successful writes, then fails the way SO_SNDTIMEO
    /// does: an error AFTER some bytes have already gone out.
    struct FlakyPeer {
        ok_writes: usize,
        written: usize,
    }
    impl Read for FlakyPeer {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            Ok(0)
        }
    }
    impl Write for FlakyPeer {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if self.written >= self.ok_writes {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "send timed out"));
            }
            self.written += 1;
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn framed(ok_writes: usize) -> Framed<FlakyPeer> {
        Framed::new(FlakyPeer { ok_writes, written: 0 })
    }

    #[test]
    fn a_healthy_peer_reports_no_teardown() {
        let mut f = framed(usize::MAX);
        assert!(!write_response_frames(&mut f, vec![vec![1u8, 2, 3], vec![4, 5]]));
    }

    #[test]
    fn a_write_failure_reports_teardown() {
        let mut f = framed(0); // fails on the very first frame
        assert!(write_response_frames(&mut f, vec![vec![1u8, 2, 3]]));
    }

    #[test]
    fn a_mid_batch_failure_stops_writing_into_a_desynced_stream() {
        // One frame lands, the next times out mid-stream. The old code swallowed
        // this and kept pushing frames onto a half-written PDU.
        let mut f = framed(1);
        assert!(write_response_frames(
            &mut f,
            vec![vec![1u8; 8], vec![2u8; 8], vec![3u8; 8]]
        ));
    }

    #[test]
    fn no_frames_is_not_a_teardown() {
        let mut f = framed(0);
        assert!(!write_response_frames(&mut f, Vec::<Vec<u8>>::new()));
    }
}

#[cfg(test)]
mod config_tests {
    // ironrdp-connector 0.12 reads `bitmap: None` as "no codecs", which sends
    // a Windows server back to legacy bitmaps; the app advertises the default
    // list (RemoteFX among it) as the 0.14 connector did.
    #[test]
    fn advertises_the_default_codecs_lossless_at_32_bpp() {
        let config = super::make_config("u".into(), "p".into(), None, 1280, 800);
        let bitmap = config.bitmap.expect("codecs advertised");
        assert!(!bitmap.lossy_compression);
        assert_eq!(bitmap.color_depth, 32);
        assert_eq!(
            bitmap.codecs,
            ironrdp_pdu::rdp::capability_sets::client_codecs_capabilities(&[]).unwrap()
        );
        assert!(!bitmap.codecs.0.is_empty());
        assert!(config.enable_credssp && !config.enable_standard_rdp_security);
        assert!(!config.support_dyn_vc_gfx_protocol && !config.remote_application_mode);
    }
}

#[cfg(test)]
mod pin_wiring_tests {
    // The app's connect path hands the real pin check to connect_session;
    // only the live tests pass a stand-in.
    #[test]
    fn the_app_connects_through_verify_rdp_pin() {
        let src = include_str!("rdp.rs").replace("\r\n", "\n");
        let from = &src[src.find("fn rdp_connect_blocking(").unwrap()..];
        let body = &from[..from.find("\n}\n").unwrap()];
        assert!(body.contains("verify_rdp_pin(&app, host, port, spki)"));
        assert_eq!(body.matches("connect_session(").count(), 1);
        let session = &src[src.find("fn connect_session(").unwrap()..];
        let session = &session[..session.find("\n}\n").unwrap()];
        let pin = session.find("pin(&host, port, &spki_der)?;").expect("the pin");
        assert!(pin < session.find("connect_finalize(").unwrap(), "pinned before credentials go out");
    }

    // A dropped bitmap is followed by a redraw request, with what the server
    // negotiated; without it the screen stays stale.
    #[test]
    fn the_worker_asks_for_a_redraw_after_a_dropped_bitmap() {
        let src = include_str!("rdp.rs").replace("\r\n", "\n");
        let worker = &src[src.find("fn rdp_worker<").unwrap()..];
        let worker = &worker[..worker.find("\n}\n").unwrap()];
        assert!(worker.contains("connection_result.refresh_rect_support,"));
        assert!(worker.contains("connection_result.suppress_output_support,"));
        let take = worker.find("if active.take_bitmap_recovery_request() && w > 0 && h > 0 {").expect("the check");
        assert!(worker[take..].contains("active.request_full_redraw(w, h, refresh_rect, suppress_output)"));
        assert!(take > worker.find("active.process(").unwrap());
    }
}

#[cfg(test)]
mod server_key_tests {
    use super::server_public_key;
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    // A throwaway self-signed RSA-2048 certificate (made with openssl on
    // 2026-10-29 for the local test server; its private key was never kept).
    // The hashes come from openssl itself: `-RSAPublicKey_out` for the key
    // CredSSP binds to, `pkey -pubin -outform DER` for the whole SPKI.
    const CERT: &str = "MIIC6DCCAdCgAwIBAgIUf+oh04klU7g6YiL1eVKP8bxKyhUwDQYJKoZIhvcNAQELBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyOTE5MTUxOVoXDTI2MTAzMTE5MTUxOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq8/pYYGffzmh9MlmWNxip+bodMmWdqkujRSlXZb9kDZxfdZznh2gUU1P+GzAFP9u2AKTfs6vEvL+xqaIhlEziGz4dRku8V97/Fz0zZwoZanvtrZm7HQ/iCyJWRsMBW034U2O1R2yMidWKiHYehrgBG4t+lAAnvfd070GAyzKy9VryYBE3t9U5OZ5MHyrY8hk3OX40tKW1Av6YYchChuB/5Fq1BrsZrPP3KkStBrZe3ytAErhSkUs7SPvFE44QtqLCcM3oEKxW9mnZCz6V/HGeX59+EX9coj54fm84NHc/oixRoBDmcSkqTPFMOhL9yDLj6vmBKkRciTOjT5EN705owIDAQABozIwMDAdBgNVHQ4EFgQUXqjBltoBXf+Ok/ocPeGq8yxOB1wwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAQZGgwYzuKH7OCPYTCSQyFQ716D+8TxAaPVmsBiofVrOFApZm1cubv6ffBamawoLBBXFPbtAKLV//pZUxuomb+00pAq17otjfS/0xsstb/dQoxIHTf/ZbPdoJNGm2Ba6Z4bkpp1LV5U+YHpdzzMOzdxws0kVCKVni/GjGa0km8F6EpT/nUP412l909yE3S3PoaCTQmC5cyKZsbI4SVazBc+ctp7mHulVMIjZq0nxQ2HdFzShBGQDBhrfrtNriQ4KWS6r/ET1eWivN+/zDUsiVzae8HQ39rh16k58FQ2zCGKDV44r2D8dgTp7G5/C/zt5BFb+uujWSMP7xGK4rVyXORg==";

    fn hex(b: &[u8]) -> String {
        Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn credssp_gets_the_subject_public_key_and_the_pin_keeps_the_whole_spki() {
        let der = base64::engine::general_purpose::STANDARD.decode(CERT).unwrap();
        let (key, spki) = server_public_key(&der).unwrap();
        assert_eq!(hex(&key), "afa7cba245909b5ee5cc328de1781fabfea9a8bbcd41048406bd5dbba031ac6a", "RSAPublicKey");
        assert_eq!(hex(&spki), "2411fbaddd155ed28ad4f81753fd05ccdc143d9ba9bd77036ea1df270e769139", "SubjectPublicKeyInfo");
        assert!(spki.len() > key.len());
        assert!(server_public_key(b"not a certificate").is_err());
    }
}

// Against a real RDP server, run by hand: tools/rdp-test-server (IronRDP's
// server, 0.13) listening on RDP_TEST_PORT with NLA and the login
// pluto / test-pw-1, which prints every input event it receives. Its README
// has the steps.
//   RDP_TEST_PORT=13389 cargo test --lib rdp::live -- --ignored --nocapture
#[cfg(test)]
mod live {
    use super::*;

    fn port() -> u16 {
        std::env::var("RDP_TEST_PORT").ok().and_then(|p| p.parse().ok()).expect("RDP_TEST_PORT")
    }

    #[test]
    #[ignore]
    fn connects_draws_and_sends_input_over_nla() {
        let mut pinned = None;
        let (mut framed, cr) = connect_session("127.0.0.1".into(), port(), "pluto".into(), "test-pw-1".into(), None, |h, p, spki| {
            pinned = Some((h.to_string(), p, spki.len()));
            Ok(())
        })
        .expect("connect");
        let (h, p, spki_len) = pinned.expect("the pin check ran");
        assert_eq!((h.as_str(), p), ("127.0.0.1", port()));
        assert!(spki_len > 200, "an RSA-2048 SPKI, {spki_len} bytes");
        let (w, ht) = (cr.desktop_size.width, cr.desktop_size.height);
        println!("CLIENT connected {w}x{ht}");
        let mut image = DecodedImage::new(ironrdp_graphics::image_processing::PixelFormat::RgbA32, w, ht);
        let mut active = active_stage(cr);
        let mut input_db = ironrdp_input::Database::new();
        let (tx, rx) = mpsc::channel();
        let mut updates = 0;
        let started = std::time::Instant::now();
        let mut sent_input = false;
        while started.elapsed() < std::time::Duration::from_secs(8) && updates < 5 {
            match framed.read_pdu() {
                Ok((action, payload)) => {
                    for out in active.process(&mut image, action, &payload, framed.last_read_at()).expect("process") {
                        match out {
                            ironrdp_session::ActiveStageOutput::ResponseFrame(f) => framed.write_all(&f).unwrap(),
                            ironrdp_session::ActiveStageOutput::GraphicsUpdate(_) => updates += 1,
                            ironrdp_session::ActiveStageOutput::Terminate(r) => panic!("terminated: {r:?}"),
                            _ => {}
                        }
                    }
                }
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(e) => panic!("read: {e}"),
            }
            if updates > 0 && !sent_input {
                use ironrdp_input::{MouseButton, MousePosition, Operation, Scancode};
                for op in [
                    Operation::MouseMove(MousePosition { x: 33, y: 44 }),
                    Operation::MouseButtonPressed(MouseButton::Left),
                    Operation::MouseButtonReleased(MouseButton::Left),
                    Operation::KeyPressed(Scancode::from(0x1e)),
                    Operation::KeyReleased(Scancode::from(0x1e)),
                ] {
                    tx.send(RdpCtrl::Op(op)).unwrap();
                }
                assert!(!drain_rdp_ctrl(&rx, &mut active, &mut image, &mut input_db, &mut framed));
                sent_input = true;
            }
        }
        assert!(updates >= 5, "graphics updates: {updates}");
        // The server paints 64x64 squares of BGRA 20 80 E0 at y=20: here as
        // RGBA. The client advertises RemoteFX, which this server then uses,
        // and RemoteFX is lossy (seen: E0 80 20 arrives as DE 80 1D), so each
        // channel is checked to within 6; the black around it is far off.
        let row = 30usize * w as usize * 4;
        let px = &image.data()[row + 15 * 4..row + 16 * 4];
        for (got, want) in px.iter().zip([0xE0u8, 0x80, 0x20, 0xFF]) {
            assert!(got.abs_diff(want) <= 6, "pixel the server painted: {px:02x?}");
        }
        println!("CLIENT updates={updates} pixel={px:02x?}");
    }

    #[test]
    #[ignore]
    fn a_wrong_password_is_refused_at_nla() {
        let err = match connect_session("127.0.0.1".into(), port(), "pluto".into(), "wrong".into(), None, |_, _, _| Ok(())) {
            Ok(_) => panic!("a wrong password connected"),
            Err(e) => e,
        };
        println!("CLIENT refused: {err}");
        assert!(err.contains("connect_finalize"), "{err}");
    }

    #[test]
    #[ignore]
    fn a_pin_mismatch_stops_before_credentials_are_sent() {
        let err = match connect_session("127.0.0.1".into(), port(), "pluto".into(), "test-pw-1".into(), None, |_, _, _| Err("pin mismatch".into())) {
            Ok(_) => panic!("connected past a failed pin"),
            Err(e) => e,
        };
        assert_eq!(err, "pin mismatch");
    }
}
