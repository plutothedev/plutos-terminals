import { test, expect } from "vitest";
import { classifyError } from "./syncEngine.js";
import { CorruptBlobError } from "./crypto.js";

test("classifyError surfaces a corrupt remote blob distinctly", () => {
  expect(classifyError(new CorruptBlobError("corrupt sync blob"))).toEqual({ state: "corrupt" });
});

test("classifyError falls back to a generic error with the message", () => {
  const r = classifyError(new Error("network down"));
  expect(r.state).toBe("error");
  expect(r.msg).toContain("network down");
});
