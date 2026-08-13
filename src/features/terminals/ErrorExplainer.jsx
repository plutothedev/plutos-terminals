// (C)
// AI error explainer — given a failed command block (command + output + exit
// code from OSC 133 tracking), asks the user's ACTIVE LLM provider (model
// picker, or the default Anthropic key) to explain the failure and suggest a
// fix. The provider call runs in Rust (llm_complete) so the key never hits a
// browser request. Reads provider config straight from localStorage (same
// pattern TerminalPane uses for env injection).
import { useEffect, useRef, useState } from "react";
import { resolveActiveLLM } from "./providers.js";
import { llmStream } from "./llmStream.js";
import { readUserSt } from "./storageKeys.js";
import { humanizeError } from "./errorText.js";
import { SAsk } from "./toolbarIcons.jsx";

const SYSTEM =
  "You are a senior engineer pair-debugging in a terminal. A shell command just " +
  "failed. From the command, its output and exit code, explain the most likely " +
  "cause in 1-3 sentences, then give the exact fix command(s) in a fenced block. " +
  "Be concise and specific — no preamble.";

// Pull the first fenced command block out of the model's answer so we can offer
// a one-click "run fix". Falls back to null when there's no fenced block.
function extractFix(answer) {
  const m = String(answer || "").match(/```(?:[a-zA-Z]*)?\n([\s\S]*?)```/);
  if (!m) return null;
  const cmd = m[1].replace(/^\$\s+/gm, "").trim();
  return cmd || null;
}

export default function ErrorExplainer({ block, onClose, onRun }) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modelLabel, setModelLabel] = useState("");
  const ranFor = useRef(null);

  useEffect(() => {
    if (!block) return;
    if (ranFor.current === block.key) return; // one call per failed block
    ranFor.current = block.key;
    const llm = resolveActiveLLM(readUserSt());
    if (!llm) {
      setLoading(false);
      setError("No model configured. Open the Models picker (toolbar) or set your Anthropic key.");
      return;
    }
    setModelLabel(llm.model);
    setLoading(true); setError(null); setAnswer("");
    const prompt =
      `Exit code: ${block.exitCode}\n\n--- terminal (command + output) ---\n` +
      block.text.slice(-3500);
    // Staleness guard + stream cancel (P3-T2): a since-dismissed block (or a
    // switch to a different failed block) cancels the stream — Rust drops the
    // connection so the provider stops generating — and mutes late deltas.
    let cancelled = false;
    const { promise, cancel } = llmStream(
      {
        kind: llm.kind, baseUrl: llm.baseUrl, apiKey: llm.apiKey,
        model: llm.model, system: SYSTEM, prompt,
      },
      (piece) => {
        if (cancelled) return;
        setLoading(false);
        setAnswer((cur) => cur + piece);
      }
    );
    promise
      .then((t) => { if (!cancelled && typeof t === "string" && t) setAnswer(t.trim()); })
      .catch((e) => { if (!cancelled) setError(humanizeError(e).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; cancel(); };
  }, [block]);

  if (!block) return null;

  const fixCmd = extractFix(answer);

  return (
    <div
      style={{
        position: "absolute", left: 12, right: 12, bottom: 12, zIndex: 30,
        maxHeight: "55%", display: "flex", flexDirection: "column",
        background: "var(--phn-surface-bg, #242424)",
        border: "1px solid var(--phn-link, #7c9cf5)",
        borderRadius: 8, boxShadow: "0 8px 26px rgba(0,0,0,0.6)",
        fontFamily: "var(--phn-ui-font)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--phn-surface-border, #151515)" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--phn-text-fg, #d4d4d4)", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <SAsk size={13} /> Explain error <span style={{ color: "#ff6b6b" }}>· exit {block.exitCode}</span>
        </span>
        {modelLabel && <span style={{ fontSize: 10, color: "var(--phn-text-dim, #888)" }}>via {modelLabel}</span>}
        <span style={{ flex: 1 }} />
        {fixCmd && onRun && (
          <button
            onClick={() => { onRun(fixCmd); onClose(); }}
            title={`Run the suggested fix: ${fixCmd}`}
            style={{ ...btn, background: "var(--phn-link, #7c9cf5)", color: "#06223a", border: "1px solid var(--phn-link, #7c9cf5)", fontWeight: 600 }}
          >
            Run fix ▶
          </button>
        )}
        {answer && (
          <button onClick={() => navigator.clipboard?.writeText(answer)} title="Copy" style={btn}>Copy</button>
        )}
        <button onClick={onClose} title="Close (Esc)" style={btn}>✕</button>
      </div>
      <div style={{ overflow: "auto", padding: "10px 12px", fontSize: 12.5, lineHeight: 1.55, color: "var(--phn-text-fg, #d4d4d4)", whiteSpace: "pre-wrap" }}>
        {loading ? (
          <span style={{ color: "var(--phn-text-dim, #888)" }}>Asking {modelLabel || "the model"}…</span>
        ) : error ? (
          <span style={{ color: "#ff6b6b" }}>{error}</span>
        ) : (
          answer || <span style={{ color: "var(--phn-text-dim, #888)" }}>No response.</span>
        )}
      </div>
    </div>
  );
}

const btn = {
  background: "transparent", border: "1px solid var(--phn-surface-border, #3a3a3a)",
  color: "var(--phn-text-fg, #d4d4d4)", borderRadius: 4, padding: "2px 8px",
  fontSize: 11, cursor: "pointer", fontFamily: "var(--phn-ui-font)",
};
