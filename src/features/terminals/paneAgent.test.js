// (C)
import { describe, it, expect } from "vitest";
import { createPaneAgent, PACE } from "./paneAgent.js";
import { programStatusReply } from "./programStatus.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// A pane with a fake clock and fake effects. `advance` runs due timers in
// order; `micro` runs queued microtasks.
function pane({ away = true, heuristic = "idle" } = {}) {
  let t = 0;
  const timers = [];
  const microtasks = [];
  const h = { away, heuristic, live: true, notices: [], pushes: [], cues: 0, writes: [], shown: [] };
  const fx = {
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: t + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.done = true;
    },
    microtask: (fn) => microtasks.push(fn),
    isLive: () => h.live,
    isAway: () => h.away,
    paneName: () => "api (deploy@prod)",
    heuristic: () => h.heuristic,
    publish: (shown) => h.shown.push(shown),
    write: (d) => h.writes.push(d),
    notify: (title, body, urgent) => h.notices.push({ title, body, urgent }),
    push: (label, exit, kind) => h.pushes.push({ label, exit, kind }),
    cue: () => {
      h.cues += 1;
    },
  };
  const agent = createPaneAgent(fx);
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
  const micro = () => {
    while (microtasks.length) microtasks.shift()();
  };
  const last = () => h.shown[h.shown.length - 1];
  return { h, agent, advance, micro, last, timers };
}

describe("what the pane shows", () => {
  it("follows reports after the publish interval, over the heuristics", () => {
    const p = pane({ heuristic: "done" });
    p.agent.report("state=working");
    expect(p.h.shown).toEqual([]);
    p.advance(PACE.publishMs);
    expect(p.last()).toBe("active");
    p.agent.report("state=blocked:kind=permission");
    p.advance(PACE.publishMs);
    expect(p.last()).toBe("waiting");
    expect(p.agent.shown).toBe("waiting");
  });

  it("still shows waiting when the heuristics see a prompt, whatever a report says", () => {
    const p = pane({ heuristic: "waiting" });
    p.agent.report("state=idle");
    p.advance(PACE.publishMs);
    expect(p.last()).toBe("waiting");
  });

  it("falls back to the heuristics with no report, and when the reports end", () => {
    const p = pane({ heuristic: "active" });
    p.agent.heuristicChanged();
    expect(p.last()).toBe("active");
    p.agent.report("state=blocked");
    p.advance(PACE.publishMs);
    expect(p.last()).toBe("waiting");
    p.agent.endInFlight();
    expect(p.last()).toBe("active");
    p.agent.report("state=working");
    p.advance(PACE.publishMs);
    p.agent.reset();
    expect(p.last()).toBe("active");
  });

  it("does nothing on a pane that is gone", () => {
    const p = pane();
    p.agent.report("state=working");
    p.h.live = false;
    p.advance(PACE.publishMs);
    expect(p.h.shown).toEqual([]);
  });

  it("ignores reports that are not reports", () => {
    const p = pane();
    p.agent.report("state=sleeping");
    p.agent.report("");
    p.advance(1000);
    expect(p.h.shown).toEqual([]);
  });
});

describe("the OSC 7501 support reply", () => {
  it("goes ahead of xterm's own reply, in one write, when they come together", () => {
    const p = pane();
    p.agent.report("?");
    p.agent.reply("<DA1>");
    p.micro();
    expect(p.h.writes).toEqual([programStatusReply() + "<DA1>"]);
  });

  it("goes alone, first, when no reply follows in the same parse", () => {
    const p = pane();
    p.agent.report("?");
    p.micro();
    p.agent.reply("<DA1>");
    expect(p.h.writes).toEqual([programStatusReply(), "<DA1>"]);
  });

  it("is sent once per probe, at most a set number a second", () => {
    const p = pane();
    p.agent.report("?");
    p.agent.report("?");
    p.micro();
    expect(p.h.writes).toEqual([programStatusReply()]);
    for (let i = 0; i < 30; i++) {
      p.agent.report("?");
      p.micro();
    }
    expect(p.h.writes.length).toBe(PACE.repliesPerSec);
    p.advance(1000);
    p.agent.report("?");
    p.micro();
    expect(p.h.writes.length).toBe(PACE.repliesPerSec + 1);
  });

  it("is never added to a reply when no probe is pending", () => {
    const p = pane();
    p.agent.reply("<CPR>");
    expect(p.h.writes).toEqual(["<CPR>"]);
  });
});

