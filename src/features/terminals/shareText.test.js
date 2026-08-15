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
    // Neutral context: a KEY/SECRET-named container (e.g. `X-Key: <key>`) is now
    // ALSO caught by the broader env-secret pattern (audit M5) and would mask
    // the whole pair under that label — still safe, but this test targets the
    // specific aws-access-key path, so keep the key out of a named assignment.
    const rawText = `the deploy step authenticates with ${AWS_KEY} at runtime`;
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

// Re-review catch: hits were computed pre-cut, so the modal could claim
// "N secrets masked in the upload above" for a secret whose placeholder the
// tail-cut discarded. Report only what survives into the uploaded text.
describe("buildShare — reported hits reflect the FINAL upload text", () => {
  const KEY = "AKIAIOSFODNN7EXAMPLE";

  it("a secret dropped by the tail-cut is not counted", () => {
    const raw = `old output\n${KEY}\n` + "z".repeat(SHARE_CAP + 50_000);
    const { masked, hits } = buildShare("transcript", raw, "2026-08-03");
    expect(masked).not.toContain("[masked aws-access-key]"); // placeholder was cut away
    expect(hits).toEqual([]); // ...so nothing is claimed about it
    expect(masked).not.toContain(KEY); // and the raw value is nowhere either
  });

  it("a secret surviving in the kept tail is still counted", () => {
    const raw = "z".repeat(SHARE_CAP + 50_000) + `\n${KEY}\n`;
    const { masked, hits } = buildShare("transcript", raw, "2026-08-03");
    expect(masked).toContain("[masked aws-access-key]");
    expect(hits.length).toBe(1);
  });
});

// Release-audit CRITICAL (found by the fix-round re-review): the Rust
// transcript cap severs whole days BEFORE any JS masking runs, so buildShare
// can receive a PEM whose BEGIN was dropped. This exercises text shaped like
// real transcript_read_all_capped output — the omission note + a `--- date ---`
// header + a headless key body — not a hand-built whole secret.
describe("buildShare — a PEM bisected upstream by the Rust read cap", () => {
  const BODY_A = "MIIEowIBAAKCAQEAx7Zk9fQ2vLmN8pQrStUvWxYz0123456789abcdefGHIJKLMN";
  const BODY_B = "OPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/AAAAAAAAAAAAAA";

  it("masks the surviving key body and flips the button to Share anyway", () => {
    const rustOutput = [
      "\n--- [earlier transcript omitted: size cap] ---",
      "\n--- 2026-08-03 ---",
      "$ cat ~/.ssh/id_rsa",
      BODY_A,
      BODY_B,
      "-----END RSA PRIVATE KEY-----",
      "$ echo done",
      "",
    ].join("\n");
    const { masked, hits } = buildShare("transcript", rustOutput, "2026-08-03");
    expect(masked).not.toContain(BODY_A);
    expect(masked).not.toContain(BODY_B);
    expect(hits.length).toBeGreaterThan(0); // hasSecrets -> "Share anyway" + warning row
    expect(masked).toContain("$ echo done"); // ordinary output survives
  });
});
