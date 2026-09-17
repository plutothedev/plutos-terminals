// (C)
// Trickle scheduling contract (P4-T5 mini-review MED: the loop had zero
// coverage). trickleTick is the pure core; the TerminalsTab effect adds only
// timer plumbing + the [state.panels] re-arm.
//
// Entries here are REAL paneRegistry entries, and the tick runs against the
// registry's real getEntry (trickleTick's default argument). The earlier
// version of this file hand-wrote its own entry object carrying a copy of the
// spawn latch, so "Latch held: nothing ever fired twice" was asserting that
// the test file's own three lines worked (audit TQ-3). The only thing a test
// may supply now is the spawn BODY, which is what TerminalPane registers.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { trickleTick } from "./trickle.js";
import { ensureEntry, destroyAll } from "./paneRegistry.js";

// Minimal DOM stub: paneRegistry mints one host element per entry. The
// trickle never attaches or reads it, so createElement + remove is the whole
// surface (vitest runs in node here; no jsdom dependency, deliberately).
beforeAll(() => {
  globalThis.document = globalThis.document || {
    createElement: () => ({ className: "", style: {}, remove() {} }),
  };
});

beforeEach(() => {
  destroyAll();
});

// A pane whose TerminalPane mount has registered its spawn body. `fired` is
// test bookkeeping hung off the entry; the latch that decides whether the
// body runs belongs to paneRegistry.
const mkEntry = (id) => {
  const e = ensureEntry(id);
  e.fired = 0;
  e.spawnBody = () => { e.fired++; };
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
    const ids = ["tabA", "b1", "b2", "b3", "tabC"];
    const made = ids.map(mkEntry);

    // Tick 1: tabA only.
    expect(trickleTick(panels)).toBe(true);
    expect(made[0].fired).toBe(1);
    expect(made[1].fired).toBe(0);

    // Tick 2: ALL of tabB's panes together, one slot, not three.
    expect(trickleTick(panels)).toBe(true);
    expect(made[1].fired).toBe(1);
    expect(made[2].fired).toBe(1);
    expect(made[3].fired).toBe(1);
    expect(made[4].fired).toBe(0);

    // Tick 3: tabC. Tick 4: nothing left -> false (timer dies; the
    // TerminalsTab effect re-arms on the next state.panels change).
    expect(trickleTick(panels)).toBe(true);
    expect(made[4].fired).toBe(1);
    expect(trickleTick(panels)).toBe(false);

    // Latch held: nothing ever fired twice, and every entry parked in
    // "starting" (the registry's synchronous flip, not a copy of it).
    for (const e of made) {
      expect(e.fired).toBe(1);
      expect(e.spawnState).toBe("starting");
    }
  });

  it("a reveal racing the same tick cannot double-spawn a pane", () => {
    // The two real callers are TerminalPane's [visible] effect
    // (entry.startSpawn()) and this tick. They can land in the same frame on
    // a restored hidden pane that is revealed just as the trickle reaches it.
    const e = mkEntry("tabA");
    e.startSpawn(); // the reveal wins the latch
    expect(e.fired).toBe(1);

    // The tick now finds nothing unspawned in tabA and moves on to the next
    // tab with work; tabA's body is never entered a second time.
    mkEntry("tabC");
    expect(trickleTick(panels)).toBe(true);
    expect(e.fired).toBe(1);
    expect(ensureEntry("tabC").fired).toBe(1);
  });

  it("panes added AFTER exhaustion are picked up by a later tick (the re-arm path of the mini-review HIGH)", () => {
    mkEntry("tabA");
    expect(trickleTick(panels)).toBe(true); // tabA
    expect(trickleTick(panels)).toBe(false); // exhausted (tabB/tabC have no entries yet)

    // Late workspace load: tabC's pane mounts now (entry born unspawned).
    const late = mkEntry("tabC");
    expect(trickleTick(panels)).toBe(true); // a re-armed tick finds it
    expect(late.fired).toBe(1);
    expect(trickleTick(panels)).toBe(false);
  });

  it("skips ids with no registry entry and already-spawned tabs without consuming a slot", () => {
    const live = mkEntry("tabA");
    live.spawnState = "live";
    const pending = mkEntry("tabC");
    // tabA live, tabB unmounted (no entries) -> first release is tabC.
    expect(trickleTick(panels)).toBe(true);
    expect(pending.fired).toBe(1);
    expect(live.fired).toBe(0);
    expect(trickleTick(panels)).toBe(false);
  });
});
