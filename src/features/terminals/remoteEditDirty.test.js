// (C)
import { describe, test, expect, beforeEach } from "vitest";
import {
  markRemoteEditDirty,
  clearRemoteEditDirty,
  hasUnsavedRemoteEdits,
} from "./remoteEditDirty.js";

describe("remoteEditDirty registry (audit C4)", () => {
  beforeEach(() => {
    // drain any residue from a prior test
    for (const k of ["a", "b", "s:undefined", "s1:/f", "s2:/g"]) clearRemoteEditDirty(k);
  });

  test("empty registry reports no unsaved edits", () => {
    expect(hasUnsavedRemoteEdits()).toBe(false);
  });

  test("marking then clearing the same key returns to clean", () => {
    markRemoteEditDirty("s1:/f");
    expect(hasUnsavedRemoteEdits()).toBe(true);
    clearRemoteEditDirty("s1:/f");
    expect(hasUnsavedRemoteEdits()).toBe(false);
  });

  test("clearing a phantom key is harmless and leaves real keys intact", () => {
    markRemoteEditDirty("s1:/f");
    clearRemoteEditDirty("s:undefined"); // the phantom the open-gate fix prevents
    expect(hasUnsavedRemoteEdits()).toBe(true);
    clearRemoteEditDirty("s1:/f");
    expect(hasUnsavedRemoteEdits()).toBe(false);
  });

  test("falsy keys are ignored (no accidental dirty state)", () => {
    markRemoteEditDirty("");
    markRemoteEditDirty(null);
    markRemoteEditDirty(undefined);
    expect(hasUnsavedRemoteEdits()).toBe(false);
  });
});
