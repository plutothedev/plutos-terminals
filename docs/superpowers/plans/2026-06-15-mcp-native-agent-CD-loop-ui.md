# MCP Native Agent — Component C/D: AgentMode loop (native tools + approval) + config UI

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.
> Spec: `docs/superpowers/specs/2026-06-14-mcp-native-agent-design.md`. **Plan 3 of 3** (A=client DONE, B=tool-calling DONE, C/D=this).

**Goal:** Rewrite AgentMode's ReAct loop onto native tool-calls — shell becomes a built-in `run_command` tool alongside MCP tools — with an annotation-aware approval gate (read-only auto-runs, writes/dangerous always gated), and extend McpInstaller to register MCP servers into the app config.

**Architecture:** Two pure, unit-tested modules — `agentTools.js` (build the tools array from MCP tools + the built-in; decide approval from annotations) and `agentLoop.js` (the native-tool-call ReAct loop with injected deps). `AgentMode.jsx` becomes UI + dependency wiring (real `toolTurn`, `mcp_list_tools`/`mcp_call_tool`, `runAndCapture`). `McpInstaller.jsx` gains real registration via the Component-A commands.

**Tech Stack:** React, vitest, the Component-A Tauri commands + Component-B `llmTools.js`.

## File Structure
- Create `src/features/terminals/agentTools.js` — tool building + approval decision + `isDangerousCommand` (moved here). Inline-tested.
- Create `src/features/terminals/agentLoop.js` — `runAgentLoop(deps)`. Inline-tested.
- Modify `src/features/terminals/AgentMode.jsx` — rewrite the loop onto native tools; keep the Modal/UI; annotation-aware approval panel.
- Modify `src/components/McpInstaller.jsx` — add app-registration UI on top of the existing copy-paste.

---

## Task C1: agentTools.js — tool building + approval decision

**Files:** Create `src/features/terminals/agentTools.js` + `agentTools.test.js`.

- [ ] **Step 1: Write failing tests** — `src/features/terminals/agentTools.test.js`:
```js
import { test, expect } from "vitest";
import { buildTools, needsApproval, isDangerousCommand, RUN_COMMAND_TOOL } from "./agentTools.js";

test("buildTools includes the built-in run_command + mcp tools with meta", () => {
  const { tools, meta } = buildTools([
    { server: "fs", name: "read_file", description: "read", schema: { type: "object" }, read_only: true, destructive: false },
    { server: "fs", name: "write_file", description: "write", schema: { type: "object" }, read_only: false, destructive: true },
  ]);
  expect(tools[0].name).toBe("run_command");
  expect(tools.map((t) => t.name)).toContain("fs.read_file");
  expect(meta["run_command"].kind).toBe("shell");
  expect(meta["fs.read_file"]).toMatchObject({ kind: "mcp", server: "fs", tool: "read_file", read_only: true });
  expect(meta["fs.write_file"].destructive).toBe(true);
});

test("needsApproval: auto-run off always gates", () => {
  const { meta } = buildTools([]);
  expect(needsApproval({ name: "run_command", args: { command: "ls" } }, meta, false)).toBe(true);
});

test("needsApproval: auto-run on — safe shell auto, dangerous shell gated", () => {
  const { meta } = buildTools([]);
  expect(needsApproval({ name: "run_command", args: { command: "ls -la" } }, meta, true)).toBe(false);
  expect(needsApproval({ name: "run_command", args: { command: "rm -rf /" } }, meta, true)).toBe(true);
});

test("needsApproval: auto-run on — read-only mcp auto, write/destructive/unknown gated", () => {
  const { meta } = buildTools([
    { server: "fs", name: "read_file", read_only: true, destructive: false },
    { server: "fs", name: "write_file", read_only: false, destructive: true },
  ]);
  expect(needsApproval({ name: "fs.read_file", args: {} }, meta, true)).toBe(false);
  expect(needsApproval({ name: "fs.write_file", args: {} }, meta, true)).toBe(true);
  expect(needsApproval({ name: "unknown.tool", args: {} }, meta, true)).toBe(true);
});

test("isDangerousCommand flags rm -rf and sudo", () => {
  expect(isDangerousCommand("rm -rf foo")).toBe(true);
  expect(isDangerousCommand("sudo apt install x")).toBe(true);
  expect(isDangerousCommand("echo hi")).toBe(false);
});
```

