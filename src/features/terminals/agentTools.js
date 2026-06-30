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
 *  → shell ALWAYS gates (it is the universal RCE primitive and the model picks the
 *  command from possibly attacker-controlled content; the denylist is evadable, so
 *  it is never the sole gate); mcp safe iff read-only AND not destructive; unknown
 *  tool → always gate. */
export function needsApproval(call, meta, autoRun) {
  if (!autoRun) return true;
  const m = meta[call.name];
  if (!m) return true;
  // SECURITY (audit 2026-06-19): never auto-run shell. The command is model-chosen
  // from content that may be attacker-controlled (a file, an MCP tool result, remote
  // terminal output), and isDangerousCommand is a denylist that is trivially evaded
  // (split download+run, base64|sh, node -e, reverse shells, persistence writes).
  // Shell therefore always requires explicit approval, even under auto-run.
  if (m.kind === "shell") return true;
  return !(m.read_only && !m.destructive);
}

/** Flatten an MCP CallToolResult into the plain text fed back to the model.
 *  rmcp/MCP serializes a result as { content: [{type, text|...}], isError }.
 *  Sending the whole stringified struct back each turn is pure token bloat
 *  (annotations, mime metadata, nesting) — the model only needs the text. Non-text
 *  parts (image/resource) are summarized so the model still knows they exist.
 *  Deferred-item #6 from docs/autonomous-session-2026-06-19.md. */
export function mcpResultToContent(out) {
  if (out == null) return "";
  if (typeof out === "string") return out;
  const parts = Array.isArray(out.content) ? out.content : null;
  if (!parts) return JSON.stringify(out); // unexpected shape: fail safe, don't drop data
  const pieces = parts
    .map((p) => {
      if (p && typeof p.text === "string") return p.text;
      if (p && p.type) return `[${p.type}]`;
      return "";
    })
    .filter(Boolean);
  return pieces.join("\n");
}
