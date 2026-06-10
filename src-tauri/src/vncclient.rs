// (C)
// VNC (RFB) remote-desktop client. Like SSH, the vnc::Client is owned solely by
// a worker thread; the registry holds an mpsc sender for input (pointer/key).
// The worker streams framebuffer rects to the webview as `vnc-frame://{id}`
// events (each = a dirty rect of RGBA bytes, base64-encoded) and `vnc-resize`/
// `vnc-exit`. The frontend draws rects to a <canvas> and sends input back.
//
// (Module is named `vncclient` so it doesn't shadow the `vnc` crate.)

use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use crate::session::{b64, new_id};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Input messages from the renderer → the VNC worker thread.
enum VncCtrl {
    Pointer { x: u16, y: u16, buttons: u8 },
    Key { down: bool, keysym: u32 },
}

pub struct VncHandle {
    ctrl: mpsc::Sender<VncCtrl>,
}

#[derive(Default)]
pub struct VncRegistry {
    sessions: Mutex<HashMap<String, VncHandle>>,
}

#[derive(Serialize, Clone)]
struct VncFrame {
    x: u16,
    y: u16,
    w: u16,
    h: u16,
    /// RGBA bytes, base64 (no padding stripped — standard base64).
    data: String,
}

#[derive(Serialize, Clone)]
struct VncSize {
    w: u16,
    h: u16,
}

fn vnc_password(pw: &str) -> Vec<u8> {
    pw.bytes().take(8).collect()
}

/// Convert one rect's pixels (in the connection's PixelFormat) to RGBA8888.
fn to_rgba(pixels: &[u8], fmt: &vnc::PixelFormat) -> Vec<u8> {
    let bpp = (fmt.bits_per_pixel / 8) as usize;
    if bpp == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(pixels.len() / bpp * 4);
    let rs = fmt.red_shift;
    let gs = fmt.green_shift;
    let bs = fmt.blue_shift;
    let rmax = fmt.red_max as u32;
    let gmax = fmt.green_max as u32;
    let bmax = fmt.blue_max as u32;
    for px in pixels.chunks_exact(bpp) {
        // Assemble the pixel value honoring endianness.
        let mut v: u32 = 0;
        if fmt.big_endian {
            for &b in px {
                v = (v << 8) | b as u32;
            }
        } else {
            for (i, &b) in px.iter().enumerate() {
                v |= (b as u32) << (8 * i);
            }
        }
        let r = if rmax > 0 {
            ((v >> rs) & rmax) * 255 / rmax
        } else {
            0
        };
        let g = if gmax > 0 {
            ((v >> gs) & gmax) * 255 / gmax
        } else {
            0
        };
        let b = if bmax > 0 {
            ((v >> bs) & bmax) * 255 / bmax
        } else {
            0
        };
        out.push(r as u8);
        out.push(g as u8);
        out.push(b as u8);
        out.push(255);
    }
    out
}

#[tauri::command]
pub async fn vnc_connect(
    app: AppHandle,
    state: State<'_, VncRegistry>,
    host: String,
    port: u16,
    password: Option<String>,
) -> Result<(String, u16, u16), String> {
    let port = if port == 0 { 5900 } else { port };
    let tcp = TcpStream::connect((host.as_str(), port))
        .map_err(|e| format!("connect to {host}:{port} failed: {e}"))?;
    let pw = vnc_password(password.as_deref().unwrap_or(""));

    let mut client = vnc::Client::from_tcp_stream(tcp, true, |methods| {
        for m in methods {
            match m {
                vnc::client::AuthMethod::None => return Some(vnc::client::AuthChoice::None),
                vnc::client::AuthMethod::Password => {
                    let mut key = [0u8; 8];
                    for (i, b) in pw.iter().take(8).enumerate() {
                        key[i] = *b;
                    }
                    return Some(vnc::client::AuthChoice::Password(key));
                }
                _ => {}
            }
        }
        None
    })
    .map_err(|e| format!("vnc handshake failed: {e}"))?;

    let (w, h) = client.size();
    let _ = client.set_encodings(&[
        vnc::Encoding::Raw,
        vnc::Encoding::CopyRect,
        vnc::Encoding::DesktopSize,
    ]);
    let _ = client.request_update(
        vnc::Rect {
            left: 0,
            top: 0,
            width: w,
            height: h,
        },
        false,
    );

    let id = new_id("vnc");
    let (ctrl_tx, ctrl_rx) = mpsc::channel::<VncCtrl>();
    state
        .sessions
        .lock()
        .map_err(|_| "vnc registry poisoned".to_string())?
        .insert(id.clone(), VncHandle { ctrl: ctrl_tx });

    let id_t = id.clone();
    let app_t = app.clone();
    thread::spawn(move || vnc_worker(client, w, h, ctrl_rx, app_t, id_t));

    Ok((id, w, h))
}

