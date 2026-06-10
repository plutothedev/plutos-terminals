// (C)
// Native Agent Mode — type a goal in plain English; an in-app agent runs commands
// in the active terminal (a ReAct loop), reads each command's output via the
// Blocks (OSC-133), and adapts step by step until done. Reuses llm_complete per
// step (history stuffed into the prompt), so no new backend. Auto-runs with a
// Stop and a hard step cap; the user watches it work.
import { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { Button, Input, Textarea } from "../../components/ui.jsx";
import { resolveActiveLLM } from "./providers.js";
import { readUserSt } from "./storageKeys.js";
import { runAndCapture } from "./ptyBridge.js";
import { llmStream } from "./llmStream.js";

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

// Non-bypassable safety guard: even with Auto-run ON, a command matching one of
// these destructive / remote-code-execution patterns is forced back through the
// per-command approval gate so a human confirms it. The system-prompt's "never
// run destructive commands" is NOT a security control — each command's OUTPUT is
// fed verbatim into the next prompt, so attacker-influenced output (a crafted
// file the agent `cat`s, an SSH MOTD, a `curl` response) could otherwise inject a
// directive that auto-executes here. Keep this list in code, not the prompt.
const DANGEROUS_PATTERNS = [
  /\brm\s+(?:-[a-z]*\s+)*-[a-z]*[rf]/i,                 // rm -rf / -fr / -r -f
  /\brmdir\s+\/s/i, /\bdel\s+\/[a-z]/i,                  // Windows recursive delete
  /\bRemove-Item\b[\s\S]*-Recurse/i,
  /\b(?:mkfs\w*|diskpart)\b/i, /\bformat\s+[a-z]:/i,     // filesystem / disk format
  /\bdd\b[^|]*\bof=/i,                                   // dd of=…
  />\s*\/dev\/(?:sd|nvme|disk|hd)/i,                     // overwrite a block device
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /:\(\)\s*\{[\s\S]*\|[\s\S]*&\s*\}/,                    // bash fork bomb
  /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[\s\S]*\|\s*(?:sh|bash|zsh|python\d?|node|pwsh|powershell|iex|Invoke-Expression)\b/i, // pipe download → shell
  /\b(?:iex|Invoke-Expression)\b/i,
  /\bsudo\b/i,                                           // privilege escalation
  /\b(?:chmod|chown)\s+-R\b/i,
  /\bgit\b[\s\S]*\bpush\b[\s\S]*--force/i,
];
function isDangerousCommand(cmd) {
  return DANGEROUS_PATTERNS.some((re) => re.test(String(cmd || "")));
}

export default function AgentMode({ open, onClose, tabId, cwd, shellName }) {
  const [goal, setGoal] = useState("");
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const [autoRun, setAutoRun] = useState(false); // off = approve each command before it runs
  const [pending, setPending] = useState(null);   // command awaiting approval { command }
  const [pendingCmd, setPendingCmd] = useState(""); // editable text of the pending command
  const [thinking, setThinking] = useState(null); // live-streamed reply for the current step (null = not streaming)
  const stopRef = useRef(false);
  const autoRunRef = useRef(false);
  const approveRef = useRef(null); // resolver for the current approval gate
  const goalRef = useRef(null);
  const scrollRef = useRef(null);
  autoRunRef.current = autoRun;

  useEffect(() => {
    if (open) {
      setGoal(""); setSteps([]); setRunning(false); stopRef.current = false;
      setPending(null); approveRef.current = null; setThinking(null);
      setTimeout(() => goalRef.current?.focus(), 30);
    }
  }, [open]);
  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [steps, thinking]);

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
        setThinking(""); // open the live area; tokens stream in below
        let acc = "";
        reply = await llmStream(
          { kind: llm.kind, baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model, system, prompt },
          (piece) => { if (!stopRef.current) { acc += piece; setThinking(acc); } }
        );
      } catch (e) { setThinking(null); push({ type: "error", text: String(e) }); break; }
      setThinking(null);
      if (stopRef.current) { push({ type: "done", text: "Stopped by you." }); break; }
      const action = parseAction(reply);
      if (action.type === "DONE") { push({ type: "done", text: action.content || "Done." }); break; }
      if (action.type === "ASK") { push({ type: "ask", text: action.content }); break; }
      let cmd = action.content;
      if (!cmd) { push({ type: "error", text: "Model returned an empty command." }); break; }
      // Auto-run is bypassed (a human must approve) when the command is off OR the
      // command matches a destructive/RCE pattern — the latter is non-negotiable.
      const risky = isDangerousCommand(cmd);
      if (!autoRunRef.current || risky) {
        // Approval gate: show the proposed command and wait for Approve / Skip
        // (the command is editable before approving).
        const decision = await new Promise((resolve) => {
          setPendingCmd(cmd);
          setPending({ command: cmd, risky: risky && autoRunRef.current });
          approveRef.current = resolve;
        });
        setPending(null); approveRef.current = null;
        if (stopRef.current || decision.action === "stop") { push({ type: "done", text: "Stopped by you." }); break; }
        if (decision.action === "skip") {
          push({ type: "skip", command: cmd });
          history.push({ command: cmd, output: "(the user skipped this command)" });
          continue;
        }
        cmd = (decision.command || cmd).trim();
      }
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

  const color = (t) => t === "error" ? "#E05B5B" : t === "done" ? "#6FB85C" : t === "ask" ? "#E0A04F" : t === "skip" ? "#888" : "#7c9cf5";

  return (
    <Modal open={open} title="Agent Mode" onClose={onClose} width={700}>
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
          ? <Button variant="danger" onClick={() => { stopRef.current = true; if (approveRef.current) approveRef.current({ action: "stop" }); }}>stop</Button>
          : <Button variant="primary" onClick={start} disabled={!goal.trim()}>run agent</Button>}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: "var(--phn-sp-2)", fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)", cursor: "pointer" }}>
        <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
        Auto-run — run each command without asking (default: approve each)
      </label>

      {pending && (
        <div style={{ marginTop: "var(--phn-sp-3)", padding: 10, border: "1px solid #E0A04F", borderRadius: 8, background: "rgba(224,160,79,0.08)" }}>
          <div style={{ fontSize: 10.5, color: "#E0A04F", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 4 }}>
            Approve command — edit if you like
          </div>
          {pending.risky && (
            <div style={{ fontSize: 11, color: "#E05B5B", fontWeight: 600, marginBottom: 6 }}>
              ⚠ This command matches a destructive / remote-code pattern — approval is required even with Auto-run on.
            </div>
          )}
          <Textarea
            value={pendingCmd}
            onChange={(e) => setPendingCmd(e.target.value)}
            rows={Math.min(4, pendingCmd.split("\n").length)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) approveRef.current?.({ action: "run", command: pendingCmd }); }}
          />
          <div style={{ display: "flex", gap: "var(--phn-sp-2)", marginTop: "var(--phn-sp-2)", justifyContent: "flex-end" }}>
            <Button variant="subtle" onClick={() => approveRef.current?.({ action: "skip" })}>skip</Button>
            <Button variant="primary" onClick={() => approveRef.current?.({ action: "run", command: pendingCmd })}>approve &amp; run ↵</Button>
          </div>
        </div>
      )}

      <div ref={scrollRef} style={{ marginTop: "var(--phn-sp-3)", maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ borderLeft: `2px solid ${color(s.type)}`, paddingLeft: 9 }}>
            {s.type === "run" ? (
              <>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "var(--phn-text-fg)" }}>$ {s.command}</div>
                <pre style={{ margin: "3px 0 0", fontSize: 11, color: "var(--phn-text-dim)", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 150, overflow: "auto" }}>{s.output}</pre>
              </>
            ) : s.type === "skip" ? (
              <div style={{ fontSize: 12, color: "#888" }}>⤼ skipped: <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{s.command}</span></div>
            ) : (
              <div style={{ fontSize: 12.5, color: color(s.type) }}>
                {s.type === "done" ? "✓ " : s.type === "ask" ? "? " : "✗ "}{s.text}
              </div>
            )}
          </div>
        ))}
        {thinking !== null && (
          thinking
            ? <div style={{ borderLeft: "2px solid #7c9cf5", paddingLeft: 9 }}>
                <pre style={{ margin: 0, fontSize: 11.5, color: "var(--phn-text-dim)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{thinking}<span className="phn-agent-caret">▍</span></pre>
              </div>
            : <div style={{ fontSize: 11, color: "var(--phn-text-dim)" }}>thinking…</div>
        )}
      </div>

      <p style={{ fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)", marginTop: "var(--phn-sp-3)", lineHeight: "var(--phn-lh)" }}>
        Runs real commands in your active terminal using your active model. Watch it work; hit <strong>stop</strong> anytime.
        It avoids destructive commands — but you're in control of the machine.
      </p>
    </Modal>
  );
}
