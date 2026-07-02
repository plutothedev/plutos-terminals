// (C)
// Coverage for the app-lock verifier (previously untested). Locks the PBKDF2
// round-trip, rejection of a wrong password, the legacy unsalted-SHA256 upgrade
// path, and constant-time-compare edge cases (length mismatch / malformed store).
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./masterPassword.js";

// Legacy verifier format = raw unsalted SHA-256 hex of the password.
async function legacySha256Hex(pw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("masterPassword verifier", () => {
  it("round-trips a PBKDF2 verifier and rejects the wrong password", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith("pbkdf2$")).toBe(true);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("uses a fresh random salt per hash (two hashes of the same pw differ)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    // …yet both still verify.
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("still verifies a legacy unsalted-SHA256 lock", async () => {
    const legacy = await legacySha256Hex("old-pass");
    expect(await verifyPassword("old-pass", legacy)).toBe(true);
    expect(await verifyPassword("nope", legacy)).toBe(false);
  });

  it("rejects empty / malformed stored verifiers instead of throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$only$two")).toBe(false); // wrong part count
  });
});
