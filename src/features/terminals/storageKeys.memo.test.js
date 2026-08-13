// @vitest-environment happy-dom
// (C)
// Memo semantics for the P4-T4 parse caches (stream-audit WARNING 2: the
// string-identity invalidation guards secrets flowing into spawned shells and
// had no regression guard).
import { describe, it, expect, beforeEach, vi } from "vitest";

// secretVault is the only non-pure dependency of readUserSt's overlay.
vi.mock("./secretVault.js", () => ({
  getCachedSecretKeys: vi.fn(() => ({ providerKeys: {}, anthropicKey: "" })),
}));

import { readUserSt, readWindowBlob, USER_STORAGE_KEY, getWindowStorageKey } from "./storageKeys.js";
import { getCachedSecretKeys } from "./secretVault.js";

beforeEach(() => {
  localStorage.clear();
  getCachedSecretKeys.mockReturnValue({ providerKeys: {}, anthropicKey: "" });
});

describe("readUserSt memo (P4-T4)", () => {
  it("parses once per raw string; a write invalidates", () => {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ welcomeDone: true, envOverrides: { A: "1" } }));
    const a = readUserSt();
    const b = readUserSt();
    expect(a).toEqual(b);
    // The memoized BASE is shared but each call returns a fresh top-level
    // object (callers may not alias each other's results).
    expect(a).not.toBe(b);
    expect(a.welcomeDone).toBe(true);

    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ welcomeDone: false }));
    expect(readUserSt().welcomeDone).toBe(false); // string changed -> reparse
  });

  it("keychain overlay is NEVER memoized — secret changes surface without a localStorage write", () => {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ providerKeys: { openai: "stale" } }));
    expect(readUserSt().providerKeys.openai).toBe("stale");
    // Keychain migration lands (in-memory cache only; the blob string is
    // UNCHANGED — exactly the case a whole-result memo would get wrong).
    getCachedSecretKeys.mockReturnValue({ providerKeys: { openai: "fresh-key" }, anthropicKey: "sk-a" });
    const st = readUserSt();
    expect(st.providerKeys.openai).toBe("fresh-key");
    expect(st.anthropicKey).toBe("sk-a");
  });

  it("bad JSON degrades to {} and recovers on the next good write", () => {
    localStorage.setItem(USER_STORAGE_KEY, "{nope");
    expect(readUserSt().welcomeDone).toBeUndefined();
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ welcomeDone: true }));
    expect(readUserSt().welcomeDone).toBe(true);
  });
});

describe("readWindowBlob memo (P4-T4)", () => {
  it("returns the same parsed object while raw is unchanged; write invalidates; missing key -> null", () => {
    expect(readWindowBlob()).toBe(null);
    localStorage.setItem(getWindowStorageKey(), JSON.stringify({ anthropicKey: "k1", envOverrides: { X: "y" } }));
    const a = readWindowBlob();
    expect(a.anthropicKey).toBe("k1");
    expect(readWindowBlob()).toBe(a); // memo hit — same object, zero reparse

    localStorage.setItem(getWindowStorageKey(), JSON.stringify({ anthropicKey: "k2" }));
    const b = readWindowBlob();
    expect(b).not.toBe(a);
    expect(b.anthropicKey).toBe("k2");

    localStorage.removeItem(getWindowStorageKey());
    expect(readWindowBlob()).toBe(null);
  });

  it("bad JSON returns null (spawn path treats it as no per-window state)", () => {
    localStorage.setItem(getWindowStorageKey(), "{nope");
    expect(readWindowBlob()).toBe(null);
  });
});
