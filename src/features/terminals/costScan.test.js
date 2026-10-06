// (C)
import { describe, it, expect } from "vitest";
import { buildScanWindow, detectModel, evictScanChunks, reconcileCost, resolveModel } from "./costScan";

// These test the REAL functions TerminalPane imports. There is no second copy
// of the scan-window assembly, the chunk eviction, the family detector or the
// cost reconciliation anywhere in the app: TerminalPane.jsx calls all four
// directly (appendScrollback -> evictScanChunks, checkCost -> the rest), so a
// regression in any of them shows up here.

describe("buildScanWindow", () => {
  it("returns empty string for no chunks", () => {
    expect(buildScanWindow([], 10)).toBe("");
    expect(buildScanWindow(null, 10)).toBe("");
    expect(buildScanWindow(undefined, 10)).toBe("");
  });

  it("returns every chunk, in original order, when they all fit the budget", () => {
    expect(buildScanWindow(["A", "B", "C", "D"], 100)).toBe("ABCD");
  });

  it("keeps the NEWEST chunks and returns them oldest-first", () => {
    // Walks backwards from D, so a budget of 2 collects [D, C], but the caller
    // scans the result as text, so it must come back as "CD", not "DC". This is
    // the assertion that fails if the push-then-reverse loses its reverse.
    expect(buildScanWindow(["A", "B", "C", "D"], 2)).toBe("CD");
    expect(buildScanWindow(["A", "B", "C", "D"], 3)).toBe("BCD");
  });

  it("stops on >= budget, and the chunk that crosses it lands whole", () => {
    // 5-char chunk against a 3-char budget: the window overshoots rather than
    // slicing a chunk in half (slicing could cut an escape sequence or a
    // "Total cost: $" line apart, which is the whole reason it is chunk-wise).
    expect(buildScanWindow(["xxxxx", "yyyyy"], 3)).toBe("yyyyy");
    // Exactly hitting the budget must still stop, not take one more chunk.
    expect(buildScanWindow(["aa", "bb", "cc"], 4)).toBe("bbcc");
  });

  it("takes only the last chunk for a zero budget", () => {
    expect(buildScanWindow(["A", "B", "C"], 0)).toBe("C");
  });

  it("preserves order across a long chunk list", () => {
    // 500 one-char chunks, budget 10. Oracle is Array.slice + join, which is a
    // different mechanism from the reverse-accumulator under test.
    const chunks = Array.from({ length: 500 }, (_, i) => String.fromCharCode(97 + (i % 26)));
    expect(buildScanWindow(chunks, 10)).toBe(chunks.slice(-10).join(""));
  });

  it("handles a single chunk larger than the whole budget", () => {
    expect(buildScanWindow(["the entire 10KB window in one chunk"], 5))
      .toBe("the entire 10KB window in one chunk");
  });
});

