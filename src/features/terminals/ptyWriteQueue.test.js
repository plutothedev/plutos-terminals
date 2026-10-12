// (C)
import { describe, it, expect } from "vitest";
import { createWriteQueue, MAX_PENDING_CHARS } from "./ptyWriteQueue.js";

// A send whose invokes resolve only when the test says so, recording what
// arrived and in what order.
function deferredSend() {
  const calls = [];
  const resolvers = [];
  const send = (data) => {
    calls.push(data);
    return new Promise((resolve, reject) => resolvers.push({ resolve, reject }));
  };
  return { send, calls, resolvers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createWriteQueue", () => {
  it("sends the first write at once", () => {
    const d = deferredSend();
    const q = createWriteQueue(d.send);
    q.write("a");
    expect(d.calls).toEqual(["a"]);
  });

  it("holds later writes until the one in flight is done, then sends them joined and in order", async () => {
    const d = deferredSend();
    const q = createWriteQueue(d.send);
    q.write("probe-reply");
    q.write("da1-reply");
    q.write("x");
    expect(d.calls).toEqual(["probe-reply"]);
    d.resolvers[0].resolve();
    await flush();
    expect(d.calls).toEqual(["probe-reply", "da1-reply" + "x"]);
    d.resolvers[1].resolve();
    await flush();
    q.write("y");
    expect(d.calls).toEqual(["probe-reply", "da1-reply" + "x", "y"]);
  });

  it("keeps going after a failed or throwing send", async () => {
    const d = deferredSend();
    const q = createWriteQueue(d.send);
    q.write("a");
    q.write("b");
    d.resolvers[0].reject(new Error("pty gone"));
    await flush();
    expect(d.calls).toEqual(["a", "b"]);
    const throwing = createWriteQueue(() => {
      throw new Error("boom");
    });
    throwing.write("z");
    await flush();
    expect(throwing.pendingLength).toBe(0);
  });

  it("drops writes past the cap instead of holding them without end", () => {
    const d = deferredSend();
    const q = createWriteQueue(d.send);
    q.write("first");
    q.write("x".repeat(MAX_PENDING_CHARS));
    q.write("over");
    expect(q.pendingLength).toBe(MAX_PENDING_CHARS);
  });

  it("ignores empty and non-text writes", () => {
    const d = deferredSend();
    const q = createWriteQueue(d.send);
    q.write("");
    q.write(undefined);
    expect(d.calls).toEqual([]);
  });
});
