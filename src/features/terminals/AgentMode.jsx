// (C)
// Native Agent Mode — type a goal in plain English; an in-app agent accomplishes
// it by calling tools: the built-in run_command (shell, via OSC-133 Blocks capture)
// plus any configured MCP server tools. Uses native LLM function-calling
// (llm_tool_turn). Per-tool-call approval by default; with Auto-run on, only
// read-only MCP tools auto-execute. Shell commands ALWAYS require approval (the
// command is model-chosen from possibly attacker-controlled content and the danger
// denylist is evadable), as do MCP write/destructive tools (annotation-aware, in
// code; see agentTools.js).
import { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { Button, Input, Textarea } from "../../components/ui.jsx";
import { invoke } from "@backend";
import { resolveActiveLLM } from "./providers.js";
import { readUserSt } from "./storageKeys.js";
import { runAndCapture } from "./ptyBridge.js";
import { toolTurn } from "./llmTools.js";
import { buildTools, needsApproval, isDangerousCommand, mcpResultToContent } from "./agentTools.js";
import { runAgentLoop } from "./agentLoop.js";
import { collectProjectContext, partitionRuleFiles, buildContextBlock } from "./agentContext.js";
import { scanSecrets, maskSecrets } from "./secretScan.js";

const MAX_STEPS = 14;

const EMPTY_CTX = { block: "", pending: [], masked: 0, hasRules: false, agentsCount: 0, claudeCount: 0, hasGit: false };

export default function AgentMode({ open, onClose, tabId, cwd, shellName, userSt, saveUser }) {
  const [goal, setGoal] = useState("");
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const [autoRun, setAutoRun] = useState(false);
  const [ctx, setCtx] = useState(EMPTY_CTX);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [pending, setPending] = useState(null);     // { call, isShell, risky, argsText }
  const [pendingCmd, setPendingCmd] = useState("");  // editable shell command text
  const stopRef = useRef(false);
  const autoRunRef = useRef(false);
  const approveRef = useRef(null);
  const goalRef = useRef(null);
  const scrollRef = useRef(null);
  autoRunRef.current = autoRun;

  useEffect(() => {
    if (open) {
      // Keep the previous run's step log visible on reopen so it stays reviewable;
      // a new run clears it (see start()).
      setGoal(""); setRunning(false); stopRef.current = false;
      setPending(null); approveRef.current = null;
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
    setSteps([]); // clear the previous run's log now that a new run is starting
    const local = [];
    const onStep = (s) => { local.push(s); setSteps([...local]); };

    let contextBlock = "";
    if (userSt?.agentContextEnabled !== false) {
      try {
        const { ruleFiles, facts } = await collectProjectContext({ cwd, invoke });
        const { approved, pending } = partitionRuleFiles(ruleFiles, userSt?.approvedRuleFiles);
        const raw = buildContextBlock({ globalRules: userSt?.agentRules, ruleFiles: approved, facts });
        const hits = scanSecrets(raw);
        contextBlock = maskSecrets(raw, hits);
        // Chip segments come from STRUCTURED data, not regex over the block —
        // a rule file whose prose contains "git:" must not fake a segment.
        setCtx({
          block: contextBlock,
          pending,
          masked: hits.length,
          hasRules: !!String(userSt?.agentRules || "").trim(),
          agentsCount: approved.filter((f) => f.name === "AGENTS.md").length,
          claudeCount: approved.filter((f) => f.name === "CLAUDE.md").length,
          hasGit: !!(facts && facts.git),
        });
      } catch {
        contextBlock = ""; // context must never block the run
        setCtx(EMPTY_CTX);
      }
    } else {
      setCtx(EMPTY_CTX);
    }

    let mcpTools = [];
    try { mcpTools = await invoke("mcp_list_tools"); } catch { mcpTools = []; }
    const { tools, meta } = buildTools(mcpTools);

    const system =
      `You are an autonomous agent operating a ${shellName || "shell"} terminal on ${os}` + (cwd ? `, cwd: ${cwd}` : "") + `.\n` +
      `Accomplish the user's GOAL by calling the provided tools. Use run_command for shell work; ` +
      `use the other tools when they fit. Call one or more tools per turn; I will send you each tool's RESULT. ` +
      `When the goal is complete, reply with a short summary and DO NOT call any tool. ` +
      `Prefer safe, idempotent actions.` +
      (contextBlock ? `\n\n${contextBlock}` : "");

    const executeTool = async (call) => {
      const m = meta[call.name];
      if (!m) return { content: `unknown tool ${call.name}`, isError: true };
      if (m.kind === "shell") {
        const cmd = String(call.args?.command || "").trim();
        if (!cmd) return { content: "empty command", isError: true };
        const result = await runAndCapture(tabId, cmd);
        return { content: (result?.output || "").slice(-3000) || "(no output captured)", isError: false };
      }
      const out = await invoke("mcp_call_tool", { server: m.server, tool: m.tool, args: call.args || {} });
      const isErr = !!(out && out.isError);
      // Feed back only the text parts, not the whole stringified CallToolResult
      // (token bloat + prompt-injection surface). See mcpResultToContent.
      return { content: mcpResultToContent(out), isError: isErr };
    };

    const requestApproval = (call) => new Promise((resolve) => {
      const m = meta[call.name];
      const isShell = m?.kind === "shell";
      // Shell now always requires approval; show the ⚠ destructive warning only when
      // the command actually matches a danger pattern. For MCP, being forced under
      // auto-run means it is a write/destructive tool.
      const risky = isShell ? isDangerousCommand(String(call.args?.command || "")) : autoRunRef.current;
      setPendingCmd(isShell ? String(call.args?.command || "") : "");
      setPending({ call, isShell, risky, argsText: isShell ? "" : JSON.stringify(call.args || {}, null, 2) });
      approveRef.current = resolve;
    });

    await runAgentLoop({
      goal: g,
      maxSteps: MAX_STEPS,
      shouldStop: () => stopRef.current,
      toolTurn: (messages) => toolTurn(llm, system, messages, tools),
      needsApproval: (call) => needsApproval(call, meta, autoRunRef.current),
      requestApproval,
      executeTool,
      onStep,
    });

    setPending(null); approveRef.current = null;
    setRunning(false);
  };

  const resolveApproval = (action) => {
    const r = approveRef.current; if (!r) return;
    approveRef.current = null;
    if (action !== "run") { setPending(null); r({ action }); return; }
    const call = pending?.call;
    const args = pending?.isShell ? { ...(call?.args || {}), command: pendingCmd } : (call?.args || {});
    setPending(null);
    r({ action: "run", args });
  };

  const color = (t) => t === "error" ? "#E05B5B" : t === "done" ? "#6FB85C" : t === "ask" ? "#E0A04F" : t === "skip" ? "#888" : "#7c9cf5";

  return (
    <Modal open={open} title="Agent Mode" onClose={onClose} width={700}>
      {(() => {
        const off = userSt?.agentContextEnabled === false;
        const seg = [];
        if (!off && ctx.block) {
          if (ctx.hasRules) seg.push("rules");
          if (ctx.agentsCount) seg.push(`AGENTS.md ×${ctx.agentsCount}`);
          if (ctx.claudeCount) seg.push(`CLAUDE.md ×${ctx.claudeCount}`);
          if (ctx.hasGit) seg.push("git");
        }
        if (!off && ctx.pending.length) seg.push(`${ctx.pending.length} pending review`);
        const label = off ? "context: off" : (seg.length ? `context: ${seg.join(" · ")}` : "context: none");
        const expandable = !!(ctx.block || ctx.pending.length);
        return (
          <div style={{ fontSize: 11, color: "var(--phn-text-dim)", marginBottom: 8 }}>
            <span
              role="button"
              tabIndex={0}
              onClick={() => expandable && setCtxOpen((v) => !v)}
              onKeyDown={(e) => { if (e.key === "Enter" && expandable) setCtxOpen((v) => !v); }}
              style={{ cursor: expandable ? "pointer" : "default" }}
              title={expandable ? "Show the exact injected context + pending rule files" : ""}
            >
              {label}
              {!off && ctx.masked > 0 && (
                <span style={{ color: "var(--phn-danger)", marginLeft: 6 }}>· {ctx.masked} secret{ctx.masked > 1 ? "s" : ""} masked</span>
              )}
            </span>
            {ctxOpen && (
              <div>
                {ctx.block && (
                  <pre style={{ maxHeight: 180, overflow: "auto", background: "rgba(255,255,255,0.04)", padding: 8, borderRadius: 6, fontSize: 11, whiteSpace: "pre-wrap" }}>{ctx.block}</pre>
                )}
                {ctx.pending.map((f) => (
                  <div key={f.path} style={{ marginTop: 6, border: "1px solid var(--phn-danger)", borderRadius: 6, padding: 8 }}>
                    <div style={{ marginBottom: 4 }}>
                      Pending review: <strong>{f.name}</strong> ({f.path}) — not sent to the model until approved.
                    </div>
                    <pre style={{ maxHeight: 120, overflow: "auto", fontSize: 11, whiteSpace: "pre-wrap" }}>{f.content}</pre>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (!saveUser) return;
                        saveUser((prev) => ({
                          ...prev,
                          approvedRuleFiles: { ...(prev?.approvedRuleFiles || {}), [String(f.path).toLowerCase()]: f.hash },
                        }));
                      }}
                    >Approve (applies from the next run)</Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
      <div style={{ display: "flex", gap: "var(--phn-sp-2)" }}>
        <Input
          ref={goalRef} value={goal} onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") start(); }}
          placeholder="Goal in plain English — e.g. find the largest files in this repo and summarize them"
          disabled={running}
        />
        {running
          ? <Button variant="danger" onClick={() => { stopRef.current = true; if (approveRef.current) resolveApproval("stop"); }}>stop</Button>
          : <Button variant="primary" onClick={start} disabled={!goal.trim()}>run agent</Button>}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: "var(--phn-sp-2)", fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)", cursor: "pointer" }}>
        <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
        Auto-run: auto-execute read-only MCP tools only. Shell commands and writes/destructive tools always ask.
      </label>

      {pending && (
        <div style={{ marginTop: "var(--phn-sp-3)", padding: 10, border: "1px solid #E0A04F", borderRadius: 8, background: "rgba(224,160,79,0.08)" }}>
          <div style={{ fontSize: 10.5, color: "#E0A04F", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 4 }}>
            Approve {pending.isShell ? "command" : `tool: ${pending.call.name}`}
          </div>
          {pending.risky && (
            <div style={{ fontSize: 11, color: "#E05B5B", fontWeight: 600, marginBottom: 6 }}>
              ⚠ This {pending.isShell ? "command matches a destructive / remote-code pattern" : "tool writes or is destructive"} — approval is required even with Auto-run on.
            </div>
          )}
          {pending.isShell ? (
            <Textarea
              value={pendingCmd} onChange={(e) => setPendingCmd(e.target.value)}
              rows={Math.min(4, pendingCmd.split("\n").length)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) resolveApproval("run"); }}
            />
          ) : (
            <pre style={{ margin: 0, fontSize: 11, color: "var(--phn-text-dim)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 160, overflow: "auto" }}>{pending.argsText}</pre>
          )}
          <div style={{ display: "flex", gap: "var(--phn-sp-2)", marginTop: "var(--phn-sp-2)", justifyContent: "flex-end" }}>
            <Button variant="subtle" onClick={() => resolveApproval("skip")}>skip</Button>
            <Button variant="primary" onClick={() => resolveApproval("run")}>approve &amp; run ↵</Button>
          </div>
        </div>
      )}

      <div ref={scrollRef} style={{ marginTop: "var(--phn-sp-3)", maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ borderLeft: `2px solid ${color(s.type)}`, paddingLeft: 9 }}>
            {s.type === "call" ? (
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "var(--phn-text-fg)" }}>
                {s.call.name === "run_command" ? `$ ${s.call.args?.command || ""}` : `→ ${s.call.name}(${JSON.stringify(s.call.args || {})})`}
              </div>
            ) : s.type === "result" ? (
              <pre style={{ margin: "3px 0 0", fontSize: 11, color: s.isError ? "#E05B5B" : "var(--phn-text-dim)", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 150, overflow: "auto" }}>{String(s.content)}</pre>
            ) : s.type === "skip" ? (
              <div style={{ fontSize: 12, color: "#888" }}>⤼ skipped: <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{s.call?.name}</span></div>
            ) : s.type === "text" ? (
              <div style={{ fontSize: 12, color: "var(--phn-text-dim)", whiteSpace: "pre-wrap" }}>{s.text}</div>
            ) : (
              <div style={{ fontSize: 12.5, color: color(s.type) }}>
                {s.type === "done" ? "✓ " : s.type === "ask" ? "? " : "✗ "}{s.text}
              </div>
            )}
          </div>
        ))}
      </div>

      <p style={{ fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)", marginTop: "var(--phn-sp-3)", lineHeight: "var(--phn-lh)" }}>
        Runs real commands + MCP tools using your active model. Watch it work; hit <strong>stop</strong> anytime.
        Read-only MCP tools can auto-run; shell commands, writes &amp; destructive actions always ask.
      </p>
    </Modal>
  );
}
