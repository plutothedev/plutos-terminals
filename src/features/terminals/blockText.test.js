// (C)
import { describe, it, expect } from "vitest";
import { blockOutputText } from "./blockText";
import { scanSecrets } from "./secretScan";

// Minimal fake of xterm's IBuffer / IBufferLine. Each row is { text, wrapped }.
// getLine(i) mirrors xterm: undefined when out of range; translateToString(trim)
// returns the row content and, when trim is true, drops trailing whitespace (this
// is xterm's translateToString(trimRight)). isWrapped marks a row that is a
// wrapped CONTINUATION of the row above it.
function makeBuf(rows) {
  return {
    length: rows.length,
    getLine(i) {
      const r = rows[i];
      if (!r) return undefined;
      return {
        isWrapped: !!r.wrapped,
        translateToString(trim) {
          return trim ? r.text.replace(/\s+$/, "") : r.text;
        },
      };
    },
  };
}

describe("blockOutputText soft-wrap handling", () => {
  // Case 1 (the whole point): a 20-char AWS key soft-wrapped across the pane width.
  // Row 1 holds the first 13 chars as a full, hard-filled row; row 2 is the wrapped
  // continuation. secretScan's aws pattern is newline-free, so a \n injected between
  // the halves silently defeats masking and leaks the raw key into the gist.
  it("keeps a wrap-split secret contiguous so scanSecrets still catches it", () => {
    const buf = makeBuf([
      { text: "echo $AWS_KEY", wrapped: false }, // row 0: command (loop never reads it)
      { text: "AKIAIOSFODNN7", wrapped: false }, // row 1: full row, wraps into row 2
      { text: "EXAMPLE", wrapped: true },        // row 2: wrapped continuation
    ]);
    const out = blockOutputText(buf, 0, 2);
    // contiguous on screen must stay contiguous in the string:
    expect(out).toContain("AKIAIOSFODNN7EXAMPLE");
    // and therefore the scanner still masks it:
    expect(scanSecrets(out).length).toBeGreaterThan(0);
  });

  // Case 2: genuine line breaks survive. Two unwrapped output rows join with exactly
  // one \n and there is no trailing newline.
  it("joins genuinely separate rows with a single newline and no trailing newline", () => {
    const buf = makeBuf([
      { text: "run", wrapped: false },      // row 0: command
      { text: "line one", wrapped: false }, // row 1: output
      { text: "line two", wrapped: false }, // row 2: output
    ]);
    const out = blockOutputText(buf, 0, 2);
    expect(out).toBe("line one\nline two");
  });

  // Case 3: a trailing blank row contributes no whitespace (the replace(/\s+$/, "")).
  it("strips a trailing blank row", () => {
    const buf = makeBuf([
      { text: "run", wrapped: false },    // row 0: command
      { text: "result", wrapped: false }, // row 1: output
      { text: "", wrapped: false },       // row 2: trailing blank
    ]);
    const out = blockOutputText(buf, 0, 2);
    expect(out).toBe("result");
  });

  // Case 4: a token that soft-wraps across THREE rows (row 1 full, row 2 wrapped and
  // full, row 3 wrapped) stays fully contiguous with no interior newlines.
  it("keeps a token spanning three wrapped rows contiguous", () => {
    const TOKEN = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const buf = makeBuf([
      { text: "printenv", wrapped: false },                 // row 0: command
      { text: "sk-proj-abcdefghijklmnop", wrapped: false }, // row 1: full, wraps
      { text: "qrstuvwxyz0123456789", wrapped: true },      // row 2: wrapped + full, wraps
      { text: "ABCD", wrapped: true },                       // row 3: wrapped continuation
    ]);
    const out = blockOutputText(buf, 0, 3);
    expect(out).toBe(TOKEN);
  });
});
