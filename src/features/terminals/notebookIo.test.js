// (C)
// Pins the notebook name-sanitization contract: any typed text must reduce to a
// stem the Rust gate (notebook_path / safe_filename in commands.rs) accepts
// byte-for-byte, or be rejected with a reason. These are the cases the
// whole-stream review flagged as silently unsavable under the old ".md"-append.
import { describe, it, expect } from "vitest";
import { sanitizeNotebookStem, toNotebookName } from "./notebookIo.js";

describe("sanitizeNotebookStem", () => {
  it("collapses a space run to a single dash", () => {
    expect(sanitizeNotebookStem("meeting notes")).toBe("meeting-notes");
  });

  it("leaves an already-clean stem untouched", () => {
    expect(sanitizeNotebookStem("notes_v1-2")).toBe("notes_v1-2");
    expect(sanitizeNotebookStem("Notes")).toBe("Notes"); // case is allowed
  });

  it("replaces a dot and keeps existing dashes", () => {
    expect(sanitizeNotebookStem("v1.2-notes")).toBe("v1-2-notes");
  });

  it("drops non-ASCII and trims the trailing dash it leaves", () => {
    expect(sanitizeNotebookStem("café")).toBe("caf"); // café -> caf-  -> caf
  });

  it("collapses repeated/adjacent separators and trims the edges", () => {
    expect(sanitizeNotebookStem("  --a @@ b--  ")).toBe("a-b");
  });

  it("yields an empty string for all-disallowed input", () => {
    expect(sanitizeNotebookStem("   ")).toBe("");
    expect(sanitizeNotebookStem("笔记")).toBe(""); // 笔记
  });

  it("handles null / undefined without throwing", () => {
    expect(sanitizeNotebookStem(null)).toBe("");
    expect(sanitizeNotebookStem(undefined)).toBe("");
  });

  it("every non-empty result is gate-clean (only [A-Za-z0-9_-])", () => {
    for (const raw of ["meeting notes", "v1.2-notes", "café", "a/b\\c:d", "my notes!!"]) {
      const out = sanitizeNotebookStem(raw);
      if (out) expect(out).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("toNotebookName — pinned gate-charset cases", () => {
  it("multi-word name becomes a hyphenated .md file", () => {
    expect(toNotebookName("meeting notes")).toEqual({ ok: true, name: "meeting-notes.md" });
  });

  it("strips a single trailing .md the user typed (no double-append)", () => {
    expect(toNotebookName("notes.md")).toEqual({ ok: true, name: "notes.md" });
    expect(toNotebookName("notes.MD")).toEqual({ ok: true, name: "notes.md" });
  });

  it("only strips ONE trailing .md", () => {
    expect(toNotebookName("notes.md.md")).toEqual({ ok: true, name: "notes-md.md" });
  });

  it("sanitizes a dotted version tag", () => {
    expect(toNotebookName("v1.2-notes")).toEqual({ ok: true, name: "v1-2-notes.md" });
  });

  it("drops accented letters (café -> caf.md)", () => {
    expect(toNotebookName("café")).toEqual({ ok: true, name: "caf.md" });
  });

  it("rejects whitespace-only input", () => {
    expect(toNotebookName("   ")).toEqual({ ok: false, reason: "name has no usable characters" });
  });

  it("rejects an all-unicode name as empty", () => {
    expect(toNotebookName("笔记")).toEqual({ ok: false, reason: "name has no usable characters" });
  });

  it("rejects reserved Windows device names (case-insensitive)", () => {
    expect(toNotebookName("con")).toEqual({ ok: false, reason: "reserved name" });
    expect(toNotebookName("COM1")).toEqual({ ok: false, reason: "reserved name" });
    expect(toNotebookName("nul.md")).toEqual({ ok: false, reason: "reserved name" });
  });

  it("accepts a single valid character (>= gate minimum after .md)", () => {
    expect(toNotebookName("a")).toEqual({ ok: true, name: "a.md" });
  });
});
