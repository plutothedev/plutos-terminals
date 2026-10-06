// (C)
//! LLM completion gateway: Anthropic Messages API + OpenAI-compatible chat
//! (OpenRouter / DeepSeek / Groq / Moonshot / ...). Runs in Rust (reqwest) so the
//! API key never hits a browser-origin request and we sidestep CORS. Extracted
//! from the commands.rs grab-bag (the only HTTP-client concern in there).

/// Map a non-success HTTP response to a readable error: prefer the provider's
/// JSON `error.message`; otherwise status + a body excerpt (capped). Checking
/// status BEFORE parsing JSON matters — an HTML 502 from a proxy must surface
/// as "502 Bad Gateway: <html>…", not as a JSON decode error.
pub(crate) async fn http_error(status: reqwest::StatusCode, resp: reqwest::Response) -> String {
    if let Some(msg) = refused_redirect_message(status, resp.headers(), resp.url()) {
        return msg;
    }
    let body = resp.text().await.unwrap_or_default();
    if let Some(msg) = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
    {
        return msg;
    }
    let excerpt: String = body.trim().chars().take(300).collect();
    if excerpt.is_empty() {
        status.to_string()
    } else {
        format!("{status}: {excerpt}")
    }
}

// ── Shared HTTP client + retry policy (P3-T1) ───────────────────────────────
// A fresh Client per request discarded reqwest's connection pool: every agent
// step paid DNS+TCP+TLS to the same host (14 handshakes/run ≈ 1.5-4s of pure
// setup). One shared client; per-call TOTAL timeouts move to the REQUEST
// (RequestBuilder::timeout — same total-including-body semantics), never the
// client (a client-level timeout would cap streaming reads too). UA lives
// here because GitHub's API rejects UA-less requests (gist sharing) and LLM
// providers don't care. connect_timeout is explicit — reqwest has NO default.

use std::sync::OnceLock;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Most redirects the shared client follows in one chain.
pub(crate) const MAX_REDIRECTS: usize = 5;

/// Whether the shared client follows a redirect from `first`, the URL the
/// request was sent to, on to `next`: only within the same host and port, over
/// http or https, and never from https down to http. The one port change
/// allowed is http upgrading to https on https's own port (443). The LLM calls
/// carry the API key in `x-api-key`, which reqwest does NOT strip on a
/// cross-host or cross-port hop (only Authorization and cookies; redirect.rs
/// remove_sensitive_headers), and reqwest's default policy also follows https
/// to http. So a provider, or anything answering at its address, could
/// otherwise send a 30x and receive the key at an address the user never
/// entered, or in cleartext. A same-host hop (a trailing slash, a moved path)
/// still works, for a base given as an IP address too: local MCP servers on
/// 127.0.0.1 (FastMCP answers /mcp with a 307 to /mcp/) depend on it.
///
/// Known residual, accepted: this rule sees the WHATWG-normalised host, while
/// the connector dials the Location's own text, and the two can read an
/// unusual IPv4 spelling differently (macOS takes "0177.0.0.1" as 177.0.0.1
/// where WHATWG reads 127.0.0.1; review 2026-10-05). Only the server that just
/// received the key can send such a Location, so it gains nothing it did not
/// already have, and only a plain-http base is exposed: over https the
/// connector checks the certificate against the spelling it dials and refuses
/// an alternative one before any handshake. Refusing every redirect from an
/// IP-address base to close it broke those MCP servers.
pub(crate) fn redirect_allowed(first: &reqwest::Url, next: &reqwest::Url) -> bool {
    let Some(host) = first.host_str() else { return false };
    if !matches!(next.scheme(), "http" | "https") {
        return false;
    }
    let same_host = next.host_str().is_some_and(|h| h.eq_ignore_ascii_case(host));
    let downgrade = first.scheme() == "https" && next.scheme() != "https";
    let same_port = next.port_or_known_default() == first.port_or_known_default();
    let upgrade = first.scheme() == "http" && next.scheme() == "https" && next.port_or_known_default() == Some(443);
    same_host && !downgrade && (same_port || upgrade)
}

/// The shared client's settings, also what the tests build from.
fn shared_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent("plutos-terminals")
        .connect_timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > MAX_REDIRECTS {
                return attempt.error("too many redirects");
            }
            let allowed = attempt
                .previous()
                .first()
                .is_some_and(|first| redirect_allowed(first, attempt.url()));
            if allowed {
                attempt.follow()
            } else {
                // The 30x itself comes back to the caller, which reports it
                // through refused_redirect_message.
                attempt.stop()
            }
        }))
}

pub(crate) fn http_client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| shared_client_builder().build().expect("shared HTTP client (TLS backend init)"))
}

/// A failed send, as the user reads it. A redirect chain longer than
/// MAX_REDIRECTS gets a fixed sentence, because reqwest's own text carries the
/// last address in the chain, which the provider chose. Every other error
/// keeps reqwest's text, which names the base URL the user set.
pub(crate) fn send_error(e: reqwest::Error) -> String {
    if e.is_redirect() {
        format!("the provider redirected more than {MAX_REDIRECTS} times, so the request stopped. Check the base URL in Models.")
    } else {
        e.to_string()
    }
}

/// The error for a redirect the shared client would not follow
/// (redirect_allowed), or None when there is no redirect to describe: a
/// status that is not 3xx, or a 3xx with no usable Location (304, 300, a bare
/// 301), which then reads as its plain status. It says what kind of place the
/// provider pointed at, naming a host or port but never the full address, and
/// what to check, so a moved endpoint reads as a settings problem rather than
/// a bare "301 Moved Permanently".
pub(crate) fn refused_redirect_message(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    from: &reqwest::Url,
) -> Option<String> {
    if !status.is_redirection() {
        return None;
    }
    let target = headers
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|loc| from.join(loc).ok())?;
    let same_host = match (target.host_str(), from.host_str()) {
        (Some(t), Some(f)) => t.eq_ignore_ascii_case(f),
        _ => false,
    };
    let place = if !matches!(target.scheme(), "http" | "https") {
        "an address that is not http or https".to_string()
    } else if !same_host {
        format!("another host ({})", target.host_str().unwrap_or("no host"))
    } else if from.scheme() == "https" && target.scheme() != "https" {
        "plain http".to_string()
    } else if target.port_or_known_default() != from.port_or_known_default() {
        let port = target.port_or_known_default().map_or_else(|| "none".to_string(), |p| p.to_string());
        format!("another port ({port})")
    } else {
        "another address".to_string()
    };
    Some(format!(
        "{status}: the provider redirected to {place}. The app only sends your key to the base URL you set, so check that address in Models."
    ))
}

/// The error for a streaming call's non-2xx answer: a refused redirect as
/// refused_redirect_message words it, else the JSON error message, else the
/// status. Error bodies are plain JSON, not SSE.
async fn stream_http_error(status: reqwest::StatusCode, resp: reqwest::Response) -> String {
    if let Some(msg) = refused_redirect_message(status, resp.headers(), resp.url()) {
        return msg;
    }
    let v: serde_json::Value = resp.json().await.unwrap_or_else(|_| serde_json::json!({}));
    let msg = v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("");
    if msg.is_empty() { status.to_string() } else { msg.to_string() }
}

/// Transient statuses worth retrying: rate limit, upstream unavailable, and
/// Anthropic's 529 overloaded.
pub(crate) fn is_retryable_status(status: u16) -> bool {
    matches!(status, 429 | 503 | 529)
}

/// Delay before retry `attempt` (1-based): Retry-After wins (capped 30s),
/// else 2s then 8s.
pub(crate) fn retry_delay(attempt: u32, retry_after_secs: Option<u64>) -> std::time::Duration {
    let secs = match retry_after_secs {
        Some(s) => s.min(30),
        None => match attempt {
            1 => 2,
            _ => 8,
        },
    };
    std::time::Duration::from_secs(secs)
}

/// Send a NON-STREAMING request with <=2 retries on transient statuses,
/// honoring Retry-After. Streaming paths must NOT use this — a mid-stream
/// retry would duplicate partial output. The builder is cloned per attempt
/// (JSON bodies are cloneable; a non-cloneable body just gets no retries).
pub(crate) async fn send_with_retry(
    builder: reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let mut attempt: u32 = 0;
    loop {
        let this_try = match builder.try_clone() {
            Some(b) => b,
            None => return builder.send().await.map_err(send_error),
        };
        let resp = this_try.send().await.map_err(send_error)?;
        let status = resp.status().as_u16();
        if !is_retryable_status(status) || attempt >= 2 {
            return Ok(resp);
        }
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok());
        attempt += 1;
        tokio::time::sleep(retry_delay(attempt, retry_after)).await;
    }
}

#[cfg(test)]
mod retry_policy_tests {
    use super::*;

