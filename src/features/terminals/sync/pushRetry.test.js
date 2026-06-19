import { test, expect } from "vitest";
import { pushWithRePull } from "./pushRetry.js";

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
  let pushes = 0, repulls = 0;
  const r = await pushWithRePull(
    async () => { pushes++; if (pushes < 3) throw new Error("non-ff"); return "ok"; },
    async () => { repulls++; },
    4,
  );
  expect(r).toBe("ok");
  expect(pushes).toBe(3);
  expect(repulls).toBe(2); // re-pulled between the two failures, not after success
});

test("pushWithRePull throws the last error after exhausting attempts (no silent unpushed edit)", async () => {
  let repulls = 0;
  await expect(
    pushWithRePull(
      async () => { throw new Error("always non-ff"); },
      async () => { repulls++; },
      3,
    ),
  ).rejects.toThrow("always non-ff");
  expect(repulls).toBe(2); // re-pulls only BETWEEN attempts, not after the final one
});
