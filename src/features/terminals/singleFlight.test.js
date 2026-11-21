// (C)
// runExclusive: the single-flight guard TerminalsTab and the palette put on
// actions that open a confirm (close tab, Exit, Reset workspace), v0.7.6
// audit. Confirms queue FIFO, so a second request while the first one's
// confirm is still open would stack an identical dialog behind it.
import { test, expect } from "vitest";
import { runExclusive } from "./singleFlight.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("a second request for the same key while the first is pending is ignored", async () => {
  const flights = new Set();
  const answer = deferred();
  let runs = 0;
  const action = async () => { runs += 1; return answer.promise; };
  const first = runExclusive(flights, "close:t1", action);
  const second = runExclusive(flights, "close:t1", action);
  expect(runs).toBe(1);
  expect(await second).toBeUndefined();
  answer.resolve("done");
  expect(await first).toBe("done");
});

test("other keys are not blocked", async () => {
  const flights = new Set();
  const answer = deferred();
  let runs = 0;
  const action = async () => { runs += 1; return answer.promise; };
  runExclusive(flights, "close:t1", action);
  runExclusive(flights, "close:t2", action);
  expect(runs).toBe(2);
  answer.resolve();
});

test("the key frees once the action settles, even when it throws", async () => {
  const flights = new Set();
  await expect(runExclusive(flights, "exit", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  let ran = false;
  await runExclusive(flights, "exit", async () => { ran = true; });
  expect(ran).toBe(true);
  expect(flights.size).toBe(0);
});

test("a synchronous throw also frees the key", async () => {
  const flights = new Set();
  await expect(runExclusive(flights, "k", () => { throw new Error("sync"); })).rejects.toThrow("sync");
  expect(flights.has("k")).toBe(false);
});
