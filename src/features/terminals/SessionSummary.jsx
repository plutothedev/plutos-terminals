// (C)
// AI session summary — sends the active terminal's recent output to the active
// LLM and shows a concise summary (what happened, key results, anything that
// errored, suggested next step). Same Rust llm_complete path as ErrorExplainer
// (the key never hits a browser request).
import { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { Button } from "../../components/ui.jsx";
import { resolveActiveLLM } from "./providers.js";
import { llmStream } from "./llmStream.js";
import { readUserSt } from "./storageKeys.js";

const SYSTEM =
  "You are summarizing a terminal session for an engineer. From the recent " +
  "terminal output, produce: (1) a 1-2 sentence summary of what was done, " +
  "(2) key results or state changes as short bullets, (3) anything that errored " +
  "or looks wrong, and (4) one suggested next step. Be concise; skip prompts/noise.";

export default function SessionSummary({ open, text, onClose }) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modelLabel, setModelLabel] = useState("");
  const ran = useRef(false);

  useEffect(() => {
    if (!open) { ran.current = false; setAnswer(""); setError(null); return; }
    if (ran.current) return;
    ran.current = true;
    const body = (text || "").trim();
    if (!body) { setLoading(false); setError("Nothing in this terminal to summarize yet."); return; }
    const llm = resolveActiveLLM(readUserSt());
    if (!llm) { setLoading(false); setError("No model configured — open the Models picker first."); return; }
    setModelLabel(llm.model);
    setLoading(true); setError(null); setAnswer("");
    // Streaming (P3-T2): deltas render as they arrive — the spinner clears on
    // the first token. Cleanup CANCELS the stream AND resets the ran-guard so
    // StrictMode's dev double-mount re-runs cleanly instead of dead-modaling
    // (plan audit M3); a real close also stops provider-side generation.
    // `cancelled` guards every continuation (stream audit W1): summarizing tab
    // B while A still streams re-runs this effect on the SAME mounted modal —
    // without the guard, A's cancelled promise still resolves with partial
    // text and clobbers B's answer (llm_stream returns Ok on cancel, not Err).
    let cancelled = false;
    const { promise, cancel } = llmStream(
      {
        kind: llm.kind, baseUrl: llm.baseUrl, apiKey: llm.apiKey,
        model: llm.model, system: SYSTEM,
        prompt: `--- recent terminal output ---\n${body}`,
      },
      (piece) => {
        if (cancelled) return;
        setLoading(false);
        setAnswer((cur) => cur + piece);
      }
    );
    promise
      .then((t) => { if (!cancelled && typeof t === "string" && t) setAnswer(t.trim()); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      cancel();
      ran.current = false;
    };
  }, [open, text]);

  return (
    <Modal open={open} title="Summarize session" onClose={onClose} width={620}>
      <div style={{ fontSize: "var(--phn-fs-2xs)", color: "var(--phn-text-dim)", marginBottom: "var(--phn-sp-2)" }}>
        {modelLabel ? `via ${modelLabel}` : "active model"}
      </div>
      <div style={{ maxHeight: "60vh", overflow: "auto", fontSize: "var(--phn-fs-sm)", lineHeight: "var(--phn-lh)", color: "var(--phn-text-fg)", whiteSpace: "pre-wrap" }}>
        {loading ? (
          <span style={{ color: "var(--phn-text-dim)" }}>Reading the terminal and summarizing…</span>
        ) : error ? (
          <span style={{ color: "var(--phn-danger)" }}>{error}</span>
        ) : (
          answer || <span style={{ color: "var(--phn-text-dim)" }}>No response.</span>
        )}
      </div>
      {answer && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--phn-sp-3)" }}>
          <Button variant="ghost" size="sm" onClick={() => navigator.clipboard?.writeText(answer)}>
            Copy
          </Button>
        </div>
      )}
    </Modal>
  );
}
