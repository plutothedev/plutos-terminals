// (C)
// isNewer decides whether the app EVER tells a user an update exists. A false
// negative here means a security fix silently never gets offered, which is the
// exact failure the updater was added to prevent, so it is worth pinning.
import { describe, it, expect } from "vitest";
import { isNewer } from "./UpdateBanner.jsx";

describe("isNewer", () => {
  it("detects a newer release across each position", () => {
    expect(isNewer("v0.6.1", "0.6.0")).toBe(true);
    expect(isNewer("v0.7.0", "0.6.9")).toBe(true);
    expect(isNewer("v1.0.0", "0.99.99")).toBe(true);
  });

  it("does not offer an update for same or older", () => {
    expect(isNewer("v0.6.0", "0.6.0")).toBe(false);
    expect(isNewer("v0.5.9", "0.6.0")).toBe(false);
    expect(isNewer("v0.6.0", "0.6.1")).toBe(false);
  });

  it("tolerates a missing or present leading v on either side", () => {
    expect(isNewer("0.6.1", "v0.6.0")).toBe(true);
    expect(isNewer("v0.6.1", "v0.6.0")).toBe(true);
  });

  it("treats a shorter version as zero-padded, not as newer", () => {
    // 0.6 vs 0.6.0 are equal; 0.6.1 vs 0.6 is newer.
    expect(isNewer("v0.6", "0.6.0")).toBe(false);
    expect(isNewer("v0.6.1", "0.6")).toBe(true);
  });

  it("never fires on unparseable tags (no false update banner)", () => {
    for (const junk of ["nightly", "v", "", null, undefined, "vX.Y.Z", "latest"]) {
      expect(isNewer(junk, "0.6.0")).toBe(false);
    }
  });

  it("does not throw on non-string input from a corrupt cache or API", () => {
    for (const junk of [42, {}, [], true, null, undefined]) {
      expect(() => isNewer(junk, "0.6.0")).not.toThrow();
      expect(() => isNewer("v9.9.9", junk)).not.toThrow();
    }
  });
});
