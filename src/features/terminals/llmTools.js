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
