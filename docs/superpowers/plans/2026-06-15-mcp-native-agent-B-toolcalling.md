# MCP Native Agent — Component B: LLM native tool-calling

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.
> Spec: `docs/superpowers/specs/2026-06-14-mcp-native-agent-design.md`. **Plan 2 of 3** (A=client DONE, B=this, C/D=agent loop+UI next).

**Goal:** A new Tauri command `llm_tool_turn` that runs one tool-calling turn against the active LLM — accepting a normalized conversation + a tools array, returning the model's text + any tool calls — across the Anthropic and OpenAI dialects, without regressing the existing no-tools `llm_complete`/`llm_stream`.

**Architecture:** Pure, unit-tested translate/parse helpers in a new `src-tauri/src/llm_tools.rs` (normalized↔dialect message translation, tools-schema translation, response parsing). A thin async command in `llm.rs` does the HTTP using those helpers + the existing client/error patterns. A JS wrapper `src/features/terminals/llmTools.js` exposes it. **Non-streaming in v1** (reliable tool-call parsing); streaming-during-tool-turns is a documented follow-up — agent text still renders per step.

**Tech Stack:** Rust (reqwest, serde_json), Tauri v2, vitest (JS). No new crates.

## Normalized shapes (the contract between JS and Rust)
```
NormMsg (one of):
  { "role":"user", "text":"..." }
  { "role":"assistant", "text":"...", "tool_calls":[{ "id":"..", "name":"server.tool", "args":{...} }] }   // a model turn that called tools (text optional)
  { "role":"tool", "tool_call_id":"..", "content":"<result text>", "is_error":false }                      // a tool result

ToolDef: { "name":"server.tool", "description":"..", "input_schema":{json schema} }

llm_tool_turn returns: { "text":"..", "tool_calls":[{ "id","name","args" }], "stop_reason":"tool_use"|"end"|"other" }
```
Tool names use `server.tool` (dot) so the agent loop can route; for the wire we send the name as-is (both APIs accept `.`? — OpenAI function names must match `^[a-zA-Z0-9_-]+$`, NO dots. So translate: on the wire use `server__tool` (double underscore), and map back on parse. Helpers own this encoding.)

---

## File Structure
- Create `src-tauri/src/llm_tools.rs` — pure translate/parse helpers + the `llm_tool_turn` command. Unit tests inline.
- Modify `src-tauri/src/lib.rs` — `mod llm_tools;` + register `llm_tool_turn`.
- Modify `src-tauri/src/llm.rs` — expose the shared `http_error` helper as `pub(crate)` if not already (the command reuses it); confirm and adjust visibility only.
- Create `src/features/terminals/llmTools.js` — JS wrapper + normalized-message helpers. Inline vitest.

---

## Task B1: Pure helpers — name encoding + tools translation

**Files:** Create `src-tauri/src/llm_tools.rs` (+ inline tests).

- [ ] **Step 1: Write failing tests**

Create `src-tauri/src/llm_tools.rs`:
```rust
// (C)
// LLM native tool-calling: translate a normalized conversation + tool defs into
// the Anthropic and OpenAI request shapes, and parse their responses back into a
// uniform { text, tool_calls, stop_reason }. Pure functions (HTTP lives in the
// command at the bottom). Tool names are "server.tool"; OpenAI function names
// forbid '.', so on the wire we encode '.' as '__' and decode on the way back.
use serde_json::{json, Value};

pub fn enc_name(name: &str) -> String { name.replace('.', "__") }
pub fn dec_name(name: &str) -> String { name.replacen("__", ".", 1) }

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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encodes_and_decodes_dotted_names() {
        assert_eq!(enc_name("fs.read_file"), "fs__read_file");
        assert_eq!(dec_name("fs__read_file"), "fs.read_file");
    }
    #[test]
    fn anthropic_tools_shape() {
        let t = vec![json!({"name":"fs.read","description":"d","input_schema":{"type":"object"}})];
        let out = tools_to_anthropic(&t);
        assert_eq!(out[0]["name"], "fs__read");
        assert_eq!(out[0]["input_schema"]["type"], "object");
    }
    #[test]
    fn openai_tools_shape() {
        let t = vec![json!({"name":"fs.read","description":"d","input_schema":{"type":"object"}})];
        let out = tools_to_openai(&t);
        assert_eq!(out[0]["type"], "function");
        assert_eq!(out[0]["function"]["name"], "fs__read");
        assert_eq!(out[0]["function"]["parameters"]["type"], "object");
    }
}
```
Also add `mod llm_tools;` to `src-tauri/src/lib.rs` (near other `mod`s) so it compiles.

