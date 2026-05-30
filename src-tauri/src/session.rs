// (C)
//! Small shared helpers for the worker-thread session modules (pty/ssh/serial,
//! sftp, forward, rdp, vnc). Previously copy-pasted near-verbatim across each:
//! a unique session-id generator and a base64 encoder.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Monotonic per-process counter mixed into every id so two sessions minted in
/// the same clock tick (e.g. a workspace restore opening many tabs at once) —
/// or under a coarse / backwards-stepping wall clock — can never collide on the
/// same id (which would clobber a registry entry and strand a worker thread).
static SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

/// A unique, opaque session id of the form `{prefix}_{nanos:x}_{seq:x}`
/// (e.g. `pty_…`, `vnc_…`, `rdp_…`, `fwd_…`, `sftp_…`). Opaque to callers —
/// used only as a registry key and event-channel suffix, never parsed.
pub fn new_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{nanos:x}_{seq:x}")
}

/// Standard-alphabet base64 WITH `=` padding. Used for framebuffer pixel data
/// streamed to the webview (RDP/VNC dirty-rects), which decodes it via
/// atob/Uint8Array. (SSH host-key fingerprints use a separate no-pad encoder in
/// pty.rs — OpenSSH's `SHA256:` form is unpadded, so don't merge the two.)
pub fn b64(data: &[u8]) -> String {
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
