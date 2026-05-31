// (C)
// Ask-AI command bar (NL→command). Type what you want in plain English; the
// active LLM (Models picker / default Claude) returns ONE shell command, which
// you review/edit before running. The provider call runs in Rust (llm_complete)
// so the key never hits a browser request — same pattern as ErrorExplainer.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@backend";
import Modal from "../../components/Modal.jsx";
import { Button, Input, Textarea } from "../../components/ui.jsx";
import { resolveActiveLLM } from "./providers.js";
import { readUserSt } from "./storageKeys.js";

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
    <Modal open={open} title="Ask AI" onClose={onClose} width={600}>
      <div style={{ display: "flex", gap: "var(--phn-sp-2)" }}>
        <Input
          ref={intentRef}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") generate(); }}
          placeholder="e.g. find files over 100MB under this folder, newest first"
        />
        <Button variant="primary" onClick={generate} disabled={loading || !intent.trim()}>
          {loading ? "thinking…" : "generate"}
        </Button>
      </div>
      {modelLabel && <div style={{ fontSize: "var(--phn-fs-2xs)", color: "var(--phn-text-dim)", marginTop: "var(--phn-sp-2)" }}>via {modelLabel}</div>}

      {error && <div style={{ color: "var(--phn-danger)", fontSize: "var(--phn-fs-sm)", marginTop: "var(--phn-sp-3)" }}>{error}</div>}

      {command && (
        <div style={{ marginTop: "var(--phn-sp-3)" }}>
          <div style={{ fontSize: "var(--phn-fs-2xs)", color: "var(--phn-text-dim)", marginBottom: "var(--phn-sp-1)", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600 }}>Proposed command — review before running</div>
          <Textarea
            ref={cmdRef}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }}
            rows={Math.min(6, command.split("\n").length + 1)}
          />
          <div style={{ display: "flex", gap: "var(--phn-sp-2)", marginTop: "var(--phn-sp-3)", justifyContent: "flex-end" }}>
            <Button variant="subtle" onClick={onClose}>cancel</Button>
            <Button variant="ghost" onClick={insert} title="Put it on the prompt without running">insert</Button>
            <Button variant="primary" onClick={run} title="Run in the active terminal (⌘/Ctrl+Enter)">run ↵</Button>
          </div>
        </div>
      )}

      <p style={{ fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)", marginTop: "var(--phn-sp-4)", lineHeight: "var(--phn-lh)" }}>
        Uses your active model from the <strong>Models</strong> section. The command is shown for
        review — nothing runs until you click <strong>run</strong>. <em>insert</em> drops it on the
        prompt so you can tweak it first.
      </p>
    </Modal>
  );
}
