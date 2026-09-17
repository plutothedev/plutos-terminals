// (C)
// The boot restore sequence end to end, with real parsing, a real plan and a
// real mirror behind a recording transport.
//
// The rule behind the shape of this sequence is that boot NEVER ASKS: there is
// no confirm parameter to pass any more, so a boot prompt cannot be answered
// here without changing the signature. An earlier revision put
// a confirm() here to tell WebView2 profile loss apart from a Settings factory
// reset, and every defect that followed was downstream of that one modal: it
// raced the recording-recovery prompt through ConfirmProvider's single request
// slot (whichever promise lost was orphaned, so this function never returned and
// the mirror stayed suspended for the rest of the session), it rendered over the
// Welcome screen and the LockScreen, and its "Start fresh" branch wrote nothing.
// The ambiguity is gone at the source instead: factory reset now clears
// store.json too (SettingsModal.jsx), so a populated backup behind an empty blob
// can only mean profile loss.
import { describe, test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseWorkspace, layoutFingerprint } from "./workspaceBoot.js";
import { createWorkspaceMirror } from "./workspaceMirror.js";
import { runBootRecovery, READ_STORE_TIMEOUT_MS } from "./bootRecovery.js";

const BACKUP = '{"terminalsState":{"panels":[{"id":"p1","tabs":[{"id":"t1"}]}]},"uiLayout":"moba"}';

// What the two unconditional boot migrations leave in `st` by the time the async
// read_store answers (headerSkin/oledDefaultMigrated, uiLayout/mobaDefaultForced).
const MIGRATED = { headerSkin: "oled", oledDefaultMigrated: true, uiLayout: "moba", mobaDefaultForced: true };

function harness({ raw = null, store = BACKUP, state = MIGRATED, whileReading = null, discarded = null, timeoutMs, hang = false } = {}) {
  const writes = [];
  const mirror = createWorkspaceMirror((data) => writes.push(JSON.parse(data)));
  mirror.suspend(); // App suspends before the first render finishes
  let cur = state;
  const save = (updater) => { cur = typeof updater === "function" ? updater(cur) : updater; };
  const toast = { success: vi.fn(), error: vi.fn() };
  return {
    writes,
    mirror,
    toast,
    get state() { return cur; },
    run: () =>
      runBootRecovery({
        boot: parseWorkspace(raw),
        readStore: () => {
          if (whileReading) whileReading(save);
          // `hang` is the never-settling read: an IPC call that goes out and
          // never comes back, which is not the same thing as one that fails.
          if (hang) return new Promise(() => {});
          return store instanceof Error ? Promise.reject(store) : Promise.resolve(store);
        },
        mirror,
        save,
        getState: () => cur,
        toast,
        discarded,
        timeoutMs,
      }),
  };
}