    #[test]
    fn retryable_statuses() {
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(503));
        assert!(is_retryable_status(529));
        assert!(!is_retryable_status(500));
        assert!(!is_retryable_status(400));
        assert!(!is_retryable_status(200));
    }

    #[test]
    fn delays_honor_retry_after_capped_else_backoff() {
        use std::time::Duration;
        assert_eq!(retry_delay(1, Some(5)), Duration::from_secs(5));
        assert_eq!(retry_delay(1, Some(300)), Duration::from_secs(30)); // cap
        assert_eq!(retry_delay(1, None), Duration::from_secs(2));
        assert_eq!(retry_delay(2, None), Duration::from_secs(8));
    }
}

// ── Stream cancellation + role-structured messages (P3-T2) ──────────────────

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

static CANCELS: OnceLock<std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cancels() -> &'static std::sync::Mutex<HashMap<String, Arc<AtomicBool>>> {
    CANCELS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Insert-or-set-true (audit): a cancel can land BEFORE the stream registers
/// its id (two independent invokes, no ordering) — set-if-present would no-op
/// and the stream would run to max_tokens, the exact cost this exists to stop.
#[tauri::command]
pub fn llm_stream_cancel(request_id: String) {
    let mut map = cancels().lock().unwrap_or_else(|p| p.into_inner());
    map.entry(request_id)
        .or_default()
        .store(true, Ordering::Relaxed);
}

/// Removes the entry on EVERY stream exit (Ok/Err/cancelled) via Drop, so the
/// map can't grow one entry per LLM call for the app's lifetime — early `?`
/// returns can't skip it.
struct CancelGuard(String);
impl Drop for CancelGuard {
    fn drop(&mut self) {
        let mut map = cancels().lock().unwrap_or_else(|p| p.into_inner());
        map.remove(&self.0);
    }
}

/// Role-structured history (P3-T2). JS sends [{role, content}] with string
/// content (user/assistant); absent/empty falls back to the single-prompt
/// form both commands always supported.
fn anthropic_messages(
    messages: &Option<Vec<serde_json::Value>>,
    prompt: &str,
) -> serde_json::Value {
    match messages {
        Some(m) if !m.is_empty() => serde_json::Value::Array(m.clone()),
        _ => serde_json::json!([{ "role": "user", "content": prompt }]),
    }
}

fn openai_messages(
    messages: &Option<Vec<serde_json::Value>>,
    system: &str,
    prompt: &str,
) -> serde_json::Value {
    let mut arr = vec![serde_json::json!({ "role": "system", "content": system })];
    match messages {
        Some(m) if !m.is_empty() => arr.extend(m.iter().cloned()),
        _ => arr.push(serde_json::json!({ "role": "user", "content": prompt })),
    }
    serde_json::Value::Array(arr)
}

#[cfg(test)]
mod message_shape_tests {
    use super::*;

    #[test]
    fn fallback_single_prompt_when_absent_or_empty() {
        let a = anthropic_messages(&None, "hi");
        assert_eq!(a[0]["content"], "hi");
        let o = openai_messages(&Some(vec![]), "sys", "hi");
        assert_eq!(o[0]["role"], "system");
        assert_eq!(o[1]["content"], "hi");
    }

    #[test]
    fn role_structured_passthrough_and_system_prepend() {
        let msgs = vec![
            serde_json::json!({"role": "user", "content": "a"}),
            serde_json::json!({"role": "assistant", "content": "b"}),
        ];
        let a = anthropic_messages(&Some(msgs.clone()), "unused");
        assert_eq!(a.as_array().unwrap().len(), 2);
        let o = openai_messages(&Some(msgs), "sys", "unused");
        assert_eq!(o.as_array().unwrap().len(), 3);
        assert_eq!(o[0]["role"], "system");
        assert_eq!(o[2]["role"], "assistant");
    }
}

/// Is `host` a loopback / private / local-network address? Self-hosted LLMs
/// (Ollama, LM Studio, llama.cpp) commonly run over plain http on the LAN, so we
/// permit cleartext to those while still blocking cleartext to the public internet.
fn is_private_or_local(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']');
    if h == "localhost" || h.ends_with(".local") || h.ends_with(".localhost") {
        return true;
    }
    if let Ok(ip) = h.parse::<std::net::Ipv4Addr>() {
        return ip.is_loopback() || ip.is_private() || ip.is_link_local();
    }
    if let Ok(ip) = h.parse::<std::net::Ipv6Addr>() {
        // An IPv4-mapped v6 address (::ffff:a.b.c.d) is the same host as its v4
        // form — classify by the embedded v4 so ::ffff:127.0.0.1 counts as local.
        if let Some(v4) = ip.to_ipv4_mapped() {
            return v4.is_loopback() || v4.is_private() || v4.is_link_local();
        }
        // is_unique_local()/is_unicast_link_local() are unstable, so match the
        // prefixes directly: unique-local fc00::/7 and link-local fe80::/10 are
        // the v6 equivalents of the RFC1918 / 169.254 ranges allowed above, so a
        // self-hosted LLM gateway on a v6 LAN is reachable over http like a v4 one.
        let seg0 = ip.segments()[0];
        let unique_local = (seg0 & 0xfe00) == 0xfc00; // fc00::/7
        let link_local = (seg0 & 0xffc0) == 0xfe80; // fe80::/10
        return ip.is_loopback() || unique_local || link_local;
    }
    false
}

/// Resolve the provider base URL, enforcing a safe scheme so the user's API key is
/// never POSTed over cleartext to a public endpoint (credential exfil / MITM). An
/// empty base falls back to the provider default. A non-empty base must be https://,
/// or http:// only when the host is loopback/private/.local (self-hosted gateways).
/// This is defense in depth: the key + base both come from JS, so a compromised
/// webview could otherwise pair a stolen key with an attacker URL, bypassing the
/// document CSP (these requests originate from reqwest, not the webview).
pub(crate) fn resolve_base(base_url: &str, default: &str) -> Result<String, String> {
    let raw = base_url.trim();
    if raw.is_empty() {
        return Ok(default.to_string());
    }
    let b = raw.trim_end_matches('/');
    // Parse with a real URL parser (reqwest::Url == url::Url) instead of hand-
    // splitting: it correctly isolates the host from userinfo, port, query and
    // fragment, closing host-spoof bypasses such as http://localhost:x@evil.com
    // and http://evil.com#@localhost. https is always allowed; http only to a
    // loopback / private-LAN / .local host (self-hosted LLM gateways on the LAN).
    let parsed = reqwest::Url::parse(b).map_err(|_| format!("Invalid base URL: {b}"))?;
    let host = parsed.host_str().unwrap_or("");
    let ok = parsed.scheme() == "https" || (parsed.scheme() == "http" && is_private_or_local(host));
    if !ok {
        return Err(format!(
            "Refusing to send the API key to a non-HTTPS endpoint: {b}. Use https:// (http:// is allowed only for localhost / a private-LAN address)."
        ));
    }
    Ok(b.to_string())
}

#[cfg(test)]
mod base_url_tests {
    use super::{is_private_or_local, resolve_base};

    #[test]
    fn empty_base_uses_default() {
        assert_eq!(resolve_base("", "https://api.anthropic.com").unwrap(), "https://api.anthropic.com");
        assert_eq!(resolve_base("   ", "https://d").unwrap(), "https://d");
    }

    #[test]
    fn https_is_allowed_and_trailing_slash_trimmed() {
        assert_eq!(resolve_base("https://api.openai.com/v1/", "x").unwrap(), "https://api.openai.com/v1");
    }

    #[test]
    fn http_localhost_and_private_lan_allowed() {
        for u in ["http://localhost:1234", "http://127.0.0.1:8080", "http://192.168.1.50:11434", "http://10.0.0.5", "http://ollama.local", "http://user:pass@192.168.1.5:8080"] {
            assert!(resolve_base(u, "x").is_ok(), "should allow {u}");
        }
    }

    #[test]
    fn http_to_public_is_rejected() {
        // cleartext key leak to the public internet, the localhost-prefix bypass,
        // and the userinfo spoof (host is what's AFTER the last @, not the username).
        for u in [
            "http://api.evil.com/v1",
            "http://1.2.3.4:8080",
            "http://localhost.evil.com",
            "http://localhost:x@evil.com/v1",
            "http://127.0.0.1@evil.com",
            "http://user@8.8.8.8",
            "http://evil.com#@localhost",
            "http://evil.com?x=@localhost",
        ] {
            assert!(resolve_base(u, "x").is_err(), "should reject {u}");
        }
    }

    #[test]
    fn private_host_classification() {
        assert!(is_private_or_local("localhost"));
        assert!(is_private_or_local("127.0.0.1"));
        assert!(is_private_or_local("192.168.0.1"));
        assert!(!is_private_or_local("8.8.8.8"));
        assert!(!is_private_or_local("localhost.evil.com"));
    }

