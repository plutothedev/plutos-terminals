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