- [ ] **Step 2: Run to fail** — `npm test -- agentTools` → FAIL.
- [ ] **Step 3: Implement** — `src/features/terminals/agentTools.js`:
```js
// (C)
// Agent tool registry + the annotation-aware approval decision. The native agent
// (AgentMode) exposes ONE built-in tool (run_command = shell) alongside every MCP
// tool. Whether a tool call may auto-execute (auto-run mode) is decided HERE, in
// code, from MCP annotations + a shell danger check — NEVER from the model/prompt,
// because tool results are fed back into the next turn (prompt-injection surface).

// Non-bypassable destructive/RCE shell patterns (moved verbatim from AgentMode).
const DANGEROUS_PATTERNS = [
  /\brm\s+(?:-[a-z]*\s+)*-[a-z]*[rf]/i,
  /\brmdir\s+\/s/i, /\bdel\s+\/[a-z]/i,
  /\bRemove-Item\b[\s\S]*-Recurse/i,
  /\b(?:mkfs\w*|diskpart)\b/i, /\bformat\s+[a-z]:/i,
  /\bdd\b[^|]*\bof=/i,
  />\s*\/dev\/(?:sd|nvme|disk|hd)/i,
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /:\(\)\s*\{[\s\S]*\|[\s\S]*&\s*\}/,
  /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[\s\S]*\|\s*(?:sh|bash|zsh|python\d?|node|pwsh|powershell|iex|Invoke-Expression)\b/i,
  /\b(?:iex|Invoke-Expression)\b/i,
  /\bsudo\b/i,
  /\b(?:chmod|chown)\s+-R\b/i,
  /\bgit\b[\s\S]*\bpush\b[\s\S]*--force/i,
];
export function isDangerousCommand(cmd) {
  return DANGEROUS_PATTERNS.some((re) => re.test(String(cmd || "")));
}

export const RUN_COMMAND_TOOL = {
  name: "run_command",
  description: "Run a single shell command in the user's active terminal and return its output. Use for all shell work.",
  input_schema: {
    type: "object",
    properties: { command: { type: "string", description: "The shell command to run." } },
    required: ["command"],
  },
};

/** Build the LLM tools array + an annotation/routing meta map from MCP tools.
 *  mcpTools: [{ server, name, description, schema, read_only, destructive }]. */
export function buildTools(mcpTools) {
  const tools = [RUN_COMMAND_TOOL];
  const meta = { run_command: { kind: "shell" } };
  for (const t of mcpTools || []) {
    const name = `${t.server}.${t.name}`;
    tools.push({ name, description: t.description || "", input_schema: t.schema || { type: "object" } });
    meta[name] = { kind: "mcp", server: t.server, tool: t.name, read_only: !!t.read_only, destructive: !!t.destructive };
  }
  return { tools, meta };
}

/** Does this tool call require manual approval? auto-run OFF → always. auto-run ON
 *  → gate unless safe: shell safe iff not a dangerous command; mcp safe iff
 *  read-only AND not destructive; unknown tool → always gate. */
export function needsApproval(call, meta, autoRun) {
  if (!autoRun) return true;
  const m = meta[call.name];
  if (!m) return true;
  if (m.kind === "shell") return isDangerousCommand(call.args?.command || "");
  return !(m.read_only && !m.destructive);
}
```

- [ ] **Step 4: Run to pass** — `npm test -- agentTools` → 5 pass.
- [ ] **Step 5: Commit**
```bash
git add src/features/terminals/agentTools.js src/features/terminals/agentTools.test.js
git commit -m "feat(agent): tool registry + annotation-aware approval decision"
```

---

## Task C2: agentLoop.js — the native-tool-call ReAct loop

**Files:** Create `src/features/terminals/agentLoop.js` + `agentLoop.test.js`.

