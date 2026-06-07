// (C)
//! LLM completion gateway: Anthropic Messages API + OpenAI-compatible chat
//! (OpenRouter / DeepSeek / Groq / Moonshot / ...). Runs in Rust (reqwest) so the
//! API key never hits a browser-origin request and we sidestep CORS. Extracted
//! from the commands.rs grab-bag (the only HTTP-client concern in there).

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
    let trim = |s: &str| s.trim_end_matches('/').to_string();
    let anthropic = kind == "anthropic" || kind == "anthropic-compat";

    if anthropic {
        let base = if base_url.is_empty() {
            "https://api.anthropic.com".to_string()
        } else {
            trim(&base_url)
        };
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
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let msg = v
                .pointer("/error/message")
                .and_then(|m| m.as_str())
                .unwrap_or("");
            return Err(if msg.is_empty() {
                status.to_string()
            } else {
                msg.to_string()
            });
        }
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
        let base = if base_url.is_empty() {
            "https://api.openai.com/v1".to_string()
        } else {
            trim(&base_url)
        };
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
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let msg = v
                .pointer("/error/message")
                .and_then(|m| m.as_str())
                .unwrap_or("");
            return Err(if msg.is_empty() {
                status.to_string()
            } else {
                msg.to_string()
            });
        }
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
    let trim = |s: &str| s.trim_end_matches('/').to_string();
    let anthropic = kind == "anthropic" || kind == "anthropic-compat";

    let resp = if anthropic {
        let base = if base_url.is_empty() { "https://api.anthropic.com".to_string() } else { trim(&base_url) };
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
        let base = if base_url.is_empty() { "https://api.openai.com/v1".to_string() } else { trim(&base_url) };
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
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&bytes).replace("\r\n", "\n"));
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