describe("finished and failed", () => {
  const work = (p, ms, end = "state=done") => {
    p.agent.report("state=working:app=claude-code");
    p.advance(PACE.publishMs);
    p.advance(ms);
    p.agent.report(end);
    p.advance(PACE.publishMs);
  };

  it("tells you after real work, once", () => {
    const p = pane();
    work(p, PACE.finishMinWorkMs, "state=done:app=claude-code:msg=" + b64("Tests pass"));
    expect(p.h.cues).toBe(1);
    expect(p.h.notices).toEqual([{ title: "Agent finished: api (deploy@prod)", body: "claude-code says: Tests pass", urgent: false }]);
    expect(p.h.pushes).toEqual([{ label: "api (deploy@prod)", exit: 0, kind: "finished" }]);
  });

  it("stays quiet for quick flips, and inside the gap", () => {
    const p = pane();
    for (let i = 0; i < 20; i++) work(p, 50);
    expect(p.h.notices).toEqual([]);
    work(p, PACE.finishMinWorkMs);
    work(p, PACE.finishMinWorkMs);
    expect(p.h.notices.length).toBe(1);
    p.advance(PACE.finishGapMs);
    work(p, PACE.finishMinWorkMs);
    expect(p.h.notices.length).toBe(2);
  });

  it("says failed for an error, with a failing exit", () => {
    const p = pane();
    work(p, PACE.finishMinWorkMs, "state=error:app=cargo");
    expect(p.h.notices[0].title).toBe("Agent failed: api (deploy@prod)");
    expect(p.h.notices[0].body).toBe("cargo stopped with an error");
    expect(p.h.pushes[0].exit).toBe(1);
  });

  it("stays quiet while you are looking at the pane", () => {
    const p = pane({ away: false });
    work(p, PACE.finishMinWorkMs);
    expect(p.h.notices).toEqual([]);
    expect(p.h.cues).toBe(0);
  });

  it("counts a heuristic finish without the reported-work minimum", () => {
    const p = pane({ heuristic: "active" });
    p.agent.heuristicChanged();
    p.h.heuristic = "done";
    p.agent.heuristicChanged();
    expect(p.h.notices.length).toBe(1);
  });
});

describe("needs you", () => {
  const block = (p) => {
    p.agent.report("state=blocked:kind=permission:app=claude-code:msg=" + b64("Edit 3 files?"));
    p.advance(PACE.publishMs);
  };
  const unblock = (p) => {
    p.agent.report("state=working");
    p.advance(PACE.publishMs);
  };

  it("tells you, urgently, once the pane has waited", () => {
    const p = pane();
    block(p);
    p.advance(PACE.needsYouDelayMs - 1);
    expect(p.h.notices).toEqual([]);
    p.advance(1);
    expect(p.h.notices).toEqual([{ title: "Needs you: api (deploy@prod)", body: "claude-code says: Edit 3 files?", urgent: true }]);
    expect(p.h.pushes).toEqual([{ label: "api (deploy@prod)", exit: null, kind: "needs_you" }]);
  });

  it("stays quiet when the wait ends first (auto-approve answered)", () => {
    const p = pane();
    block(p);
    p.advance(PACE.needsYouDelayMs / 2);
    unblock(p);
    p.advance(PACE.needsYouDelayMs * 2);
    expect(p.h.notices).toEqual([]);
  });

  it("tells you again after the gap when a second wait comes inside it", () => {
    const p = pane();
    block(p);
    p.advance(PACE.needsYouDelayMs);
    expect(p.h.notices.length).toBe(1);
    unblock(p);
    p.advance(3000);
    block(p);
    p.advance(PACE.needsYouDelayMs);
    expect(p.h.notices.length).toBe(1);
    p.advance(PACE.needsYouGapMs);
    expect(p.h.notices.length).toBe(2);
  });

  it("stays quiet while you are looking at the pane", () => {
    const p = pane({ away: false });
    block(p);
    p.advance(PACE.needsYouGapMs * 2);
    expect(p.h.notices).toEqual([]);
  });

  it("stops when the pane is gone or disposed", () => {
    const p = pane();
    block(p);
    p.h.live = false;
    p.advance(PACE.needsYouDelayMs);
    expect(p.h.notices).toEqual([]);
    const q = pane();
    block(q);
    q.agent.dispose();
    q.advance(PACE.needsYouDelayMs * 2);
    expect(q.h.notices).toEqual([]);
  });

  it("dispose cancels a pending publish too", () => {
    const p = pane({ away: false });
    p.agent.report("state=working");
    expect(p.timers.some((t) => !t.done)).toBe(true);
    p.agent.dispose();
    expect(p.timers.every((t) => t.done)).toBe(true);
    p.advance(PACE.publishMs * 3);
    expect(p.h.shown).toEqual([]);
  });
});

describe("seeing and typing", () => {
  it("acknowledges a finished report on reveal, and on typing", () => {
    const p = pane({ away: false });
    p.agent.report("state=done");
    p.advance(PACE.publishMs);
    expect(p.last()).toBe("done");
    p.agent.acknowledge();
    expect(p.last()).toBe("idle");
    p.agent.report("state=error");
    p.advance(PACE.publishMs);
    p.agent.userInput();
    expect(p.last()).toBe("idle");
  });

  it("keeps a running agent's report when someone types", () => {
    const p = pane();
    p.agent.report("state=working");
    p.advance(PACE.publishMs);
    p.agent.userInput();
    expect(p.last()).toBe("active");
  });

  it("holds auto-approve on a resumed pane until someone types", () => {
    const p = pane();
    expect(p.agent.held).toBe(false);
    p.agent.holdForResume();
    expect(p.agent.held).toBe(true);
    p.agent.reply("<a program's own query answered>");
    expect(p.agent.held).toBe(true);
    p.agent.userInput();
    expect(p.agent.held).toBe(false);
  });
});

describe("runningAgent", () => {
  it("is the report while an agent runs there, and null once it is done", () => {
    const p = pane();
    expect(p.agent.runningAgent()).toBeNull();
    for (const state of ["idle", "working", "blocked"]) {
      p.agent.report(`state=${state}:app=claude-code`);
      expect(p.agent.runningAgent()).toMatchObject({ state, app: "claude-code" });
    }
    p.agent.report("state=done");
    expect(p.agent.runningAgent()).toBeNull();
  });
});
