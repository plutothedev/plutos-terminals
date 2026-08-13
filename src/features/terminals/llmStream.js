// (C)
// Streaming LLM helper (P3-T2). Calls the Rust `llm_stream` command with a
// Tauri Channel so token deltas arrive live via onToken(piece); the returned
// promise resolves with the full text. Returns { promise, cancel }: cancel
// tells Rust to stop consuming (dropping the response closes the connection so
// the provider stops generating — tokens stop billing) and mutes onToken.
//
// Falls back to non-streaming `llm_complete` ONLY when streaming itself is
// unavailable (missing command / older backend). Provider errors rethrow — a
// blanket fallback would turn one 429 into a second full request on top of the
// Rust-side transient retries (P3 audit M9).

import { invoke } from "@backend";

export function llmStream(
  { kind, baseUrl, apiKey, model, system, prompt, messages },
  onToken
) {
  const requestId = `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let cancelled = false;
  const promise = (async () => {
    try {
      // Lazy import so non-Tauri bundles (the phone companion web build)
      // don't hard-depend on @tauri-apps/api/core at module load.
      const { Channel } = await import("@tauri-apps/api/core");
      const channel = new Channel();
      channel.onmessage = (msg) => {
        if (cancelled) return;
        try { onToken?.(msg); } catch { /* ignore */ }
      };
      return await invoke("llm_stream", {
        onChunk: channel,
        kind, baseUrl, apiKey, model,
        system, prompt: prompt ?? "",
        messages: messages ?? null,
        requestId,
      });
    } catch (err) {
      const msg = String(err);
      // EXACT missing-command string from Tauri's dispatcher
      // (`Command {name} not found`, webview/mod.rs) — nothing broader (stream
      // audit W3): loose terms like "not found"/"unknown" also appear in real
      // provider errors ("model not found", "unknown parameter"), and a misfire
      // silently re-issues the same failing request as a second paid call.
      const streamingUnavailable = /command llm_stream not found/i.test(msg);
      if (!streamingUnavailable) throw err;
      const full = await invoke("llm_complete", {
        kind, baseUrl, apiKey, model,
        system, prompt: prompt ?? "",
        messages: messages ?? null,
      });
      if (full && !cancelled) onToken?.(full);
      return full;
    }
  })();
  const cancel = () => {
    cancelled = true;
    invoke("llm_stream_cancel", { requestId }).catch(() => {});
  };
  return { promise, cancel };
}
