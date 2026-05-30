// (C)
// SSH local port forwarding (ssh -L localPort:remoteHost:remotePort).
//
// ssh2 sessions are !Sync, so a forward runs entirely on ONE worker thread that
// owns a dedicated connection, the local TCP listener, and every proxied
// socket. I/O is non-blocking with per-direction buffers (VecDeque), giving
// correct flow control with backpressure — no dropped or corrupted bytes under
// load. The listener binds 127.0.0.1 only (never exposes the tunnel to the LAN).
// Stop by dropping the handle (the worker sees the stop channel disconnect).

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::State;

use crate::pty::{connect_session, SshAuth};
use crate::session::new_id;

const BUF: usize = 32 * 1024;
const MAX_QUEUE: usize = 1 << 20; // 1 MB per-direction backpressure cap
const EAGAIN: i32 = -37; // LIBSSH2_ERROR_EAGAIN

/// One proxied connection: a local TCP socket bridged to a direct-tcpip channel,
/// with a buffer for each direction so a slow side applies backpressure instead
/// of dropping bytes.
struct Proxy {
    tcp: TcpStream,
    ch: ssh2::Channel,
    to_ch: VecDeque<u8>,  // bytes read from tcp, awaiting write to the channel
    to_tcp: VecDeque<u8>, // bytes read from channel, awaiting write to tcp
    tcp_eof: bool,
    ch_eof: bool,
}

pub struct ForwardHandle {
    _stop: mpsc::Sender<()>,
}

#[derive(Default)]
pub struct ForwardRegistry {
    forwards: Mutex<HashMap<String, ForwardHandle>>,
}

fn is_eagain(e: &ssh2::Error) -> bool {
    matches!(e.code(), ssh2::ErrorCode::Session(c) if c == EAGAIN)
}

fn would_block(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::WouldBlock
}

