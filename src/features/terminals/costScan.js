// (C)
// Pure helpers for TerminalPane's cost/token telemetry scan.
//
// Extracted from TerminalPane.jsx's checkCost() so the pieces that had real
// bugs in them are unit-testable in isolation (audit PERF-2 + PERF-5).
// Everything here is side-effect-free EXCEPT evictScanChunks, which mutates
// the array it is handed on purpose (see its comment). The per-family rate
// table stays in the component: it is pricing DATA that moves whenever
// Anthropic reprices, while the reconciliation rules below are the invariant,
// so the rate arrives as a plain number argument.

// Assemble the trailing scan window from a scrollback chunk list.
//
// Walks the chunk list backwards, newest first, until at least `maxBytes`
// have been collected (the last chunk always lands whole, so the window is
// >= maxBytes rather than exactly maxBytes), then returns the chunks joined
// back in ORIGINAL order.
//
// PERF-5: the previous inline version built the window with `parts.unshift()`,
// which shifts every element already in the array, so assembling a k-chunk
// window cost O(k^2) element moves. The Rust coalescer leading-edges a raw
// read whenever the session has been idle >= 8 ms, so a token-by-token agent
// stream produces MANY tiny chunks: k is ~1,000 at 10-byte chunks, and this
// runs up to once per animation frame per streaming pane. Push-then-reverse
// is the same output in O(k).
//
// `length` is JS string length (UTF-16 code units), not bytes. That is what
// the inline version measured too; the window is a heuristic scan budget, so
// the distinction never mattered and is preserved rather than "fixed".
export function buildScanWindow(chunks, maxBytes) {
  if (!chunks || chunks.length === 0) return "";
  const parts = [];
  let bytes = 0;
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    parts.push(chunk);
    bytes += chunk.length;
    if (bytes >= maxBytes) break;
  }
  parts.reverse();
  return parts.join("");
}

// Evict oldest chunks once the buffer runs `slack` bytes past its budget.
// MUTATES `chunks` in place (one splice) and returns the new byte total.
//
// PERF-5, second half. Fixing buildScanWindow's O(k^2) assembly left the
// identical quadratic class one call site away: the append path evicted with
// `chunks.shift()` in a while loop, and at steady state every arriving chunk
// pushes the buffer over budget by roughly its own size, so every chunk paid
// one full-array shift. With a 100 KB budget and the coalescer's ~10-20 byte
// chunks the array holds 5,000-10,000 elements, i.e. ~7,500 element moves per
// chunk at ~125 chunks/sec/pane -- and this app's headline use case is twenty
// of those panes at once.
//
// Two changes make it amortized O(1) per chunk without a new registry field:
//  1. HYSTERESIS. Do nothing until the buffer is `slack` bytes past budget,
//     then cut all the way back to budget. One eviction per `slack` bytes
//     arriving instead of one per chunk.
//  2. ONE splice, not N shifts. `splice(0, n)` is a single move of the
//     surviving tail; `shift()` n times moves that tail n times. Without this
//     the hysteresis buys nothing, because the batch would just pay the
//     per-chunk cost in a burst.
//
// The cost is `slack` extra bytes of retained scrollback per pane. The scan
// window is a tail, so slack at the HEAD is never read by anything.
//
// The newest chunk is never evicted, so a single chunk larger than the whole
// budget still survives (it is what the next scan reads).
export function evictScanChunks(chunks, bytes, maxBytes, slack) {
  if (!chunks) return bytes;
  if (bytes <= maxBytes + slack) return bytes;
  // `keepFrom` is the only thing protecting the newest chunk, and it also
  // covers the empty and single-chunk lists on its own (length - 1 is <= 0, so
  // the loop never runs and the `drop === 0` return below fires). A separate
  // `chunks.length <= 1` guard here would be unkillable by any test.
  const keepFrom = chunks.length - 1;
  let drop = 0;
  let freed = 0;
  while (drop < keepFrom && bytes - freed > maxBytes) {
    freed += chunks[drop].length;
    drop++;
  }
  if (drop === 0) return bytes;
  chunks.splice(0, drop);
  return bytes - freed;
}

// Claude Code prints the model both as a friendly banner ("Opus 4.7 (1M
// context) with high effort") and in API form inside /cost output
// ("claude-sonnet-4-5: 12,345 input, ..."). Both surface forms are covered.
// Global so detectFamily can walk every occurrence in the window; lastIndex is
// reset on entry (same discipline as MODEL_LINE_RE in TerminalPane). That
// reset is belt-and-braces given the loop below runs to exhaustion, which
// resets lastIndex by itself: it is there so a future first-match-wins rewrite
// cannot strand the offset. Do not read it as load-bearing today.
const FAMILY_DETECT_RE = /\bclaude-(opus|sonnet|haiku)\b|\b(opus|sonnet|haiku)\s*[0-9]/gi;