- [ ] **Step 1: Write failing tests** — `src/features/terminals/agentLoop.test.js`:
```js
import { test, expect } from "vitest";
import { runAgentLoop } from "./agentLoop.js";

test("auto-running tool call executes without approval then ends", async () => {
  const steps = [];
  let turn = 0;
  await runAgentLoop({
    goal: "do it",
    toolTurn: async (messages) => {
      turn++;
      if (turn === 1) return { text: "working", tool_calls: [{ id: "c1", name: "run_command", args: { command: "ls" } }], stop_reason: "tool_use" };
      return { text: "all done", tool_calls: [], stop_reason: "end" };
    },
    needsApproval: () => false,
    requestApproval: async () => { throw new Error("should not be called"); },
    executeTool: async (call) => ({ content: "file1 file2", isError: false }),
    onStep: (s) => steps.push(s),
  });
  expect(steps.some((s) => s.type === "call" && s.call.name === "run_command")).toBe(true);
  expect(steps.some((s) => s.type === "result" && s.content === "file1 file2")).toBe(true);
  expect(steps[steps.length - 1]).toMatchObject({ type: "done", text: "all done" });
});

test("gated tool call requests approval; skip feeds a skipped result back", async () => {
  const steps = [];
  let turn = 0;
  let approvalAsked = false;
  await runAgentLoop({
    goal: "g",
    toolTurn: async () => {
      turn++;
      if (turn === 1) return { text: "", tool_calls: [{ id: "c1", name: "fs.write", args: {} }], stop_reason: "tool_use" };
      return { text: "done", tool_calls: [], stop_reason: "end" };
    },
    needsApproval: () => true,
    requestApproval: async () => { approvalAsked = true; return { action: "skip" }; },
    executeTool: async () => { throw new Error("should not execute a skipped call"); },
    onStep: (s) => steps.push(s),
  });
  expect(approvalAsked).toBe(true);
  expect(steps.some((s) => s.type === "skip")).toBe(true);
  expect(steps[steps.length - 1].type).toBe("done");
});

test("shouldStop ends the loop", async () => {
  const steps = [];
  await runAgentLoop({
    goal: "g",
    toolTurn: async () => ({ text: "", tool_calls: [{ id: "c1", name: "run_command", args: { command: "ls" } }], stop_reason: "tool_use" }),
    needsApproval: () => false,
    requestApproval: async () => ({ action: "run" }),
    executeTool: async () => ({ content: "x", isError: false }),
    onStep: (s) => steps.push(s),
    shouldStop: () => true,
  });
  expect(steps[steps.length - 1]).toMatchObject({ type: "done", text: "Stopped by you." });
});
```

- [ ] **Step 2: Run to fail** — `npm test -- agentLoop` → FAIL.
- [ ] **Step 3: Implement** — `src/features/terminals/agentLoop.js`:
```js
// (C)
// Native-tool-calling ReAct loop for the in-app agent. All side effects are
// injected (toolTurn / executeTool / requestApproval / needsApproval / onStep) so
// the loop is unit-testable with fakes. The loop maintains the normalized message
// list, gates each tool call, executes approved calls, and feeds results back
// until the model stops calling tools (stop_reason "end") or the step cap / stop.
export async function runAgentLoop({
  goal, toolTurn, executeTool, requestApproval, needsApproval,
  onStep, maxSteps = 14, shouldStop = () => false,
}) {
  const messages = [{ role: "user", text: `GOAL: ${goal}` }];
  for (let i = 0; i < maxSteps; i++) {
    if (shouldStop()) { onStep({ type: "done", text: "Stopped by you." }); return; }
    let res;
    try { res = await toolTurn(messages); }
    catch (e) { onStep({ type: "error", text: String(e) }); return; }
    if (shouldStop()) { onStep({ type: "done", text: "Stopped by you." }); return; }

    const calls = res.tool_calls || [];
    if (res.text) onStep({ type: "text", text: res.text });
    if (!calls.length || res.stop_reason === "end") {
      onStep({ type: "done", text: res.text || "Done." });
      return;
    }
    messages.push({ role: "assistant", text: res.text || "", tool_calls: calls });

    for (const call of calls) {
      if (shouldStop()) { onStep({ type: "done", text: "Stopped by you." }); return; }
      let args = call.args || {};
      if (needsApproval(call)) {
        const d = await requestApproval(call);
        if (d.action === "stop") { onStep({ type: "done", text: "Stopped by you." }); return; }
        if (d.action === "skip") {
          onStep({ type: "skip", call });
          messages.push({ role: "tool", tool_call_id: call.id, content: "(skipped by the user)", is_error: false });
          continue;
        }
        if (d.args) args = d.args;
      }
      const finalCall = { ...call, args };
      onStep({ type: "call", call: finalCall });
      let result;
      try { result = await executeTool(finalCall); }
      catch (e) { result = { content: String(e), isError: true }; }
      onStep({ type: "result", id: call.id, content: result.content, isError: !!result.isError });
      messages.push({ role: "tool", tool_call_id: call.id, content: String(result.content ?? ""), is_error: !!result.isError });
    }
    if (i === maxSteps - 1) onStep({ type: "done", text: "Reached the step limit." });
  }
}
```

- [ ] **Step 4: Run to pass** — `npm test -- agentLoop` → 3 pass.
- [ ] **Step 5: Commit**
```bash
git add src/features/terminals/agentLoop.js src/features/terminals/agentLoop.test.js
git commit -m "feat(agent): native-tool-call ReAct loop (injected deps, tested)"
```

