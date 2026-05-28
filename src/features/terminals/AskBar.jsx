// (C)
// Ask-AI command bar (NL→command). Type what you want in plain English; the
// active LLM (Models picker / default Claude) returns ONE shell command, which
// you review/edit before running. The provider call runs in Rust (llm_complete)
// so the key never hits a browser request — same pattern as ErrorExplainer.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Modal from "../../components/Modal.jsx";
import { resolveActiveLLM } from "./providers.js";

function readUserSt() {
  try { return JSON.parse(localStorage.getItem("plutos-terminals:user:v0") || "{}"); }
  catch { return {}; }
}

// Strip markdown fences / "$ " prompts the model sometimes adds despite asking
// for a bare command, and collapse to the first non-empty line(s).
function cleanCommand(raw) {
  let s = String(raw || "").trim();
  const fence = s.match(/```(?:[a-zA-Z]*)?\n([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  s = s.replace(/^\$\s+/gm, "");
  return s.trim();
}

export default function AskBar({ open, onClose, onRun, onInsert, shellName, cwd }) {
  const [intent, setIntent] = useState("");
  const [command, setCommand] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [modelLabel, setModelLabel] = useState("");
  const intentRef = useRef(null);
  const cmdRef = useRef(null);

  useEffect(() => {
    if (open) {
      setIntent(""); setCommand(""); setError(null); setLoading(false);
      setTimeout(() => intentRef.current?.focus(), 30);
    }
  }, [open]);

  const generate = async () => {
    const q = intent.trim();
    if (!q) return;
    const llm = resolveActiveLLM(readUserSt());
    if (!llm) { setError("No model configured — open the Models picker (toolbar) first."); return; }
    setModelLabel(llm.model);
    setLoading(true); setError(null); setCommand("");
    const os = navigator.userAgent.includes("Windows") ? "Windows"
      : navigator.userAgent.includes("Mac") ? "macOS" : "Linux";
    const system =
      `You translate a natural-language request into a single ${shellName || "shell"} ` +
      `command for ${os}. Output ONLY the command — no explanation, no markdown, no ` +
      `code fences, no leading "$". If multiple steps are required, join them with && ` +
      `on one line. Prefer safe, non-destructive commands.`;
    const prompt = (cwd ? `Current directory: ${cwd}\n` : "") + `Request: ${q}`;
    try {
      const t = await invoke("llm_complete", {
        kind: llm.kind, baseUrl: llm.baseUrl, apiKey: llm.apiKey,
        model: llm.model, system, prompt,
      });
      const cmd = cleanCommand(t);
      setCommand(cmd);
      setTimeout(() => cmdRef.current?.focus(), 30);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const run = () => { const c = command.trim(); if (!c) return; onRun(c); onClose(); };
  const insert = () => { const c = command.trim(); if (!c) return; onInsert(c); onClose(); };

  return (
    <Modal open={open} title="Ask AI — describe what you want to run" onClose={onClose} width={600}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          ref={intentRef}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") generate(); }}
          placeholder="e.g. find files over 100MB under this folder, newest first"
          style={input}
        />
        <button onClick={generate} disabled={loading || !intent.trim()} style={primaryBtn}>
          {loading ? "thinking…" : "generate"}
        </button>
      </div>
      {modelLabel && <div style={{ fontSize: 10, color: DIM, marginTop: 6 }}>via {modelLabel}</div>}

      {error && <div style={{ color: "#ff6b6b", fontSize: 12, marginTop: 10 }}>{error}</div>}

      {command && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, color: DIM, marginBottom: 4, letterSpacing: 0.5 }}>PROPOSED COMMAND — review before running</div>
          <textarea
            ref={cmdRef}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }}
            rows={Math.min(6, command.split("\n").length + 1)}
            style={{ ...input, width: "100%", fontFamily: "'MesloLGS NF', monospace", fontSize: 12.5, resize: "vertical", boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
            <button onClick={onClose} style={ghostBtn}>cancel</button>
            <button onClick={insert} style={ghostBtn} title="Put it on the prompt without running">insert</button>
            <button onClick={run} style={primaryBtn} title="Run in the active terminal (⌘/Ctrl+Enter)">run ↵</button>
          </div>
        </div>
      )}

      <p style={{ fontSize: 10.5, color: DIM, marginTop: 14, lineHeight: 1.5 }}>
        Uses your active model from the <strong>Models</strong> section. The command is shown for
        review — nothing runs until you click <strong>run</strong>. <em>insert</em> drops it on the
        prompt so you can tweak it first.
      </p>
    </Modal>
  );
}

const DIM = "var(--phn-text-dim, #888)";
const input = {
  flex: 1, background: "var(--phn-page-bg, #1c1c1c)",
  border: "1px solid var(--phn-surface-border, #2a2a2a)", borderRadius: 4,
  color: "var(--phn-text-fg, #d4d4d4)", padding: "7px 9px", fontSize: 12.5,
  fontFamily: "var(--phn-ui-font)", outline: "none",
};
const primaryBtn = {
  background: "var(--phn-link, #4aa8c0)", border: "1px solid var(--phn-link, #4aa8c0)",
  color: "#06223a", padding: "6px 14px", borderRadius: 4, fontSize: 11.5, fontWeight: 600,
  cursor: "pointer", fontFamily: "var(--phn-ui-font)", whiteSpace: "nowrap",
};
const ghostBtn = {
  background: "transparent", border: "1px solid var(--phn-surface-border, #3a3a3a)",
  color: "var(--phn-text-fg, #d4d4d4)", padding: "6px 14px", borderRadius: 4,
  fontSize: 11.5, cursor: "pointer", fontFamily: "var(--phn-ui-font)", whiteSpace: "nowrap",
};
