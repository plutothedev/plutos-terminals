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
import { modCombo } from "./keybindings.js";
import { classifyInput } from "./inputClassify.js";

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
  // Run the typed text directly as a command (auto-detect path — no LLM).
  const runDirect = () => { const c = intent.trim(); if (!c) return; onRun(c); onClose(); };

  // Auto-detect: is what the user typed a command (run it) or English (ask AI)?
  const cls = classifyInput(intent);
  const looksCommand = cls.kind === "command";
  const onIntentEnter = (e) => {
    if (e.key !== "Enter") return;
    if (looksCommand) runDirect();
    else generate();
  };

  return (
    <Modal open={open} title="Ask AI · run a command" onClose={onClose} width={600}>
      <div style={{ display: "flex", gap: "var(--phn-sp-2)" }}>
        <Input
          ref={intentRef}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={onIntentEnter}
          mono={looksCommand}
          placeholder="Type a command, or describe what you want in plain English"
        />
        {looksCommand
          ? <Button variant="primary" onClick={runDirect} disabled={!intent.trim()} title="Run this command in the active terminal (↵)">run ↵</Button>
          : <Button variant="primary" onClick={generate} disabled={loading || !intent.trim()}>{loading ? "thinking…" : "generate ↵"}</Button>}
      </div>
      {intent.trim() && (
        <div style={{ fontSize: "var(--phn-fs-2xs)", color: "var(--phn-text-dim)", marginTop: "var(--phn-sp-2)", display: "flex", gap: "var(--phn-sp-2)", alignItems: "center" }}>
          {looksCommand
            ? <><span style={{ color: "var(--phn-success, #6FB85C)" }}>● command</span> · Enter runs it as-is · <button onClick={generate} disabled={loading} style={{ background: "none", border: "none", color: "var(--phn-link)", cursor: "pointer", padding: 0, font: "inherit" }}>ask AI instead</button></>
            : <><span style={{ color: "var(--phn-link)" }}>● natural language</span> · Enter asks AI to write the command · <button onClick={runDirect} style={{ background: "none", border: "none", color: "var(--phn-text-dim)", cursor: "pointer", padding: 0, font: "inherit", textDecoration: "underline" }}>run as-is</button></>}
        </div>
      )}
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
            <Button variant="primary" onClick={run} title={`Run in the active terminal (${modCombo("Enter")})`}>run ↵</Button>
          </div>
        </div>
      )}

      <p style={{ fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)", marginTop: "var(--phn-sp-4)", lineHeight: "var(--phn-lh)" }}>
        Auto-detects: type a real command and Enter runs it; describe what you want in plain
        English and Enter asks your active model to write it (shown for review — nothing runs
        until you click <strong>run</strong>). <em>insert</em> drops a generated command on the
        prompt to tweak first.
      </p>
    </Modal>
  );
}