describe("detectModel", () => {
  it("returns null when the text names no model", () => {
    // THE PERF-2 fix. This used to return "opus", which made a non-detection
    // indistinguishable from a detection and pinned every session to Opus
    // rates on the shell's own first prompt output.
    expect(detectModel("PS C:\\Users\\pluto> ")).toBe(null);
    expect(detectModel("michael@box:~/code$ npm test")).toBe(null);
    expect(detectModel("")).toBe(null);
    expect(detectModel(null)).toBe(null);
  });

  it("reads the friendly banner form", () => {
    expect(detectModel("Opus 4.7 (1M context) with high effort")).toBe("opus 4.7");
    expect(detectModel("Sonnet 4.5 (1M context) \u00b7 Claude Max")).toBe("sonnet 4.5");
    expect(detectModel("Haiku 4 \u00b7 ready")).toBe("haiku 4.0");
  });

  it("reads the API form printed in /cost output", () => {
    expect(detectModel("claude-sonnet-4-5: 12,345 input, 6,789 output")).toBe("sonnet 4.5");
    expect(detectModel("claude-opus-4-5: 100 input, 20 output")).toBe("opus 4.5");
    expect(detectModel("claude-haiku-4-5: 100 input, 20 output")).toBe("haiku 4.5");
  });

  it("is case-insensitive", () => {
    expect(detectModel("CLAUDE-OPUS-4-5")).toBe("opus 4.5");
    expect(detectModel("SONNET 4.5")).toBe("sonnet 4.5");
  });

  it("reads the version, which the price depends on", () => {
    // Opus 5.5 costs about a quarter of Opus 4.1 (modelRates.js).
    expect(detectModel("Opus 5.5 (1M context) with medium effort")).toBe("opus 5.5");
    expect(detectModel("claude-opus-5-5: 100 input, 20 output")).toBe("opus 5.5");
    expect(detectModel("claude-opus-5: 100 input")).toBe("opus 5.0");
    expect(detectModel("claude-opus-4-1-20250805: 100 input")).toBe("opus 4.1");
    expect(detectModel("claude-haiku-4-5-20251001: 100 input")).toBe("haiku 4.5");
    expect(detectModel("claude-sonnet-5-5")).toBe("sonnet 5.5");
  });

  it("does not read a dated id's date as its minor version", () => {
    expect(detectModel("claude-opus-4-20250514: 100 input")).toBe("opus 4.0");
    expect(detectModel("claude-sonnet-4-20250514")).toBe("sonnet 4.0");
  });

  it("reads a dot between the major and minor version, as OpenRouter and LiteLLM write ids", () => {
    expect(detectModel("anthropic/claude-opus-4.5: 100 input")).toBe("opus 4.5");
    expect(detectModel("claude-opus-5.5")).toBe("opus 5.5");
    expect(detectModel("claude-fable-5.1")).toBe("fable 5.1");
    expect(detectModel("claude-haiku-4.5")).toBe("haiku 4.5");
  });

  it("reads the Claude 3 naming, version first", () => {
    expect(detectModel("claude-3-7-sonnet-20250219: 100 input, 20 output")).toBe("sonnet 3.7");
    expect(detectModel("claude-3-5-haiku-20241022")).toBe("haiku 3.5");
    expect(detectModel("claude-3-opus-20240229")).toBe("opus 3.0");
    expect(detectModel("anthropic/claude-3.5-sonnet")).toBe("sonnet 3.5");
    expect(detectModel("claude-3.7-sonnet:thinking")).toBe("sonnet 3.7");
  });

  it("knows Fable and Mythos, in both forms", () => {
    expect(detectModel("Fable 5.1 (1M context)")).toBe("fable 5.1");
    expect(detectModel("claude-fable-5-1: 100 input, 20 output")).toBe("fable 5.1");
    expect(detectModel("Mythos 5.1")).toBe("mythos 5.1");
    expect(detectModel("claude-mythos-5")).toBe("mythos 5.0");
  });

  it("reports a bare family when the text gives no version", () => {
    expect(detectModel("model: claude-opus")).toBe("opus");
  });

  it("does not read a year after a family name as its version", () => {
    // A version is one or two digits; "Opus 2026" is prose, not Opus 20.
    expect(detectModel("the Opus 2026 roadmap")).toBe(null);
    expect(detectModel("Sonnet 1999 anthology")).toBe(null);
  });

  it("does not fire on fable or mythos in prose", () => {
    expect(detectModel("Aesop's fable about the fox")).toBe(null);
    expect(detectModel("the founding mythos of the company")).toBe(null);
  });

  it("does not fire on a bare family word with no version digit", () => {
    // Guards the estimate against prose: someone catting a README that says
    // "we moved off opus" must not reprice the session.
    expect(detectModel("we moved off opus last quarter")).toBe(null);
    expect(detectModel("haiku poetry generator")).toBe(null);
  });

  it("takes the LAST model named in the window, not the first", () => {
    // The 10KB window straddles a model switch. String.match() without /g would
    // hand back the stale Opus mention that scrolled by earlier.
    const window = [
      "Opus 4.7 (1M context) with high effort",
      "> /model sonnet",
      "Set model to Sonnet 4.5",
      "1.6k tokens \u00b7 thought for 2s",
    ].join("\n");
    expect(detectModel(window)).toBe("sonnet 4.5");
  });

  it("gives the same answer when called twice on the same text", () => {
    // Pins one thing: the exec loop runs to EXHAUSTION on every call. A
    // first-match-wins rewrite fails here on the second call, because bailing
    // early strands the module-level /g regex's lastIndex mid-string.
    //
    // It does NOT pin the explicit `lastIndex = 0` reset on entry. With the
    // loop shaped as it is, exec() returning null resets lastIndex by itself,
    // so deleting that line changes nothing observable and no test here kills
    // the mutant. The line stays as future-proofing against exactly the
    // first-match-wins rewrite above; see the comment on MODEL_DETECT_RE.
    const window = "claude-opus-4-5 then claude-haiku-4-5";
    expect(detectModel(window)).toBe("haiku 4.5");
    expect(detectModel(window)).toBe("haiku 4.5");
    expect(detectModel("Sonnet 4.5")).toBe("sonnet 4.5");
  });
});

