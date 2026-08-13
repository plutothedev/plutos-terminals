// (C)
// Network tools for the MobaXterm-style toolbox: ping, traceroute, TCP port
// scan, and DNS lookup. ping/traceroute shell out to the OS tools (their output
// is what users expect to see) with a STRICTLY validated host — only DNS-name /
// IP characters are allowed, so the argument can never inject a shell command
// (and Command doesn't use a shell anyway). Port scan + DNS are pure Rust.

use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn silent(program: &str) -> Command {
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// A host is valid only if it's a plausible DNS name or IP literal: letters,
/// digits, dot, hyphen, colon (IPv6), underscore. No spaces, slashes, or shell
/// metacharacters — so it's safe to pass as a command argument.
fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 255
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_'))
}

fn run_text(mut cmd: Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| e.to_string())?;
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.stderr.is_empty() {
        s.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    let s = s.trim().to_string();
    if s.is_empty() {
        Err("no output".into())
    } else {
        Ok(s)
    }
}

/// ping the host a few times and return the raw output.
#[tauri::command]
pub async fn net_ping(host: String) -> Result<String, String> {
    let host = host.trim();
    if !valid_host(host) {
        return Err("invalid host".into());
    }
    let mut cmd = silent("ping");
    #[cfg(target_os = "windows")]
    cmd.args(["-n", "4", host]);
    #[cfg(not(target_os = "windows"))]
    cmd.args(["-c", "4", host]);
    run_text(cmd)
}

/// traceroute / tracert to the host (capped hop count) and return the output.
#[tauri::command]
pub async fn net_traceroute(host: String) -> Result<String, String> {
    let host = host.trim();
    if !valid_host(host) {
        return Err("invalid host".into());
    }
    #[cfg(target_os = "windows")]
    let cmd = {
        let mut c = silent("tracert");
        c.args(["-h", "15", "-w", "1500", host]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let cmd = {
        let mut c = silent("traceroute");
        c.args(["-m", "15", "-w", "2", host]);
        c
    };
    run_text(cmd)
}

/// Parse a port spec like "22,80,443" or "1-1024" or a mix into a deduped,
/// capped list (max 256 ports to keep a scan bounded).
fn parse_ports(spec: &str) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((a, b)) = part.split_once('-') {
            if let (Ok(lo), Ok(hi)) = (a.trim().parse::<u16>(), b.trim().parse::<u16>()) {
                let (lo, hi) = (lo.min(hi), lo.max(hi));
                for p in lo..=hi {
                    out.push(p);
                }
            }
        } else if let Ok(p) = part.parse::<u16>() {
            out.push(p);
        }
        if out.len() > 4096 {
            break;
        }
    }
    out.sort_unstable();
    out.dedup();
    out.truncate(256);
    out
}

/// TCP-connect scan: return the subset of `ports` that accept a connection on
/// `host` within a short timeout. Pure Rust (no external tool). Scans in
/// parallel batches so a 256-port scan stays quick.
#[tauri::command]
pub async fn net_port_scan(host: String, ports: String) -> Result<Vec<u16>, String> {
    let host = host.trim().to_string();
    if !valid_host(&host) {
        return Err("invalid host".into());
    }
    let list = parse_ports(&ports);
    if list.is_empty() {
        return Err("no valid ports — try \"22,80,443\" or \"1-1024\"".into());
    }
    let mut open: Vec<u16> = Vec::new();
    // 64-wide batches: each port gets its own short-lived thread; join per batch.
    for chunk in list.chunks(64) {
        let handles: Vec<_> = chunk
            .iter()
            .map(|&port| {
                let host = host.clone();
                std::thread::spawn(move || {
                    // Resolve host:port, then try each resolved addr briefly.
                    let addrs = match (host.as_str(), port).to_socket_addrs() {
                        Ok(a) => a,
                        Err(_) => return None,
                    };
                    for addr in addrs {
                        if TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok() {
                            return Some(port);
                        }
                    }
                    None
                })
            })
            .collect();
        for h in handles {
            if let Ok(Some(p)) = h.join() {
                open.push(p);
            }
        }
    }
    open.sort_unstable();
    Ok(open)
}

/// Latency to a host's SSH port (or `port`) via a timed TCP connect — bounded
/// and portable (no ICMP/ping-flag differences). Returns round-trip ms, or None
/// if it times out / is refused. Used for the session-tree latency readout.
#[tauri::command]
pub async fn net_latency(host: String, port: Option<u16>) -> Result<Option<u32>, String> {
    let host = host.trim().to_string();
    if !valid_host(&host) {
        return Err("invalid host".into());
    }
    // Blocking DNS + connect off the runtime (P2-T4): as a bare async fn this
    // parked a tokio worker for up to 1.5s per unreachable addr.
    Ok(tauri::async_runtime::spawn_blocking(move || net_latency_sync(&host, port))
        .await
        .unwrap_or(None))
}

fn net_latency_sync(host: &str, port: Option<u16>) -> Option<u32> {
    let p = port.unwrap_or(22);
    let addrs = match (host, p).to_socket_addrs() {
        Ok(a) => a,
        Err(_) => return None,
    };
    // First 2 resolved addrs only (audit M4): the full loop walked EVERY
    // addr at 1.5s each — a dual-stack dead host cost 3s+, and a long
    // resolver list far more.
    for addr in addrs.take(2) {
        let start = std::time::Instant::now();
        if TcpStream::connect_timeout(&addr, Duration::from_millis(1500)).is_ok() {
            return Some(start.elapsed().as_millis() as u32);
        }
    }
    None
}

/// Batched probe for the session tree (P2-T4): one invoke per 30s cycle,
/// chunks of 16 scoped threads inside one spawn_blocking slot — 40
/// unreachable hosts cost ~3 chunk-waves (~4.5s) instead of 60s serial, and
/// zero tokio workers.
#[tauri::command]
pub async fn net_latency_many(
    hosts: Vec<(String, Option<u16>)>,
) -> std::collections::HashMap<String, Option<u32>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = std::collections::HashMap::new();
        for chunk in hosts.chunks(16) {
            let results: Vec<(String, Option<u32>)> = std::thread::scope(|scope| {
                let handles: Vec<_> = chunk
                    .iter()
                    .map(|(host, port)| {
                        let host = host.trim().to_string();
                        let port = *port;
                        scope.spawn(move || {
                            let ms = if valid_host(&host) {
                                net_latency_sync(&host, port)
                            } else {
                                None
                            };
                            (host, ms)
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .filter_map(|h| h.join().ok())
                    .collect()
            });
            out.extend(results);
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// Resolve a hostname to its IP address(es). Pure Rust via the system resolver.
#[tauri::command]
pub async fn net_dns(host: String) -> Result<Vec<String>, String> {
    let host = host.trim();
    if !valid_host(host) {
        return Err("invalid host".into());
    }
    let mut ips: Vec<String> = (host, 0u16)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .map(|sa| sa.ip().to_string())
        .collect();
    ips.sort();
    ips.dedup();
    if ips.is_empty() {
        Err("no addresses resolved".into())
    } else {
        Ok(ips)
    }
}
