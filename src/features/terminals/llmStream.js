// (C)
// Streaming LLM helper. Calls the Rust `llm_stream` command with a Tauri Channel
// so token deltas arrive live via onToken(piece); resolves with the full text.
// Falls back to the non-streaming `llm_complete` if streaming is unavailable
// (older backend, web build, or an endpoint that rejects stream:true).

import { invoke } from "@backend";

export async function llmStream({ kind, baseUrl, apiKey, model, system, prompt }, onToken) {
  try {
    // Lazy import so non-Tauri bundles (the phone companion web build) don't
    // hard-depend on @tauri-apps/api/core at module load.
    const { Channel } = await import("@tauri-apps/api/core");
    const channel = new Channel();
    channel.onmessage = (msg) => { try { onToken?.(msg); } catch { /* ignore */ } };
    return await invoke("llm_stream", { onChunk: channel, kind, baseUrl, apiKey, model, system, prompt });
  } catch (err) {
    // Distinguish "streaming not wired up" from a real provider error. If the
    // command itself is missing/unsupported, retry non-streaming; otherwise the
    // non-streaming path will surface the same provider error to the caller.
    const full = await invoke("llm_complete", { kind, baseUrl, apiKey, model, system, prompt });
    if (full) onToken?.(full);
    return full;
  }
}