    #[test]
    fn private_host_classification_ipv6() {
        // loopback + the v6 equivalents of the RFC1918 / link-local ranges.
        assert!(is_private_or_local("::1"));
        assert!(is_private_or_local("[::1]"));
        assert!(is_private_or_local("fd00::1")); // unique-local fc00::/7
        assert!(is_private_or_local("fc00::abcd"));
        assert!(is_private_or_local("fe80::1")); // link-local fe80::/10
        assert!(is_private_or_local("::ffff:127.0.0.1")); // v4-mapped loopback
        assert!(is_private_or_local("::ffff:192.168.1.5")); // v4-mapped private
        // public v6 must still be rejected (http key-leak protection holds).
        assert!(!is_private_or_local("2001:4860:4860::8888")); // Google public DNS
        assert!(!is_private_or_local("::ffff:8.8.8.8")); // v4-mapped public
    }
}

#[tauri::command]
pub async fn llm_complete(
    kind: String,
    base_url: String,
    api_key: String,
    model: String,
    system: String,
    prompt: String,
    messages: Option<Vec<serde_json::Value>>,
) -> Result<String, String> {
    let client = http_client();
    let anthropic = kind == "anthropic" || kind == "anthropic-compat";

    if anthropic {
        let base = resolve_base(&base_url, "https://api.anthropic.com")?;
        let body = serde_json::json!({
            "model": model,
            "max_tokens": 1024,
            "system": system,
            "messages": anthropic_messages(&messages, &prompt),
        });
        // Anthropic native authenticates with x-api-key; Anthropic-compatible
        // gateways (e.g. Moonshot /anthropic) expect Authorization: Bearer — the
        // same token Claude Code sends as ANTHROPIC_AUTH_TOKEN. Send both so
        // whichever the endpoint honours works.
        let resp = send_with_retry(
            client
                .post(format!("{}/v1/messages", base))
                .timeout(std::time::Duration::from_secs(60))
                .header("x-api-key", &api_key)
                .header("authorization", format!("Bearer {}", api_key))
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body),
        )
        .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(http_error(status, resp).await);
        }
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();
        Ok(text)
    } else {
        let base = resolve_base(&base_url, "https://api.openai.com/v1")?;
        let body = serde_json::json!({
            "model": model,
            "messages": openai_messages(&messages, &system, &prompt),
        });
        let resp = send_with_retry(
            client
                .post(format!("{}/chat/completions", base))
                .timeout(std::time::Duration::from_secs(60))
                .header("authorization", format!("Bearer {}", api_key))
                .header("content-type", "application/json")
                .json(&body),
        )
        .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(http_error(status, resp).await);
        }
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let text = v
            .pointer("/choices/0/message/content")
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string();
        Ok(text)
    }
}

use futures_util::StreamExt;

/// Streaming variant of [`llm_complete`]: pushes incremental text deltas to the
/// JS `on_chunk` Channel as they arrive (SSE), and returns the full text at the
/// end so callers can still parse the complete reply. Same provider routing as
/// the non-streaming path; adds `"stream": true` and parses the SSE deltas for
/// Anthropic (content_block_delta) and OpenAI-compatible (choices[].delta).
// The params ARE the IPC surface — every one arrives by name from JS; bundling
// them into a struct would change the wire shape for zero benefit.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn llm_stream(
    on_chunk: tauri::ipc::Channel<String>,
    kind: String,
    base_url: String,
    api_key: String,
    model: String,
    system: String,
    prompt: String,
    messages: Option<Vec<serde_json::Value>>,
    request_id: Option<String>,
) -> Result<String, String> {
    // Cancellation: register (or adopt a pre-landed cancel) before firing the
    // request; the guard removes the entry on every exit path.
    let cancel_flag = request_id.as_ref().map(|id| {
        let mut map = cancels().lock().unwrap_or_else(|p| p.into_inner());
        map.entry(id.clone()).or_default().clone()
    });
    let _cancel_guard = request_id.clone().map(CancelGuard);
    let is_cancelled =
        || cancel_flag.as_ref().map(|f| f.load(Ordering::Relaxed)).unwrap_or(false);
    if is_cancelled() {
        return Ok(String::new()); // cancelled before we ever fired
    }
    // Shared client; NO total timeout (the old 120s TOTAL cap killed long
    // generations mid-stream). Bounds instead: a headers-timeout around
    // send(), then a per-chunk IDLE timeout in the read loop. No retry — a
    // mid-stream retry would duplicate partial output.
    let client = http_client();
    let anthropic = kind == "anthropic" || kind == "anthropic-compat";

    let send_fut = if anthropic {
        let base = resolve_base(&base_url, "https://api.anthropic.com")?;
        let body = serde_json::json!({
            "model": model,
            "max_tokens": 1024,
            "stream": true,
            "system": system,
            "messages": anthropic_messages(&messages, &prompt),
        });
        client
            .post(format!("{}/v1/messages", base))
            .header("x-api-key", &api_key)
            .header("authorization", format!("Bearer {}", api_key))
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
    } else {
        let base = resolve_base(&base_url, "https://api.openai.com/v1")?;
        let body = serde_json::json!({
            "model": model,
            "stream": true,
            "messages": openai_messages(&messages, &system, &prompt),
        });
        client
            .post(format!("{}/chat/completions", base))
            .header("authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json")
            .json(&body)
            .send()
    };
    let resp = tokio::time::timeout(std::time::Duration::from_secs(30), send_fut)
        .await
        .map_err(|_| "timed out waiting for the provider to respond".to_string())?
        .map_err(send_error)?;

    let status = resp.status();
    if !status.is_success() {
        return Err(stream_http_error(status, resp).await);
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
    // Incomplete trailing UTF-8 bytes carried across network chunks — a
    // multibyte char straddling a chunk boundary must not become U+FFFD
    // (see pty::decode_utf8_stream).
    let mut pending: Vec<u8> = Vec::new();
    loop {
        // Idle timeout between chunks — long generations stream for minutes
        // legitimately; 90s of SILENCE means the stream died.
        let next = tokio::time::timeout(std::time::Duration::from_secs(90), stream.next())
            .await
            .map_err(|_| "stream stalled (no data for 90s)".to_string())?;
        let Some(chunk) = next else { break };
        if is_cancelled() {
            // Dropping resp/stream closes the connection so the provider
            // stops generating; partial text returns quietly (the surface
            // that cancelled has already moved on).
            return Ok(full);
        }
        let bytes = chunk.map_err(|e| e.to_string())?;
        let text = crate::pty::decode_utf8_stream(&mut pending, &bytes);
        buf.push_str(&text.replace("\r\n", "\n"));
        // Process complete SSE events (separated by a blank line).
        while let Some(idx) = buf.find("\n\n") {
            let event: String = buf[..idx].to_string();
            buf = buf[idx + 2..].to_string();
            for line in event.lines() {
                let line = line.trim_start();
                let data = match line.strip_prefix("data:") {
                    Some(d) => d.trim(),
                    None => continue,
                };
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let v: serde_json::Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let piece = if anthropic {
                    v.pointer("/delta/text").and_then(|t| t.as_str())
                } else {
                    v.pointer("/choices/0/delta/content").and_then(|t| t.as_str())
                };
                if let Some(p) = piece {
                    if !p.is_empty() {
                        full.push_str(p);
                        let _ = on_chunk.send(p.to_string());
                    }
                }
            }
        }
    }
    Ok(full)
}

// ── Model discovery ─────────────────────────────────────────────────────────
// The Models picker's lists were typed into providers.js by hand, so a build
// only knew the models that existed when it shipped: v0.7.1 stopped at Claude
// Opus 4.8 and never showed Opus 5.5. Every provider the app routes to
// publishes the models it serves, so the picker now asks: Anthropic's
// GET /v1/models (cursor-paged, newest first) for the two anthropic kinds, the
// OpenAI-style GET {base}/models for everything else. Same key handling and the
// same https rule (resolve_base) as llm_complete.
//
// The answer is untrusted input. A custom endpoint can return anything, and a
// chosen id ends up as ANTHROPIC_MODEL / OPENAI_MODEL in every shell the app
// spawns afterwards. So ids are held to the characters real model ids use
// (anything else is dropped, never repaired), names lose control and bidi
// characters, dates are range-checked, bodies are read under a size cap, and
// the key is taken out of any error text before it leaves this module.

/// One model a provider says it serves. `created` is unix seconds when the
/// provider dates its models (Anthropic `created_at`, OpenAI `created`).
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct ListedModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
}

/// Largest list body read. OpenRouter's catalog, the biggest seen (466 models
/// with descriptions and pricing, measured 2026-10-03), is 0.76 MB, so this is
/// five times it. The cap is also the memory bound: serde_json::Value turns a
/// body of tiny objects into 60x to 85x its size in nodes depending on shape
/// (review 2026-10-03 measured 943 MB of heap from a 16 MB body, and 238 MB to
/// 332 MB at 4 MB), transient and freed when the call returns. llm_complete
/// reads the same endpoints with no cap at all.
const MODEL_LIST_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Most of an error body read: enough for any provider's JSON error message.
const MODEL_LIST_ERROR_BYTES: usize = 64 * 1024;
/// Most models kept from one provider, after cleaning.
const MODEL_LIST_MAX_MODELS: usize = 5000;
/// Most Anthropic pages followed. At limit=1000 (the API's maximum) one page is
/// the whole list; the bound only stops a cursor that never ends.
const MODEL_LIST_MAX_PAGES: usize = 20;
/// Total time for one page, body included (RequestBuilder::timeout semantics).
const MODEL_LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// The latest release date taken at face value: 2100-01-01T00:00:00Z.
const MAX_CREATED_SECS: i64 = 4_102_444_800;

