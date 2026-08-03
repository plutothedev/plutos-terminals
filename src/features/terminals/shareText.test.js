// (C)
import { describe, it, expect } from "vitest";
import { buildShare, SHARE_CAP } from "./shareText.js";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

describe("buildShare", () => {
  it("no secrets -> masked equals rawText verbatim, hits empty", () => {
    const rawText = "just a normal command\nwith normal output, nothing sensitive";
    const { masked, hits } = buildShare("block", rawText, "2026-07-21");
    expect(masked).toBe(rawText);
    expect(hits).toEqual([]);
  });

  it("an AWS key in rawText is masked and hits lists it", () => {
    const rawText = `curl -H "X-Key: ${AWS_KEY}" https://example.com`;
    const { masked, hits } = buildShare("block", rawText, "2026-07-21");
    expect(masked).toContain("[masked aws-access-key]");
    expect(masked).not.toContain(AWS_KEY);
    expect(hits.some((h) => h.name === "aws-access-key" && h.match === AWS_KEY)).toBe(true);
  });

  it("filename is content-independent: identical for harmless vs secret-carrying rawText on the same date", () => {
    const harmless = buildShare("block", "harmless", "2026-07-21");
    const leaky = buildShare("block", `leaked key ${AWS_KEY} right here`, "2026-07-21");
    expect(leaky.filename).toBe(harmless.filename);
    expect(leaky.filename).not.toContain(AWS_KEY);
  });

  it('kind "transcript" gets a .md extension', () => {
    const { filename } = buildShare("transcript", "whatever", "2026-07-21");
    expect(filename).toBe("plutos-terminal-share-2026-07-21.md");
  });

  it('kind "block" gets a .txt extension', () => {
    const { filename } = buildShare("block", "whatever", "2026-07-21");
    expect(filename).toBe("plutos-terminal-share-2026-07-21.txt");
  });

  it("any non-transcript kind falls back to .txt", () => {
    const { filename } = buildShare("something-else", "whatever", "2026-07-21");
    expect(filename).toBe("plutos-terminal-share-2026-07-21.txt");
  });

  it("dateStamp is used verbatim in the filename", () => {
    const { filename } = buildShare("block", "x", "2026-07-21");
    expect(filename).toContain("2026-07-21");
  });

  it("different dateStamp values produce different filenames, injected not computed", () => {
    const a = buildShare("block", "same content", "2026-01-01");
    const b = buildShare("block", "same content", "2026-12-31");
    expect(a.filename).not.toBe(b.filename);
    expect(a.filename).toBe("plutos-terminal-share-2026-01-01.txt");
    expect(b.filename).toBe("plutos-terminal-share-2026-12-31.txt");
  });

  it("returns ONLY {filename, masked, hits, truncated} -- no raw property, no extras", () => {
    const result = buildShare("block", "some raw text", "2026-07-21");
    expect(Object.keys(result).sort()).toEqual(["filename", "hits", "masked", "truncated"]);
    expect(result.raw).toBeUndefined();
  });

  it("does not export a slugFilename function", async () => {
    const mod = await import("./shareText.js");
    expect(mod.slugFilename).toBeUndefined();
  });
});

// Release-audit pin: the share pipeline had NO size bound — a multi-day
// transcript ran unbounded through scan/render/POST. buildShare now caps the
// UPLOAD text (preview === upload still holds: the cap lives inside here).
describe("buildShare — size cap", () => {
  it("caps oversized input keeping the newest tail, with a truncation marker", () => {
    const raw = "start-sentinel\n" + "x".repeat(SHARE_CAP + 50_000) + "\nend-sentinel";
    const { masked, truncated } = buildShare("transcript", raw, "2026-08-03");
    expect(truncated).toBe(true);
    expect(masked.length).toBeLessThanOrEqual(SHARE_CAP + 200); // marker allowance
    expect(masked).toContain("end-sentinel"); // newest output survives
    expect(masked).not.toContain("start-sentinel"); // oldest is what's dropped
    expect(masked.startsWith("[truncated")).toBe(true);
  });

  it("a secret bisected by the cut never ships raw bytes (mask runs before the cut)", () => {
    const KEY = "AKIAIOSFODNN7EXAMPLE"; // 20 chars
    // Tail after the key ≈ SHARE_CAP - 10, so a naive cut-then-mask would slice
    // mid-key and ship an unmatchable raw fragment. Masked-first, the cut can
    // only bisect a placeholder — zero secret bytes either way.
    const raw = "y".repeat(60_000) + "\n" + KEY + "\n" + "z".repeat(SHARE_CAP - 10);
    const { masked } = buildShare("block", raw, "2026-08-03");
    expect(masked).not.toMatch(/AKIA/);
    expect(masked).not.toContain(KEY);
  });

  it("under-cap input is untouched and reports truncated=false", () => {
    const { masked, truncated } = buildShare("block", "small", "2026-08-03");
    expect(truncated).toBe(false);
    expect(masked).toBe("small");
  });
});
