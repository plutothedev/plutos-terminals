// (C)
// Trickle scheduling contract (P4-T5 mini-review MED: the loop had zero
// coverage). trickleTick is the pure core; the TerminalsTab effect adds only
// timer plumbing + the [state.panels] re-arm.
import { describe, it, expect } from "vitest";
import { trickleTick } from "./trickle.js";

const mkEntry = () => {
  const e = { spawnState: "unspawned", fired: 0 };
  e.startSpawn = () => {
    if (e.spawnState !== "unspawned") return; // mirror TerminalPane's latch
    e.spawnState = "starting";
    e.fired++;
  };
  return e;
};

const panels = [
  {
    id: "p1",
    tabs: [
      { id: "tabA" }, // single pane
      {
        id: "tabB", // 3-way split: leaf ids from the layout tree
        layout: {
          id: "s1", dir: "row", ratio: 0.5,
          a: { id: "b1" },
          b: { id: "s2", dir: "col", ratio: 0.5, a: { id: "b2" }, b: { id: "b3" } },
        },
      },
      { id: "tabC" },
    ],
  },
];

describe("trickleTick", () => {
  it("releases exactly ONE tab per tick (a split tab = one slot), reports work-remaining, and drains in render order", () => {
    const reg = new Map([
      ["tabA", mkEntry()], ["b1", mkEntry()], ["b2", mkEntry()], ["b3", mkEntry()], ["tabC", mkEntry()],
    ]);
    const get = (id) => reg.get(id) ?? null;

    // Tick 1: tabA only.
    expect(trickleTick(panels, get)).toBe(true);
    expect(reg.get("tabA").fired).toBe(1);
    expect(reg.get("b1").fired).toBe(0);

    // Tick 2: ALL of tabB's panes together — one slot, not three.
    expect(trickleTick(panels, get)).toBe(true);
    expect(reg.get("b1").fired).toBe(1);
    expect(reg.get("b2").fired).toBe(1);
    expect(reg.get("b3").fired).toBe(1);
    expect(reg.get("tabC").fired).toBe(0);

    // Tick 3: tabC. Tick 4: nothing left -> false (timer dies; the
    // TerminalsTab effect re-arms on the next state.panels change).
    expect(trickleTick(panels, get)).toBe(true);
    expect(reg.get("tabC").fired).toBe(1);
    expect(trickleTick(panels, get)).toBe(false);

    // Latch held: nothing ever fired twice.
    for (const e of reg.values()) expect(e.fired).toBe(1);
  });

  it("panes added AFTER exhaustion are picked up by a later tick (the re-arm path of the mini-review HIGH)", () => {
    const reg = new Map([["tabA", mkEntry()]]);
    const get = (id) => reg.get(id) ?? null;
    expect(trickleTick(panels, get)).toBe(true); // tabA
    expect(trickleTick(panels, get)).toBe(false); // exhausted (tabB/tabC have no entries yet)

    // Late workspace load: tabC's pane mounts now (entry born unspawned).
    reg.set("tabC", mkEntry());
    expect(trickleTick(panels, get)).toBe(true); // a re-armed tick finds it
    expect(reg.get("tabC").fired).toBe(1);
    expect(trickleTick(panels, get)).toBe(false);
  });

  it("skips ids with no registry entry and already-spawned tabs without consuming a slot", () => {
    const live = mkEntry();
    live.spawnState = "live";
    const reg = new Map([["tabA", live], ["tabC", mkEntry()]]);
    const get = (id) => reg.get(id) ?? null;
    // tabA live, tabB unmounted (no entries) -> first release is tabC.
    expect(trickleTick(panels, get)).toBe(true);
    expect(reg.get("tabC").fired).toBe(1);
    expect(live.fired).toBe(0);
    expect(trickleTick(panels, get)).toBe(false);
  });
});
