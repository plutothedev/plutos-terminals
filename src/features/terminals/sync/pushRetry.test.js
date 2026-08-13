import { test, expect, vi, afterEach } from "vitest";
import { pushWithRePull } from "./pushRetry.js";

// Fake timers: the retry path sleeps 1s/3s(+jitter) between attempts — real
// timers made this file ~8s of wall clock. advanceTimersByTimeAsync flushes
// the await-sleep chain deterministically.
afterEach(() => {
  vi.useRealTimers();
});

test("pushWithRePull succeeds on first try, no re-pull", async () => {
  let pushes = 0, repulls = 0;
  const r = await pushWithRePull(
    async () => { pushes++; return "ok"; },
    async () => { repulls++; },
    4,
  );
  expect(r).toBe("ok");
  expect(pushes).toBe(1);
  expect(repulls).toBe(0);
});

test("pushWithRePull re-pulls and retries on non-fast-forward, then succeeds", async () => {
  vi.useFakeTimers();
  let pushes = 0, repulls = 0;
  const p = pushWithRePull(
    async () => { pushes++; if (pushes < 3) throw new Error("non-ff"); return "ok"; },
    async () => { repulls++; },
    4,
  );
  // Two backoffs (1s then 3s, ±20% jitter) — 10s covers the worst case.
  await vi.advanceTimersByTimeAsync(10_000);
  const r = await p;
  expect(r).toBe("ok");
  expect(pushes).toBe(3);
  expect(repulls).toBe(2); // re-pulled between the two failures, not after success
});

test("pushWithRePull throws the last error after exhausting attempts (no silent unpushed edit)", async () => {
  vi.useFakeTimers();
  let repulls = 0;
  // Capture the rejection up front so the pending promise never trips the
  // unhandled-rejection detector while timers advance.
  const p = pushWithRePull(
    async () => { throw new Error("always non-ff"); },
    async () => { repulls++; },
    3,
  ).then(
    () => { throw new Error("should not resolve"); },
    (e) => e,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  const err = await p;
  expect(String(err)).toContain("always non-ff");
  expect(repulls).toBe(2); // re-pulls only BETWEEN attempts, not after the final one
});
