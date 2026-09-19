import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildTools, needsApproval, isDangerousCommand, RUN_COMMAND_TOOL, mcpResultToContent, toolResultText } from "./agentTools.js";

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

test("needsApproval: auto-run on — shell ALWAYS gates (denylist is not a safe-auto gate)", () => {
  const { meta } = buildTools([]);
  // Shell is the universal RCE primitive and the dangerous-command denylist is
  // evadable via indirect prompt injection, so shell never auto-runs — even a
  // benign-looking `ls` requires explicit approval under auto-run.
  expect(needsApproval({ name: "run_command", args: { command: "ls -la" } }, meta, true)).toBe(true);
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

test("mcpResultToContent extracts text parts, dropping struct bloat", () => {
  const out = {
    content: [
      { type: "text", text: "hello" },
      { type: "text", text: "world", annotations: { audience: ["user"] } },
    ],
    isError: false,
  };
  expect(mcpResultToContent(out)).toBe("hello\nworld");
});

test("mcpResultToContent passes a plain string through", () => {
  expect(mcpResultToContent("raw output")).toBe("raw output");
});

test("mcpResultToContent summarizes non-text parts so the model knows they exist", () => {
  const out = { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "ok" }] };
  expect(mcpResultToContent(out)).toBe("[image]\nok");
});

test("mcpResultToContent fails safe on an unexpected shape (no data dropped)", () => {
  const out = { weird: 1 };
  expect(mcpResultToContent(out)).toBe(JSON.stringify(out));
});

test("mcpResultToContent handles null/undefined", () => {
  expect(mcpResultToContent(null)).toBe("");
  expect(mcpResultToContent(undefined)).toBe("");
});

// ── toolResultText: mask-before-trim tool-output shaping ──────────────────
// Every shell this app spawns carries provider API keys in its environment
// (spawnEnv.js). An approved `env`, `printenv`, or a hostile test script would
// print them, and the old raw slice(-3000) path fed that straight back to
// whichever provider is active. These pin mask-BEFORE-trim: trimming first
// could cut a key in half so no pattern recognises the remainder. Key
// fixtures are built at runtime (not written as literals) so no key-shaped
// string sits in the source for GitHub push protection to trip on.

test("toolResultText masks an AWS-shaped key and a provider sk- key in the middle of output", () => {
  const awsKey = "AKIA" + "A".repeat(16);
  const skKey = "sk-" + "b".repeat(40);
  const raw = `before ${awsKey} middle ${skKey} after`;
  const out = toolResultText(raw);
  expect(out).not.toContain(awsKey);
  expect(out).not.toContain(skKey);
  expect(out).toContain("[masked aws-access-key]");
  expect(out).toContain("[masked provider-key]");
});

test("toolResultText masks a key near the end of a 5000-char output and fills the budget exactly (the cut happens after masking)", () => {
  const skKey = "sk-" + "b".repeat(40); // 43 chars
  // "." on both sides keeps the regex word-boundary intact around the key
  // without adding any secret-shaped bytes of its own.
  const raw = ".".repeat(4857) + skKey + ".".repeat(100);
  expect(raw.length).toBe(5000);
  const out = toolResultText(raw);
  expect(out).not.toContain(skKey);
  // The length is the ordering assertion, and `not.toContain` is NOT (review):
  // this key sits wholly inside the kept tail, so trim-then-mask would mask it
  // too. What only mask-then-trim can do is fill the budget: masking first
  // shrinks 5000 -> 4978 (43-char key -> 21-char placeholder) and the cut then
  // yields exactly 3000. Trimming first cuts 3000 raw chars and THEN shrinks
  // them to 2978. The straddle test below is the one that catches a leak.
  expect(out.length).toBe(3000);
});

test("toolResultText masks a key that straddles the trim boundary — masking happens before the cut", () => {
  const skKey = "sk-" + "b".repeat(40); // spans raw[0, 43)
  const raw = skKey + ".".repeat(2977); // length 3020
  // Sanity: an un-masked slice(-3000) would cut at index 20, inside the key
  // (0..43) — this is the exact scenario mask-after-trim would get wrong.
  expect(raw.length - 3000).toBeLessThan(skKey.length);
  const out = toolResultText(raw);
  expect(out).not.toContain(skKey);
  expect(out).not.toMatch(/b{8,}/); // no run of raw key bytes survives a mid-key cut
});

test("toolResultText returns the placeholder for empty, null, and undefined", () => {
  expect(toolResultText("")).toBe("(no output captured)");
  expect(toolResultText(null)).toBe("(no output captured)");
  expect(toolResultText(undefined)).toBe("(no output captured)");
});

test("toolResultText respects a custom max", () => {
  const raw = "y".repeat(50);
  expect(toolResultText(raw, { max: 10 })).toBe("y".repeat(10));
});

test("toolResultText keeps nothing at max 0 (slice(-0) used to return the whole string)", () => {
  const raw = "y".repeat(50);
  expect(toolResultText(raw, { max: 0 })).toBe("(no output captured)");
  expect(toolResultText(raw, { max: -5 })).toBe("(no output captured)");
});

// ── AgentMode.jsx regression: the shell branch must route through toolResultText ──
test("AgentMode's shell branch uses toolResultText, not the raw slice(-3000) path", () => {
  const src = readFileSync(fileURLToPath(new URL("./AgentMode.jsx", import.meta.url)), "utf8");
  expect(src).not.toContain(".slice(-3000)");
  expect(src).toContain("toolResultText(");
});