/// The client for list calls. It never follows a redirect: these requests carry
/// the key in `x-api-key`, which reqwest does NOT strip on a cross-host hop
/// (only Authorization and cookies; redirect.rs remove_sensitive_headers), and
/// reqwest's default policy also follows https to http. A model list has no
/// reason to redirect, so a 3xx comes back as an error instead. sync_git.rs
/// turns redirects off for the same reason.
fn list_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent("plutos-terminals")
        .connect_timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
}

static LIST_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn list_client() -> &'static reqwest::Client {
    LIST_CLIENT.get_or_init(|| list_client_builder().build().expect("model-list HTTP client (TLS backend init)"))
}

/// A model id the app may store and later inject at shell spawn, or None.
/// Real ids are ASCII words joined by `-` `.` `_` `:` `/` (plus the odd `@`,
/// `+`, `~` or `=`): `claude-opus-5-5`, `gpt-4o-2024-08-06`,
/// `meta-llama/Llama-3.3-70B-Instruct`, `llama3.1:8b`, `qwen/qwen3:free`.
/// Whitespace, quotes, angle brackets and control characters never appear in
/// one, so an id carrying them is dropped whole.
pub(crate) fn clean_model_id(raw: &str) -> Option<String> {
    let id = raw.trim();
    let allowed = |c: char| {
        c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/' | '@' | '+' | '~' | '=' | '#' | '[' | ']')
    };
    let ok = !id.is_empty() && id.len() <= 200 && !id.starts_with('-') && id.chars().all(allowed);
    ok.then(|| id.to_string())
}

/// A display name with control characters and bidi/zero-width formatting
/// removed (a hostile endpoint could otherwise reorder what the tooltip
/// shows), capped at 120 characters. None when nothing printable is left.
fn clean_model_name(raw: &str) -> Option<String> {
    let s: String = raw
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(
                    *c,
                    '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
                )
        })
        .take(120)
        .collect();
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// Unix seconds from a raw provider date, or None. Seconds are taken as they
/// are; a value in the millisecond, microsecond or nanosecond band is scaled
/// down; anything else (zero, negative, past 2100, or between the bands) reads
/// as undated. Without this a nanosecond `created` reached the picker as a
/// year no JavaScript Date can hold, and formatting it threw during render,
/// which took the whole window down (review 2026-10-03).
fn plausible_secs(n: i64) -> Option<i64> {
    if n <= 0 {
        return None;
    }
    if n <= MAX_CREATED_SECS {
        return Some(n);
    }
    for (floor, per_sec) in [
        (1_000_000_000_000_i64, 1_000_i64),
        (1_000_000_000_000_000, 1_000_000),
        (1_000_000_000_000_000_000, 1_000_000_000),
    ] {
        if n >= floor && n / per_sec <= MAX_CREATED_SECS {
            return Some(n / per_sec);
        }
    }
    None
}

/// Unix seconds from an RFC 3339 date. Anthropic sends the epoch when it does
/// not know a release date, which plausible_secs reads as undated.
fn created_from_rfc3339(s: &str) -> Option<i64> {
    plausible_secs(chrono::DateTime::parse_from_rfc3339(s.trim()).ok()?.timestamp())
}

/// Unix seconds from a numeric `created`.
fn created_from_number(v: &serde_json::Value) -> Option<i64> {
    let n = v.as_i64().or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))?;
    plausible_secs(n)
}

/// The provider's own message in an error-shaped JSON body, trimmed and capped:
/// `error.message` (OpenAI, Anthropic), `message`, `msg` (Z.AI), or `error`
/// as a plain string.
fn body_message(v: &serde_json::Value) -> Option<String> {
    v.pointer("/error/message")
        .and_then(|m| m.as_str())
        .or_else(|| v.get("message").and_then(|m| m.as_str()))
        .or_else(|| v.get("msg").and_then(|m| m.as_str()))
        .or_else(|| v.get("error").and_then(|m| m.as_str()))
        .map(|m| m.trim().chars().take(300).collect::<String>())
        .filter(|m| !m.is_empty())
}

/// The array of model entries in a list body: `{"data": [...]}` (Anthropic,
/// OpenAI and nearly every compatible server), a bare array (Together), or
/// `{"models": [...]}`. Anything else is an error, never an empty list: Z.AI
/// answers a refused key with HTTP 200 and `{"code":401,"msg":"token expired
/// or incorrect"}` (checked live 2026-10-03), and reading that as "no models"
/// hid the refusal and suppressed refreshes for an hour.
///
/// A list key that is present but null is an empty list only when the body is
/// nothing but a list envelope: Ollama with no models pulled answers
/// `{"object":"list","data":null}` (Go writes a nil slice as null). Any other
/// key means the body is saying something else, and refusals come in too many
/// shapes to enumerate (`{"code":401,"msg":...,"data":null,"success":false}`,
/// `{"data":null,"status":401,"detail":...}`, MiniMax's `base_resp`; review
/// rounds 3 and 4), so those are errors. A real array always wins, checked
/// first, so `data: [...]` beside `models: null` keeps its list.
fn list_entries(v: &serde_json::Value) -> Result<&Vec<serde_json::Value>, String> {
    static EMPTY: Vec<serde_json::Value> = Vec::new();
    if let Some(arr) = v
        .as_array()
        .or_else(|| v.get("data").and_then(|d| d.as_array()))
        .or_else(|| v.get("models").and_then(|d| d.as_array()))
    {
        return Ok(arr);
    }
    let null_list = v.get("data").is_some_and(|d| d.is_null()) || v.get("models").is_some_and(|d| d.is_null());
    let bare_envelope = v.as_object().is_some_and(|o| {
        o.keys()
            .all(|k| matches!(k.as_str(), "object" | "data" | "models" | "has_more" | "first_id" | "last_id"))
    });
    if null_list && bare_envelope {
        return Ok(&EMPTY);
    }
    Err(match body_message(v) {
        Some(m) => format!("The provider answered without a model list: {m}"),
        None => "The provider answered without a model list.".to_string(),
    })
}

/// One page of Anthropic's GET /v1/models: the models, plus the `after_id`
/// cursor for the next page when `has_more` says there is one. A compatible
/// gateway may answer in the OpenAI shape instead, so a numeric `created` is
/// accepted when `created_at` is absent.
fn parse_anthropic_page(v: &serde_json::Value) -> Result<(Vec<ListedModel>, Option<String>), String> {
    let models = list_entries(v)?
        .iter()
        .filter_map(|m| {
            let id = clean_model_id(m.get("id")?.as_str()?)?;
            let name = m.get("display_name").and_then(|n| n.as_str()).and_then(clean_model_name);
            let created = m
                .get("created_at")
                .and_then(|c| c.as_str())
                .and_then(created_from_rfc3339)
                .or_else(|| m.get("created").and_then(created_from_number));
            Some(ListedModel { id, name, created })
        })
        .collect();
    let next = if v.get("has_more").and_then(|h| h.as_bool()) == Some(true) {
        v.get("last_id")
            .and_then(|l| l.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    } else {
        None
    };
    Ok((models, next))
}

/// An OpenAI-style model list (see list_entries for the shapes). An entry's id
/// is `id`, else `name`.
fn parse_openai_list(v: &serde_json::Value) -> Result<Vec<ListedModel>, String> {
    Ok(list_entries(v)?
        .iter()
        .filter_map(|m| {
            let raw_id = m
                .get("id")
                .and_then(|i| i.as_str())
                .or_else(|| m.get("name").and_then(|n| n.as_str()))?;
            let id = clean_model_id(raw_id)?;
            let name = m
                .get("name")
                .and_then(|n| n.as_str())
                .filter(|n| *n != raw_id)
                .or_else(|| m.get("display_name").and_then(|n| n.as_str()))
                .and_then(clean_model_name);
            let created = m
                .get("created")
                .and_then(created_from_number)
                .or_else(|| m.get("created_at").and_then(|c| c.as_str()).and_then(created_from_rfc3339));
            Some(ListedModel { id, name, created })
        })
        .collect())
}

/// Read at most `cap` bytes of a body. Returns the bytes and whether the body
/// ran past the cap; reading stops there and the rest is never pulled.
async fn read_capped(resp: reqwest::Response, cap: usize) -> Result<(Vec<u8>, bool), String> {
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        let room = cap - buf.len();
        if chunk.len() > room {
            buf.extend_from_slice(&chunk[..room]);
            return Ok((buf, true));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok((buf, false))
}

/// One list page as JSON, or "HTTP <code>: <message>". The status leads so the
/// picker can tell a missing list endpoint (404) from a refused key (401)
/// without reading prose.
async fn list_page_json(resp: reqwest::Response, cap: usize) -> Result<serde_json::Value, String> {
    let status = resp.status();
    if !status.is_success() {
        let (body, _) = read_capped(resp, MODEL_LIST_ERROR_BYTES).await.unwrap_or_default();
        let msg = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| body_message(&v))
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("error").to_string());
        return Err(format!("HTTP {}: {msg}", status.as_u16()));
    }
    let too_large = || format!("The provider's model list is larger than {} MB, so it was not read.", cap / (1024 * 1024));
    if resp.content_length().is_some_and(|n| n > cap as u64) {
        return Err(too_large());
    }
    let (body, truncated) = read_capped(resp, cap).await?;
    if truncated {
        return Err(too_large());
    }
    serde_json::from_slice(&body).map_err(|_| "The provider's model list was not valid JSON.".to_string())
}

