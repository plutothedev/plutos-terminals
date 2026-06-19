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
        return ip.is_loopback();
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
    let lower = b.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(b.to_string());
    }
    if let Some(rest) = lower.strip_prefix("http://") {
        let authority = rest.split('/').next().unwrap_or("");
        // Strip any userinfo ("user:pass@") FIRST — otherwise a private-looking
        // username spoofs the host check (http://localhost:x@evil.com would parse
        // "localhost" as the host while reqwest actually connects to evil.com).
        let authority = authority.rsplit('@').next().unwrap_or(authority);
        // host = authority minus an optional :port (IPv6 literals keep their brackets).
        let host = if let Some(stripped) = authority.strip_prefix('[') {
            stripped.split(']').next().unwrap_or("")
        } else {
            authority.split(':').next().unwrap_or("")
        };
        if is_private_or_local(host) {
            return Ok(b.to_string());
        }
    }
    Err(format!(
        "Refusing to send the API key to a non-HTTPS endpoint: {b}. Use https:// (http:// is allowed only for localhost / a private-LAN address)."
    ))
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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
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
        let resp = client
            .post(format!("{}/v1/messages", base))
            .header("x-api-key", &api_key)
            .header("authorization", format!("Bearer {}", api_key))
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
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
        let resp = client
            .post(format!("{}/chat/completions", base))
            .header("authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let anthropic = kind == "anthropic" || kind == "anthropic-compat";

    let resp = if anthropic {
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
            .await
            .map_err(|e| e.to_string())?
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
            .await
            .map_err(|e| e.to_string())?
    };

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
    while let Some(chunk) = stream.next().await {
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