// Which Claude family the scan window names, or null when it names none.
//
// PERF-2: this used to return the "opus" worst-case default on no match, which
// made a non-detection indistinguishable from a detection. Its one caller
// latched on the first truthy result, so the family was pinned to opus by the
// shell's own prompt output on the very first PTY chunk -- long before anyone
// could type `claude` -- and could never move. Every Sonnet session was then
// costed at Opus's blended rate (4.8x over; 17x for Haiku). Returning null is
// what lets the caller keep the default separate from a real reading.
//
// LAST match wins, not first. The window is a 10KB tail that can straddle a
// model switch ("...Opus 4.7..." earlier, "...Sonnet 4.5..." later); the
// latest mention is the current model. String.match() without /g returns the
// FIRST match, which would have read the stale one.
//
// KNOWN IMPRECISION: this reads the pane's output, so any text that merely
// NAMES a model reads as a detection -- `cat`-ing a file containing
// "claude-opus-4-5", for instance. That can misprice the ESTIMATE for a while
// (resolveFamily is sticky), but since reconcileCost recomputes the estimate
// from the current family every scan rather than ratcheting it, a later
// correct mention repairs the figure, and any authoritative /cost line
// replaces the estimate for everything it covers. It is a wrong estimate, not
// a permanent floor.
export function detectFamily(text) {
  if (!text) return null;
  FAMILY_DETECT_RE.lastIndex = 0;
  let found = null;
  let m;
  while ((m = FAMILY_DETECT_RE.exec(text)) !== null) {
    const fam = (m[1] || m[2] || "").toLowerCase();
    if (fam) found = fam;
  }
  return found;
}

// Sticky-with-re-evaluation family resolution.
//
// Two requirements pull in opposite directions and both are real:
//  1. STICKY. The banner naming the model scrolls out of the 10KB window fast
//     on a busy session, so a window with no model mention must NOT reset the
//     family to unknown. That is why the original code latched at all.
//  2. RE-EVALUATE. `/model sonnet` mid-session, or a second `claude` run in
//     the same tab, genuinely changes the model. A latch that only ever samples
//     once cannot follow that.
// Keeping the previous value only when the window says nothing satisfies both:
// silence preserves, a fresh reading replaces.
export function resolveFamily(prevFamily, text) {
  return detectFamily(text) || prevFamily || null;
}

// Fold one scan's observations into the pane's running cost record.
//
// PERF-2, second clause. The estimate and the authoritative `/cost` figure
// used to share ONE `cost` field that both wrote through a max(), so an
// estimate computed at the wrong (opus) rate became a permanent floor: a
// genuine "Total cost: $X.XX" line reading lower was discarded, and the
// headline symptom of the finding survived its own fix. They are two fields
// now, with different rules:
//
//  - `costAuth` is written ONLY by a COST_RE match, and only upward. Claude's
//    "Total cost" is cumulative for the session, so a lower reading is a stale
//    frame still sitting in the 10KB window, not a refund.
//  - `costEst` is RECOMPUTED from scratch every scan: current cumulative
//    tokens times the current family's rate. Never max()-ed against its own
//    previous value, which is what lets a family correction (opus -> sonnet)
//    actually lower it.
//  - `cost`, the figure the status bar and toolbar render, is the
//    authoritative figure whenever one has landed, and the plain estimate
//    until then. See the block below for why it is not an accrual.
//
// `costEst` cannot walk backwards on its own -- `tokens` is monotonic, so at a
// fixed rate the estimate only climbs. It moves down exactly when the rate
// does, i.e. when the family reading is corrected. That is the correction the
// old max() suppressed, not a regression of it.
//
// AUTHORITATIVE PINS THE DISPLAY UNTIL THE NEXT /cost, DELIBERATELY.
// An accrual (costAuth + est(tokens - authTokens)) was written here and then
// reverted, because it cannot be correct on this input. `tokens` upstream is a
// monotonic MAX over four signals on TWO scales: the /cost summary forms and
// the per-model lines are CUMULATIVE session totals, while the status banner
// form is context size, which is far smaller. So (a) a /cost run spikes tokens
// to the cumulative scale, the baseline latches there, the banner can never
// climb back above it, and the display re-freezes anyway; and (b) the /cost
// block can straddle two rAF-coalesced scans, and since 'Total cost:' prints
// BEFORE the per-model lines, the baseline can pin low and the whole cumulative
// total then accrues on top of the exact figure, roughly DOUBLING it. (b) is a
// worse failure than the freeze, so the freeze stays until the token signal is
// split by scale (a separate cumulative-only counter upstream). See the
// 2026-08-21 audit, PERF-2, which fixed the model-family latch above; this is
// its neighbour and is NOT the same bug.
//
// `prev` may be the bare `{ tokens, cost }` a fresh registry entry is born
// with; the missing fields read as 0.
export function reconcileCost(prev, observed) {
  const p = prev || {};
  const o = observed || {};
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

  const tokens = Math.max(num(p.tokens), num(o.tokens));
  const prevAuth = num(p.costAuth);
  const costAuth = Math.max(prevAuth, num(o.authoritative));
  const rate = num(o.ratePerM);
  const est = (t) => (t > 0 && rate > 0 ? (t * rate) / 1_000_000 : 0);
  const costEst = est(tokens);
  const cost = costAuth > 0 ? costAuth : costEst;

  return { tokens, cost, costAuth, costEst };
}
