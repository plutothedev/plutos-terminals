// (C)
// Right-dock AI Assistant — a compact chat against the active model from the
// Models picker. The provider call runs in Rust (llm_complete) so the key never
// touches the webview. When the model replies with a fenced command you can run
// or insert it into the active terminal.
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@backend";
import { resolveActiveLLM } from "./providers.js";
import { readUserSt } from "./storageKeys.js";
import { SSend } from "./toolbarIcons.jsx";
import PromptSlashMenu, { filterPrompts, menuKeyAction } from "./PromptSlashMenu.jsx";

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

  // Saved-prompts "/" menu. `promptMenuClosed` is an EXPLICIT override on top of
  // the input.startsWith("/") derivation — inserting a prompt whose body itself
  // starts with "/" must not immediately reopen the menu (see PromptSlashMenu.jsx
  // header comment). It resets on the next real keystroke (onChange), so typing
  // further re-evaluates normally.
  const [promptMenuClosed, setPromptMenuClosed] = useState(false);
  const [promptMenuIndex, setPromptMenuIndex] = useState(0);
  const hasPrompts = Array.isArray(prompts) && prompts.length > 0;
  const promptMenuOpen = !promptMenuClosed && input.startsWith("/") && hasPrompts;
  const filteredPrompts = useMemo(
    () => (promptMenuOpen ? filterPrompts(prompts, input.slice(1)) : []),
    [promptMenuOpen, prompts, input]
  );

  const insertPrompt = (body) => {
    setInput(body);
    setPromptMenuClosed(true); // explicit close — see comment above
  };

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
        {promptMenuOpen && (
          <PromptSlashMenu
            prompts={prompts}
            inputValue={input}
            selectedIndex={promptMenuIndex}
            onInsert={insertPrompt}
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
          onChange={(e) => {
            setInput(e.target.value);
            setPromptMenuClosed(false);
            setPromptMenuIndex(0);
          }}
          onKeyDown={(e) => {
            // The slash-menu's Enter/Escape decision is consulted BEFORE the
            // existing Enter-to-send below, so an open menu's Enter selects a
            // prompt instead of sending the message. ArrowUp/Down (menu
            // selection movement) don't compete with any existing behavior
            // here, so they're handled unconditionally while the menu is open.
            if (promptMenuOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setPromptMenuIndex((i) => Math.min(i + 1, Math.max(filteredPrompts.length - 1, 0)));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setPromptMenuIndex((i) => Math.max(i - 1, 0));
                return;
              }
            }
            const action = menuKeyAction(e.key, promptMenuOpen);
            if (action === "select") {
              e.preventDefault();
              const chosen = filteredPrompts[promptMenuIndex] || filteredPrompts[0];
              if (chosen) insertPrompt(chosen.body);
              return;
            }
            if (action === "close") {
              e.preventDefault();
              setPromptMenuClosed(true);
              return;
            }
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
