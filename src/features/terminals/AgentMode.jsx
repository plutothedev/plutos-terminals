// (C)
// Native Agent Mode — type a goal in plain English; an in-app agent runs commands
// in the active terminal (a ReAct loop), reads each command's output via the
// Blocks (OSC-133), and adapts step by step until done. Reuses llm_complete per
// step (history stuffed into the prompt), so no new backend. Auto-runs with a
// Stop and a hard step cap; the user watches it work.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@backend";
import Modal from "../../components/Modal.jsx";
import { Button, Input } from "../../components/ui.jsx";
import { resolveActiveLLM } from "./providers.js";
import { readUserSt } from "./storageKeys.js";
import { runAndCapture } from "./ptyBridge.js";

const MAX_STEPS = 14;

// Pull the first RUN:/DONE:/ASK: directive out of the model's reply.
function parseAction(reply) {
  const text = String(reply || "").trim();
  const m = text.match(/(?:^|\n)\s*(RUN|DONE|ASK)\s*:\s*([\s\S]*)$/i);
  if (!m) return { type: "DONE", content: text }; // no directive → treat as final answer
  const type = m[1].toUpperCase();
  let content = m[2].trim();
  if (type === "RUN") {
    // One command line; strip fences/backticks/leading "$ " the model may add.
    content = content.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "").trim();
    content = content.split("\n").find((l) => l.trim()) || "";
    content = content.replace(/^\$\s+/, "").replace(/`/g, "").trim();
  }
  return { type, content };
}

export default function AgentMode({ open, onClose, tabId, cwd, shellName }) {
  const [goal, setGoal] = useState("");
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);
  const goalRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (open) {
      setGoal(""); setSteps([]); setRunning(false); stopRef.current = false;
      setTimeout(() => goalRef.current?.focus(), 30);
    }
  }, [open]);
  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [steps]);

  const os = navigator.userAgent.includes("Windows") ? "Windows"
    : navigator.userAgent.includes("Mac") ? "macOS" : "Linux";

  const start = async () => {
    const g = goal.trim();
    if (!g || running) return;
    const llm = resolveActiveLLM(readUserSt());
    if (!llm) { setSteps([{ type: "error", text: "No model configured — open the Models picker (toolbar) first." }]); return; }
    if (!tabId) { setSteps([{ type: "error", text: "No active terminal to run in." }]); return; }
    setRunning(true); stopRef.current = false;
    const local = [];
    const push = (s) => { local.push(s); setSteps([...local]); return s; };
    const system =
      `You are an autonomous agent operating a ${shellName || "shell"} terminal on ${os}` + (cwd ? `, cwd: ${cwd}` : "") + `.\n` +
      `Accomplish the user's GOAL by issuing shell commands ONE AT A TIME.\n` +
      `Reply with EXACTLY ONE of these and nothing else:\n` +
      `  RUN: <a single shell command>\n` +
      `  DONE: <one-line summary of what you accomplished>\n` +
      `  ASK: <a question for the user, if you are blocked>\n` +
      `After each RUN I send you that command's OUTPUT; use it to choose the next step and to fix errors. ` +
      `Prefer safe, idempotent commands. NEVER run destructive commands (rm -rf, disk formatting, mass deletion) unless that is literally the goal.`;
    const history = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      if (stopRef.current) { push({ type: "done", text: "Stopped by you." }); break; }
      const prompt = `GOAL: ${g}\n\n`
        + history.map((h) => `RUN: ${h.command}\nOUTPUT:\n${h.output || "(no output)"}\n`).join("\n")
        + `\nWhat is your next action?`;
      let reply;
      try {
        reply = await invoke("llm_complete", {
          kind: llm.kind, baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model, system, prompt,
        });
      } catch (e) { push({ type: "error", text: String(e) }); break; }
      if (stopRef.current) { push({ type: "done", text: "Stopped by you." }); break; }
      const action = parseAction(reply);
      if (action.type === "DONE") { push({ type: "done", text: action.content || "Done." }); break; }
      if (action.type === "ASK") { push({ type: "ask", text: action.content }); break; }
      const cmd = action.content;
      if (!cmd) { push({ type: "error", text: "Model returned an empty command." }); break; }
      const entry = push({ type: "run", command: cmd, output: "running…" });
      const result = await runAndCapture(tabId, cmd);
      const out = (result?.output || "").slice(-3000);
      entry.output = out || "(no output captured)";
      setSteps([...local]);
      history.push({ command: cmd, output: out });
      if (i === MAX_STEPS - 1) push({ type: "done", text: "Reached the step limit." });
    }
    setRunning(false);
  };

  const color = (t) => t === "error" ? "#E05B5B" : t === "done" ? "#6FB85C" : t === "ask" ? "#E0A04F" : "#4D8FE0";

  return (
    <Modal open={open} title="🤖 Agent Mode" onClose={onClose} width={700}>
      <div style={{ display: "flex", gap: "var(--phn-sp-2)" }}>
        <Input
          ref={goalRef}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") start(); }}
          placeholder="Goal in plain English — e.g. initialize a git repo, add a .gitignore, and make the first commit"
          disabled={running}
        />
        {running
          ? <Button variant="danger" onClick={() => { stopRef.current = true; }}>stop</Button>
          : <Button variant="primary" onClick={start} disabled={!goal.trim()}>run agent</Button>}
      </div>

      <div ref={scrollRef} style={{ marginTop: "var(--phn-sp-3)", maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ borderLeft: `2px solid ${color(s.type)}`, paddingLeft: 9 }}>
            {s.type === "run" ? (
              <>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "var(--phn-text-fg)" }}>$ {s.command}</div>
                <pre style={{ margin: "3px 0 0", fontSize: 11, color: "var(--phn-text-dim)", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 150, overflow: "auto" }}>{s.output}</pre>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: color(s.type) }}>
                {s.type === "done" ? "✓ " : s.type === "ask" ? "? " : "✗ "}{s.text}
              </div>
            )}
          </div>
        ))}
        {running && <div style={{ fontSize: 11, color: "var(--phn-text-dim)" }}>thinking…</div>}
      </div>

      <p style={{ fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)", marginTop: "var(--phn-sp-3)", lineHeight: "var(--phn-lh)" }}>
        Runs real commands in your active terminal using your active model. Watch it work; hit <strong>stop</strong> anytime.
        It avoids destructive commands — but you're in control of the machine.
      </p>
    </Modal>
  );
}
