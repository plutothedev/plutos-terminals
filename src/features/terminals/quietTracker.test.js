// (C)
import { describe, it, expect } from "vitest";
import { createQuietTracker, QUIET } from "./quietTracker.js";

function pane({ held = false } = {}) {
  let t = 0;
  const timers = [];
  const h = { on: false, live: true, held, turnedOn: 0 };
  const tracker = createQuietTracker({
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: t + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.done = true;
    },
    isLive: () => h.live,
    isHeld: () => h.held,
    isOn: () => h.on,
    turnOn: () => {
      h.on = true;
      h.turnedOn += 1;
    },
  });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => !x.done && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at;
      due.done = true;
      due.fn();
    }
    t = end;
  };
  return { h, tracker, advance, timers };
}

describe("quiet tracker", () => {
  it("starts tracking once output has been quiet after a query, not before", () => {
    const p = pane();
    p.tracker.arm();
    p.advance(QUIET.quietMs - 1);
    expect(p.h.on).toBe(false);
    p.advance(1);
    expect(p.h.on).toBe(true);
    expect(p.h.turnedOn).toBe(1);
  });

  it("starts the quiet wait over on every output, so a startup is not counted", () => {
    const p = pane();
    p.tracker.arm();
    for (let i = 0; i < 3; i++) {
      p.advance(QUIET.quietMs - 500);
      p.tracker.output();
    }
    expect(p.h.on).toBe(false);
    p.advance(QUIET.quietMs);
    expect(p.h.on).toBe(true);
  });

  it("a second query restarts the quiet wait and leaves no earlier timer behind", () => {
    const p = pane();
    p.tracker.arm();
    p.advance(2000);
    p.tracker.arm();
    expect(p.timers.filter((x) => !x.done)).toHaveLength(1);
    p.advance(QUIET.quietMs - 1);
    expect(p.h.on).toBe(false);
    p.advance(1);
    expect(p.h.on).toBe(true);
  });

  it("a later query does not push the deadline back past the first", () => {
    const p = pane();
    p.tracker.arm();
    for (let i = 0; i < 30; i++) {
      p.advance(400);
      if (i % 3 === 0) p.tracker.arm();
      else p.tracker.output();
    }
    expect(p.h.on).toBe(true);
  });

  it("starts by maxWaitMs after the first query even when output never stops", () => {
    const p = pane();
    p.tracker.arm();
    for (let elapsed = 0; elapsed < QUIET.maxWaitMs - 400; elapsed += 400) {
      p.advance(400);
      p.tracker.output();
    }
    expect(p.h.on).toBe(false);
    for (let i = 0; i < 3; i++) {
      p.advance(400);
      p.tracker.output();
    }
    expect(p.h.on).toBe(true);
  });

  it("never arms a pane held after a resume, however long it repaints", () => {
    const p = pane({ held: true });
    p.tracker.arm();
    expect(p.tracker.armed).toBe(false);
    p.advance(QUIET.maxWaitMs * 3);
    expect(p.h.on).toBe(false);
  });

  it("a query before the hold does not turn on a pane held since", () => {
    const p = pane();
    p.tracker.arm();
    p.h.held = true;
    p.advance(QUIET.maxWaitMs * 2);
    expect(p.h.on).toBe(false);
  });

  it("does nothing once tracking is on, and nothing when not armed", () => {
    const p = pane();
    p.tracker.output();
    expect(p.tracker.armed).toBe(false);
    p.h.on = true;
    p.tracker.arm();
    expect(p.tracker.armed).toBe(false);
    p.advance(QUIET.maxWaitMs);
    expect(p.h.turnedOn).toBe(0);
  });

  it("start() turns tracking on at once and cancels the wait", () => {
    const p = pane();
    p.tracker.arm();
    p.tracker.start();
    expect(p.h.on).toBe(true);
    expect(p.tracker.armed).toBe(false);
    expect(p.timers.every((x) => x.done)).toBe(true);
    p.advance(QUIET.maxWaitMs);
    expect(p.h.turnedOn).toBe(1);
  });

  it("does not turn on for a pane that is gone, or after dispose", () => {
    const p = pane();
    p.tracker.arm();
    p.h.live = false;
    p.advance(QUIET.maxWaitMs);
    expect(p.h.on).toBe(false);
    const q = pane();
    q.tracker.arm();
    q.tracker.dispose();
    expect(q.timers.every((x) => x.done)).toBe(true);
    q.advance(QUIET.maxWaitMs);
    expect(q.h.on).toBe(false);
  });

  it("keeps its numbers: 3 s of quiet, 10 s at most", () => {
    expect(QUIET).toEqual({ quietMs: 3000, maxWaitMs: 10000 });
  });
});
