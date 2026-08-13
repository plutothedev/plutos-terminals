// (C)
// Right-dock AI Assistant — a compact chat against the active model from the
// Models picker. The provider call runs in Rust (llm_complete) so the key never
// touches the webview. When the model replies with a fenced command you can run
// or insert it into the active terminal.
import { useEffect, useRef, useState } from "react";
import { resolveActiveLLM } from "./providers.js";
import { llmStream } from "./llmStream.js";
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
  // Live stream cancel handle — invoked on unmount (dock tab switch) so a
  // closed surface stops consuming (and billing) the stream. P3-T2.
  // aliveRef guards send()'s post-await tail (P3 re-review): a cancelled
  // stream still RESOLVES Ok with partial text, and the unmounted tail would
  // otherwise run its normalize/finally against the dead fiber — the same
  // hazard class the W1 fix closed in SessionSummary.
  const cancelRef = useRef(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; cancelRef.current?.(); };
  }, []);

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
    // Role-structured recent turns (P3-T2): the old path flattened them into
    // ONE user string — losing role structure and any chance of provider-side
    // prefix reuse. Bounded to the last 12 turns as before.
    const history = next.slice(-12).map((m) => ({ role: m.role, content: m.content }));
    try {
      // Streaming: an empty assistant message appends first, then deltas grow
      // it in place — time-to-first-token instead of time-to-last.
      setMessages((cur) => [...cur, { role: "assistant", content: "" }]);
      const { promise, cancel } = llmStream(
        {
          kind: llm.kind, baseUrl: llm.baseUrl, apiKey: llm.apiKey,
          model: llm.model, system, messages: history,
        },
        (piece) => {
          // First token retires the "thinking…" ghost (stream audit W2) —
          // leaving it to the outer finally kept BOTH the growing bubble and
          // the ghost on screen for the whole stream.
          setLoading(false);
          setMessages((cur) => {
            const out = cur.slice();
            const last = out[out.length - 1];
            if (last?.role === "assistant") {
              out[out.length - 1] = { ...last, content: last.content + piece };
            }
            return out;
          });
        }
      );
      cancelRef.current = cancel;
      const t = await promise;
      if (!aliveRef.current) return;
      // Normalize the final text once complete (trim + authoritative full).
      setMessages((cur) => {
        const out = cur.slice();
        const last = out[out.length - 1];
        if (last?.role === "assistant") {
          out[out.length - 1] = { ...last, content: String(t ?? last.content).trim() };
        }
        return out;
      });
    } catch (e) {
      if (!aliveRef.current) return;
      setError(String(e));
      // Drop the empty/partial assistant placeholder on error.
      setMessages((cur) => {
        const last = cur[cur.length - 1];
        return last?.role === "assistant" && !last.content ? cur.slice(0, -1) : cur;
      });
    } finally {
      cancelRef.current = null;
      if (aliveRef.current) setLoading(false);
    }
  };

  return (
    <div className="phn-assistant">
      <div className="phn-assistant-list" ref={listRef}>
        {messages.length === 0 && !loading && (
          <div className="phn-assistant-empty">
            Ask anything — commands, errors, git, regex. Replies use your active model from the
            <strong> Models</strong> picker; fenced commands get <em>Run</em> / <em>Insert</em> buttons.
          </div>
        )}
        {messages.map((m, i) => {
          // Pre-first-token, the empty assistant placeholder would render as a
          // bare bubble under the "thinking…" ghost — hide it until it grows.
          if (m.role === "assistant" && !m.content && loading && i === messages.length - 1) return null;
          const cmd = m.role === "assistant" ? extractCmd(m.content) : null;
          return (
            <div key={i} className={m.role === "user" ? "phn-msg user" : "phn-msg assistant"}>
              <div className="phn-msg-body">{m.content}</div>
              {cmd && onSendToTerminal && (
                <div className="phn-msg-actions">
                  <button onClick={() => onSendToTerminal(cmd.replace(/\n+$/, "") + "\r")} title="Run in the active terminal">Run ↵</button>
                  <button onClick={() => onSendToTerminal(cmd)} title="Insert on the prompt (don't run)">Insert</button>
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