/// Open a direct-tcpip channel, retrying while the non-blocking session reports
/// EAGAIN (channel setup isn't instantaneous in non-blocking mode).
fn open_direct(sess: &ssh2::Session, host: &str, port: u16) -> Result<ssh2::Channel, String> {
    for _ in 0..2000 {
        match sess.channel_direct_tcpip(host, port, None) {
            Ok(ch) => return Ok(ch),
            Err(ref e) if is_eagain(e) => thread::sleep(Duration::from_millis(2)),
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("opening forward channel timed out".into())
}

/// Move as much data as possible in both directions without blocking. Returns
/// true if any byte moved this tick (so the loop can sleep only when fully idle).
fn pump(p: &mut Proxy, buf: &mut [u8]) -> bool {
    let mut progress = false;

    // tcp → to_ch (stop reading when the buffer is full — backpressure)
    if !p.tcp_eof && p.to_ch.len() < MAX_QUEUE {
        match p.tcp.read(buf) {
            Ok(0) => p.tcp_eof = true,
            Ok(n) => {
                p.to_ch.extend(&buf[..n]);
                progress = true;
            }
            Err(ref e) if would_block(e) => {}
            Err(_) => p.tcp_eof = true,
        }
    }

    // to_ch → channel
    loop {
        let (front, _) = p.to_ch.as_slices();
        if front.is_empty() {
            break;
        }
        match p.ch.write(front) {
            Ok(0) => break,
            Ok(n) => {
                p.to_ch.drain(..n);
                progress = true;
            }
            Err(ref e) if would_block(e) => break,
            Err(_) => {
                p.ch_eof = true;
                break;
            }
        }
    }

    // channel → to_tcp
    if !p.ch_eof && p.to_tcp.len() < MAX_QUEUE {
        match p.ch.read(buf) {
            Ok(0) => {
                if p.ch.eof() {
                    p.ch_eof = true;
                }
            }
            Ok(n) => {
                p.to_tcp.extend(&buf[..n]);
                progress = true;
            }
            Err(ref e) if would_block(e) => {}
            Err(_) => p.ch_eof = true,
        }
    }

    // to_tcp → tcp
    loop {
        let (front, _) = p.to_tcp.as_slices();
        if front.is_empty() {
            break;
        }
        match p.tcp.write(front) {
            Ok(0) => break,
            Ok(n) => {
                p.to_tcp.drain(..n);
                progress = true;
            }
            Err(ref e) if would_block(e) => break,
            Err(_) => p.tcp_eof = true,
        }
    }

    progress
}

/// A connection is finished once one side closed and its pending buffer drained.
fn finished(p: &Proxy) -> bool {
    (p.tcp_eof && p.to_ch.is_empty()) || (p.ch_eof && p.to_tcp.is_empty())
}

fn worker(
    sess: ssh2::Session,
    listener: TcpListener,
    rhost: String,
    rport: u16,
    stop_rx: mpsc::Receiver<()>,
) {
    sess.set_blocking(false);
    let _ = listener.set_nonblocking(true);
    let mut proxies: Vec<Proxy> = Vec::new();
    let mut buf = [0u8; BUF];

    loop {
        match stop_rx.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }

        // Accept any pending local connections; bridge each to a remote channel.
        loop {
            match listener.accept() {
                Ok((tcp, _addr)) => {
                    let _ = tcp.set_nonblocking(true);
                    match open_direct(&sess, &rhost, rport) {
                        Ok(ch) => proxies.push(Proxy {
                            tcp,
                            ch,
                            to_ch: VecDeque::new(),
                            to_tcp: VecDeque::new(),
                            tcp_eof: false,
                            ch_eof: false,
                        }),
                        Err(_) => { /* couldn't reach remote — drop the local conn */ }
                    }
                }
                Err(ref e) if would_block(e) => break,
                Err(_) => break,
            }
        }

        // Pump every live connection; reap finished ones.
        let mut any = false;
        let mut i = 0;
        while i < proxies.len() {
            any |= pump(&mut proxies[i], &mut buf);
            if finished(&proxies[i]) {
                let _ = proxies[i].ch.close();
                proxies.swap_remove(i);
            } else {
                i += 1;
            }
        }

        if !any {
            thread::sleep(Duration::from_millis(2));
        }
    }
    // Dropping `proxies` + `sess` here closes all channels and the connection.
}

// ── Dynamic (SOCKS5) forwarding ──────────────────────────────────────────────
// `ssh -D`: a local SOCKS5 proxy whose CONNECTs are tunnelled through the SSH
// session. Each accepted socket does a tiny no-auth SOCKS5 handshake (blocking,
// bounded by a read timeout — the bytes arrive immediately) to learn the target
// host:port, then opens a direct-tcpip channel and relays via the same pump loop
// the static forward uses. CONNECT only (BIND/UDP aren't meaningful over SSH).

/// Read the SOCKS5 greeting + CONNECT request, returning the requested target.
fn socks5_negotiate(tcp: &mut TcpStream) -> Result<(String, u16), String> {
    tcp.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let mut head = [0u8; 2];
    tcp.read_exact(&mut head).map_err(|e| e.to_string())?;
    if head[0] != 0x05 {
        return Err("not SOCKS5".into());
    }
    let mut methods = vec![0u8; head[1] as usize];
    tcp.read_exact(&mut methods).map_err(|e| e.to_string())?;
    tcp.write_all(&[0x05, 0x00]).map_err(|e| e.to_string())?; // choose no-auth

    let mut req = [0u8; 4];
    tcp.read_exact(&mut req).map_err(|e| e.to_string())?;
    if req[0] != 0x05 {
        return Err("bad SOCKS5 request".into());
    }
    if req[1] != 0x01 {
        let _ = tcp.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]); // cmd not supported
        return Err("only CONNECT is supported".into());
    }
    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            tcp.read_exact(&mut a).map_err(|e| e.to_string())?;
            format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3])
        }
        0x03 => {
            let mut l = [0u8; 1];
            tcp.read_exact(&mut l).map_err(|e| e.to_string())?;
            let mut d = vec![0u8; l[0] as usize];
            tcp.read_exact(&mut d).map_err(|e| e.to_string())?;
            String::from_utf8_lossy(&d).into_owned()
        }
        0x04 => {
            let mut a = [0u8; 16];
            tcp.read_exact(&mut a).map_err(|e| e.to_string())?;
            a.chunks(2)
                .map(|c| format!("{:x}", u16::from_be_bytes([c[0], c[1]])))
                .collect::<Vec<_>>()
                .join(":")
        }
        _ => {
            let _ = tcp.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            return Err("bad address type".into());
        }
    };
    let mut p = [0u8; 2];
    tcp.read_exact(&mut p).map_err(|e| e.to_string())?;
    Ok((host, u16::from_be_bytes(p)))
}

