// (C)
// Right-dock AI Assistant — a compact chat against the active model from the
// Models picker. The provider call runs in Rust (llm_complete) so the key never
// touches the webview. When the model replies with a fenced command you can run
// or insert it into the active terminal.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveActiveLLM } from "./providers.js";
import { readUserSt } from "./storageKeys.js";

// First fenced code block in an assistant reply, if any (so we can offer run/insert).
function extractCmd(text) {
  const m = String(text).match(/```(?:[a-zA-Z]*)?\n?([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

export default function DockAssistant({ onSendToTerminal, shellName, cwd }) {
  const [messages, setMessages] = useState([]); // {role:'user'|'assistant', content}
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [model, setModel] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, loading]);

  const send = async () => {
    const q = input.trim();
    if (!q || loading) return;
    const llm = resolveActiveLLM(readUserSt());
    if (!llm) { setError("No model configured — open the Models picker (toolbar) first."); return; }
    setModel(llm.model);
    setError(null);
    const next = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setLoading(true);
    const os = navigator.userAgent.includes("Windows") ? "Windows"
      : navigator.userAgent.includes("Mac") ? "macOS" : "Linux";
    const system =
      `You are a concise terminal & developer assistant embedded in Pluto's Terminals on ${os}. ` +
      `The user's shell is ${shellName || "shell"}${cwd ? `, working directory ${cwd}` : ""}. ` +
      `Answer briefly. When you give a shell command, put it on its own line in a fenced code block.`;
    // Only send the recent turns so the prompt (and cost/latency) stays bounded
    // as the conversation grows.
    const transcript = next
      .slice(-12)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    try {
      const t = await invoke("llm_complete", {
        kind: llm.kind, baseUrl: llm.baseUrl, apiKey: llm.apiKey,
        model: llm.model, system, prompt: `${transcript}\n\nAssistant:`,
      });
      setMessages((cur) => [...cur, { role: "assistant", content: String(t).trim() }]);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="phn-assistant">
      <div className="phn-assistant-list" ref={listRef}>
        {messages.length === 0 && !loading && (
          <div className="phn-assistant-empty">
            Ask anything — commands, errors, git, regex. Replies use your active model from the
            <strong> Models</strong> picker; fenced commands get <em>run</em> / <em>insert</em> buttons.
          </div>
        )}
        {messages.map((m, i) => {
          const cmd = m.role === "assistant" ? extractCmd(m.content) : null;
          return (
            <div key={i} className={m.role === "user" ? "phn-msg user" : "phn-msg assistant"}>
              <div className="phn-msg-body">{m.content}</div>
              {cmd && onSendToTerminal && (
                <div className="phn-msg-actions">
                  <button onClick={() => onSendToTerminal(cmd.replace(/\n+$/, "") + "\r")} title="Run in the active terminal">run ↵</button>
                  <button onClick={() => onSendToTerminal(cmd)} title="Insert on the prompt (don't run)">insert</button>
                </div>
              )}
            </div>
          );
        })}
        {loading && (
          <div className="phn-msg assistant"><div className="phn-msg-body phn-msg-thinking">thinking…</div></div>
        )}
      </div>
      {error && <div className="phn-assistant-error">{error}</div>}
      <div className="phn-assistant-input">
        {messages.length > 0 && (
          <button
            className="phn-assistant-clear"
            onClick={() => { setMessages([]); setError(null); }}
            disabled={loading}
            title="Clear conversation"
          >
            clear
          </button>
        )}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={model ? `Message ${model}…` : "Ask the assistant… (Enter to send)"}
          rows={2}
          spellCheck={false}
        />
        <button onClick={send} disabled={loading || !input.trim()} title="Send (Enter)">➤</button>
      </div>
    </div>
  );
}
