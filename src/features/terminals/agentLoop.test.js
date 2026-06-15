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
