import { test, expect } from "vitest";
import { buildTools, needsApproval, isDangerousCommand, RUN_COMMAND_TOOL, mcpResultToContent } from "./agentTools.js";

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
