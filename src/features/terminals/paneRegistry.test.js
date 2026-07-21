// (C)
import { describe, it, expect, beforeAll } from "vitest";

// Minimal DOM stub: the registry uses document.createElement + appendChild +
// remove only. vitest runs in node (no jsdom dependency in this repo — a
// deliberate choice); this stub keeps it that way.
beforeAll(() => {
  const makeEl = () => {
    const el = {
      className: "", style: {}, parentNode: null, children: [],
      appendChild(child) {
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((c) => c !== child);
        child.parentNode = el; el.children.push(child); return child;
      },
      remove() {
        if (el.parentNode) { el.parentNode.children = el.parentNode.children.filter((c) => c !== el); el.parentNode = null; }
      },
      contains(node) { return el.children.includes(node); },
    };
    return el;
  };
  globalThis.document = globalThis.document || { createElement: () => makeEl() };
  globalThis.__makeSlot = makeEl;
});

const load = async () => await import("./paneRegistry.js");

describe("paneRegistry", () => {
  it("ensureEntry is idempotent and synchronous", async () => {
    const R = await load();
    R.destroyAll();
    const a = R.ensureEntry("p1");
    const b = R.ensureEntry("p1");
    expect(b).toBe(a);
    expect(a.spawnState).toBe("starting");
    expect(typeof a.host.appendChild).toBe("function");
  });

  it("attachHost moves the SAME host node between slots (implicit re-parent)", async () => {
    const R = await load();
    R.destroyAll();
    const e = R.ensureEntry("p2");
    const s1 = globalThis.__makeSlot();
    const s2 = globalThis.__makeSlot();
    R.attachHost("p2", s1);
    expect(s1.contains(e.host)).toBe(true);
    R.attachHost("p2", s2); // no detach first — appendChild moves it
    expect(s1.contains(e.host)).toBe(false);
    expect(s2.contains(e.host)).toBe(true);
    expect(e.currentSlot).toBe(s2);
    R.detachHost("p2");
    expect(s2.contains(e.host)).toBe(false);
    expect(e.currentSlot).toBe(null);
  });

  it("destroyEntry runs hooks LIFO and survives a throwing hook", async () => {
    const R = await load();
    R.destroyAll();
    R.ensureEntry("p3");
    const order = [];
    R.registerDestroyHook("p3", () => order.push("first-registered"));
    R.registerDestroyHook("p3", () => { throw new Error("boom"); });
    R.registerDestroyHook("p3", () => order.push("last-registered"));
    R.destroyEntry("p3");
    expect(order).toEqual(["last-registered", "first-registered"]);
    expect(R.getEntry("p3")).toBeNull();
  });

  it("reconcile destroys exactly the ids missing from the live set", async () => {
    const R = await load();
    R.destroyAll();
    R.ensureEntry("keep1"); R.ensureEntry("keep2"); R.ensureEntry("gone1"); R.ensureEntry("gone2");
    const killed = [];
    R.registerDestroyHook("gone1", () => killed.push("gone1"));
    R.registerDestroyHook("gone2", () => killed.push("gone2"));
    const destroyed = R.reconcile(new Set(["keep1", "keep2"]));
    expect(destroyed.sort()).toEqual(["gone1", "gone2"]);
    expect(killed.sort()).toEqual(["gone1", "gone2"]);
    expect(R.listEntries().sort()).toEqual(["keep1", "keep2"]);
  });

  it("reconcile accepts a plain array (not just a Set) with identical behavior", async () => {
    const R = await load();
    R.destroyAll();
    R.ensureEntry("keep1"); R.ensureEntry("gone1");
    const killed = [];
    R.registerDestroyHook("gone1", () => killed.push("gone1"));
    const destroyed = R.reconcile(["keep1"]); // array, not a Set
    expect(destroyed).toEqual(["gone1"]);
    expect(killed).toEqual(["gone1"]);
    expect(R.listEntries()).toEqual(["keep1"]);
  });

  it("reconcile with everything live destroys nothing (move case)", async () => {
    const R = await load();
    R.destroyAll();
    R.ensureEntry("m1");
    expect(R.reconcile(new Set(["m1", "m2-not-yet-mounted"]))).toEqual([]);
    expect(R.getEntry("m1")).not.toBeNull();
  });

  it("destroyAll clears everything and runs hooks", async () => {
    const R = await load();
    R.destroyAll();
    R.ensureEntry("a"); R.ensureEntry("b");
    let hooks = 0;
    R.registerDestroyHook("a", () => hooks++);
    R.registerDestroyHook("b", () => hooks++);
    R.destroyAll();
    expect(hooks).toBe(2);
    expect(R.listEntries()).toEqual([]);
  });

  it("close-then-reopen same id gets a FRESH entry; counters do not leak across", async () => {
    const R = await load();
    R.destroyAll();
    const first = R.ensureEntry("r1");
    first.counters.lastCost = { tokens: 42, cost: 0.5 };
    R.reconcile(new Set()); // closed
    const second = R.ensureEntry("r1");
    expect(second).not.toBe(first);
    expect(second.counters.lastCost.tokens).toBe(0);
    expect(second.setupDone).toBe(false);
  });

  it("counters and ui pointer survive a park cycle (detach only)", async () => {
    const R = await load();
    R.destroyAll();
    const e = R.ensureEntry("k1");
    e.counters.scrollbackBytes = 999;
    e.ui = { marker: 1 };
    R.detachHost("k1");
    const again = R.ensureEntry("k1");
    expect(again.counters.scrollbackBytes).toBe(999);
    expect(again.ui.marker).toBe(1);
  });
});