---

## Task C3: Rewrite AgentMode.jsx onto the native-tool loop

**Files:** Modify `src/features/terminals/AgentMode.jsx` (full rewrite of the loop + approval; keep the Modal shell).

- [ ] **Step 1: Replace the file** with this content:
```jsx
// (C)
// Native Agent Mode — type a goal in plain English; an in-app agent accomplishes
// it by calling tools: the built-in run_command (shell, via OSC-133 Blocks capture)
// plus any configured MCP server tools. Uses native LLM function-calling
// (llm_tool_turn). Per-tool-call approval by default; with Auto-run on, read-only
// MCP tools + safe shell commands auto-execute while writes/destructive/dangerous
// are always gated (annotation-aware, in code — see agentTools.js).
import { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { Button, Input, Textarea } from "../../components/ui.jsx";
import { invoke } from "@backend";
import { resolveActiveLLM } from "./providers.js";
import { readUserSt } from "./storageKeys.js";
import { runAndCapture } from "./ptyBridge.js";
import { toolTurn } from "./llmTools.js";
import { buildTools, needsApproval } from "./agentTools.js";
import { runAgentLoop } from "./agentLoop.js";

const MAX_STEPS = 14;

export default function AgentMode({ open, onClose, tabId, cwd, shellName }) {
  const [goal, setGoal] = useState("");
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const [autoRun, setAutoRun] = useState(false);
  const [pending, setPending] = useState(null);     // { call, risky, editable }
  const [pendingCmd, setPendingCmd] = useState("");  // editable shell command text
  const stopRef = useRef(false);
  const autoRunRef = useRef(false);
  const approveRef = useRef(null);
  const goalRef = useRef(null);
  const scrollRef = useRef(null);
  autoRunRef.current = autoRun;

  useEffect(() => {
    if (open) {
      setGoal(""); setSteps([]); setRunning(false); stopRef.current = false;
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
    const local = [];
    const onStep = (s) => { local.push(s); setSteps([...local]); };

    // Discover MCP tools (best-effort) + build the tool set.
    let mcpTools = [];
    try { mcpTools = await invoke("mcp_list_tools"); } catch { mcpTools = []; }
    const { tools, meta } = buildTools(mcpTools);

    const system =
      `You are an autonomous agent operating a ${shellName || "shell"} terminal on ${os}` + (cwd ? `, cwd: ${cwd}` : "") + `.\n` +
      `Accomplish the user's GOAL by calling the provided tools. Use run_command for shell work; ` +
      `use the other tools when they fit. Call one or more tools per turn; I will send you each tool's RESULT. ` +
      `When the goal is complete, reply with a short summary and DO NOT call any tool. ` +
      `Prefer safe, idempotent actions.`;

    const executeTool = async (call) => {
      const m = meta[call.name];
      if (!m) return { content: `unknown tool ${call.name}`, isError: true };
      if (m.kind === "shell") {
        const cmd = String(call.args?.command || "").trim();
        if (!cmd) return { content: "empty command", isError: true };
        const result = await runAndCapture(tabId, cmd);
        return { content: (result?.output || "").slice(-3000) || "(no output captured)", isError: false };
      }
      // mcp
      const out = await invoke("mcp_call_tool", { server: m.server, tool: m.tool, args: call.args || {} });
      const isErr = !!(out && out.isError);
      return { content: typeof out === "string" ? out : JSON.stringify(out), isError: isErr };
    };

    const requestApproval = (call) => new Promise((resolve) => {
      const m = meta[call.name];
      const isShell = m?.kind === "shell";
      const risky = autoRunRef.current; // only reach here in auto-run when forced (write/dangerous)
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

  // Resolve the pending approval, applying an edited shell command if present.
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
        Auto-run — run read-only / safe tools without asking (writes & destructive always confirm)
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
        Read-only tools can auto-run; writes &amp; destructive actions always ask.
      </p>
    </Modal>
  );
}
```

- [ ] **Step 2: Verify build** — `npm run build` → succeeds. `npm test` → all prior tests still pass (agentTools + agentLoop + llmTools + others). Note: `llmStream`/`parseAction` are no longer used by AgentMode; that's fine (llmStream.js stays for other callers). Confirm no other file imports `parseAction`/`isDangerousCommand` FROM AgentMode (they weren't exported, so none can).

- [ ] **Step 3: Commit**
```bash
git add src/features/terminals/AgentMode.jsx
git commit -m "feat(agent): rewrite loop onto native tool-calls + MCP tools"
```

---

## Task D1: McpInstaller — register servers into the app config

**Files:** Modify `src/components/McpInstaller.jsx`.

The existing component lists curated MCP servers with copy-paste `claude mcp add` commands. Add app-registration so the native agent can use them. Read the current file first to match its structure/styling (it uses Modal, MODAL_COLORS, useToast, invoke from @backend).

- [ ] **Step 1: Add a configured-servers section + register actions**

Add, using the existing styling tokens, near the top of the modal body:
- On mount, load configured servers: `const [configured, setConfigured] = useState([]);` and an effect `useEffect(() => { invoke("mcp_servers_list").then(setConfigured).catch(() => {}); }, []);`
- A small list of `configured` servers, each showing `id`, `transport`, an **enabled** toggle, and a **Remove** button:
  - toggle → `invoke("mcp_server_add", { cfg: { ...srv, enabled: !srv.enabled } })` then refresh the list.
  - remove → `invoke("mcp_server_remove", { id: srv.id })` then refresh.
- For each CURATED server (the existing `MCPS` array, which has `id`, `command` like `claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem ${PWD}`), add an **"Add to Pluto agent"** button next to the existing copy button that registers it as a stdio `ServerCfg`. Parse the curated command into argv: strip the leading `claude mcp add <id> --` and use the remainder as `{ command: argv[0], args: argv.slice(1) }`, expanding `${PWD}`/`$HOME`/`%USERPROFILE%` to a directory chosen by the user (reuse the existing directory-pick the component already does for filesystem if present; otherwise prompt via `window.prompt` for the directory and substitute). Build:
  ```js
  const cfg = { id: mcp.id, enabled: true, transport: "stdio", command, args, env: {}, url: null, secret_keys: [] };
  await invoke("mcp_server_add", { cfg });
  ```
  then toast "Added <id> to the agent" + refresh `configured`. (For servers needing a token like github, also `window.prompt` for the token and store it: register `secret_keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"]` and write the value to the keychain via the existing `invoke("secret_set", { account: \`mcp-secret:${mcp.id}:GITHUB_PERSONAL_ACCESS_TOKEN\`, secret: token })` — only if a token was entered.)