describe("resolveModel", () => {
  it("adopts a model the window names", () => {
    expect(resolveModel(null, "Sonnet 4.5 \u00b7 Claude Max")).toBe("sonnet 4.5");
  });

  it("KEEPS the previous model when the window names none (sticky)", () => {
    // The reason the original code latched at all: the banner scrolls out of
    // the 10KB window within seconds on a busy session, and losing the family
    // there would silently reprice the tab at the opus default.
    expect(resolveModel("sonnet 4.5", "just some build output\n$ ")).toBe("sonnet 4.5");
    expect(resolveModel("haiku 4.5", "")).toBe("haiku 4.5");
  });

  it("REPLACES the previous model when the window names a different one", () => {
    // The half the latch could not do. `/model sonnet` mid-session, or a second
    // `claude` run in the same tab, genuinely changes the model.
    expect(resolveModel("opus 5.5", "Set model to Sonnet 4.5")).toBe("sonnet 4.5");
    expect(resolveModel("sonnet 4.5", "claude-haiku-4-5: 10 input, 2 output")).toBe("haiku 4.5");
    // A version change within one family is a real change too.
    expect(resolveModel("opus 4.1", "Opus 5.5 (1M context)")).toBe("opus 5.5");
  });

  it("stays null while nothing has ever been detected", () => {
    // Leaves modelRates.js's DEFAULT_MODEL to supply the Opus rate, which is
    // the intended not-yet-known behaviour.
    expect(resolveModel(null, "PS C:\\Users\\pluto> ")).toBe(null);
    expect(resolveModel(undefined, "")).toBe(null);
  });

  it("regression PERF-2: a shell prompt on the first chunk no longer pins the family", () => {
    // Replays the real sequence. checkCost is scheduled on the first rAF after
    // the FIRST PTY chunk, which for a local shell is the shell's own banner,
    // long before anyone types `claude`.
    let family = null;
    family = resolveModel(family, "Windows PowerShell\nPS C:\\Users\\pluto> ");
    expect(family).toBe(null);            // old code: "opus", permanently
    family = resolveModel(family, "PS C:\\Users\\pluto> claude --model sonnet");
    family = resolveModel(family, "Sonnet 4.5 (1M context)\n1.6k tokens");
    expect(family).toBe("sonnet 4.5");    // costed at Sonnet 4.5's rate, not the Opus default
    family = resolveModel(family, "\u23fa Running tests...\n");
    expect(family).toBe("sonnet 4.5");    // survives the banner scrolling out
  });
});