/// An error text with the request's key taken out, for the screen. (The cache
/// never stores provider wording at all: modelCatalog.js keeps only a fixed
/// summary, because no redaction can promise to catch every echo.) Covers the
/// whole key; a word that IS the key, any case, which is how a short key (a
/// LiteLLM master key like `sk-1234`) gets caught; a word holding the key's
/// first 12 characters, any case (a truncated echo); a word with a run of
/// asterisks, the way OpenAI quotes a key's ends; and a word that abbreviates
/// the key around "...", the way LiteLLM quotes it (`sk-...abcd`). Words split
/// on any whitespace, and the whitespace itself is kept.
fn redact_key(msg: &str, key: &str) -> String {
    let key = key.trim();
    let key_lc = key.to_ascii_lowercase();
    let msg = if key.len() >= 8 { msg.replace(key, "[your key]") } else { msg.to_string() };
    let head_lc = if key.len() >= 16 { key_lc.get(..12) } else { None };
    // A short key with no digit is a documented placeholder (Ollama's
    // "ollama", vLLM's "EMPTY"), not a secret, and matching it as a word only
    // scrubs ordinary text ("the list is empty"). Real short keys
    // (LiteLLM's "sk-1234") carry digits.
    let word_rule = key.len() >= 8 || (key.len() >= 4 && key.chars().any(|c| c.is_ascii_digit()));
    let is_key_word = |word: &str| {
        let lc = word.to_ascii_lowercase();
        let bare = lc.trim_matches(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '-' | '_'));
        (word_rule && bare == key_lc)
            || word.contains("***")
            || head_lc.is_some_and(|h| lc.contains(h))
            || lc.split_once("...").is_some_and(|(pre, _)| {
                let pre = pre.trim_start_matches(|c: char| !c.is_ascii_alphanumeric());
                pre.len() >= 2 && key_lc.starts_with(pre)
            })
    };
    // The key-shaped middle of a word, so quotes, backticks and trailing
    // punctuation around it survive ("`sk-1234`." becomes "`[key]`.").
    let core = |word: &str| -> (usize, usize) {
        let start = word.find(|c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '*' | '.'));
        let end = word.rfind(|c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '*')).map(|i| i + 1);
        match (start, end) {
            (Some(s), Some(e)) if s < e => (s, e),
            _ => (0, word.len()),
        }
    };
    let mut out = String::with_capacity(msg.len());
    for piece in msg.split_inclusive(char::is_whitespace) {
        let (word, sep) = match piece.char_indices().last() {
            Some((i, c)) if c.is_whitespace() => (&piece[..i], &piece[i..]),
            _ => (piece, ""),
        };
        if is_key_word(word) {
            let (s, e) = core(word);
            out.push_str(&word[..s]);
            out.push_str("[key]");
            out.push_str(&word[e..]);
        } else {
            out.push_str(word);
        }
        out.push_str(sep);
    }
    out
}

/// [`llm_list_models`] with the client and the body cap injected, so tests can
/// run it against a loopback server with a fresh client and a small cap.
async fn list_models_with(
    client: &reqwest::Client,
    kind: &str,
    base_url: &str,
    api_key: &str,
    cap: usize,
) -> Result<Vec<ListedModel>, String> {
    list_models_unredacted(client, kind, base_url, api_key, cap)
        .await
        .map_err(|e| redact_key(&e, api_key))
}

async fn list_models_unredacted(
    client: &reqwest::Client,
    kind: &str,
    base_url: &str,
    api_key: &str,
    cap: usize,
) -> Result<Vec<ListedModel>, String> {
    if api_key.trim().is_empty() {
        return Err("No API key is set for this provider.".to_string());
    }
    let mut models: Vec<ListedModel> = Vec::new();
    if kind == "anthropic" || kind == "anthropic-compat" {
        let base = resolve_base(base_url, "https://api.anthropic.com")?;
        let mut after: Option<String> = None;
        for _ in 0..MODEL_LIST_MAX_PAGES {
            let mut req = client
                .get(format!("{base}/v1/models"))
                .timeout(MODEL_LIST_TIMEOUT)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .query(&[("limit", "1000")]);
            // Compatible gateways take the key as a bearer token, the way Claude
            // Code sends ANTHROPIC_AUTH_TOKEN (same pairing as llm_complete).
            // Anthropic itself gets x-api-key alone.
            if kind == "anthropic-compat" {
                req = req.header("authorization", format!("Bearer {api_key}"));
            }
            if let Some(cursor) = &after {
                req = req.query(&[("after_id", cursor.as_str())]);
            }
            let page = list_page_json(send_with_retry(req).await?, cap).await?;
            let (found, next) = parse_anthropic_page(&page)?;
            models.extend(found);
            match next {
                // A cursor that repeats would loop forever; stop instead.
                Some(n) if after.as_deref() != Some(n.as_str()) && models.len() < MODEL_LIST_MAX_MODELS => {
                    after = Some(n)
                }
                _ => break,
            }
        }
    } else {
        let base = resolve_base(base_url, "https://api.openai.com/v1")?;
        let req = client
            .get(format!("{base}/models"))
            .timeout(MODEL_LIST_TIMEOUT)
            .header("authorization", format!("Bearer {api_key}"));
        models = parse_openai_list(&list_page_json(send_with_retry(req).await?, cap).await?)?;
    }
    let mut seen = std::collections::HashSet::new();
    models.retain(|m| seen.insert(m.id.clone()));
    models.truncate(MODEL_LIST_MAX_MODELS);
    Ok(models)
}

/// List the models a provider serves to this key, newest first where the
/// provider dates them. `kind` and `base_url` follow llm_complete: the two
/// anthropic kinds ask GET {base}/v1/models, everything else GET {base}/models.
#[tauri::command]
pub async fn llm_list_models(kind: String, base_url: String, api_key: String) -> Result<Vec<ListedModel>, String> {
    list_models_with(list_client(), &kind, &base_url, &api_key, MODEL_LIST_MAX_BYTES).await
}