- A **tool count** per enabled server is nice-to-have: optionally call `invoke("mcp_list_tools")` once and show counts grouped by `server`. Keep it simple — a single "N tools available" line under the configured list is enough; skip if it complicates.

Keep all existing copy-paste UI intact (users may still want the external `claude` CLI to have the server).

- [ ] **Step 2: Verify build** — `npm run build` → succeeds. Manually sanity-check the modal renders (no runtime import errors) via the dev server if convenient.

- [ ] **Step 3: Commit**
```bash
git add src/components/McpInstaller.jsx
git commit -m "feat(mcp): register servers into app config for the native agent"
```

---

## Self-Review (Component C/D vs spec)
- Loop unified on native tool-calls; shell = built-in `run_command` tool → C1 (`RUN_COMMAND_TOOL`) + C3 (`executeTool` shell branch via `runAndCapture`). ✓
- MCP tools exposed to the model with schemas → C1 (`buildTools`) + C3 (`mcp_list_tools`). ✓
- Annotation-aware approval IN CODE: read-only auto, write/destructive/unannotated + dangerous shell gated; tool results never bypass → C1 (`needsApproval`) + C2 (gate before execute) + C3 (wiring). ✓
- Per-call approval default; editable shell command; MCP args shown → C3 approval panel. ✓
- Stop + step cap + per-step rendering of calls/results/text → C2/C3. ✓
- Config UI: real registration via Component-A commands, secrets → keychain → D1. ✓
- Loop + gating tested with fakes → C2 (3 tests) + C1 (5 tests). ✓

**Deviation (carried from B):** non-streaming per turn — text renders per step, not token-by-token. Follow-up.

**Type consistency:** `buildTools` returns `{tools, meta}`; `meta[name]` = `{kind:"shell"}` or `{kind:"mcp",server,tool,read_only,destructive}` — consumed identically by `needsApproval` (C1) and `executeTool` (C3). `runAgentLoop` step types (`call`/`result`/`skip`/`text`/`done`/`error`) match the C3 renderer. `toolTurn(llm,system,messages,tools)` signature matches Component B's `llmTools.js`. `mcp_call_tool` args `{server,tool,args}` match Component A's command.
```