- [ ] **Step 2: Run to fail** — build env, `cargo test llm_tools` → FAIL (module missing until added).
- [ ] **Step 3: Implement** — the code above IS the implementation.
- [ ] **Step 4: Run to pass** — `cargo test llm_tools` → 3 pass.
- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/llm_tools.rs src-tauri/src/lib.rs
git commit -m "feat(llm): tool name encoding + tools-schema translation"
```

---

## Task B2: Message translation (normalized → each dialect)

**Files:** Modify `src-tauri/src/llm_tools.rs` (add fns + tests).

- [ ] **Step 1: Add failing tests** (append to the `tests` mod):
```rust
    #[test]
    fn anthropic_messages_translate() {
        let msgs = vec![
            json!({"role":"user","text":"hi"}),
            json!({"role":"assistant","text":"ok","tool_calls":[{"id":"c1","name":"fs.read","args":{"p":"a"}}]}),
            json!({"role":"tool","tool_call_id":"c1","content":"file body","is_error":false}),
        ];
        let out = to_anthropic_messages(&msgs);
        assert_eq!(out[0]["role"], "user");
        // assistant turn carries a tool_use block with encoded name + input
        let a = &out[1];
        assert_eq!(a["role"], "assistant");
        let tu = a["content"].as_array().unwrap().iter().find(|b| b["type"]=="tool_use").unwrap();
        assert_eq!(tu["name"], "fs__read");
        assert_eq!(tu["id"], "c1");
        assert_eq!(tu["input"]["p"], "a");
        // tool result becomes a user message with a tool_result block
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
        assert_eq!(a["tool_calls"][0]["function"]["name"], "fs__read");
        // arguments is a JSON STRING in OpenAI
        let args_str = a["tool_calls"][0]["function"]["arguments"].as_str().unwrap();
        assert!(args_str.contains("\"p\""));
        let r = &out[3];
        assert_eq!(r["role"], "tool");
        assert_eq!(r["tool_call_id"], "c1");
    }
