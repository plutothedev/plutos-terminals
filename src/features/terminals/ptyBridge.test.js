// (C)
// Locks the Native-Agent-Mode capture path in ptyBridge, including the
// 2026-07-01 fix: closing a tab (unregisterPty) with an in-flight runAndCapture
// must resolve it immediately instead of hanging until the 120s timeout.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerPtyWriter,
  unregisterPty,
  runAndCapture,
  reportBlockDone,
} from "./ptyBridge.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ptyBridge runAndCapture", () => {
  it("resolves null (not hang) when the tab is closed mid-capture", async () => {
    const writes = [];
    registerPtyWriter("t1", (d) => writes.push(d));
    const p = runAndCapture("t1", "sleep 999");
    expect(writes).toEqual(["sleep 999\r"]); // command was written
    unregisterPty("t1"); // tab closed before any block-done arrives
    await expect(p).resolves.toBeNull();
  });

  it("resolves with the correlated finished block", async () => {
    registerPtyWriter("t2", () => {});
    const p = runAndCapture("t2", "ls");
    // A foreign block-done (different command) must NOT resolve the capture…
    reportBlockDone("t2", { command: "whoami", output: "me" });
    // …the matching one does.
    reportBlockDone("t2", { command: "ls", output: "a b c" });
    const got = await p;
    expect(got.command).toBe("ls");
    expect(got.output).toBe("a b c");
    unregisterPty("t2");
  });

  it("resolves null immediately when the tab has no live writer", async () => {
    // No registerPtyWriter for t3 → writeToTab fails → capture resolves null.
    await expect(runAndCapture("t3", "ls")).resolves.toBeNull();
  });

  it("a new capture supersedes a stale pending one on the same tab", async () => {
    registerPtyWriter("t4", () => {});
    const first = runAndCapture("t4", "one");
    const second = runAndCapture("t4", "two"); // replaces the first
    await expect(first).resolves.toBeNull();
    reportBlockDone("t4", { command: "two", output: "ok" });
    expect((await second).output).toBe("ok");
    unregisterPty("t4");
  });
});