#[cfg(test)]
pub(crate) mod list_models_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    pub(crate) type Heads = Arc<Mutex<Vec<String>>>;

    /// A loopback HTTP server: every connection gets the raw response `respond`
    /// builds from the request head, and every head is kept (lowercased) for
    /// assertions. Loopback is the one place resolve_base allows cleartext,
    /// which is what lets these tests drive the real request path.
    pub(crate) async fn serve(respond: impl Fn(&str) -> String + Send + Sync + 'static) -> (String, Heads) {
        let respond = Arc::new(respond);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let heads: Heads = Arc::new(Mutex::new(Vec::new()));
        let seen = heads.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let seen = seen.clone();
                let respond = respond.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut tmp).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                        }
                    }
                    let head = String::from_utf8_lossy(&buf).to_ascii_lowercase();
                    seen.lock().unwrap().push(head.clone());
                    let _ = sock.write_all(respond(&head).as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (format!("http://127.0.0.1:{port}"), heads)
    }

    pub(crate) fn json(status: u16, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// The production client's settings (no redirects), minus proxies so a
    /// developer machine's proxy env cannot intercept loopback.
    fn client() -> reqwest::Client {
        list_client_builder().no_proxy().build().unwrap()
    }

    fn ids(models: &[ListedModel]) -> Vec<&str> {
        models.iter().map(|m| m.id.as_str()).collect()
    }

    #[tokio::test]
    async fn anthropic_follows_the_cursor_with_the_key_header_only() {
        let (base, heads) = serve(|head| {
            if head.contains("after_id=claude-b") {
                json(200, r#"{"data":[{"id":"claude-c","display_name":"Claude C","created_at":"2025-01-01T00:00:00Z"}],"has_more":false,"first_id":"claude-c","last_id":"claude-c"}"#)
            } else {
                json(200, r#"{"data":[{"id":"claude-a","display_name":"Claude A","created_at":"2026-09-01T00:00:00Z"},{"id":"claude-b","display_name":"Claude B","created_at":"1970-01-01T00:00:00Z"}],"has_more":true,"first_id":"claude-a","last_id":"claude-b"}"#)
            }
        })
        .await;
        let models = list_models_with(&client(), "anthropic", &base, "sk-test", MODEL_LIST_MAX_BYTES)
            .await
            .unwrap();
        assert_eq!(ids(&models), ["claude-a", "claude-b", "claude-c"]);
        assert_eq!(models[0].name.as_deref(), Some("Claude A"));
        assert_eq!(models[0].created, Some(1_788_220_800)); // 2026-09-01T00:00:00Z
        assert_eq!(models[1].created, None, "the epoch means undated");
        let heads = heads.lock().unwrap();
        assert_eq!(heads.len(), 2);
        assert!(heads[0].starts_with("get /v1/models?limit=1000 "), "{}", heads[0]);
        assert!(heads[1].contains("after_id=claude-b"));
        for h in heads.iter() {
            assert!(h.contains("x-api-key: sk-test"));
            assert!(h.contains("anthropic-version: 2023-06-01"));
            assert!(!h.contains("authorization:"), "native Anthropic gets x-api-key alone");
        }
    }

    #[tokio::test]
    async fn anthropic_compat_also_sends_the_key_as_a_bearer_token() {
        let (base, heads) = serve(|_| json(200, r#"{"data":[{"id":"kimi-k2.5"}],"has_more":false}"#)).await;
        let models = list_models_with(&client(), "anthropic-compat", &format!("{base}/anthropic"), "sk-test", MODEL_LIST_MAX_BYTES)
            .await
            .unwrap();
        assert_eq!(ids(&models), ["kimi-k2.5"]);
        let heads = heads.lock().unwrap();
        assert!(heads[0].starts_with("get /anthropic/v1/models?limit=1000 "), "{}", heads[0]);
        assert!(heads[0].contains("authorization: bearer sk-test"));
        assert!(heads[0].contains("x-api-key: sk-test"));
    }

    #[tokio::test]
    async fn a_repeating_cursor_stops_instead_of_looping() {
        let (base, heads) = serve(|_| json(200, r#"{"data":[{"id":"m1"}],"has_more":true,"last_id":"m1"}"#)).await;
        let models = list_models_with(&client(), "anthropic", &base, "k", MODEL_LIST_MAX_BYTES).await.unwrap();
        assert_eq!(ids(&models), ["m1"], "duplicates across pages are dropped");
        assert_eq!(heads.lock().unwrap().len(), 2, "page 2 repeats the cursor, so the walk ends there");
    }

    #[tokio::test]
    async fn openai_style_lists_use_bearer_and_read_created() {
        let (base, heads) = serve(|_| {
            json(200, r#"{"object":"list","data":[{"id":"gpt-5","object":"model","created":1767225600,"owned_by":"openai"},{"id":"text-embedding-3-large","created":1705953180000}]}"#)
        })
        .await;
        let models = list_models_with(&client(), "openai", &format!("{base}/v1"), "sk-oa", MODEL_LIST_MAX_BYTES)
            .await
            .unwrap();
        // Non-chat filtering is the picker's job (modelCatalog.js), not this one's.
        assert_eq!(ids(&models), ["gpt-5", "text-embedding-3-large"]);
        assert_eq!(models[0].created, Some(1_767_225_600));
        assert_eq!(models[1].created, Some(1_705_953_180), "milliseconds are read as ms");
        let heads = heads.lock().unwrap();
        assert!(heads[0].starts_with("get /v1/models "), "{}", heads[0]);
        assert!(heads[0].contains("authorization: bearer sk-oa"));
        assert!(!heads[0].contains("x-api-key"));
    }

    #[tokio::test]
    async fn a_provider_error_leads_with_its_status_code() {
        let (base, _) = serve(|_| {
            json(401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#)
        })
        .await;
        let err = list_models_with(&client(), "anthropic", &base, "bad", MODEL_LIST_MAX_BYTES).await.unwrap_err();
        assert_eq!(err, "HTTP 401: invalid x-api-key");

        let (base, _) = serve(|_| "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string()).await;
        let err = list_models_with(&client(), "openai", &base, "k", MODEL_LIST_MAX_BYTES).await.unwrap_err();
        assert_eq!(err, "HTTP 404: Not Found", "no JSON message: the status reason stands in");
    }

    #[tokio::test]
    async fn a_200_without_a_list_is_an_error_not_an_empty_list() {
        // Z.AI's answer to a refused key on its Claude-compatible list path.
        let (base, _) = serve(|_| json(200, r#"{"code":401,"msg":"token expired or incorrect","success":false}"#)).await;
        let err = list_models_with(&client(), "anthropic-compat", &base, "k", MODEL_LIST_MAX_BYTES).await.unwrap_err();
        assert_eq!(err, "The provider answered without a model list: token expired or incorrect");
    }

    #[tokio::test]
    async fn a_declared_size_over_the_cap_is_refused_before_reading() {
        // Declares 50 MB, sends 13 bytes, hangs up. Only the content-length
        // check can call this "too large"; without it the read would end in a
        // truncated-body error instead, so this discriminates.
        let (base, _) = serve(|_| {
            "HTTP/1.1 200 X\r\ncontent-type: application/json\r\ncontent-length: 50000000\r\nconnection: close\r\n\r\n{\"data\":[]}..".to_string()
        })
        .await;
        let err = list_models_with(&client(), "openai", &base, "k", MODEL_LIST_MAX_BYTES).await.unwrap_err();
        assert!(err.contains("larger than 4 MB"), "{err}");
    }

    #[tokio::test]
    async fn an_undeclared_oversized_body_stops_at_the_cap() {
        let (base, _) = serve(|_| {
            let body = format!(r#"{{"data":[{{"id":"{}"}}]}}"#, "a".repeat(5000));
            format!("HTTP/1.1 200 X\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{body}")
        })
        .await;
        let err = list_models_with(&client(), "openai", &base, "k", 1024).await.unwrap_err();
        assert!(err.contains("larger than"), "{err}");
    }

    #[tokio::test]
    async fn redirects_are_not_followed() {
        let (elsewhere, elsewhere_heads) = serve(|_| json(200, r#"{"data":[{"id":"stolen"}]}"#)).await;
        let target = format!("{elsewhere}/v1/models");
        let (base, _) = serve(move |_| {
            format!("HTTP/1.1 302 Found\r\nlocation: {target}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
        })
        .await;
        let err = list_models_with(&client(), "anthropic", &base, "sk-ant-secret", MODEL_LIST_MAX_BYTES).await.unwrap_err();
        assert!(err.starts_with("HTTP 302"), "{err}");
        assert!(elsewhere_heads.lock().unwrap().is_empty(), "the key must not reach the redirect target");
    }

    #[tokio::test]
    async fn the_key_is_taken_out_of_error_text() {
        static CASE: AtomicUsize = AtomicUsize::new(0);
        let (base, _) = serve(|_| match CASE.load(std::sync::atomic::Ordering::SeqCst) {
            // A debug gateway echoing the whole key.
            0 => json(401, r#"{"error":{"message":"Invalid API key: sk-or-v1-0123456789abcdef0123456789"}}"#),
            // OpenAI's refusal: the key's ends around a row of asterisks.
            1 => json(401, r#"{"error":{"message":"Incorrect API key provided: sk-or-v1********************6789. You can find your API key at https://platform.openai.com/account/api-keys."}}"#),
            // A gateway that echoes a truncated key.
            2 => json(401, r#"{"error":{"message":"unknown token sk-or-v1-0123456789abc for this route"}}"#),
            // LiteLLM's refusal: the key abbreviated around "...".
            3 => json(401, r#"{"error":{"message":"Received API Key = sk-...6789, Key Hash (Token) =9f2c"}}"#),
            // An upper-cased truncated echo.
            _ => json(401, r#"{"error":{"message":"bad token SK-OR-V1-0123456789ABC"}}"#),
        })
        .await;
        let key = "sk-or-v1-0123456789abcdef0123456789";
        for case in 0..5 {
            CASE.store(case, std::sync::atomic::Ordering::SeqCst);
            let err = list_models_with(&client(), "openai", &base, key, MODEL_LIST_MAX_BYTES).await.unwrap_err();
            assert!(!err.to_ascii_lowercase().contains("0123456789"), "case {case}: {err}");
            assert!(!err.contains("****"), "case {case}: {err}");
            assert!(!err.contains("...6789"), "case {case}: {err}");
            assert!(err.starts_with("HTTP 401: "), "case {case}: {err}");
        }
    }

    #[test]
    fn redaction_catches_short_keys_and_keeps_the_layout() {
        // A short proxy master key, standing alone, any case, its punctuation kept.
        assert_eq!(redact_key("invalid key `SK-1234`.\nretry", "sk-1234"), "invalid key `[key]`.\nretry");
        assert_eq!(redact_key("Received API Key = sk-...6789, Key Hash", "sk-or-v1-0123456789"), "Received API Key = [key], Key Hash");
        // Whitespace (newline, tab, double space) survives untouched.
        assert_eq!(
            redact_key("a\tb  c\nsk-or-v1-0123456789abcdef", "sk-or-v1-0123456789abcdef0123"),
            "a\tb  c\n[key]"
        );
    }

    #[test]
    fn redaction_leaves_text_alone_when_there_is_nothing_to_hide() {
        assert_eq!(redact_key("HTTP 404: url.not_found", "sk-anything-long-enough"), "HTTP 404: url.not_found");
        assert_eq!(redact_key("Loading... please wait", "sk-anything-long-enough"), "Loading... please wait");
        // A key too short to search for safely is not used as a pattern.
        assert_eq!(redact_key("a key is required", "k"), "a key is required");
        // Documented placeholder keys are not secrets and do not scrub words.
        assert_eq!(redact_key("no models: try `ollama pull`", "ollama"), "no models: try `ollama pull`");
        assert_eq!(redact_key("the list is empty", "EMPTY"), "the list is empty");
    }

    #[test]
    fn a_null_list_from_a_server_with_no_models_is_an_empty_list() {
        // Ollama with nothing pulled (Go writes a nil slice as null).
        let v = serde_json::json!({ "object": "list", "data": null });
        assert!(parse_openai_list(&v).unwrap().is_empty());
        assert!(parse_anthropic_page(&v).unwrap().0.is_empty());
    }

    #[test]
    fn a_null_list_never_hides_a_refusal_or_a_real_list() {
        for refusal in [
            serde_json::json!({ "code": 401, "msg": "token expired or incorrect", "data": null, "success": false }),
            serde_json::json!({ "data": null, "error": { "message": "Incorrect API key provided" } }),
            serde_json::json!({ "data": null, "success": false }),
            serde_json::json!({ "code": 403, "data": null }),
            // Refusal shapes no signal list would enumerate (review round 4).
            serde_json::json!({ "data": null, "error": { "code": "invalid_api_key" } }),
            serde_json::json!({ "data": null, "code": "401" }),
            serde_json::json!({ "data": null, "status": 401, "detail": "Unauthorized" }),
            serde_json::json!({ "data": null, "base_resp": { "status_code": 1004 } }),
        ] {
            assert!(parse_openai_list(&refusal).is_err(), "{refusal}");
        }
        let both = serde_json::json!({ "data": [{ "id": "gpt-5" }], "models": null });
        assert_eq!(ids(&parse_openai_list(&both).unwrap()), ["gpt-5"]);
    }

    #[tokio::test]
    async fn cleartext_to_a_public_host_is_refused_before_any_request() {
        let err = list_models_with(&client(), "openai", "http://example.com/v1", "k", MODEL_LIST_MAX_BYTES)
            .await
            .unwrap_err();
        assert!(err.contains("non-HTTPS"), "{err}");
    }

    #[tokio::test]
    async fn an_empty_key_is_refused_without_a_request() {
        let err = list_models_with(&client(), "anthropic", "", "  ", MODEL_LIST_MAX_BYTES).await.unwrap_err();
        assert!(err.contains("No API key"), "{err}");
    }

    #[test]
    fn dates_are_scaled_to_seconds_and_range_checked() {
        let s = 1_727_000_000_i64; // 2024-09-22
        assert_eq!(plausible_secs(s), Some(s));
        assert_eq!(plausible_secs(s * 1_000), Some(s), "ms");
        assert_eq!(plausible_secs(s * 1_000_000), Some(s), "us");
        assert_eq!(plausible_secs(s * 1_000_000_000), Some(s), "ns (the value that crashed the picker)");
        for bad in [0, -5, 5_000_000_000, i64::MAX] {
            assert_eq!(plausible_secs(bad), None, "{bad}");
        }
        assert_eq!(created_from_number(&serde_json::json!(1e300)), None);
        assert_eq!(created_from_number(&serde_json::json!(1_727_000_000.5)), Some(s));
        assert_eq!(created_from_rfc3339("9999-12-31T23:59:59Z"), None, "past 2100");
        assert_eq!(created_from_rfc3339("1970-01-01T00:00:00Z"), None, "Anthropic's unknown date");
    }

    #[test]
    fn hostile_ids_are_dropped_not_repaired() {
        let v = serde_json::json!({ "data": [
            { "id": "ok-model:1" },
            { "id": "bad\nid" },
            { "id": "<img src=x onerror=alert(1)>" },
            { "id": "has space" },
            { "id": "\"quoted\"" },
            { "id": "$(rm -rf ~)" },
            { "id": "a".repeat(201) },
            { "id": "" },
            { "id": 42 },
            { "name": "named/only:latest" },
        ]});
        assert_eq!(ids(&parse_openai_list(&v).unwrap()), ["ok-model:1", "named/only:latest"]);
    }

    #[test]
    fn names_lose_control_and_bidi_characters() {
        assert_eq!(clean_model_name("Claude\u{202E}evil\u{0007} Opus\u{061C}"), Some("Claudeevil Opus".into()));
        assert_eq!(clean_model_name(" \u{200B} "), None);
        assert_eq!(clean_model_name(&"x".repeat(500)).map(|s| s.len()), Some(120));
    }

    #[test]
    fn list_shapes_bare_array_and_models_key_and_no_list() {
        let bare = serde_json::json!([{ "id": "together/m1", "created": 1700000000 }]);
        assert_eq!(ids(&parse_openai_list(&bare).unwrap()), ["together/m1"]);
        let models_key = serde_json::json!({ "models": [{ "name": "llama3.1:8b" }] });
        assert_eq!(ids(&parse_openai_list(&models_key).unwrap()), ["llama3.1:8b"]);
        let err = parse_openai_list(&serde_json::json!({ "error": "nope" })).unwrap_err();
        assert_eq!(err, "The provider answered without a model list: nope");
        assert!(parse_anthropic_page(&serde_json::json!({ "type": "error" })).is_err());
        // An honest empty list is still a list.
        assert!(parse_openai_list(&serde_json::json!({ "data": [] })).unwrap().is_empty());
    }

    #[test]
    fn openrouter_names_are_kept_when_they_differ_from_the_id() {
        let v = serde_json::json!({ "data": [
            { "id": "anthropic/claude-opus-5.5", "name": "Anthropic: Claude Opus 5.5", "created": 1760000000 },
            { "id": "same", "name": "same" },
        ]});
        let m = parse_openai_list(&v).unwrap();
        assert_eq!(m[0].name.as_deref(), Some("Anthropic: Claude Opus 5.5"));
        assert_eq!(m[1].name, None);
    }

    #[test]
    fn anthropic_page_without_has_more_has_no_cursor() {
        let (m, next) = parse_anthropic_page(&serde_json::json!({ "data": [{ "id": "a" }], "last_id": "a" })).unwrap();
        assert_eq!(ids(&m), ["a"]);
        assert_eq!(next, None);
    }
}

#[cfg(test)]
mod redirect_tests {
    use super::list_models_tests::{json, serve};
    use super::*;

    fn url(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).unwrap()
    }

    /// The production client's settings, minus proxies so a developer
    /// machine's proxy env cannot intercept loopback.
    fn client() -> reqwest::Client {
        shared_client_builder().no_proxy().build().unwrap()
    }

    fn redirect(status: &str, location: &str) -> String {
        format!("HTTP/1.1 {status}\r\nlocation: {location}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
    }

    /// The loopback server under its host NAME, for the tests that need two
    /// spellings of one server (a name and an IP address are different hosts).
    fn named(base: &str) -> String {
        base.replace("127.0.0.1", "localhost")
    }

    fn port_of(base: &str) -> String {
        base.rsplit(':').next().unwrap().to_string()
    }

    #[test]
    fn only_same_host_same_port_redirects_that_keep_https_are_allowed() {
        let api = url("https://api.example.com/v1/messages");
        assert!(redirect_allowed(&api, &url("https://api.example.com/v1/messages/")));
        assert!(redirect_allowed(&api, &url("https://API.example.com/v2/messages")));
        assert!(redirect_allowed(&api, &url("https://api.example.com:443/v1")), "443 is https's own port");
        assert!(!redirect_allowed(&api, &url("https://api.example.com:8443/v1")), "another port can be another service");
        assert!(!redirect_allowed(&api, &url("http://api.example.com/v1/messages")), "a downgrade sends the key in cleartext");
        assert!(
            !redirect_allowed(&url("https://gw.example:8443/v1"), &url("http://gw.example:8443/v1")),
            "a downgrade that keeps the port is still a downgrade"
        );
        assert!(!redirect_allowed(&api, &url("https://evil.example/v1/messages")));
        assert!(!redirect_allowed(&api, &url("https://api.example.com.evil.example/v1")));
        assert!(!redirect_allowed(&api, &url("ftp://api.example.com/v1")), "not a web address");
        assert!(!redirect_allowed(&api, &url("file:///etc/passwd")));
        let lan = url("http://gateway.local:8080/v1");
        assert!(redirect_allowed(&lan, &url("http://gateway.local:8080/v1/")));
        assert!(redirect_allowed(&lan, &url("https://gateway.local/v1")), "an upgrade onto https's own port");
        assert!(!redirect_allowed(&lan, &url("https://gateway.local:8443/v1")), "an upgrade that also moves port");
        assert!(!redirect_allowed(&lan, &url("http://gateway.local:9090/v1")));
        assert!(!redirect_allowed(&lan, &url("ws://gateway.local:8080/v1")));
    }

    #[test]
    fn a_base_given_as_an_ip_address_follows_a_same_address_redirect() {
        // FastMCP answers /mcp with a 307 to /mcp/, and local MCP servers are
        // usually configured as http://127.0.0.1:port.
        for base in ["http://127.0.0.1:8000/mcp", "http://192.168.1.50:8080/v1", "http://[::1]:8080/v1"] {
            let b = url(base);
            assert!(redirect_allowed(&b, &b.join("/mcp/").unwrap()), "{base}");
        }
        assert!(!redirect_allowed(&url("http://127.0.0.1:8000/mcp"), &url("http://127.0.0.2:8000/mcp/")));
        assert!(!redirect_allowed(&url("http://127.0.0.1:8000/mcp"), &url("http://localhost:8000/mcp/")));
    }

    #[test]
    fn a_refused_redirect_says_where_it_pointed_and_never_the_full_address() {
        let msg = |status: reqwest::StatusCode, from: &str, location: Option<&str>| {
            let mut h = reqwest::header::HeaderMap::new();
            if let Some(l) = location {
                h.insert(reqwest::header::LOCATION, l.parse().unwrap());
            }
            refused_redirect_message(status, &h, &url(from))
        };
        let api = "https://api.example.com/v1/messages";
        let m = msg(reqwest::StatusCode::TEMPORARY_REDIRECT, api, Some("https://evil.example/collect?k=1")).unwrap();
        assert!(m.starts_with("307 Temporary Redirect: the provider redirected to another host (evil.example)."), "{m}");
        assert!(!m.contains("collect"), "{m}");
        let m = msg(reqwest::StatusCode::MOVED_PERMANENTLY, api, Some("http://api.example.com/v1/messages")).unwrap();
        assert!(m.contains("redirected to plain http."), "{m}");
        let m = msg(reqwest::StatusCode::FOUND, api, Some("https://api.example.com:8443/v1")).unwrap();
        assert!(m.contains("redirected to another port (8443)."), "{m}");
        let m = msg(reqwest::StatusCode::FOUND, api, Some("javascript:alert(1)")).unwrap();
        assert!(m.contains("redirected to an address that is not http or https."), "{m}");
        // No Location is no redirect to describe: 304, 300, a bare 301.
        assert_eq!(msg(reqwest::StatusCode::NOT_MODIFIED, api, None), None);
        assert_eq!(msg(reqwest::StatusCode::MULTIPLE_CHOICES, api, None), None);
        assert_eq!(msg(reqwest::StatusCode::MOVED_PERMANENTLY, api, None), None);
        assert_eq!(msg(reqwest::StatusCode::NOT_FOUND, api, Some("https://evil.example/")), None);
    }

    #[tokio::test]
    async fn a_same_host_redirect_is_followed_with_the_key() {
        let (base, heads) = serve(|head| {
            if head.starts_with("get /a ") { redirect("302 Found", "/b") } else { json(200, "{}") }
        })
        .await;
        let resp = client().get(format!("{}/a", named(&base))).header("x-api-key", "sk-test").send().await.unwrap();
        assert_eq!(resp.status(), 200);
        let heads = heads.lock().unwrap();
        assert_eq!(heads.len(), 2);
        assert!(heads[1].starts_with("get /b "), "{}", heads[1]);
        assert!(heads[1].contains("x-api-key: sk-test"));
    }

    #[tokio::test]
    async fn a_redirect_to_another_host_never_carries_the_key_there() {
        // The same server and port under another host name, so the host alone
        // is what refuses the hop: the server must never see a second request.
        let port = std::sync::Arc::new(std::sync::OnceLock::<String>::new());
        let p = port.clone();
        let (base, heads) = serve(move |head| {
            if head.starts_with("post /v1/messages ") {
                redirect("307 Temporary Redirect", &format!("http://127.0.0.1:{}/steal", p.get().unwrap()))
            } else {
                json(200, "{}")
            }
        })
        .await;
        port.set(port_of(&base)).unwrap();
        let resp = client()
            .post(format!("{}/v1/messages", named(&base)))
            .header("x-api-key", "sk-secret")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 307);
        let msg = http_error(resp.status(), resp).await;
        assert!(msg.contains("another host (127.0.0.1)"), "{msg}");
        assert!(!msg.contains("sk-secret"));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let heads = heads.lock().unwrap();
        assert_eq!(heads.len(), 1, "the key reached the other host: {heads:?}");
    }

    #[tokio::test]
    async fn a_redirect_to_another_port_never_carries_the_key_there() {
        let (other, other_heads) = serve(|_| json(200, "{}")).await;
        let other_port = port_of(&other);
        let (base, _) = serve(move |_| redirect("307 Temporary Redirect", &format!("http://localhost:{other_port}/steal"))).await;
        let resp = client()
            .post(format!("{}/v1/messages", named(&base)))
            .header("x-api-key", "sk-secret")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 307);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(other_heads.lock().unwrap().is_empty(), "the key reached another port");
    }

    #[tokio::test]
    async fn a_base_given_as_an_ip_address_follows_a_same_address_redirect_with_the_key() {
        let (base, heads) = serve(|head| {
            if head.starts_with("get /mcp ") { redirect("307 Temporary Redirect", "/mcp/") } else { json(200, "{}") }
        })
        .await;
        let resp = client().get(format!("{base}/mcp")).header("x-api-key", "sk-test").send().await.unwrap();
        assert_eq!(resp.status(), 200);
        let heads = heads.lock().unwrap();
        assert_eq!(heads.len(), 2);
        assert!(heads[1].starts_with("get /mcp/ ") && heads[1].contains("x-api-key: sk-test"), "{}", heads[1]);
    }

    #[tokio::test]
    async fn the_stream_reports_a_refused_redirect_too() {
        let (base, _) = serve(|_| redirect("307 Temporary Redirect", "https://evil.example/v1/messages")).await;
        let resp = client().post(format!("{}/v1/messages", named(&base))).body("{}").send().await.unwrap();
        let msg = stream_http_error(resp.status(), resp).await;
        assert!(msg.contains("another host (evil.example)"), "{msg}");
    }

    #[tokio::test]
    async fn an_endless_same_host_chain_stops_without_echoing_an_address() {
        let (base, heads) = serve(|head| {
            let n: usize = head
                .split_whitespace()
                .nth(1)
                .and_then(|path| path.trim_start_matches("/hop").parse().ok())
                .unwrap_or(0);
            redirect("302 Found", &format!("/hop{}", n + 1))
        })
        .await;
        let err = client().get(format!("{}/hop0", named(&base))).send().await.unwrap_err();
        let msg = send_error(err);
        assert!(msg.contains("more than 5 times"), "{msg}");
        assert!(!msg.contains("hop"), "{msg}");
        assert_eq!(heads.lock().unwrap().len(), MAX_REDIRECTS + 1);
    }
}

#[cfg(test)]
mod model_id_mirror_tests {
    use super::clean_model_id;

    /// providers.js keeps a JS copy of this rule (MODEL_ID_RE, applied where an
    /// id is typed, sent from the phone, or handed to a new shell). Nothing
    /// else ties the two together, so this pins both: the JS line verbatim, and
    /// Rust's character set, first-character rule and length cap to the same
    /// ones. A change on either side fails here; change both, then this test.
    #[test]
    fn the_js_model_id_rule_matches_clean_model_id() {
        let js = include_str!("../../src/features/terminals/providers.js");
        assert!(
            js.contains(r"const MODEL_ID_RE = /^(?!-)[A-Za-z0-9._:/@+~=#[\]-]{1,200}$/;"),
            "MODEL_ID_RE in providers.js changed: make clean_model_id match, then update this test"
        );
        for c in (0u8..128).map(char::from) {
            let allowed = c.is_ascii_alphanumeric() || "._:/@+~=#[]-".contains(c);
            assert_eq!(clean_model_id(&format!("a{c}b")).is_some(), allowed, "{c:?} after the first character");
            if c.is_whitespace() {
                continue; // clean_model_id trims first, as the JS callers do
            }
            assert_eq!(clean_model_id(&format!("{c}ab")).is_some(), allowed && c != '-', "{c:?} as the first character");
        }
        assert!(clean_model_id(&"a".repeat(200)).is_some());
        assert!(clean_model_id(&"a".repeat(201)).is_none());
        assert!(clean_model_id("sonnet[1m]").is_some(), "Claude Code's 1M-context suffix");
        assert!(clean_model_id("/models/Qwen2.5-7B-Instruct").is_some(), "vLLM serves a local path as the id");
        assert!(clean_model_id("accounts/fireworks/models/x#accounts/acme/deployments/d1").is_some(), "a Fireworks deployment");
        assert!(clean_model_id("-rf").is_none(), "an id never starts with a dash");
        assert!(clean_model_id("é").is_none(), "ASCII only, as in the JS class");
    }
}
