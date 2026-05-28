// (C)
// RDP remote-desktop client (IronRDP). Like VNC/SSH, the session lives on one
// worker thread; the registry holds an mpsc sender for input. Streams the
// framebuffer to the webview as rdp-frame://{id} events (RGBA dirty-rects,
// base64) + rdp-exit. Connect sequence: TCP → connect_begin → native-tls
// handshake (+ extract server SPKI) → connect_finalize (CredSSP/NLA) →
// ActiveStage loop. v1: input is applied between server PDUs (read is blocking).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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

fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("rdp_{:x}", nanos)
}

fn b64(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(A[((n >> 18) & 63) as usize] as char);
        out.push(A[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            A[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            A[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
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
pub fn rdp_connect(
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

    let tcp = TcpStream::connect((host.as_str(), port))
        .map_err(|e| format!("connect {host}:{port}: {e}"))?;
    let client_addr: SocketAddr = tcp.local_addr().map_err(|e| e.to_string())?;

    let config = make_config(username, password, domain, req_w, req_h);
    let mut connector = ClientConnector::new(config, client_addr);

    let mut framed = Framed::new(tcp);
    let should_upgrade =
        connect_begin(&mut framed, &mut connector).map_err(|e| format!("connect_begin: {e}"))?;
    let (initial_stream, _leftover) = framed.into_inner();

    // TLS upgrade (RDP servers are usually self-signed → accept).
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

    let id = new_id();
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
    let left = rect.left as usize;
    let top = rect.top as usize;
    let rw = (rect.right - rect.left + 1) as usize;
    let rh = (rect.bottom - rect.top + 1) as usize;
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
        // Read one PDU (blocking).
        let (action, payload) = match framed.read_pdu() {
            Ok(v) => v,
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

        // Apply any queued input between PDUs.
        let mut ops = Vec::new();
        loop {
            match ctrl_rx.try_recv() {
                Ok(RdpCtrl::Op(op)) => ops.push(op),
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = app.emit(&format!("rdp-exit://{}", id), ());
                    return;
                }
            }
        }
        if !ops.is_empty() {
            let events = input_db.apply(ops);
            if let Ok(out) = active.process_fastpath_input(&mut image, &events) {
                for o in out {
                    if let ActiveStageOutput::ResponseFrame(frame) = o {
                        let _ = framed.write_all(&frame);
                    }
                }
            }
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