```

- [ ] **Step 2: Run to fail** — `cargo test llm_tools` → FAIL.
- [ ] **Step 3: Implement** (add to `llm_tools.rs`):
```rust
/// Normalized messages -> Anthropic `messages` (system is sent separately).
pub fn to_anthropic_messages(msgs: &[Value]) -> Value {
    let mut out = Vec::new();
    for m in msgs {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        match role {
            "tool" => {
                // Anthropic models tool results as a user message with a tool_result block.
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
```

- [ ] **Step 4: Run to pass** — `cargo test llm_tools` → 5 pass.
- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/llm_tools.rs
git commit -m "feat(llm): normalized->dialect message translation"
```

---

## Task B3: Response parsing (each dialect → uniform result)

**Files:** Modify `src-tauri/src/llm_tools.rs` (add fns + tests).

- [ ] **Step 1: Add failing tests:**
```rust
    #[test]
    fn parse_anthropic_with_tool_use() {
        let resp = json!({
            "stop_reason":"tool_use",
            "content":[
                {"type":"text","text":"let me read"},
                {"type":"tool_use","id":"c1","name":"fs__read","input":{"p":"a"}}
            ]
        });
        let r = parse_anthropic_response(&resp);
        assert_eq!(r["text"], "let me read");
        assert_eq!(r["tool_calls"][0]["id"], "c1");
        assert_eq!(r["tool_calls"][0]["name"], "fs.read"); // decoded
        assert_eq!(r["tool_calls"][0]["args"]["p"], "a");
        assert_eq!(r["stop_reason"], "tool_use");
    }
    #[test]
    fn parse_openai_with_tool_calls() {
        let resp = json!({
            "choices":[{"finish_reason":"tool_calls","message":{
                "content":null,
                "tool_calls":[{"id":"c1","type":"function","function":{"name":"fs__read","arguments":"{\"p\":\"a\"}"}}]
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
```

- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement:**
```rust
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
```

- [ ] **Step 4: Run to pass** — `cargo test llm_tools` → 8 pass.
- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/llm_tools.rs
git commit -m "feat(llm): parse anthropic/openai tool-call responses"
```

---

## Task B4: The `llm_tool_turn` command (HTTP wiring)

**Files:** Modify `src-tauri/src/llm_tools.rs` (add the command), `src-tauri/src/llm.rs` (expose `http_error`), `src-tauri/src/lib.rs` (register).

- [ ] **Step 1: Confirm/expose the shared error helper**

Read `src-tauri/src/llm.rs` and find `async fn http_error(...)`. If it's private, change its signature to `pub(crate) async fn http_error(...)`. (It builds an error string from a non-2xx response.) Note its exact signature for the call below.

- [ ] **Step 2: Add the command to `llm_tools.rs`**
```rust
use crate::llm::http_error;

#[tauri::command]
pub async fn llm_tool_turn(
    kind: String,
    base_url: String,
    api_key: String,
    model: String,
    system: String,
    messages: Vec<Value>,   // normalized NormMsg list
    tools: Vec<Value>,      // ToolDef list (may be empty)
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| e.to_string())?;
    let trim = |s: &str| s.trim_end_matches('/').to_string();
    let anthropic = kind == "anthropic" || kind == "anthropic-compat";

    let resp = if anthropic {
        let base = if base_url.is_empty() { "https://api.anthropic.com".into() } else { trim(&base_url) };
        let mut body = json!({
            "model": model, "max_tokens": 4096, "system": system,
            "messages": to_anthropic_messages(&messages),
        });
        if !tools.is_empty() { body["tools"] = tools_to_anthropic(&tools); }
        client.post(format!("{}/v1/messages", base))
            .header("x-api-key", &api_key)
            .header("authorization", format!("Bearer {}", api_key))
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body).send().await.map_err(|e| e.to_string())?
    } else {
        let base = if base_url.is_empty() { "https://api.openai.com/v1".into() } else { trim(&base_url) };
        let mut body = json!({ "model": model, "messages": to_openai_messages(&messages, &system) });
        if !tools.is_empty() { body["tools"] = tools_to_openai(&tools); }
        client.post(format!("{}/chat/completions", base))
            .header("authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json")
            .json(&body).send().await.map_err(|e| e.to_string())?
    };

    let status = resp.status();
    if !status.is_success() { return Err(http_error(status, resp).await); }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(if anthropic { parse_anthropic_response(&v) } else { parse_openai_response(&v) })
}
```
(`json` and `Value` are already imported at the top of the file. Adjust the `http_error` call to its real signature found in Step 1.)

- [ ] **Step 3: Register in lib.rs** — add `llm_tools::llm_tool_turn,` to `generate_handler![]` (after the llm commands, if listed there, else anywhere in the list).

- [ ] **Step 4: Verify** — build env, `cargo check` → compiles; `cargo test llm_tools` → 8 still pass. Confirm the no-tools paths (`llm_complete`/`llm_stream`) are untouched (you only changed `http_error` visibility).

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/llm_tools.rs src-tauri/src/llm.rs src-tauri/src/lib.rs
git commit -m "feat(llm): llm_tool_turn command (anthropic+openai, non-streaming)"
```

---

## Task B5: JS wrapper + message helpers

**Files:** Create `src/features/terminals/llmTools.js` (+ inline vitest test).

- [ ] **Step 1: Write failing test**

Create `src/features/terminals/llmTools.test.js`:
```js
import { test, expect } from "vitest";
import { userMsg, assistantToolCalls, toolResult } from "./llmTools.js";

test("builds normalized messages", () => {
  expect(userMsg("hi")).toEqual({ role: "user", text: "hi" });
  const a = assistantToolCalls("ok", [{ id: "c1", name: "fs.read", args: { p: "a" } }]);
  expect(a.role).toBe("assistant");
  expect(a.tool_calls[0].name).toBe("fs.read");
  const r = toolResult("c1", "body", false);
  expect(r).toEqual({ role: "tool", tool_call_id: "c1", content: "body", is_error: false });
});
```

- [ ] **Step 2: Run to fail** — `npm test -- llmTools` → FAIL.
- [ ] **Step 3: Implement** `src/features/terminals/llmTools.js`:
```js
// (C)
// Frontend wrapper for the native tool-calling turn (Rust llm_tool_turn). Builds
// the normalized message shapes the command expects and returns the uniform
// { text, tool_calls:[{id,name,args}], stop_reason } result. Non-streaming: one
// turn per call; the agent loop calls it repeatedly, feeding tool results back.
import { invoke } from "@backend";

export function userMsg(text) { return { role: "user", text }; }
export function assistantToolCalls(text, toolCalls) {
  return { role: "assistant", text: text || "", tool_calls: toolCalls || [] };
}
export function toolResult(toolCallId, content, isError = false) {
  return { role: "tool", tool_call_id: toolCallId, content: String(content ?? ""), is_error: !!isError };
}

/** Run one tool-calling turn. llm = { kind, baseUrl, apiKey, model }.
 *  messages = normalized NormMsg[]; tools = ToolDef[] (may be []). */
export async function toolTurn(llm, system, messages, tools) {
  return await invoke("llm_tool_turn", {
    kind: llm.kind, baseUrl: llm.baseUrl || "", apiKey: llm.apiKey,
    model: llm.model, system, messages, tools: tools || [],
  });
}
```

- [ ] **Step 4: Run to pass** — `npm test -- llmTools` → PASS. Also `npm run build` → succeeds.
- [ ] **Step 5: Commit**
```bash
git add src/features/terminals/llmTools.js src/features/terminals/llmTools.test.js
git commit -m "feat(llm): JS tool-turn wrapper + message builders"
```

---

## Self-Review (Component B vs spec)
- Native function-calling, Anthropic + OpenAI dialects → B1–B4. ✓
- Tools optional; no-tools `llm_complete`/`llm_stream` untouched (only `http_error` visibility) → B4 Step 4. ✓
- Uniform `{text, tool_calls:[{id,name,args}], stop_reason}` consumed by the agent loop (Component C) → B3/B5. ✓
- OpenAI function-name `.`-restriction handled (encode `__`) → B1, round-tripped in parse → B3. ✓
- Tested without a live LLM via pure translate/parse unit tests → B1–B3 (8 Rust tests) + B5 (JS). ✓

**Deviation from spec (note for the user):** spec B mentioned streaming tool-call deltas; v1 is **non-streaming** per turn — far more reliable to parse correctly across both dialects, and the agent still renders text per step. Streaming-during-tool-turns is a clean follow-up. Flagged at handoff.

**Type consistency:** `enc_name`/`dec_name` round-trip used in both translate (B1/B2) and parse (B3); the `{text,tool_calls:[{id,name,args}],stop_reason}` result shape is identical across `parse_anthropic_response`/`parse_openai_response` and the JS wrapper; `llm_tool_turn` params match the JS `toolTurn` invoke args (camelCase `baseUrl`→`base_url`).
