import { test, expect } from "vitest";
import { userMsg, assistantToolCalls, toolResult } from "./llmTools.js";

test("builds normalized messages", () => {
  expect(userMsg("hi")).toEqual({ role: "user", text: "hi" });
  const a = assistantToolCalls("ok", [{ id: "c1", name: "fs.read", args: { p: "a" } }]);
  expect(a.role).toBe("assistant");
  expect(a.tool_calls[0].name).toBe("fs.read");
  const r = toolResult("c1", "body", false);
  expect(r).toEqual({ role: "tool", tool_call_id: "c1", content: "body", is_error: false });
});
