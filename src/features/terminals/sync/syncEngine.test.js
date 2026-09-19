// (C)
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Hoisted so the vi.mock factories (lifted above these imports) can see them.
// crypto.js stays REAL: the decryptRemote tests below exercise it.
const { invokeMock, pushMock, getPassphraseMock, getPatMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  pushMock: vi.fn(),
  getPassphraseMock: vi.fn(),
  getPatMock: vi.fn(),
}));
vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));
vi.mock("./syncSecrets.js", () => ({
  getPassphrase: getPassphraseMock,
  getPat: getPatMock,
  setPassphrase: vi.fn(),
  setPat: vi.fn(),
}));
// The push path has its own tests (pushRetry.test.js) and needs real PBKDF2;
// stub it so the gate tests stay fast and deterministic under fake timers.
vi.mock("./pushRetry.js", () => ({ pushWithRePull: pushMock }));

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

// ---------------------------------------------------------------------------
// The enabled gate.
//
// "Disable sync" only cleared userSt.sync.enabled; the engine's 5-minute poll
// knew nothing about it and kept pulling, merging and pushing with the user's
// token until the app restarted (and enabling after a disabled boot never
// started the poller at all). The fix is two-layer: App.jsx starts/stops the
// poller on the flag, and the engine itself refuses to sync while it is off.
// Both layers are guarded here, because either alone leaves a hole: a stale
// straggler timer (the finally re-arm below) outlives the lifecycle fix, and a
// lifecycle-only fix leaves the engine trusting whoever calls it.
const POLL_MS = 5 * 60 * 1000; // mirrors syncEngine.js

function cmdCount(cmd) {
  return invokeMock.mock.calls.filter((c) => c[0] === cmd).length;
}

/** A fresh engine module per test: cfg/busy/poll/timer are module-level state. */
async function freshEngine(getEnabled, statuses = []) {
  vi.resetModules();
  const mod = await import("./syncEngine.js");
  mod.configure({
    getStores: () => ({ userSt: {}, st: {}, macros: [] }),
    applyStores: () => {},
    getRepoUrl: () => "https://example.test/pluto-sync.git",
    setStatus: (s) => statuses.push(s),
    getEnabled,
  });
  return mod;
}

const stoppers = [];
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({}); // sync_pull → empty remote; others ignore the value
  pushMock.mockReset();
  pushMock.mockResolvedValue(undefined);
  getPassphraseMock.mockReset();
  getPassphraseMock.mockResolvedValue("correct horse");
  getPatMock.mockReset();
  getPatMock.mockResolvedValue("ghp_test");
});
afterEach(() => {
  while (stoppers.length) stoppers.pop()();
  vi.useRealTimers();
});

test("the poll does not touch the backend while sync is disabled", async () => {
  vi.useFakeTimers();
  const statuses = [];
  const { start } = await freshEngine(() => false, statuses);
  stoppers.push(start());
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(invokeMock).not.toHaveBeenCalled();
  expect(statuses.map((s) => s.state)).toContain("disabled");
});

test("the poll syncs while sync is enabled", async () => {
  vi.useFakeTimers();
  const { start } = await freshEngine(() => true);
  stoppers.push(start());
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(cmdCount("sync_clone_or_open")).toBe(2); // start()'s immediate sync + one poll tick
  expect(cmdCount("sync_pull")).toBe(2);
});

test("flipping enabled off between polls stops the next one", async () => {
  vi.useFakeTimers();
  let enabled = true;
  const { start } = await freshEngine(() => enabled);
  stoppers.push(start());
  await vi.advanceTimersByTimeAsync(POLL_MS);
  const before = invokeMock.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  enabled = false;
  await vi.advanceTimersByTimeAsync(POLL_MS * 2);
  expect(invokeMock.mock.calls.length).toBe(before);
});

test("a retry re-armed by the finally block does not sync once disabled", async () => {
  vi.useFakeTimers();
  let enabled = true;
  let fail;
  invokeMock.mockImplementation((cmd) => {
    if (cmd === "sync_clone_or_open") return new Promise((_res, rej) => { fail = () => rej(new Error("git offline")); });
    return Promise.resolve({});
  });
  const { syncNow } = await freshEngine(() => enabled);
  const inFlight = syncNow();
  await vi.advanceTimersByTimeAsync(0); // let it park on the pending clone
  await syncNow();                      // busy → pendingResync, so the finally re-arms
  enabled = false;                      // user hits "Disable sync" mid-flight
  fail();
  await inFlight;
  const before = invokeMock.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000); // well past the 250ms re-arm
  expect(invokeMock.mock.calls.length).toBe(before);
});

test("re-enabling resumes the poll, so the gate never wedges the engine", async () => {
  vi.useFakeTimers();
  let enabled = false;
  const { start } = await freshEngine(() => enabled);
  stoppers.push(start());
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(invokeMock).not.toHaveBeenCalled();
  enabled = true;
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(cmdCount("sync_pull")).toBe(1);
});

// The engine gate is only half the fix: without the lifecycle half, enabling
// sync after a disabled boot never starts a poller. This reads the shipped
// App.jsx so a refactor back to a mount-only start goes red here.
test("App.jsx starts the sync poller from an effect keyed on the enabled flag", () => {
  const src = readFileSync(fileURLToPath(new URL("../../../App.jsx", import.meta.url)), "utf8");
  const callAt = src.indexOf("startSync()");
  expect(callAt).toBeGreaterThan(0);
  const deps = src.slice(callAt).match(/\}, \[([^\]]*)\]/);
  expect(deps, "the startSync() effect has no dependency array").not.toBeNull();
  expect(deps[1]).toContain("syncEnabled");
  expect(src.slice(0, callAt)).toMatch(/!syncEnabled\)\s*return/);
  expect(src).toMatch(/getEnabled:\s*\(\)\s*=>/);
});
