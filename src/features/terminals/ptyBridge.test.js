// (C)
// Locks the Native-Agent-Mode capture path in ptyBridge, including the
// 2026-07-01 fix: closing a tab (unregisterPty) with an in-flight runAndCapture
// must resolve it immediately instead of hanging until the 120s timeout.
// Also locks the TWO-CHANNEL version surface (P2-T5, replacing the #27
// single channel): dims changes and pty-registry changes (spawn/death) bump
// SEPARATE counters, so a split-drag resize storm no longer re-renders the
// registry consumers (companion session list) and vice versa. unregisterPty
// mutates both maps, so it bumps BOTH.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerPtyWriter,
  unregisterPty,
  runAndCapture,
  reportBlockDone,
  getDimsVersion,
  subscribeDims,
  getRegistryVersion,
  subscribeRegistry,
  setTabDims,
  setPtyId,
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

  it("a new capture supersedes a stale pending one — evicted resolves {evicted}, not null", async () => {
    // Supersede stays (an agent stop can leave a stale pending entry that the
    // next run must clear), but the evicted caller gets a DISTINGUISHABLE
    // result: null means pane-closed; {evicted:true} means another capture
    // took the pane (release-audit fix — cross-feature agent/notebook runs
    // were indistinguishable from a closed pane).
    registerPtyWriter("t4", () => {});
    const first = runAndCapture("t4", "one");
    const second = runAndCapture("t4", "two"); // replaces the first
    await expect(first).resolves.toEqual({ evicted: true });
    reportBlockDone("t4", { command: "two", output: "ok" });
    expect((await second).output).toBe("ok");
    unregisterPty("t4");
  });

  it("pane-closed still resolves null (evicted and closed stay distinguishable)", async () => {
    registerPtyWriter("t5", () => {});
    const p = runAndCapture("t5", "one");
    unregisterPty("t5");
    await expect(p).resolves.toBeNull();
  });
});

describe("ptyBridge two-channel version surface (P2-T5)", () => {
  it("setTabDims bumps ONLY the dims channel", () => {
    const dimsBefore = getDimsVersion();
    const regBefore = getRegistryVersion();
    setTabDims("bv1", 80, 24);
    expect(getDimsVersion()).toBeGreaterThan(dimsBefore);
    expect(getRegistryVersion()).toBe(regBefore);
  });

  it("setPtyId bumps ONLY the registry channel", () => {
    const dimsBefore = getDimsVersion();
    const regBefore = getRegistryVersion();
    setPtyId("bv-reg", "pty-abc123");
    expect(getRegistryVersion()).toBeGreaterThan(regBefore);
    expect(getDimsVersion()).toBe(dimsBefore);
    setPtyId("bv-reg", null); // cleanup (also bumps registry — fine)
  });

  it("unregisterPty bumps BOTH channels (it mutates both maps)", () => {
    registerPtyWriter("bv-both", () => {});
    setTabDims("bv-both", 80, 24);
    setPtyId("bv-both", "pty-def456");
    const dimsBefore = getDimsVersion();
    const regBefore = getRegistryVersion();
    unregisterPty("bv-both");
    expect(getDimsVersion()).toBeGreaterThan(dimsBefore);
    expect(getRegistryVersion()).toBeGreaterThan(regBefore);
  });

  it("each channel's subscribers fire only for their own events", () => {
    let dimsCalls = 0;
    let regCalls = 0;
    const unsubDims = subscribeDims(() => { dimsCalls += 1; });
    const unsubReg = subscribeRegistry(() => { regCalls += 1; });
    setTabDims("bv2", 100, 40);
    expect(dimsCalls).toBe(1);
    expect(regCalls).toBe(0);
    setPtyId("bv2", "pty-xyz");
    expect(dimsCalls).toBe(1);
    expect(regCalls).toBe(1);
    unsubDims();
    unsubReg();
    setPtyId("bv2", null);
  });

  it("stops delivering to an unsubscribed callback while the version keeps moving", () => {
    let calls = 0;
    const unsubscribe = subscribeDims(() => { calls += 1; });
    setTabDims("bv3", 80, 24);
    expect(calls).toBe(1);
    const versionAtUnsubscribe = getDimsVersion();
    unsubscribe();
    setTabDims("bv3", 120, 30); // a real dims change — emit fires again
    expect(getDimsVersion()).toBeGreaterThan(versionAtUnsubscribe);
    expect(calls).toBe(1);
  });
});
