// (C)
// Locks the auto-approve prompt detector (P2-T5 review WARNING: this exact
// needs-you class regressed at v0.6.0 and shipped untested). The un-block
// contract: ANY miss returns false — the caller flips waiting→active on it.
import { describe, it, expect } from "vitest";
import { detectPendingPrompt, stripAnsi } from "./promptDetect.js";

const PROMPT =
  "Do you want to run this command?\n\x1b[36m❯\x1b[0m 1. Yes\n  2. No (esc)\n";

describe("detectPendingPrompt", () => {
  it("detects Claude's real four-marker prompt, ANSI-interleaved", () => {
    expect(detectPendingPrompt(PROMPT)).toBe(true);
  });

  it("prompt scrolled out -> false (the un-block signal)", () => {
    expect(detectPendingPrompt("regular build output, no prompt here\n")).toBe(false);
  });

  it("prefilter can never hide a real prompt: stripAnsi only removes", () => {
    // Every raw buffer containing the stripped prompt also contains ❯ raw —
    // pin the direction with an escape-heavy variant.
    const heavy = PROMPT.replace(/❯/g, "\x1b[1m\x1b[36m❯\x1b[0m");
    expect(stripAnsi(heavy).includes("❯")).toBe(true);
    expect(detectPendingPrompt(heavy)).toBe(true);
  });

  it("forged fragments without the question do not match (defense-in-depth)", () => {
    expect(detectPendingPrompt("echo '❯ 1. Yes (esc)'\n")).toBe(false);
  });

  it("empty / null-ish buffers are false, never throw", () => {
    expect(detectPendingPrompt("")).toBe(false);
    expect(detectPendingPrompt(null)).toBe(false);
    expect(detectPendingPrompt(undefined)).toBe(false);
  });

  it("missing ❯ fast-path equals full-scan miss", () => {
    const noArrow = "Do you want this? 1. Yes (esc)";
    expect(detectPendingPrompt(noArrow)).toBe(false);
  });
});
