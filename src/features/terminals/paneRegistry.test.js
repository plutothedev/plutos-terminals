// (C)
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    // P4-T5 boot stagger: entries are born UNSPAWNED (spawn requested later
    // by visibility/trickle via startSpawn), no longer auto-"starting".
    expect(a.spawnState).toBe("unspawned");
    // The BODY slot is empty until TerminalPane's first mount fills it; the
    // LATCH is the registry's own and exists from birth.
    expect(a.spawnBody).toBe(null);
    expect(typeof a.startSpawn).toBe("function");
    expect(typeof a.host.appendChild).toBe("function");
  });

  // The latch group below drives paneRegistry's OWN latch. These used to
  // assign a hand-written copy of it onto the entry and assert on that, so
  // they passed no matter what the module did (audit TQ-3). Never
  // re-introduce a local `e.startSpawn = () => ...`: register a BODY and let
  // the module decide whether to run it. The last two in the group come at
  // the same failure from outside the behaviour, because behaviour alone
  // cannot see a latch that was replaced rather than broken.
  it("startSpawn latch: the first caller wins, later callers no-op (P4-T5)", async () => {
    const R = await load();
    R.destroyAll();
    const e = R.ensureEntry("p-latch");
    let fired = 0;
    e.spawnBody = () => { fired++; };
    expect(e.startSpawn()).toBe(true); // reveal
    expect(e.startSpawn()).toBe(false); // trickle arriving late
    expect(e.startSpawn()).toBe(false); // second reveal
    expect(fired).toBe(1);
    expect(e.spawnState).toBe("starting");
  });

  it("startSpawn flips to starting BEFORE running the body, so an async body cannot be entered twice", async () => {
    const R = await load();
    R.destroyAll();
    const e = R.ensureEntry("p-async");
    // The real body awaits replayScrollback before it touches anything. If
    // the state flip ever moves inside the async part, the second caller in
    // the same frame passes the "unspawned" check and the pane gets a second
    // PTY. Both facts are asserted: what the body SEES on entry, and how many
    // times it is entered when two callers race in one tick.
    const seenOnEntry = [];
    let entered = 0;
    e.spawnBody = async () => {
      entered++;
      seenOnEntry.push(e.spawnState);
      await Promise.resolve();
    };
    e.startSpawn(); // TerminalPane's [visible] reveal
    e.startSpawn(); // the trickle tick, same frame
    expect(entered).toBe(1);
    expect(seenOnEntry).toEqual(["starting"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(entered).toBe(1); // still one after the body's await resolves
  });

  it("startSpawn with no body registered does NOT latch, so a later tick still spawns", async () => {
    const R = await load();
    R.destroyAll();
    // A trickle tick can reach an entry that exists (ensureEntry ran) before
    // TerminalPane's mount effect has registered the body. Latching there
    // would strand the pane unspawned forever.
    const e = R.ensureEntry("p-nobody");
    expect(e.startSpawn()).toBe(false);
    expect(e.spawnState).toBe("unspawned");
    let fired = 0;
    e.spawnBody = () => { fired++; };
    expect(e.startSpawn()).toBe(true);
    expect(fired).toBe(1);
  });

  it("startSpawn on an already-live entry never re-runs the body", async () => {
    const R = await load();
    R.destroyAll();
    const e = R.ensureEntry("p-live");
    let fired = 0;
    e.spawnBody = () => { fired++; };
    e.spawnState = "live"; // the spawn body sets this once the PTY exists
    expect(e.startSpawn()).toBe(false);
    expect(fired).toBe(0);
    expect(e.spawnState).toBe("live");
  });

  it("the latch is not replaceable: assigning over startSpawn throws instead of silently disarming it", async () => {
    const R = await load();
    R.destroyAll();
    const e = R.ensureEntry("p-lock");
    // A plain data property here is what made the whole fix hinge on one
    // untestable token: writing `entry.startSpawn = fn` where
    // `entry.spawnBody = fn` was meant would replace the latch, succeed
    // silently, and leave the pane able to spawn twice. Locked, that slip is
    // a TypeError at mount (strict-mode ESM never drops a write to a
    // non-writable own property) instead of a shipped double-spawn.
    const d = Object.getOwnPropertyDescriptor(e, "startSpawn");
    expect(d.writable).toBe(false);
    expect(d.configurable).toBe(false);
    expect(d.enumerable).toBe(true); // same shape the plain assignment had
    let fired = 0;
    expect(() => { e.startSpawn = () => { fired++; }; }).toThrow(TypeError);
    // configurable:false also closes the redefine route around the write.
    expect(() => Object.defineProperty(e, "startSpawn", { value: () => { fired++; } })).toThrow(TypeError);
    // The module's own latch is untouched and still latches.
    e.spawnBody = () => { fired++; };
    expect(e.startSpawn()).toBe(true);
    expect(e.startSpawn()).toBe(false);
    expect(fired).toBe(1);
  });

  // The registry owns the latch, but ONE line in TerminalPane.jsx decides
  // whether that latch is USED (register a body) or REPLACED (assign over
  // startSpawn), and no test can import that file: 2,185 lines of xterm +
  // Tauri + React side effects, and the vitest include glob reaches no
  // mutation confined to it. So pin the wiring from the source text, the way
  // commands.rs's reserved_names_match_js_mirror include_str!-pins
  // notebookIo.js's RESERVED_NAMES across the language boundary. Same idea,
  // same language.
  it("TerminalPane registers a spawn BODY exactly once and never assigns over the registry's latch", () => {
    const PANE_SRC = fileURLToPath(new URL("./TerminalPane.jsx", import.meta.url));
    // Comment-only lines are stripped first: prose that names the forbidden
    // token (the "do NOT re-add a guard here" warning that sits at the
    // registration site is exactly that) is documentation, not wiring.
    const code = readFileSync(PANE_SRC, "utf8").replace(/^[ \t]*\/\/.*/gm, "");
    expect(code.match(/entry\.spawnBody\s*=[^=]/g) ?? []).toHaveLength(1);
    // Any `<obj>.startSpawn = ...` in that file is the latch being overwritten
    // by a private copy. Calls are the intended use and do not match.
    expect(code.match(/\.startSpawn\s*=[^=]/g) ?? []).toEqual([]);
    // Both real callers must still be wired, so this cannot pass by the spawn
    // path having been deleted wholesale: the [visible] first-reveal effect
    // and the mount effect's at-boot-visible fire.
    expect(code).toMatch(/entry\.startSpawn\(\)/);
    expect(code).toMatch(/entryRef\.current\?\.startSpawn\?\.\(\)/);
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

  it("reentrancy: a destroy hook re-creating the same id mid-teardown yields a FRESH entry that survives", async () => {
    const R = await load();
    R.destroyAll();
    const doomed = R.ensureEntry("z1");
    let duringTeardown = null;
    let fresh = null;
    let reentered = false;
    R.registerDestroyHook("z1", () => {
      if (reentered) return; // the nested destroy below re-runs this hook once
      reentered = true;
      // Mid-teardown the dying entry is STILL mapped — a bare ensureEntry
      // returns it, not a fresh one (pinned below, outside the hook, because
      // destroyEntry's per-hook try/catch would swallow a failing expect):
      duringTeardown = R.ensureEntry("z1");
      // A reentrant close-then-reopen (destroy → ensure) is what mints the
      // fresh replacement under the same id while the outer teardown is
      // still unwinding:
      R.destroyEntry("z1");
      fresh = R.ensureEntry("z1");
    });
    R.destroyEntry("z1");
    expect(duringTeardown).toBe(doomed);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(doomed);
    // The delete-by-identity guard in destroyEntry must NOT wipe the hook's
    // replacement out of the map: after the outer destroy returns, getEntry
    // yields the FRESH entry — not null.
    expect(R.getEntry("z1")).toBe(fresh);
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