describe("runBootRecovery", () => {
  test("a MISSING blob with a real backup restores silently and says so afterwards", async () => {
    // The WebView2 profile-loss case, which is what this whole mechanism exists
    // for: Chromium discards a damaged localStorage database and starts empty,
    // so profile loss arrives as an absent key, not a garbled string.
    const h = harness({ raw: null });
    expect(await h.run()).toBe("restored");
    expect(h.state.terminalsState).toEqual(JSON.parse(BACKUP).terminalsState);
    expect(h.state.oledDefaultMigrated).toBe(true); // the migrations survive the merge
    expect(h.toast.success).toHaveBeenCalled();
    expect(h.mirror.isSuspended()).toBe(false);
  });

  test("a corrupt blob adopts the backup the same way", async () => {
    const h = harness({ raw: '{"panels":[' });
    expect(await h.run()).toBe("restored");
    expect(h.state.terminalsState).toEqual(JSON.parse(BACKUP).terminalsState);
    expect(h.mirror.isSuspended()).toBe(false);
  });

  test("the restored workspace reaches store.json immediately, not 200 ms later", async () => {
    // resume() would otherwise send the deferred PRE-restore migration defaults
    // over the backup first, so the act of recovering would destroy what it
    // recovered.
    const h = harness({ raw: null });
    h.mirror.write(MIGRATED); // the migrations' flush, mid-hold
    await h.run();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].terminalsState).toEqual(JSON.parse(BACKUP).terminalsState);
  });

  test("the restore merges onto the LATEST state, not the one captured at entry", async () => {
    // Invariant 3. The merge lands after an await, so a captured-state spread
    // would revert whatever the boot migrations committed while read_store was
    // still in flight.
    const h = harness({
      raw: null,
      state: {},
      whileReading: (save) => save((prev) => ({ ...prev, ...MIGRATED })),
    });
    await h.run();
    expect(h.state.oledDefaultMigrated).toBe(true); // committed mid-flight, still here
    expect(h.state.terminalsState).toEqual(JSON.parse(BACKUP).terminalsState);
  });

  test("a genuine first run is silent and fast, and releases the mirror", async () => {
    const h = harness({ raw: null, store: "null" });
    expect(await h.run()).toBe("none");
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.mirror.isSuspended()).toBe(false);
  });

  test("a write deferred during the hold reaches store.json when the hold lifts", async () => {
    // The gap C2 exists to close: read_store outruns the 200 ms debounce on a
    // slow first launch, flushNow consumes pendingRef, and the mirror gate drops
    // the value with nothing to re-queue it. A new install left resident in the
    // tray then has no durable copy at all.
    const h = harness({ raw: null, store: "null" });
    h.mirror.write(MIGRATED);
    expect(h.writes).toEqual([]);
    await h.run();
    expect(h.writes).toEqual([MIGRATED]);
  });

  test("a corrupt blob with no backup tells the user instead of pretending", async () => {
    const h = harness({ raw: '{"panels":[', store: "null" });
    expect(await h.run()).toBe("notice");
    expect(h.toast.error).toHaveBeenCalled();
    expect(h.mirror.isSuspended()).toBe(false);
  });

  test("an unreadable backup is treated as no backup, and never throws out of boot", async () => {
    const h = harness({ raw: null, store: new Error("IPC down") });
    await expect(h.run()).resolves.toBe("none");
    expect(h.mirror.isSuspended()).toBe(false);
  });

  test("the mirror is released on EVERY path, which is what keeps the backup alive", async () => {
    // The failure this replaces: the boot prompt and the recording-recovery
    // prompt both went through ConfirmProvider's single `request` slot, so the
    // loser's promise was never resolved, this function never returned, and the
    // app ran the rest of the session with its durable backup suspended. No
    // layout change reached store.json again until a restart.
    for (const args of [
      { raw: null },                                // restore
      { raw: '{"panels":[' },                       // adopt a corrupt boot
      { raw: null, store: "null" },                 // first run
      { raw: '{"panels":[', store: "null" },        // notice
      { raw: null, store: new Error("IPC down") },  // read failed
      { raw: null, store: "{}" },                   // backup file exists but is empty
    ]) {
      const h = harness(args);
      await h.run();
      expect(h.mirror.isSuspended()).toBe(false);
    }
  });

  test("nothing is written to store.json on the paths that recover nothing", async () => {
    // The old "none" branch cleared a pending-offer marker with a save() and let
    // the resulting blob ride out to store.json. There is no marker any more, so
    // the only thing that reaches disk here is whatever the app itself deferred.
    for (const args of [{ raw: null, store: "null" }, { raw: '{"panels":[', store: "null" }]) {
      const h = harness(args);
      await h.run();
      expect(h.writes).toEqual([]);
      expect(h.state).toEqual(MIGRATED);
    }
  });
});

describe("runBootRecovery after a deliberate discard", () => {
  // "Reset layout & reload" (ErrorBoundary) fingerprints the layout it throws
  // away and boot carries that mark in. It used to carry a bare boolean that
  // suppressed the backup read outright, which meant the migrations' first flush
  // put their defaults into store.json ~200 ms later: the crash hatch took the
  // durable backup with it.
  test("the layout that crashed is not restored back over the reset", async () => {
    const h = harness({ raw: null, discarded: layoutFingerprint(BACKUP) });
    expect(await h.run()).toBe("skipped");
    expect(h.state).toEqual(MIGRATED);                 // nothing merged in
    expect(h.toast.success).not.toHaveBeenCalled();    // the user asked for this
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);                      // nothing forced to disk
    expect(h.mirror.isSuspended()).toBe(false);
  });

  test("a backup holding a DIFFERENT layout is still restored", async () => {
    // The whole point of naming the discarded layout instead of banning
    // recovery: a crash can beat the 200 ms debounce, so store.json can still
    // hold the last good workspace while only localStorage ever saw the poison.
    const older = '{"terminalsState":{"panels":[{"id":"older"}]},"uiLayout":"moba"}';
    const h = harness({ raw: null, store: older, discarded: layoutFingerprint(BACKUP) });
    expect(await h.run()).toBe("restored");
    expect(h.state.terminalsState).toEqual(JSON.parse(older).terminalsState);
    expect(h.mirror.isSuspended()).toBe(false);
  });

  test("the skip path still releases the mirror", async () => {
    const h = harness({ raw: null, discarded: layoutFingerprint(BACKUP) });
    h.mirror.write(MIGRATED);     // the migrations' flush, mid-hold
    await h.run();
    expect(h.mirror.isSuspended()).toBe(false);
    expect(h.writes).toEqual([MIGRATED]); // deferred, then sent: still backed up
  });
});

