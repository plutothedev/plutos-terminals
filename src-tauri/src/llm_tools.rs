// (C)
// LLM native tool-calling: translate a normalized conversation + tool defs into
// the Anthropic and OpenAI request shapes, and parse their responses back into a
// uniform { text, tool_calls, stop_reason }. Pure functions (HTTP lives in the
// command, added in a later task). Tool names are "server.tool"; OpenAI function
// names forbid '.', so on the wire we encode '.' as '__' and decode on return.
use serde_json::{json, Value};

// Bijective encode into the OpenAI function-name charset ([A-Za-z0-9_-], no '.').
// (Wire format only — not persisted. Changing the scheme is safe: agent
// conversations don't survive an app restart, and an MSI upgrade restarts the
// app, so no in-flight history carries old-encoded names across the change.)
// Escape char is '_':  '_' -> "_u",  '.' -> "_d". This is a true inverse pair:
// the old encoder (".".replace -> "__") was AMBIGUOUS — a real tool name that
// itself contained "__" decoded to a "." and mis-routed (fails to the unknown-
// tool gate). Now every escape sequence is self-delimiting, so "__", "_d", and
// multi-dot names ("tv.chart.set_symbol") all round-trip.
pub fn enc_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for c in name.chars() {
        match c {
            '_' => out.push_str("_u"),
            '.' => out.push_str("_d"),
            _ => out.push(c),
        }
    }
    out
}
// Inverse of enc_name: walk the escape sequences left-to-right. A naive
// `.replace("_u","_").replace("_d",".")` would be wrong (the first pass can
// manufacture a fake "_d"), so decode by scanning.
pub fn dec_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut chars = name.chars();
    while let Some(c) = chars.next() {
        if c == '_' {
            match chars.next() {
                Some('u') => out.push('_'),
                Some('d') => out.push('.'),
                // Malformed input from the model: keep the bytes verbatim so the
                // lookup misses and the call gets gated as an unknown tool.
                Some(other) => { out.push('_'); out.push(other); }
                None => out.push('_'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Anthropic `tools`: [{ name, description, input_schema }].
pub fn tools_to_anthropic(tools: &[Value]) -> Value {
    Value::Array(tools.iter().map(|t| json!({
        "name": enc_name(t.get("name").and_then(|n| n.as_str()).unwrap_or("")),
        "description": t.get("description").and_then(|d| d.as_str()).unwrap_or(""),
        "input_schema": t.get("input_schema").cloned().unwrap_or(json!({"type":"object"})),
    })).collect())
}

/// OpenAI `tools`: [{ type:"function", function:{ name, description, parameters } }].
pub fn tools_to_openai(tools: &[Value]) -> Value {
    Value::Array(tools.iter().map(|t| json!({
        "type": "function",
        "function": {
            "name": enc_name(t.get("name").and_then(|n| n.as_str()).unwrap_or("")),
            "description": t.get("description").and_then(|d| d.as_str()).unwrap_or(""),
            "parameters": t.get("input_schema").cloned().unwrap_or(json!({"type":"object"})),
        }
    })).collect())
}

/// Normalized messages -> Anthropic `messages` (system is sent separately).
pub fn to_anthropic_messages(msgs: &[Value]) -> Value {
    let mut out = Vec::new();
    for m in msgs {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        match role {
            "tool" => {
                out.push(json!({ "role": "user", "content": [{
                    "type": "tool_result",
                    "tool_use_id": m.get("tool_call_id").and_then(|i| i.as_str()).unwrap_or(""),
                    "content": m.get("content").and_then(|c| c.as_str()).unwrap_or(""),
                    "is_error": m.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false),
                }] }));
            }
            "assistant" => {
                let mut content = Vec::new();
                if let Some(t) = m.get("text").and_then(|t| t.as_str()) {
                    if !t.is_empty() { content.push(json!({ "type":"text", "text": t })); }
                }
                if let Some(calls) = m.get("tool_calls").and_then(|c| c.as_array()) {
                    for c in calls {
                        content.push(json!({
                            "type": "tool_use",
                            "id": c.get("id").and_then(|i| i.as_str()).unwrap_or(""),
                            "name": enc_name(c.get("name").and_then(|n| n.as_str()).unwrap_or("")),
                            "input": c.get("args").cloned().unwrap_or(json!({})),
                        }));
                    }
                }
                out.push(json!({ "role":"assistant", "content": content }));
            }
            _ => {
                out.push(json!({ "role":"user", "content": m.get("text").and_then(|t| t.as_str()).unwrap_or("") }));
            }
        }
    }
    Value::Array(out)
}

/// Normalized messages -> OpenAI `messages` (system prepended).
pub fn to_openai_messages(msgs: &[Value], system: &str) -> Value {
    let mut out = vec![json!({ "role":"system", "content": system })];
    for m in msgs {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        match role {
            "tool" => out.push(json!({
                "role":"tool",
                "tool_call_id": m.get("tool_call_id").and_then(|i| i.as_str()).unwrap_or(""),
                "content": m.get("content").and_then(|c| c.as_str()).unwrap_or(""),
            })),
            "assistant" => {
                let mut msg = json!({ "role":"assistant", "content": m.get("text").and_then(|t| t.as_str()).unwrap_or("") });
                if let Some(calls) = m.get("tool_calls").and_then(|c| c.as_array()) {
                    let tcs: Vec<Value> = calls.iter().map(|c| json!({
                        "id": c.get("id").and_then(|i| i.as_str()).unwrap_or(""),
                        "type": "function",
                        "function": {
                            "name": enc_name(c.get("name").and_then(|n| n.as_str()).unwrap_or("")),
                            "arguments": serde_json::to_string(c.get("args").unwrap_or(&json!({}))).unwrap_or("{}".into()),
                        }
                    })).collect();
                    msg["tool_calls"] = Value::Array(tcs);
                }
                out.push(msg);
            }
            _ => out.push(json!({ "role":"user", "content": m.get("text").and_then(|t| t.as_str()).unwrap_or("") })),
        }
    }
    Value::Array(out)
}

/// Anthropic prompt caching (P3-T3): mark three breakpoints with
/// `cache_control: {type: "ephemeral"}` so agent runs stop resending the full
/// tool schemas + growing history at O(n^2) token cost (~100k redundant tokens
/// per 14-step run with MCP servers). NATIVE Anthropic ONLY — compat gateways
/// (Moonshot-style) may 400 on the proprietary key (audit M2), so the caller
/// gates on kind == "anthropic", never "anthropic-compat".
///
/// Breakpoints (<=4 allowed; we use 3):
///   1. the LAST tools[] entry (caches the whole tool prefix),
///   2. system — converted from top-level string to block form (required for
///      the marker); an EMPTY system emits no block at all,
///   3. the LAST message — shape-aware (audit M1): assistant = block array
///      (mark the last block), tool = tool_result one-element array (mark the
///      block; is_error is an orthogonal field, coexists fine), user = STRING
///      content (converted to a text block first).
///
/// Marking the last message beats second-to-last (audit L2): strictly cheaper,
/// and Anthropic auto-checks ~20 prior breakpoint positions so both hit.
/// Cache-hit viability: agentLoop appends only, tools/system are per-run
/// constants, serde ordering is deterministic -> byte-stable prefix.
pub fn attach_cache_control(body: &mut Value) {
    let marker = json!({ "type": "ephemeral" });

    if let Some(tools) = body.get_mut("tools").and_then(|t| t.as_array_mut()) {
        if let Some(last) = tools.last_mut() {
            last["cache_control"] = marker.clone();
        }
    }

    if let Some(system) = body.get_mut("system") {
        if let Some(text) = system.as_str() {
            if text.is_empty() {
                // No block for an empty system — a marked empty block is an
                // API error waiting to happen and caches nothing.
                *system = json!([]);
            } else {
                *system = json!([{ "type": "text", "text": text, "cache_control": marker.clone() }]);
            }
        }
    }

    if let Some(msgs) = body.get_mut("messages").and_then(|m| m.as_array_mut()) {
        if let Some(last) = msgs.last_mut() {
            let content = &mut last["content"];
            if let Some(text) = content.as_str() {
                // String content (the user goal on turn 1) -> block form.
                *content = json!([{ "type": "text", "text": text, "cache_control": marker }]);
            } else if let Some(blocks) = content.as_array_mut() {
                if let Some(last_block) = blocks.last_mut() {
                    last_block["cache_control"] = marker;
                }
            }
        }
    }
}

pub fn parse_anthropic_response(v: &Value) -> Value {
    let mut text = String::new();
    let mut calls = Vec::new();
    if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
        for b in arr {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => text.push_str(b.get("text").and_then(|t| t.as_str()).unwrap_or("")),
                Some("tool_use") => calls.push(json!({
                    "id": b.get("id").and_then(|i| i.as_str()).unwrap_or(""),
                    "name": dec_name(b.get("name").and_then(|n| n.as_str()).unwrap_or("")),
                    "args": b.get("input").cloned().unwrap_or(json!({})),
                })),
                _ => {}
            }
        }
    }
    let stop = if v.get("stop_reason").and_then(|s| s.as_str()) == Some("tool_use") { "tool_use" }
               else if !calls.is_empty() { "tool_use" } else { "end" };
    json!({ "text": text, "tool_calls": calls, "stop_reason": stop })
}

pub fn parse_openai_response(v: &Value) -> Value {
    let msg = v.pointer("/choices/0/message").cloned().unwrap_or(json!({}));
    let text = msg.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let mut calls = Vec::new();
    if let Some(tcs) = msg.get("tool_calls").and_then(|c| c.as_array()) {
        for c in tcs {
            let args_str = c.pointer("/function/arguments").and_then(|a| a.as_str()).unwrap_or("{}");
            let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
            calls.push(json!({
                "id": c.get("id").and_then(|i| i.as_str()).unwrap_or(""),
                "name": dec_name(c.pointer("/function/name").and_then(|n| n.as_str()).unwrap_or("")),
                "args": args,
            }));
        }
    }
    let stop = if !calls.is_empty() { "tool_use" } else { "end" };
    json!({ "text": text, "tool_calls": calls, "stop_reason": stop })
}

use crate::llm::{http_error, resolve_base};

/// The cache-control gate as a named predicate so the test suite can pin it
/// (stream audit S1: the 4 snapshot tests exercised attach_cache_control
/// directly but nothing pinned WHICH kinds get it — a future "compat works
/// too, right?" edit would have passed every test).
fn wants_cache_control(kind: &str) -> bool {
    kind == "anthropic"
}

#[tauri::command]
pub async fn llm_tool_turn(
    kind: String,
    base_url: String,
    api_key: String,
    model: String,
    system: String,
    messages: Vec<Value>,
    tools: Vec<Value>,
) -> Result<Value, String> {
    let client = crate::llm::http_client();
    let anthropic = kind == "anthropic" || kind == "anthropic-compat";

    let resp = if anthropic {
        let base = resolve_base(&base_url, "https://api.anthropic.com")?;
        let mut body = json!({
            "model": model, "max_tokens": 4096, "system": system,
            "messages": to_anthropic_messages(&messages),
        });
        if !tools.is_empty() { body["tools"] = tools_to_anthropic(&tools); }
        // Native Anthropic only — never compat gateways (audit M2).
        if wants_cache_control(&kind) { attach_cache_control(&mut body); }
        let req = client.post(format!("{}/v1/messages", base))
            .header("x-api-key", &api_key)
            .header("authorization", format!("Bearer {}", api_key))
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body).timeout(std::time::Duration::from_secs(120));
        crate::llm::send_with_retry(req).await?
    } else {
        let base = resolve_base(&base_url, "https://api.openai.com/v1")?;
        let mut body = json!({ "model": model, "messages": to_openai_messages(&messages, &system) });
        if !tools.is_empty() { body["tools"] = tools_to_openai(&tools); }
        let req = client.post(format!("{}/chat/completions", base))
            .header("authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json")
            .json(&body).timeout(std::time::Duration::from_secs(120));
        crate::llm::send_with_retry(req).await?
    };

    let status = resp.status();
    if !status.is_success() { return Err(http_error(status, resp).await); }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(if anthropic { parse_anthropic_response(&v) } else { parse_openai_response(&v) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encodes_and_decodes_dotted_names() {
        assert_eq!(enc_name("fs.read_file"), "fs_dread_ufile");
        assert_eq!(dec_name("fs_dread_ufile"), "fs.read_file");
        // multi-dot (a server tool name that itself contains a dot) must round-trip
        assert_eq!(dec_name(&enc_name("tv.chart.set_symbol")), "tv.chart.set_symbol");
        // bijectivity regression: a tool name containing a literal "__" must NOT
        // collapse to a "." (the old encoder's bug). "a__b" and "a.b" stay distinct.
        assert_eq!(dec_name(&enc_name("a__b")), "a__b");
        assert_eq!(dec_name(&enc_name("a.b")), "a.b");
        assert_ne!(enc_name("a__b"), enc_name("a.b"));
        // every encoded name is OpenAI-safe (no '.')
        assert!(!enc_name("x.y_z").contains('.'));
    }
    #[test]
    fn anthropic_tools_shape() {
        let t = vec![json!({"name":"fs.read","description":"d","input_schema":{"type":"object"}})];
        let out = tools_to_anthropic(&t);
        assert_eq!(out[0]["name"], "fs_dread");
        assert_eq!(out[0]["input_schema"]["type"], "object");
    }
    #[test]
    fn openai_tools_shape() {
        let t = vec![json!({"name":"fs.read","description":"d","input_schema":{"type":"object"}})];
        let out = tools_to_openai(&t);
        assert_eq!(out[0]["type"], "function");
        assert_eq!(out[0]["function"]["name"], "fs_dread");
        assert_eq!(out[0]["function"]["parameters"]["type"], "object");
    }
    #[test]
    fn anthropic_messages_translate() {
        let msgs = vec![
            json!({"role":"user","text":"hi"}),
            json!({"role":"assistant","text":"ok","tool_calls":[{"id":"c1","name":"fs.read","args":{"p":"a"}}]}),
            json!({"role":"tool","tool_call_id":"c1","content":"file body","is_error":false}),
        ];
        let out = to_anthropic_messages(&msgs);
        assert_eq!(out[0]["role"], "user");
        let a = &out[1];
        assert_eq!(a["role"], "assistant");
        let tu = a["content"].as_array().unwrap().iter().find(|b| b["type"]=="tool_use").unwrap();
        assert_eq!(tu["name"], "fs_dread");
        assert_eq!(tu["id"], "c1");
        assert_eq!(tu["input"]["p"], "a");
        let r = &out[2];
        assert_eq!(r["role"], "user");
        let tr = &r["content"][0];
        assert_eq!(tr["type"], "tool_result");
        assert_eq!(tr["tool_use_id"], "c1");
    }
    #[test]
    fn openai_messages_translate() {
        let msgs = vec![
            json!({"role":"user","text":"hi"}),
            json!({"role":"assistant","text":"ok","tool_calls":[{"id":"c1","name":"fs.read","args":{"p":"a"}}]}),
            json!({"role":"tool","tool_call_id":"c1","content":"file body"}),
        ];
        let out = to_openai_messages(&msgs, "SYS");
        assert_eq!(out[0]["role"], "system");
        assert_eq!(out[1]["role"], "user");
        let a = &out[2];
        assert_eq!(a["role"], "assistant");
        assert_eq!(a["tool_calls"][0]["id"], "c1");
        assert_eq!(a["tool_calls"][0]["function"]["name"], "fs_dread");
        let args_str = a["tool_calls"][0]["function"]["arguments"].as_str().unwrap();
        assert!(args_str.contains("\"p\""));
        let r = &out[3];
        assert_eq!(r["role"], "tool");
        assert_eq!(r["tool_call_id"], "c1");
    }
    #[test]
    fn parse_anthropic_with_tool_use() {
        let resp = json!({
            "stop_reason":"tool_use",
            "content":[
                {"type":"text","text":"let me read"},
                {"type":"tool_use","id":"c1","name":"fs_dread","input":{"p":"a"}}
            ]
        });
        let r = parse_anthropic_response(&resp);
        assert_eq!(r["text"], "let me read");
        assert_eq!(r["tool_calls"][0]["id"], "c1");
        assert_eq!(r["tool_calls"][0]["name"], "fs.read");
        assert_eq!(r["tool_calls"][0]["args"]["p"], "a");
        assert_eq!(r["stop_reason"], "tool_use");
    }
    #[test]
    fn parse_openai_with_tool_calls() {
        let resp = json!({
            "choices":[{"finish_reason":"tool_calls","message":{
                "content":null,
                "tool_calls":[{"id":"c1","type":"function","function":{"name":"fs_dread","arguments":"{\"p\":\"a\"}"}}]
            }}]
        });
        let r = parse_openai_response(&resp);
        assert_eq!(r["tool_calls"][0]["id"], "c1");
        assert_eq!(r["tool_calls"][0]["name"], "fs.read");
        assert_eq!(r["tool_calls"][0]["args"]["p"], "a");
        assert_eq!(r["stop_reason"], "tool_use");
    }
    #[test]
    fn parse_openai_plain_text_is_end() {
        let resp = json!({"choices":[{"finish_reason":"stop","message":{"content":"done"}}]});
        let r = parse_openai_response(&resp);
        assert_eq!(r["text"], "done");
        assert_eq!(r["stop_reason"], "end");
        assert!(r["tool_calls"].as_array().unwrap().is_empty());
    }
}

#[cfg(test)]
mod cache_control_tests {
    use super::*;

    fn marked(v: &Value) -> bool {
        v.get("cache_control").and_then(|c| c.get("type")).and_then(|t| t.as_str())
            == Some("ephemeral")
    }

    #[test]
    fn gate_is_native_anthropic_only() {
        // Pins the llm_tool_turn gate itself (audit M2 / stream audit S1):
        // compat gateways and OpenAI-shaped providers must never receive
        // cache_control fields they may reject outright.
        assert!(wants_cache_control("anthropic"));
        assert!(!wants_cache_control("anthropic-compat"));
        assert!(!wants_cache_control("openai"));
        assert!(!wants_cache_control(""));
    }

    #[test]
    fn tools_tail_system_and_last_user_string_message() {
        let mut body = json!({
            "model": "m", "max_tokens": 4096, "system": "sys",
            "messages": [{ "role": "user", "content": "goal" }],
            "tools": [{ "name": "a" }, { "name": "b" }],
        });
        attach_cache_control(&mut body);
        let tools = body["tools"].as_array().unwrap();
        assert!(!marked(&tools[0]), "only the LAST tool is marked");
        assert!(marked(&tools[1]));
        let system = body["system"].as_array().unwrap();
        assert_eq!(system[0]["text"], "sys");
        assert!(marked(&system[0]));
        // String user content converted to block form + marked.
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content[0]["text"], "goal");
        assert!(marked(&content[0]));
    }

    #[test]
    fn last_tool_result_block_is_marked_is_error_coexists() {
        let mut body = json!({
            "model": "m", "system": "s",
            "messages": [
                { "role": "user", "content": "goal" },
                { "role": "assistant", "content": [{ "type": "text", "text": "hi" }] },
                { "role": "user", "content": [{
                    "type": "tool_result", "tool_use_id": "t1",
                    "content": "boom", "is_error": true
                }] },
            ],
        });
        attach_cache_control(&mut body);
        let msgs = body["messages"].as_array().unwrap();
        // Only the LAST message's block carries the marker.
        assert!(!marked(&msgs[1]["content"][0]));
        let block = &msgs[2]["content"][0];
        assert!(marked(block));
        assert_eq!(block["is_error"], true, "orthogonal field survives");
        assert_eq!(block["type"], "tool_result");
    }

    #[test]
    fn assistant_block_array_marks_last_block_only() {
        let mut body = json!({
            "model": "m", "system": "s",
            "messages": [{ "role": "assistant", "content": [
                { "type": "text", "text": "a" },
                { "type": "tool_use", "id": "x", "name": "run", "input": {} },
            ]}],
        });
        attach_cache_control(&mut body);
        let blocks = body["messages"][0]["content"].as_array().unwrap();
        assert!(!marked(&blocks[0]));
        assert!(marked(&blocks[1]));
    }

    #[test]
    fn empty_system_and_missing_tools_are_safe() {
        let mut body = json!({
            "model": "m", "system": "",
            "messages": [{ "role": "user", "content": "g" }],
        });
        attach_cache_control(&mut body);
        assert_eq!(body["system"].as_array().unwrap().len(), 0, "no marked empty block");
        assert!(body.get("tools").is_none());
        assert!(marked(&body["messages"][0]["content"][0]));
    }
}
