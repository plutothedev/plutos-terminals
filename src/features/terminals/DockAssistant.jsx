// (C)
// Right-dock AI Assistant — a compact chat against the active model from the
// Models picker. The provider call runs in Rust (llm_complete) so the key never
// touches the webview. When the model replies with a fenced command you can run
// or insert it into the active terminal.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@backend";
import { resolveActiveLLM } from "./providers.js";
import { readUserSt } from "./storageKeys.js";
import { SSend } from "./toolbarIcons.jsx";
import PromptSlashMenu from "./PromptSlashMenu.jsx";
import { usePromptSlashMenu } from "./hooks/usePromptSlashMenu.js";

// First fenced code block in an assistant reply, if any (so we can offer run/insert).
function extractCmd(text) {
  const m = String(text).match(/```(?:[a-zA-Z]*)?\n?([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

export default function DockAssistant({ onSendToTerminal, shellName, cwd, prompts }) {
  const [messages, setMessages] = useState([]); // {role:'user'|'assistant', content}
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [model, setModel] = useState(null);
  const listRef = useRef(null);

  // Saved-prompts "/" menu — all index/filter/keyboard state lives in the
  // shared hook (also consumed by AgentMode.jsx), so this and AgentMode can
  // never drift into two different clamp implementations again.
  const promptMenu = usePromptSlashMenu({ value: input, setValue: setInput, prompts });

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
        {promptMenu.open && (
          <PromptSlashMenu
            items={promptMenu.filtered}
            selectedIndex={promptMenu.selectedIndex}
            onInsert={promptMenu.select}
          />
        )}
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
          onChange={(e) => promptMenu.handleChange(e.target.value)}
          onKeyDown={(e) => {
            // The slash-menu gets first look at every keydown; if it reports
            // "handled" (it already preventDefault()'d and did whatever the
            // key meant — move selection, select, or close) the existing
            // Enter-to-send below is skipped. When the menu is closed (or open
            // with zero matches), it always reports "passthrough" with no
            // side effects, so Enter-to-send is byte-identical to before.
            if (promptMenu.onKeyDown(e) === "handled") return;
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          placeholder={model ? `Message ${model}…` : "Ask the assistant… (Enter to send)"}
          rows={2}
          spellCheck={false}
        />
        <button onClick={send} disabled={loading || !input.trim()} title="Send (Enter)"><SSend size={14} /></button>
      </div>
    </div>
  );
}
