// (C)
// AI session summary — sends the active terminal's recent output to the active
// LLM and shows a concise summary (what happened, key results, anything that
// errored, suggested next step). Same Rust llm_complete path as ErrorExplainer
// (the key never hits a browser request).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Modal from "../../components/Modal.jsx";
import { resolveActiveLLM } from "./providers.js";

const SYSTEM =
  "You are summarizing a terminal session for an engineer. From the recent " +
  "terminal output, produce: (1) a 1-2 sentence summary of what was done, " +
  "(2) key results or state changes as short bullets, (3) anything that errored " +
  "or looks wrong, and (4) one suggested next step. Be concise; skip prompts/noise.";

function readUserSt() {
  try { return JSON.parse(localStorage.getItem("plutos-terminals:user:v0") || "{}"); }
  catch { return {}; }
}

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
    invoke("llm_complete", {
      kind: llm.kind, baseUrl: llm.baseUrl, apiKey: llm.apiKey,
      model: llm.model, system: SYSTEM,
      prompt: `--- recent terminal output ---\n${body}`,
    })
      .then((t) => setAnswer(typeof t === "string" ? t.trim() : ""))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, text]);

  return (
    <Modal open={open} title="Summarize session" onClose={onClose} width={620}>
      <div style={{ fontSize: 10, color: "var(--phn-text-dim, #888)", marginBottom: 8 }}>
        {modelLabel ? `via ${modelLabel}` : "active model"}
      </div>
      <div style={{ maxHeight: "60vh", overflow: "auto", fontSize: 12.5, lineHeight: 1.55, color: "var(--phn-text-fg, #d4d4d4)", whiteSpace: "pre-wrap" }}>
        {loading ? (
          <span style={{ color: "var(--phn-text-dim, #888)" }}>Reading the terminal and summarizing…</span>
        ) : error ? (
          <span style={{ color: "#ff6b6b" }}>{error}</span>
        ) : (
          answer || <span style={{ color: "var(--phn-text-dim, #888)" }}>No response.</span>
        )}
      </div>
      {answer && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button
            onClick={() => navigator.clipboard?.writeText(answer)}
            style={{ background: "transparent", border: "1px solid var(--phn-surface-border, #3a3a3a)", color: "var(--phn-text-fg, #d4d4d4)", borderRadius: 4, padding: "5px 12px", fontSize: 11.5, cursor: "pointer", fontFamily: "var(--phn-ui-font)" }}
          >
            copy
          </button>
        </div>
      )}
    </Modal>
  );
}