describe("evictScanChunks", () => {
  it("does nothing until the buffer is `slack` bytes past budget", () => {
    // 120 bytes against a 100 budget + 25 slack: over budget, under the cut
    // line. This is the assertion that fails if the hysteresis is removed and
    // eviction goes back to firing on every arriving chunk (PERF-5).
    const chunks = ["a".repeat(100), "b".repeat(20)];
    expect(evictScanChunks(chunks, 120, 100, 25)).toBe(120);
    expect(chunks).toEqual(["a".repeat(100), "b".repeat(20)]);
  });

  it("cuts all the way back to budget once past budget + slack", () => {
    const chunks = ["a".repeat(60), "b".repeat(60), "c".repeat(60)];
    expect(evictScanChunks(chunks, 180, 150, 20)).toBe(120);
    expect(chunks).toEqual(["b".repeat(60), "c".repeat(60)]);
  });

  it("keeps dropping until it is actually under budget, not just one chunk", () => {
    const chunks = ["a".repeat(60), "b".repeat(60), "c".repeat(60)];
    expect(evictScanChunks(chunks, 180, 100, 25)).toBe(60);
    expect(chunks).toEqual(["c".repeat(60)]);
  });

  it("evicts with ONE splice and never a shift loop", () => {
    // The structural half of PERF-5. shift() per chunk is the quadratic; a
    // single splice moves the surviving tail once. Reverting to the shift loop
    // throws here rather than quietly costing ~7,500 element moves per chunk.
    const chunks = Array.from({ length: 500 }, () => "x".repeat(100));
    let spliceCalls = 0;
    const realSplice = Array.prototype.splice.bind(chunks);
    chunks.splice = (...args) => { spliceCalls += 1; return realSplice(...args); };
    chunks.shift = () => { throw new Error("shift() on the append path is the PERF-5 quadratic"); };
    const bytes = evictScanChunks(chunks, 50_000, 20_000, 5_000);
    expect(spliceCalls).toBe(1);
    expect(bytes).toBeLessThanOrEqual(20_000);
    expect(chunks.length).toBe(200);
  });

  it("never evicts the newest chunk, even when it alone blows the budget", () => {
    // A single 1KB chunk against a 10-byte budget is still the only thing the
    // next scan has to read. Dropping it would blank the cost window.
    const solo = ["x".repeat(1000)];
    expect(evictScanChunks(solo, 1000, 10, 5)).toBe(1000);
    expect(solo).toEqual(["x".repeat(1000)]);

    const pair = ["a".repeat(50), "b".repeat(500)];
    expect(evictScanChunks(pair, 550, 100, 25)).toBe(500);
    expect(pair).toEqual(["b".repeat(500)]);
  });

  it("tolerates an empty or missing chunk list", () => {
    expect(evictScanChunks([], 0, 100, 25)).toBe(0);
    expect(evictScanChunks(null, 7, 100, 25)).toBe(7);
    expect(evictScanChunks(undefined, 7, 100, 25)).toBe(7);
    // Byte counts PAST the cut line, so the early return cannot be what saves
    // it: these reach the length read. Without the null guard they throw
    // instead of returning, which is what pins the guard as load-bearing.
    expect(evictScanChunks(null, 999, 10, 5)).toBe(999);
    expect(evictScanChunks(undefined, 999, 10, 5)).toBe(999);
    expect(evictScanChunks([], 999, 10, 5)).toBe(999);
  });
});