describe("runBootRecovery when read_store never answers", () => {
  test("a hung read is bounded, and the mirror is released anyway", async () => {
    // Same end state as the confirm() deadlock this file already documents: a
    // promise that never settles leaves the mirror suspended for the rest of the
    // session, which is a silently disabled backup. IPC has no timeout of its
    // own, so the bound belongs here.
    const h = harness({ raw: null, hang: true, timeoutMs: 5 });
    expect(await h.run()).toBe("none");
    expect(h.mirror.isSuspended()).toBe(false);
  }, 2000);

  test("the bound applies when the caller passes no timeout, which App.jsx does not", async () => {
    // The production path takes the default, so a default that stopped being
    // applied would leave every real boot unbounded with the suite still green.
    vi.useFakeTimers();
    try {
      const h = harness({ raw: null, hang: true });
      const done = h.run();
      await vi.advanceTimersByTimeAsync(READ_STORE_TIMEOUT_MS);
      expect(await done).toBe("none");
      expect(h.mirror.isSuspended()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a hung read still keeps whatever the app deferred during the hold", async () => {
    const h = harness({ raw: null, hang: true, timeoutMs: 5 });
    h.mirror.write(MIGRATED);
    await h.run();
    expect(h.writes).toEqual([MIGRATED]);
  }, 2000);
});

// The wiring, not just the sequence. Everything above exercises runBootRecovery
// in isolation, so the entire invocation could be deleted from App.jsx with this
// file still green, and boot recovery that is never called looks exactly like
// boot recovery that found nothing. These read the SHIPPED App.jsx the same way
// releaseWorkflow.test.js reads the shipped workflow, and the mutation test at
// the bottom is what keeps them falsifiable.
const APP_SRC = readFileSync(fileURLToPath(new URL("../../App.jsx", import.meta.url)), "utf8");

function checkWiring(src) {
  // The call exists, exactly once, and is the real import.
  expect(src).toMatch(/import \{ runBootRecovery \} from "\.\/features\/terminals\/bootRecovery\.js";/);
  expect((src.match(/\brunBootRecovery\(/g) || []).length).toBe(1);
  // It is handed the collaborators it cannot work without.
  expect(src).toMatch(/readStore:\s*\(\)\s*=>\s*invoke\("read_store"\)/);
  expect(src).toMatch(/mirror:\s*mirrorRef\.current/);
  expect(src).toMatch(/discarded:\s*DISCARDED_LAYOUT/);
  // The read is gated on an empty boot in the PRIMARY window, and that same
  // branch holds the mirror: reading without the hold lets the boot migrations
  // mirror their defaults over the backup before it is read.
  expect(src).toMatch(/needsBackupRead\(boot\)\s*&&\s*isPrimaryWindow\(\)/);
  expect(src).toMatch(/mirrorRef\.current\.suspend\(\)/);
  // The discard mark names one layout now; the old boolean suppressed the read
  // (and therefore the hold) for the whole boot.
  expect(src).not.toMatch(/LAYOUT_WAS_DISCARDED/);
  expect(src).toMatch(/const DISCARDED_LAYOUT = takeDiscardedLayout\(\);/);
}

describe("App.jsx boot wiring", () => {
  test("boot actually calls the recovery sequence, gated and held", () => {
    checkWiring(APP_SRC);
  });

  test("the wiring check fails when the call is deleted", () => {
    // A guard nobody can break is decoration. Mutate the source text in memory
    // (never the file) and prove the assertions above go red.
    expect(() => checkWiring(APP_SRC.replace("await runBootRecovery(", "await noop("))).toThrow();
  });

  test("the wiring check fails when the discard mark is dropped", () => {
    expect(() => checkWiring(APP_SRC.replace("discarded: DISCARDED_LAYOUT", "discarded: null"))).toThrow();
  });

  test("the debounced flush stops writing once local state has been wiped", () => {
    // Factory reset (SettingsModal) clears both copies and reloads, but the
    // reload fires pagehide/beforeunload FIRST and this window's flush still
    // holds the last debounced layout, which would repopulate localStorage AND
    // store.json behind the reset that just cleared them.
    expect(APP_SRC).toMatch(/localWriteHolds\(\)\s*>\s*0/);
    expect(() => {
      const src = APP_SRC.replace(/if \(localWriteHolds\(\) > 0\)[^\n]*\n/, "");
      expect(src).toMatch(/localWriteHolds\(\)\s*>\s*0/);
    }).toThrow();
  });
});
