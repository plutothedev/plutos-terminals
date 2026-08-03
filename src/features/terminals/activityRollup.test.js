// (C)
// Pins the agent-activity rollup. Four surfaces read it — the tab dot and panel
// dot (TerminalPanel), the project row (ProjectSidebar via useTabTelemetry), the
// Monitor fleet line, and the Agent dashboard — and each used to carry its own
// hand-rolled copy of "active beats done". They now share mergeActivity, and
// these tests are what keep them from drifting apart again.
//
// The load-bearing rule: "waiting" (an agent blocked on your approval) outranks
// everything. It is the only state that is asking something of you, so it must
// never be masked by a sibling pane that happens to be running.
import { describe, it, expect } from "vitest";
import { mergeActivity, activityCounts, tabStatus, ACTIVITY_RANK } from "./hooks/useTabTelemetry.js";

describe("mergeActivity", () => {
  it("ranks waiting above every other state", () => {
    for (const other of ["active", "done", "idle"]) {
      expect(mergeActivity(other, "waiting")).toBe("waiting");
      expect(mergeActivity("waiting", other)).toBe("waiting");
    }
  });

  it("keeps the established active > done > idle order", () => {
    expect(mergeActivity("done", "active")).toBe("active");
    expect(mergeActivity("active", "done")).toBe("active");
    expect(mergeActivity("idle", "done")).toBe("done");
    expect(mergeActivity("done", "idle")).toBe("done");
  });

  it("is order-independent — a fold over panes gives the same answer either way", () => {
    const states = ["idle", "done", "active", "waiting"];
    for (const a of states) {
      for (const b of states) {
        expect(mergeActivity(a, b)).toBe(mergeActivity(b, a));
      }
    }
  });

  it("treats missing/unknown states as idle rather than throwing", () => {
    expect(mergeActivity(undefined, "done")).toBe("done");
    expect(mergeActivity("done", undefined)).toBe("done");
    expect(mergeActivity(undefined, undefined)).toBe("idle");
    expect(mergeActivity("bogus", "active")).toBe("active");
  });

  it("every state has a rank, so no state can silently sort as idle", () => {
    for (const s of ["waiting", "active", "done", "idle"]) {
      expect(typeof ACTIVITY_RANK[s]).toBe("number");
    }
    expect(ACTIVITY_RANK.waiting).toBeGreaterThan(ACTIVITY_RANK.active);
  });
});

// A split tab's panes have their OWN leaf ids — only one child keeps the
// original tab.id. Any surface keying off tab.id alone silently misses the
// other pane, which is exactly how the Monitor dock came to undercount
// "needs you" while the Agent dashboard showed it correctly.
describe("tabStatus — split tabs", () => {
  const unsplit = { id: "t1" };
  const split = {
    id: "t2",
    layout: { id: "root", dir: "row", a: { id: "t2" }, b: { id: "pane-2" } },
  };

  it("an unsplit tab reads its own id", () => {
    expect(tabStatus(unsplit, { t1: "waiting" })).toBe("waiting");
    expect(tabStatus(unsplit, {})).toBe("idle");
  });

  it("sees a blocked pane that is NOT the one holding tab.id", () => {
    expect(tabStatus(split, { "pane-2": "waiting" })).toBe("waiting");
  });

  it("waiting in either pane beats a sibling that is merely running", () => {
    expect(tabStatus(split, { t2: "active", "pane-2": "waiting" })).toBe("waiting");
    expect(tabStatus(split, { t2: "waiting", "pane-2": "active" })).toBe("waiting");
  });

  it("falls back to the loudest remaining state when nothing is blocked", () => {
    expect(tabStatus(split, { t2: "done", "pane-2": "active" })).toBe("active");
    expect(tabStatus(split, { "pane-2": "done" })).toBe("done");
  });
});

describe("activityCounts", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("counts a split tab once, by its loudest pane", () => {
    const split = { id: "s", layout: { id: "r", dir: "row", a: { id: "s" }, b: { id: "s2" } } };
    const counts = activityCounts([split], { s2: "waiting" });
    expect(counts).toEqual({ waiting: 1, active: 0, done: 0, idle: 0 });
  });

  it("counts each state across the fleet", () => {
    const counts = activityCounts(tabs, { a: "waiting", b: "active", c: "done" });
    expect(counts).toEqual({ waiting: 1, active: 1, done: 1, idle: 1 });
  });

  it("tabs with no recorded state count as idle (the map drops idle entries)", () => {
    expect(activityCounts(tabs, {})).toEqual({ waiting: 0, active: 0, done: 0, idle: 4 });
  });

  it("an unknown state falls into idle instead of vanishing from the totals", () => {
    const counts = activityCounts(tabs, { a: "bogus", b: "waiting" });
    expect(counts.waiting).toBe(1);
    expect(counts.waiting + counts.active + counts.done + counts.idle).toBe(tabs.length);
  });

  it("handles no tabs / no activity map", () => {
    expect(activityCounts(undefined, undefined)).toEqual({ waiting: 0, active: 0, done: 0, idle: 0 });
  });
});
