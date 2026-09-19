// (C)
// The boot scrollback sweep, and the ORDER it has to run in.
//
// The defect this file exists for: the sweep was scheduled on an idle callback
// at boot while boot recovery was still awaiting read_store. allOpenTabIds()
// builds its keep-list from localStorage alone and skips a blob it cannot
// parse, so a discarded/corrupt WebView2 profile yields an EMPTY keep-list —
// and an empty keep-list does not mean "keep everything", it means "keep
// nothing", so every scrollback file past the 30-day floor was unlinked. The
// backup then restored those panes, with their ids, and no history. The floor
// is a weaker bound than it reads: a rotated `.old.txt` segment keeps its
// rotation mtime, and merely loading a tab never touches the file, so after a
// month away every restored tab is eligible.
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  runBootSweep,
  BOOT_SETTLE_TIMEOUT_MS,
  REFUSED_EMPTY,
  REFUSED_INCOMPLETE,
  REFUSED_UNREADABLE,
} from "./diskGc.js";

// A promise plus its resolvers, so a test can hold recovery open across awaits.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // a test that rejects must not trip unhandled-rejection
  return { promise, resolve, reject };
}

// Let every already-queued microtask (and the timer-free part of the helper)
// run, without advancing real time.
const settle = () => new Promise((r) => setTimeout(r, 0));

// The collaborators, recording their call order. `flush` mutates what `harvest`
// returns, which is the whole point: if harvest runs first it sees the EMPTY
// pre-flush list, which is exactly the boot bug.
function harness({ ids = ["pane_a"], flushed = null, complete = true } = {}) {
  const order = [];
  let visible = flushed === null ? ids : [];
  return {
    order,
    invoke: vi.fn((cmd, args) => { order.push(`invoke:${cmd}`); return Promise.resolve(args); }),
    flush: vi.fn(() => { order.push("flush"); visible = flushed === null ? ids : flushed; }),
    harvest: vi.fn(() => { order.push("harvest"); return { ids: visible, complete }; }),
  };
}

describe("runBootSweep: ordering", () => {
  test("does not sweep while boot recovery is unsettled, and sweeps once it resolves", async () => {
    const h = harness();
    const rec = deferred();
    let done = false;
    const run = runBootSweep({ bootSettled: rec.promise, ...h }).then((r) => { done = true; return r; });

    await settle();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.harvest).not.toHaveBeenCalled(); // the keep-list must not be read yet either
    expect(done).toBe(false);

    rec.resolve("restored");
    const result = await run;
    expect(done).toBe(true);
    expect(h.invoke).toHaveBeenCalledWith("scrollback_sweep", { keepTabIds: ["pane_a"] });
    expect(result).toBe(true);
  });

  test("harvests the keep-list AFTER flushing the pending layout write", async () => {
    // A restored backup lands in state via save(), which only ARMS the 200 ms
    // debounce. Harvesting before that debounce lands reads a localStorage that
    // still holds the unusable boot blob: the restored panes are invisible and
    // their files look abandoned.
    const h = harness({ ids: ["pane_restored"], flushed: ["pane_restored"] });
    const rec = deferred();
    const run = runBootSweep({ bootSettled: rec.promise, ...h });
    rec.resolve();
    await run;

    expect(h.order).toEqual(["flush", "harvest", "invoke:scrollback_sweep"]);
    expect(h.invoke).toHaveBeenCalledWith("scrollback_sweep", { keepTabIds: ["pane_restored"] });
  });
});

