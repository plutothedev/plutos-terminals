// (C)
import { describe, it, expect } from "vitest";
import { buildShare } from "./shareText.js";

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

  it("returns ONLY {filename, masked, hits} -- no raw property, no extras", () => {
    const result = buildShare("block", "some raw text", "2026-07-21");
    expect(Object.keys(result).sort()).toEqual(["filename", "hits", "masked"]);
    expect(result.raw).toBeUndefined();
  });

  it("does not export a slugFilename function", async () => {
    const mod = await import("./shareText.js");
    expect(mod.slugFilename).toBeUndefined();
  });
});
