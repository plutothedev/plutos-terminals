// (C)
// The live cost estimate's per-model rates (modelRates.js). Each expected
// figure is worked by hand from Anthropic's list price at the estimate's mix
// (75% cache reads, 12% fresh input, 13% output), so a wrong row or a wrong
// lookup shows up as a wrong number here.
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MODEL, blendedRatePerM } from "./modelRates.js";
import { detectModel } from "./costScan.js";

const near = (key, expected) => expect(blendedRatePerM(key)).toBeCloseTo(expected, 4);

describe("blendedRatePerM", () => {
  test("prices each current model from its list price", () => {
    near("opus 5.5", 0.75 * 0.2 + 0.12 * 4 + 0.13 * 20); // 3.23
    near("opus 5.0", 0.75 * 0.5 + 0.12 * 5 + 0.13 * 25); // 4.225, Opus 5 is at Opus 4.8's price
    near("opus 4.8", 4.225);
    near("opus 4.5", 4.225);
    near("fable 5.1", 0.75 * 0.25 + 0.12 * 10 + 0.13 * 50); // 7.8875
    near("fable 5.0", 0.75 * 1 + 0.12 * 10 + 0.13 * 50); // 8.45
    near("sonnet 5.5", 0.75 * 0.2 + 0.12 * 2 + 0.13 * 10); // 1.69
    near("sonnet 5.0", 1.69);
    near("sonnet 4.6", 0.75 * 0.3 + 0.12 * 3 + 0.13 * 15); // 2.535
    near("haiku 4.5", 0.75 * 0.1 + 0.12 * 1 + 0.13 * 5); // 0.845
  });

  test("still prices retired models a session may name", () => {
    near("opus 4.1", 0.75 * 1.5 + 0.12 * 15 + 0.13 * 75); // 12.675
    near("opus 4.0", 12.675);
    near("haiku 3.5", 0.75 * 0.08 + 0.12 * 0.8 + 0.13 * 4); // 0.676
  });

  test("the Claude 3 models price as each family's oldest row", () => {
    near("sonnet 3.7", 2.535); // $3/$15, as Sonnet 4
    near("opus 3.0", 12.675); // $15/$75, as Opus 4
    near("haiku 3.5", 0.676);
  });

  test("Mythos costs what Fable costs, version for version", () => {
    near("mythos 5.1", 7.8875);
    near("mythos 5.0", 8.45);
  });

  test("a version newer than the table takes the newest row, an older one the oldest", () => {
    near("opus 6.0", 3.23);
    near("sonnet 9.9", 1.69);
    near("opus 3.0", 12.675);
  });

  test("a bare family is charged at the dearest rate still sold in it", () => {
    near("opus", 4.225); // Opus 4.5 to 5, not retired Opus 4.1
    near("fable", 8.45);
    near("sonnet", 2.535);
    near("haiku", 0.845); // Haiku 4.5, not retired Haiku 3.5
  });

  test("no model yet, or an unknown one, is an Opus session", () => {
    expect(DEFAULT_MODEL).toBe("opus");
    near(null, 4.225);
    near(undefined, 4.225);
    near("", 4.225);
    near("gpt 5.0", 4.225);
    near("not a key", 4.225);
  });

  test("the session a user runs today is no longer charged 3.7 times over", () => {
    // Before this table, every Opus session was charged 12.0 per million
    // tokens, Opus 4/4.1's rate. Claude Code's default model is now Opus 5.5.
    const key = detectModel("Opus 5.5 (1M context) with medium effort");
    expect(key).toBe("opus 5.5");
    expect(blendedRatePerM(key)).toBeLessThan(12.0 / 3.5);
  });

  test("TerminalPane prices its estimate with this table and the detected model", () => {
    // checkCost lives inside TerminalPane's scan closure and cannot run alone,
    // so its two lines are read from source.
    const src = readFileSync(path.join(process.cwd(), "src/features/terminals/TerminalPane.jsx"), "utf8");
    expect(src).toMatch(/e\.counters\.model = resolveModel\(e\.counters\.model, text\);/);
    expect(src).toMatch(/const ratePerM = blendedRatePerM\(e\.counters\.model\);/);
    expect(src).not.toMatch(/FAMILY_BLENDED_RATE_PER_M/);
  });
});
