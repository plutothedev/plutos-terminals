import { test, expect } from "vitest";
import { classifyError, decryptRemote } from "./syncEngine.js";
import { CorruptBlobError } from "./crypto.js";

test("classifyError surfaces a corrupt remote blob distinctly", () => {
  expect(classifyError(new CorruptBlobError("corrupt sync blob"))).toEqual({ state: "corrupt" });
});

test("classifyError falls back to a generic error with the message", () => {
  const r = classifyError(new Error("network down"));
  expect(r.state).toBe("error");
  expect(r.msg).toContain("network down");
});

test("decryptRemote: a truncated remote blob is corrupt, not a generic error", async () => {
  // The most common real corruption: the outer JSON.parse fails before decrypt runs.
  await expect(decryptRemote({ salt: "s", blob: "{not valid json" }, "pw"))
    .rejects.toBeInstanceOf(CorruptBlobError);
});

test("decryptRemote: a valid-JSON blob missing iv/ct is corrupt", async () => {
  await expect(decryptRemote({ salt: "s", blob: "{}" }, "pw"))
    .rejects.toBeInstanceOf(CorruptBlobError);
});

test("decryptRemote: an empty remote (no salt/blob) is a clean empty surface", async () => {
  await expect(decryptRemote({}, "pw")).resolves.toEqual({ fields: {}, fieldMeta: {}, collections: {} });
});

test("classifyError maps a corrupt-from-decryptRemote throw to the corrupt state", async () => {
  const err = await decryptRemote({ salt: "s", blob: "{bad" }, "pw").catch((e) => e);
  expect(classifyError(err)).toEqual({ state: "corrupt" });
});
