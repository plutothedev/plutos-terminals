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
use tauri::{AppHandle, Emitter, State};

use ironrdp::connector::{ClientConnector, Config, DesktopSize, ServerName};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::ActiveStage;
use ironrdp_blocking::{connect_begin, connect_finalize, mark_as_upgraded, Framed};

/// Input → the RDP worker thread, in `ironrdp_input` terms.
enum RdpCtrl {
    Op(ironrdp::input::Operation),
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
    use ironrdp::connector::Credentials as C;
    Config {
        desktop_size: DesktopSize {
            width: w,
            height: h,
        },
        desktop_scale_factor: 0,
        enable_tls: true,
        enable_credssp: true,
        credentials: C::UsernamePassword { username, password },
        domain,
        client_build: 0,
        client_name: "plutos-terminals".to_owned(),
        keyboard_type: ironrdp::pdu::gcc::KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0,
        ime_file_name: String::new(),
        bitmap: None,
        dig_product_id: String::new(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        platform: ironrdp::pdu::rdp::capability_sets::MajorPlatformType::WINDOWS,
        hardware_id: None,
        request_data: None,
        autologon: true,
        enable_audio_playback: false,
        performance_flags: ironrdp::pdu::rdp::client_info::PerformanceFlags::empty(),
        license_cache: None,
        timezone_info: Default::default(),
        enable_server_pointer: false,
        pointer_software_rendering: true,
    }
}

/// Extract the server's DER SubjectPublicKeyInfo from its TLS certificate.
fn server_public_key(cert_der: &[u8]) -> Result<Vec<u8>, String> {
    use x509_cert::der::{Decode, Encode};
    let cert =
        x509_cert::Certificate::from_der(cert_der).map_err(|e| format!("parse cert: {e}"))?;
    cert.tbs_certificate
        .subject_public_key_info
        .to_der()
        .map_err(|e| format!("encode SPKI: {e}"))
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
    let pubkey = server_public_key(&cert_der)?;

    // Trust-on-first-use: refuse if this host's pinned cert fingerprint changed.
    verify_rdp_pin(&app, &host, port, &pubkey)?;

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
    .map_err(|e| format!("connect_finalize (NLA/TLS): {e}"))?;

    // Bound idle reads so the worker loop can observe a disconnect (the ctrl
    // sender dropped by rdp_disconnect) instead of parking forever in read_pdu
    // on an idle remote — which leaked the thread + socket + TLS session until
    // the server happened to send a PDU. Set only AFTER connect_finalize so the
    // (potentially slow) NLA/TLS handshake reads aren't cut short. Partial
    // frames are buffered inside Framed, so a mid-PDU timeout loses nothing.
    tls_framed
        .get_inner_mut()
        .0
        .get_ref()
        .set_read_timeout(Some(std::time::Duration::from_millis(500)))
        .map_err(|e| format!("set rdp read timeout: {e}"))?;

    let id = new_id("rdp");
    let (ctrl_tx, ctrl_rx) = mpsc::channel::<RdpCtrl>();
    let (w, h) = (
        connection_result.desktop_size.width,
        connection_result.desktop_size.height,
    );
    state
        .sessions
        .lock()
        .map_err(|_| "rdp registry poisoned".to_string())?
        .insert(id.clone(), RdpHandle { ctrl: ctrl_tx });

    let id_t = id.clone();
    let app_t = app.clone();
    std::thread::spawn(move || {
        rdp_worker(tls_framed, connection_result, ctrl_rx, app_t, id_t, w, h)
    });

    Ok((id, w, h))
}

fn emit_rect(
    app: &AppHandle,
    id: &str,
    image: &DecodedImage,
    rect: &ironrdp::pdu::geometry::InclusiveRectangle,
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
            x: rect.left,
            y: rect.top,
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
    input_db: &mut ironrdp::input::Database,
    framed: &mut Framed<S>,
) -> bool {
    use ironrdp::session::ActiveStageOutput;
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
            for o in out {
                if let ActiveStageOutput::ResponseFrame(frame) = o {
                    let _ = framed.write_all(&frame);
                }
            }
        }
    }
    false
}

fn rdp_worker<S: Read + Write>(
    mut framed: Framed<S>,
    connection_result: ironrdp::connector::ConnectionResult,
    ctrl_rx: mpsc::Receiver<RdpCtrl>,
    app: AppHandle,
    id: String,
    w: u16,
    h: u16,
) {
    use ironrdp::session::ActiveStageOutput;
    let mut image = DecodedImage::new(
        ironrdp::graphics::image_processing::PixelFormat::RgbA32,
        w,
        h,
    );
    let mut active = ActiveStage::new(connection_result);
    let mut input_db = ironrdp::input::Database::new();

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
        let outputs = match active.process(&mut image, action, &payload) {
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
    use ironrdp::input::{MouseButton, MousePosition, Operation};
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "rdp registry poisoned".to_string())?;
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
    use ironrdp::input::{Operation, Scancode};
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "rdp registry poisoned".to_string())?;
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
        .map_err(|_| "rdp registry poisoned".to_string())?
        .remove(&id);
    Ok(())
}