fn vnc_worker(
    mut client: vnc::Client,
    mut w: u16,
    mut h: u16,
    ctrl_rx: mpsc::Receiver<VncCtrl>,
    app: AppHandle,
    id: String,
) {
    let format = client.format();
    loop {
        // Drain input. Disconnected sender (handle dropped) → tear down.
        loop {
            match ctrl_rx.try_recv() {
                Ok(VncCtrl::Pointer { x, y, buttons }) => {
                    let _ = client.send_pointer_event(buttons, x, y);
                }
                Ok(VncCtrl::Key { down, keysym }) => {
                    let _ = client.send_key_event(down, keysym);
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = app.emit(&format!("vnc-exit://{}", id), ());
                    return;
                }
            }
        }

        // Drain framebuffer events.
        let mut got = false;
        while let Some(event) = client.poll_event() {
            got = true;
            match event {
                vnc::client::Event::Resize(nw, nh) => {
                    w = nw;
                    h = nh;
                    let _ = app.emit(&format!("vnc-resize://{}", id), VncSize { w, h });
                }
                vnc::client::Event::PutPixels(rect, ref pixels) => {
                    let rgba = to_rgba(pixels, &format);
                    let _ = app.emit(
                        &format!("vnc-frame://{}", id),
                        VncFrame {
                            x: rect.left,
                            y: rect.top,
                            w: rect.width,
                            h: rect.height,
                            data: b64(&rgba),
                        },
                    );
                }
                vnc::client::Event::EndOfFrame => {
                    let _ = client.request_update(
                        vnc::Rect {
                            left: 0,
                            top: 0,
                            width: w,
                            height: h,
                        },
                        true,
                    );
                }
                vnc::client::Event::Disconnected(_) => {
                    let _ = app.emit(&format!("vnc-exit://{}", id), ());
                    return;
                }
                _ => {}
            }
        }
        if !got {
            thread::sleep(Duration::from_millis(8));
        }
    }
}

#[tauri::command]
pub fn vnc_pointer(
    state: State<'_, VncRegistry>,
    id: String,
    x: u16,
    y: u16,
    buttons: u8,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "vnc registry poisoned".to_string())?;
    if let Some(h) = sessions.get(&id) {
        let _ = h.ctrl.send(VncCtrl::Pointer { x, y, buttons });
    }
    Ok(())
}

#[tauri::command]
pub fn vnc_key(
    state: State<'_, VncRegistry>,
    id: String,
    keysym: u32,
    down: bool,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "vnc registry poisoned".to_string())?;
    if let Some(h) = sessions.get(&id) {
        let _ = h.ctrl.send(VncCtrl::Key { down, keysym });
    }
    Ok(())
}

#[tauri::command]
pub fn vnc_disconnect(state: State<'_, VncRegistry>, id: String) -> Result<(), String> {
    // Dropping the handle closes the ctrl channel → worker exits.
    state
        .sessions
        .lock()
        .map_err(|_| "vnc registry poisoned".to_string())?
        .remove(&id);
    Ok(())
}
