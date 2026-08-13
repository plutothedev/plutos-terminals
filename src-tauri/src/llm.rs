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

pub(crate) fn http_client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("plutos-terminals")
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("shared HTTP client (TLS backend init)")
    })
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
            None => return builder.send().await.map_err(|e| e.to_string()),
        };
        let resp = this_try.send().await.map_err(|e| e.to_string())?;
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
) -> Result<String, String> {
    let client = http_client();
    let anthropic = kind == "anthropic" || kind == "anthropic-compat";

    if anthropic {
        let base = resolve_base(&base_url, "https://api.anthropic.com")?;
        let body = serde_json::json!({
            "model": model,
            "max_tokens": 1024,
            "system": system,
            "messages": [{ "role": "user", "content": prompt }],
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
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": prompt },
            ],
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
#[tauri::command]
pub async fn llm_stream(
    on_chunk: tauri::ipc::Channel<String>,
    kind: String,
    base_url: String,
    api_key: String,
    model: String,
    system: String,
    prompt: String,
) -> Result<String, String> {
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
            "messages": [{ "role": "user", "content": prompt }],
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
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": prompt },
            ],
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
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    if !status.is_success() {
        // Error bodies are plain JSON, not SSE.
        let v: serde_json::Value = resp.json().await.unwrap_or_else(|_| serde_json::json!({}));
        let msg = v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("");
        return Err(if msg.is_empty() { status.to_string() } else { msg.to_string() });
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