describe("runBootSweep: the empty keep-list is a refusal", () => {
  // Every refusal warns by default, so the default path is exercised here (not
  // stubbed out) and merely kept off the suite's stderr.
  let warn;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  test("an empty keep-list invokes nothing at all", async () => {
    const h = harness({ ids: [] });
    const result = await runBootSweep({ bootSettled: null, ...h });
    expect(h.harvest).toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  test("an INCOMPLETE keep-list refuses even though it is not empty", async () => {
    // Review F2, and the reason this whole follow-up exists. The empty-list
    // guard above was quietly standing in for "the layout was unreadable", and
    // that only holds with ONE window open. With two, a lost or corrupt PRIMARY
    // blob plus an intact secondary yields a NON-EMPTY list: nothing refuses,
    // and the sweep unlinks the primary's aged scrollback while boot recovery is
    // restoring those very panes. Length was never the signal; completeness is.
    const h = harness({ ids: ["pane_from_window_two"], complete: false });
    const result = await runBootSweep({ bootSettled: null, ...h });
    expect(h.harvest).toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  test("a harvest that never CLAIMS completeness is treated as incomplete", async () => {
    // Silence is not consent on a path that unlinks history. A hand-rolled
    // { ids } harvest is a plausible future caller and must not sweep.
    const invoke = vi.fn();
    const reasons = [];
    const result = await runBootSweep({
      invoke, flush: vi.fn(), harvest: () => ({ ids: ["pane_a"] }), onRefuse: (r) => reasons.push(r),
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(result).toBe(false);
    expect(reasons).toEqual([REFUSED_INCOMPLETE]);
  });

  test("the three refusals are DISTINGUISHABLE, and none of them is silent", async () => {
    // The boolean result cannot tell "nothing is open" from "a window's layout
    // was unreadable", and only the second is a bug worth chasing in a log.
    const reasons = [];
    const onRefuse = (r) => reasons.push(r);
    await runBootSweep({ ...harness({ ids: [] }), onRefuse });
    await runBootSweep({ ...harness({ ids: ["p"], complete: false }), onRefuse });
    // A BARE ARRAY is the old allOpenTabIds harvest wired back in. It fails
    // closed rather than sweeping unguarded, which is the whole point.
    await runBootSweep({ invoke: vi.fn(), flush: vi.fn(), harvest: () => ["p"], onRefuse });
    expect(reasons).toEqual([REFUSED_EMPTY, REFUSED_INCOMPLETE, REFUSED_UNREADABLE]);
    expect(new Set(reasons).size).toBe(3);

    // And with no onRefuse injected, the default still leaves a trace.
    await runBootSweep({ ...harness({ ids: ["p"], complete: false }) });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(REFUSED_INCOMPLETE));
  });

  test("a harvest that throws or returns a non-array also refuses", async () => {
    const boom = { invoke: vi.fn(), flush: vi.fn(), harvest: vi.fn(() => { throw new Error("storage gone"); }) };
    await expect(runBootSweep({ bootSettled: null, ...boom })).resolves.toBe(false);
    expect(boom.invoke).not.toHaveBeenCalled();

    const junk = { invoke: vi.fn(), flush: vi.fn(), harvest: vi.fn(() => undefined) };
    await expect(runBootSweep({ bootSettled: null, ...junk })).resolves.toBe(false);
    expect(junk.invoke).not.toHaveBeenCalled();
  });
});

describe("runBootSweep: recovery outcomes", () => {
  test("a REJECTED recovery still sweeps (a failed restore must not disable GC forever)", async () => {
    const h = harness();
    const rec = deferred();
    const run = runBootSweep({ bootSettled: rec.promise, ...h });
    rec.reject(new Error("read_store did not answer"));
    await expect(run).resolves.toBe(true);
    expect(h.order).toEqual(["flush", "harvest", "invoke:scrollback_sweep"]);
  });

  test("no recovery promise at all (the layout was readable) still sweeps", async () => {
    const h = harness();
    await expect(runBootSweep({ bootSettled: null, ...h })).resolves.toBe(true);
    expect(h.order).toEqual(["flush", "harvest", "invoke:scrollback_sweep"]);
    // Same for the daily re-run, where the boot promise is long gone.
    const h2 = harness();
    await expect(runBootSweep({ ...h2 })).resolves.toBe(true);
  });

  test("a recovery that NEVER settles does not wedge the sweep forever", async () => {
    // Bounded on purpose: everything downstream of this await is the only GC
    // this app gets, and the app lives in the tray for weeks. The bound sits
    // above bootRecovery's own 10 s read_store timeout so the normal timeout
    // path always settles first and this never races it.
    expect(BOOT_SETTLE_TIMEOUT_MS).toBeGreaterThan(10_000);
    const h = harness();
    const never = new Promise(() => {});
    await expect(runBootSweep({ bootSettled: never, timeoutMs: 5, ...h })).resolves.toBe(true);
    expect(h.order).toEqual(["flush", "harvest", "invoke:scrollback_sweep"]);
  });

  test("a flush that throws does not stop the sweep", async () => {
    const h = harness();
    h.flush = vi.fn(() => { h.order.push("flush"); throw new Error("quota"); });
    await expect(runBootSweep({ bootSettled: null, ...h })).resolves.toBe(true);
    expect(h.invoke).toHaveBeenCalledWith("scrollback_sweep", { keepTabIds: ["pane_a"] });
  });
});

// ── App.jsx wiring ────────────────────────────────────────────────
// Guard tests over the shipped App.jsx text, in the style of
// releaseWorkflow.test.js. Comments are STRIPPED before matching: the effect
// and the recovery block both discuss this ordering in prose, and a wiring
// assertion that a comment can satisfy is not a wiring assertion. A reviewer on
// this batch already caught two of those passing with the code deleted.
const APP_SRC = readFileSync(fileURLToPath(new URL("../../App.jsx", import.meta.url)), "utf8");

// Strip ALL comments — block, whole-line AND TRAILING — so every assertion below
// runs against statements only.
//
// The trailing half is review F1, and it was not hypothetical: the old stripper
// dropped `^\s*//` lines only, so deleting a real call and leaving `foo(); //
// harvest: allOpenTabIds` behind satisfied the whole assertion set. The reviewer
// demonstrated it. A guard test that a comment can satisfy is not a guard test.
//
// Scanning rather than regexing, because `//` inside a string literal ("https://
// …") is not a comment and a line-wise regex cannot tell the difference. Quotes
// (' " `) and backslash escapes are tracked; the template-literal body is kept
// whole, so a `//` inside `${…}` survives too.
//
// KNOWN LIMIT: regex literals are not tracked, so a literal like /\/\// would be
// read as the start of a comment. App.jsx contains no regex literals and no URL
// strings today, and both assertions would go RED (not silently green) if one
// appeared, so the limit fails in the safe direction.
function code(src) {
  let out = "";
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += next ?? ""; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; continue; }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n"; // keep the line structure the assertions read
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++; // the loop's i++ consumes the closing slash
      continue;
    }
    out += c;
  }
  return out;
}

function checkWiring(src) {
  const js = code(src);
  // The helper is imported and called, and the raw invoke is gone from the GC
  // path: a second call site would restore the unordered sweep.
  expect(js).toMatch(/import \{ runBootSweep \} from "\.\/features\/terminals\/diskGc\.js";/);
  expect((js.match(/\brunBootSweep\(\{/g) || []).length).toBe(1);
  expect(js).not.toMatch(/invoke\("scrollback_sweep"/);
  // It is handed the recovery promise to await, the flush, and the harvest.
  expect(js).toMatch(/bootSettled:\s*recoveryDoneRef\.current/);
  expect(js).toMatch(/flush:\s*flushNowRef\.current/);
  // The COMPLETENESS-reporting harvest, not the plain-array one (review F2).
  // allOpenTabIds() cannot tell the caller that a window's blob was skipped, and
  // runBootSweep refuses anything that is not { ids, complete }.
  expect(js).toMatch(/harvest:\s*harvestKeepList/);
  expect(js).toMatch(/import \{[^}]*\bharvestKeepList\b[^}]*\} from "\.\/features\/terminals\/storageKeys\.js";/);
  // The recovery effect actually PUBLISHES its promise, or the line above is
  // awaiting a ref that is null forever.
  expect(js).toMatch(/recoveryDoneRef\.current\s*=\s*\(async \(\) => \{/);
  // Idle scheduling + its cleanup survive the lift.
  expect(js).toMatch(/const idle = rIC\(sweep, \{ timeout: 10_000 \}\);/);
  expect(js).toMatch(/\(window\.cancelIdleCallback \?\? clearTimeout\)\(idle\);/);
  // The ref is actually kept current, or `flush` above is the boot-time flushNow
  // forever.
  expect(js).toMatch(/flushNowRef\.current\s*=\s*flushNow;/);
  // And the effect's dep array is EMPTY (review F4): a dep that re-mints would
  // re-arm the idle sweep and restart the 24 h interval from zero every time,
  // so the daily GC would never reach its own deadline.
  const sweepEffect = js.slice(js.indexOf("const sweep = () => {"));
  expect(sweepEffect).toMatch(/clearInterval\(id\);\s*\};\s*\}, \[\]\);/);
}

describe("the comment stripper the wiring checks depend on", () => {
  test("drops TRAILING comments, not just whole-line ones (review F1)", () => {
    // The defeat the reviewer demonstrated: delete the real call, leave the
    // expected text in a trailing comment, and a line-wise stripper hands you a
    // green wiring suite over deleted code.
    const js = code('doSomethingElse(); // harvest: harvestKeepList\n');
    expect(js).not.toMatch(/harvest:\s*harvestKeepList/);
    expect(js).toMatch(/doSomethingElse\(\);/);
  });

  test("keeps whole-line and block comments out, and code in", () => {
    expect(code("  // gone\nkept1;\n/* also\n gone */\nkept2;")).not.toMatch(/gone/);
    expect(code("  // gone\nkept1;\n/* also\n gone */\nkept2;")).toMatch(/kept1;[\s\S]*kept2;/);
  });

  test("a `//` INSIDE a string literal is not a comment", () => {
    // App.jsx has no such string today, but a stripper that truncated at one
    // would silently delete the rest of the line and turn a real wiring
    // assertion red (or, worse, hide the statement that follows it).
    expect(code('const u = "https://x.dev/y"; // real comment\n')).toBe('const u = "https://x.dev/y"; \n');
    expect(code("const s = 'a // b';")).toBe("const s = 'a // b';");
    // Assembled, not written literally, so this file's own source does not
    // contain a "${" inside a plain string (no-template-curly-in-string).
    const tpl = "const t = `x $" + "{o[\"//\"]} y`;";
    expect(code(tpl)).toBe(tpl);
    expect(code('const e = "\\" // still in the string";')).toBe('const e = "\\" // still in the string";');
  });
});

describe("App.jsx: the boot sweep goes through diskGc", () => {
  test("wired: ordered behind recovery, flushed, harvested", () => {
    checkWiring(APP_SRC);
  });

  test("the wiring check fails when the helper call is removed", () => {
    // Mutate the source in memory (never the file) and prove it goes red.
    expect(() => checkWiring(APP_SRC.replace(
      /runBootSweep\(\{[\s\S]*?\}\)/,
      'invoke("scrollback_sweep", { keepTabIds: allOpenTabIds() })',
    ))).toThrow();
  });

  test("the wiring check fails when the recovery promise is no longer awaited", () => {
    expect(() => checkWiring(APP_SRC.replace("bootSettled: recoveryDoneRef.current", "bootSettled: null")))
      .toThrow();
  });

  test("the wiring check fails when the recovery effect stops publishing its promise", () => {
    expect(() => checkWiring(APP_SRC.replace("recoveryDoneRef.current = (async () => {", "void (async () => {")))
      .toThrow();
  });
});