fn socks_worker(sess: ssh2::Session, listener: TcpListener, stop_rx: mpsc::Receiver<()>) {
    sess.set_blocking(false);
    let _ = listener.set_nonblocking(true);
    let mut proxies: Vec<Proxy> = Vec::new();
    let mut buf = [0u8; BUF];

    // Each client's SOCKS5 negotiation (a blocking read, bounded by a 10s
    // timeout) runs on its OWN short-lived thread so one slow/idle client can't
    // stall the worker (and every other proxied connection). The thread hands
    // back the negotiated (socket, target) and the worker — sole owner of the
    // !Sync session — opens the channel and writes the final CONNECT reply.
    let (hs_tx, hs_rx) = mpsc::channel::<(TcpStream, String, u16)>();

    loop {
        match stop_rx.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        // Accept new clients; negotiate each off-thread.
        loop {
            match listener.accept() {
                Ok((mut tcp, _addr)) => {
                    let _ = tcp.set_nonblocking(false);
                    let tx = hs_tx.clone();
                    thread::spawn(move || {
                        if let Ok((h, p)) = socks5_negotiate(&mut tcp) {
                            let _ = tx.send((tcp, h, p));
                        } // else: malformed/timed-out — drop the socket
                    });
                }
                Err(ref e) if would_block(e) => break,
                Err(_) => break,
            }
        }
        // Bridge any freshly-negotiated connections (session work stays here).
        while let Ok((mut tcp, h, p)) = hs_rx.try_recv() {
            match open_direct(&sess, &h, p) {
                Ok(ch) => {
                    let _ = tcp.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]); // success
                    let _ = tcp.set_nonblocking(true);
                    proxies.push(Proxy {
                        tcp,
                        ch,
                        to_ch: VecDeque::new(),
                        to_tcp: VecDeque::new(),
                        tcp_eof: false,
                        ch_eof: false,
                    });
                }
                Err(_) => {
                    let _ = tcp.write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
                } // refused
            }
        }

        let mut any = false;
        let mut i = 0;
        while i < proxies.len() {
            any |= pump(&mut proxies[i], &mut buf);
            if finished(&proxies[i]) {
                let _ = proxies[i].ch.close();
                proxies.swap_remove(i);
            } else {
                i += 1;
            }
        }
        if !any {
            thread::sleep(Duration::from_millis(2));
        }
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Start a local port forward: listen on 127.0.0.1:local_port and tunnel each
/// connection to remote_host:remote_port through a dedicated SSH connection.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn port_forward_start(
    state: State<'_, ForwardRegistry>,
    host: String,
    port: u16,
    user: String,
    auth: SshAuth,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<String, String> {
    // Bind first so a port clash fails fast (before authenticating).
    let listener = TcpListener::bind(("127.0.0.1", local_port))
        .map_err(|e| format!("can't bind 127.0.0.1:{local_port}: {e}"))?;
    let sess = connect_session(&host, port, &user, &auth, None)?;

    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    thread::spawn(move || worker(sess, listener, remote_host, remote_port, stop_rx));

    let id = new_id("fwd");
    state
        .forwards
        .lock()
        .map_err(|_| "forward registry poisoned".to_string())?
        .insert(id.clone(), ForwardHandle { _stop: stop_tx });
    Ok(id)
}

/// Start a dynamic SOCKS5 proxy on 127.0.0.1:local_port, tunnelled through a
/// dedicated SSH connection (`ssh -D`). Point a browser/app at it as a SOCKS5
/// proxy and its traffic exits via the SSH host.
#[tauri::command]
pub fn socks_forward_start(
    state: State<'_, ForwardRegistry>,
    host: String,
    port: u16,
    user: String,
    auth: SshAuth,
    local_port: u16,
) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", local_port))
        .map_err(|e| format!("can't bind 127.0.0.1:{local_port}: {e}"))?;
    let sess = connect_session(&host, port, &user, &auth, None)?;
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    thread::spawn(move || socks_worker(sess, listener, stop_rx));
    let id = new_id("fwd");
    state
        .forwards
        .lock()
        .map_err(|_| "forward registry poisoned".to_string())?
        .insert(id.clone(), ForwardHandle { _stop: stop_tx });
    Ok(id)
}

/// One end of a jump-host tunnel: the local port a target session should connect
/// to, plus the forward id to stop when done.
#[derive(serde::Serialize)]
pub struct JumpForward {
    pub id: String,
    pub local_port: u16,
}

/// Set up a jump-host (bastion / ProxyJump) tunnel: open a connection to the
/// bastion and forward an ephemeral local port to target_host:target_port
/// through it. The caller then opens the real SSH session to 127.0.0.1:local_port
/// (passing the target's own host key for verification). This is the only viable
/// ProxyJump path with libssh2 — its Session needs a real socket fd, so a raw
/// ssh2::Channel can't be used directly as the inner transport.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn jump_forward_start(
    state: State<'_, ForwardRegistry>,
    bastion_host: String,
    bastion_port: u16,
    bastion_user: String,
    bastion_auth: SshAuth,
    target_host: String,
    target_port: u16,
) -> Result<JumpForward, String> {
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("can't bind a local port: {e}"))?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let sess = connect_session(
        &bastion_host,
        bastion_port,
        &bastion_user,
        &bastion_auth,
        None,
    )?;
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    thread::spawn(move || worker(sess, listener, target_host, target_port, stop_rx));
    let id = new_id("fwd");
    state
        .forwards
        .lock()
        .map_err(|_| "forward registry poisoned".to_string())?
        .insert(id.clone(), ForwardHandle { _stop: stop_tx });
    Ok(JumpForward { id, local_port })
}

/// Stop a forward: dropping its handle closes the stop channel, so the worker
/// exits and releases the listener + connection.
#[tauri::command]
pub fn port_forward_stop(state: State<'_, ForwardRegistry>, id: String) -> Result<(), String> {
    state
        .forwards
        .lock()
        .map_err(|_| "forward registry poisoned".to_string())?
        .remove(&id);
    Ok(())
}
