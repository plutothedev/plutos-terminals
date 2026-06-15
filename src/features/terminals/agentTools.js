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