describe("reconcileCost", () => {
  it("REGRESSION PERF-2 clause 2: a real /cost figure beats a higher estimate", () => {
    // The headline symptom the first half of the fix left reachable. An
    // estimate priced at Opus's $12/M becomes the displayed cost, then `/cost`
    // prints the true Sonnet figure. Under the old single max()'d field the
    // lower authoritative number was discarded and $12 was permanent.
    const inflated = reconcileCost({ tokens: 0, cost: 0 }, { authoritative: 0, tokens: 1_000_000, ratePerM: 12.0 });
    expect(inflated.cost).toBe(12);

    const corrected = reconcileCost(inflated, { authoritative: 2.5, tokens: 1_000_000, ratePerM: 12.0 });
    expect(corrected.cost).toBe(2.5);      // old code: 12, for the life of the pane
    expect(corrected.costAuth).toBe(2.5);
    expect(corrected.costEst).toBe(12);    // still tracked, just not what is shown
  });

  it("REGRESSION PERF-2: correcting the family lowers the estimate instead of ratcheting", () => {
    // No /cost has been run. The family was misread as opus (a stray
    // "claude-opus-4-5" in the pane's own output), then read correctly as
    // sonnet. The estimate is recomputed, not max()'d against its own past.
    const opus = reconcileCost({ tokens: 0, cost: 0 }, { authoritative: 0, tokens: 1_000_000, ratePerM: 12.0 });
    expect(opus.cost).toBe(12);

    const sonnet = reconcileCost(opus, { authoritative: 0, tokens: 1_000_000, ratePerM: 2.5 });
    expect(sonnet.cost).toBe(2.5);
    expect(sonnet.costEst).toBe(2.5);
  });

  it("keeps tokens monotonic when the banner scrolls out of the window", () => {
    // bestTokens is a snapshot of the current 10KB window and drops to 0 the
    // moment the banner rotates out. The record must not follow it down, or
    // the estimate collapses to $0 mid-session.
    const seen = reconcileCost({ tokens: 0, cost: 0 }, { authoritative: 0, tokens: 500_000, ratePerM: 2.5 });
    expect(seen.tokens).toBe(500_000);

    const gone = reconcileCost(seen, { authoritative: 0, tokens: 0, ratePerM: 2.5 });
    expect(gone.tokens).toBe(500_000);
    expect(gone.cost).toBe(1.25);
  });

  it("keeps the authoritative figure monotonic (a stale frame is not a refund)", () => {
    // "Total cost" is cumulative for the session, so a LOWER reading is an
    // older /cost block still sitting in the 10KB tail, not a price drop.
    const first = reconcileCost({ tokens: 0, cost: 0 }, { authoritative: 5, tokens: 0, ratePerM: 12 });
    expect(first.cost).toBe(5);

    const stale = reconcileCost(first, { authoritative: 3, tokens: 0, ratePerM: 12 });
    expect(stale.cost).toBe(5);
    expect(stale.costAuth).toBe(5);
  });

  it("ignores a NaN authoritative reading rather than wiping the record", () => {
    // parseFloat on a mangled "Total cost: $" line. Must not poison costAuth.
    const out = reconcileCost({ tokens: 0, cost: 4, costAuth: 4, costEst: 0 }, { authoritative: NaN, tokens: 0, ratePerM: 12 });
    expect(out.costAuth).toBe(4);
    expect(out.cost).toBe(4);
  });

  it("accepts the bare { tokens, cost } record a fresh registry entry is born with", () => {
    // paneRegistry initialises counters.lastCost = { tokens: 0, cost: 0 } and
    // this module must not require it to grow fields to be read.
    const out = reconcileCost({ tokens: 1_000_000, cost: 12 }, { authoritative: 0, tokens: 0, ratePerM: 2.5 });
    expect(out.tokens).toBe(1_000_000);
    expect(out.costAuth).toBe(0);
    expect(out.cost).toBe(2.5);
  });

  it("reports zero across the board before anything has been observed", () => {
    // toEqual is exhaustive on purpose: an unexpected extra field in the record
    // means someone widened the shape, and every consumer of it (paneRegistry's
    // lastCost seed, useTabTelemetry's tokens/cost equality check) has to be
    // looked at again. It also fails if the reverted `authTokens` accrual
    // baseline comes back without the two-scale problem being solved first.
    expect(reconcileCost(null, {})).toEqual({ tokens: 0, cost: 0, costAuth: 0, costEst: 0 });
    expect(reconcileCost(undefined, { authoritative: 0, tokens: 0, ratePerM: 12 }))
      .toEqual({ tokens: 0, cost: 0, costAuth: 0, costEst: 0 });
  });

  it("estimates nothing when the rate is missing, but still keeps the tokens", () => {
    const out = reconcileCost({ tokens: 0, cost: 0 }, { authoritative: 0, tokens: 1_000_000, ratePerM: 0 });
    expect(out.tokens).toBe(1_000_000);
    expect(out.costEst).toBe(0);
    expect(out.cost).toBe(0);
  });

  it("pins the display to the authoritative figure once a /cost lands", () => {
    // This is the DELIBERATE behaviour, not an oversight, and the comment block
    // in reconcileCost carries the reasoning. An accrual on top of the exact
    // figure was written and reverted: `tokens` upstream is a monotonic MAX over
    // signals on two different scales (cumulative /cost totals vs the status
    // banner's context size), so an accrual either re-freezes anyway or, when
    // the /cost block straddles two scans, roughly DOUBLES the displayed cost.
    const RATE = 5;
    let rec = reconcileCost({ tokens: 0, cost: 0 }, { authoritative: 0, tokens: 1_000_000, ratePerM: RATE });
    expect(rec.cost).toBe(5); // estimate only, no /cost yet

    rec = reconcileCost(rec, { authoritative: 2, tokens: 1_000_000, ratePerM: RATE });
    expect(rec.cost).toBe(2); // exact figure replaces the estimate

    // Further tokens do NOT move the display. That is the accepted cost of not
    // shipping the double-count; see reconcileCost.
    rec = reconcileCost(rec, { authoritative: 0, tokens: 1_800_000, ratePerM: RATE });
    expect(rec.cost).toBe(2);
    expect(rec.costEst).toBe(9); // the estimate keeps climbing underneath
  });

  it("lets a later /cost supersede the pinned figure", () => {
    const RATE = 5;
    let rec = reconcileCost({ tokens: 0, cost: 0 }, { authoritative: 2, tokens: 1_000_000, ratePerM: RATE });
    expect(rec.cost).toBe(2);
    rec = reconcileCost(rec, { authoritative: 3.5, tokens: 1_800_000, ratePerM: RATE });
    expect(rec.cost).toBe(3.5);
    expect(rec.costAuth).toBe(3.5);
  });

  it("treats a lower authoritative reading as a stale frame, not a refund", () => {
    // The 10KB window can re-surface an OLD "Total cost" line after a newer one
    // has already been read. Taking it at face value would walk the number
    // backwards mid-session.
    const RATE = 5;
    let rec = reconcileCost({ tokens: 0, cost: 0 }, { authoritative: 3.5, tokens: 1_000_000, ratePerM: RATE });
    rec = reconcileCost(rec, { authoritative: 2, tokens: 1_000_000, ratePerM: RATE });
    expect(rec.costAuth).toBe(3.5);
    expect(rec.cost).toBe(3.5);
  });

  it("lets a family correction lower the ESTIMATE even while a /cost pins the display", () => {
    // The PERF-2 fix: the model family used to latch to "opus" on the first
    // chunk and could never change, so Sonnet and Haiku spend read 5 to 10 times
    // too high. costEst is recomputed from scratch every scan, never max()-ed
    // against itself, which is what lets the correction land.
    let rec = reconcileCost({ tokens: 0, cost: 0 }, { authoritative: 0, tokens: 1_000_000, ratePerM: 30 });
    expect(rec.costEst).toBe(30);
    rec = reconcileCost(rec, { authoritative: 0, tokens: 1_000_000, ratePerM: 3 });
    expect(rec.costEst).toBe(3);
    expect(rec.cost).toBe(3);
  });
});
