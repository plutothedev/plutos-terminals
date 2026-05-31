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
