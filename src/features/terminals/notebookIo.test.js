// (C)
// Pins the notebook name-sanitization contract: any typed text must reduce to a
// stem the Rust gate (notebook_path / safe_filename in commands.rs) accepts
// byte-for-byte, or be rejected with a reason. These are the cases the
// whole-stream review flagged as silently unsavable under the old ".md"-append.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sanitizeNotebookStem, toNotebookName, noteWrite } from "./notebookIo.js";
import { invoke } from "@backend";

vi.mock("@backend", () => ({ invoke: vi.fn() }));

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

// Pins the write-write serialization contract: two overlapping noteWrite calls
// for the SAME name must land in call order — the unmount flush bypasses
// NotebookView's savingRef mutex, so without this queue an autosave still in
// flight can rename over the flush's newer content (silent last-edit loss).
describe("noteWrite — same-name writes are strictly serialized", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    invoke.mockReset();
  });

  it("does not start a second write for a name until the first lands", async () => {
    const calls = [];
    const resolvers = [];
    invoke.mockImplementation((_cmd, args) => {
      calls.push(args.content);
      return new Promise((res) => resolvers.push(res));
    });

    const w1 = noteWrite("race-a.md", "old");
    const w2 = noteWrite("race-a.md", "new");
    await flush();
    expect(calls).toEqual(["old"]); // "new" must NOT be in flight yet

    resolvers[0]();
    await w1;
    await flush();
    expect(calls).toEqual(["old", "new"]); // started only after "old" landed

    resolvers[1]();
    await w2;
  });

  it("a failed predecessor does not block the next write", async () => {
    const calls = [];
    invoke.mockImplementation((_cmd, args) => {
      calls.push(args.content);
      return args.content === "bad" ? Promise.reject(new Error("disk")) : Promise.resolve();
    });

    const w1 = noteWrite("race-b.md", "bad");
    const w2 = noteWrite("race-b.md", "good");
    await expect(w1).rejects.toThrow("disk"); // caller still sees its own error
    await w2;
    expect(calls).toEqual(["bad", "good"]);
  });

  it("writes to different names are not serialized against each other", async () => {
    const calls = [];
    const resolvers = [];
    invoke.mockImplementation((_cmd, args) => {
      calls.push(args.name);
      return new Promise((res) => resolvers.push(res));
    });

    noteWrite("race-c.md", "x");
    noteWrite("race-d.md", "y");
    await flush();
    expect(calls).toEqual(["race-c.md", "race-d.md"]); // both in flight at once

    resolvers.forEach((res) => res());
    await flush();
  });
});

// Cloud-sync payload guard: saved prompts and agent rules ride the synced
// surface, which is re-encrypted whole on every push, so one pasted file would
// inflate every future sync on every machine.
describe("sync payload clamps", () => {
  it("a pasted file in a prompt body is truncated, not synced whole", async () => {
    const { normalizePrompt, PROMPT_BODY_MAX, PROMPT_NAME_MAX, PROMPT_TAGS_MAX, PROMPT_TAG_MAX } =
      await import("./hooks/useSavedPrompts.js");
    const huge = normalizePrompt({
      name: "n".repeat(5000),
      body: "x".repeat(PROMPT_BODY_MAX + 500_000),
      tags: Array(100).fill("t".repeat(200)),
    });
    expect(huge.body.length).toBe(PROMPT_BODY_MAX);
    expect(huge.name.length).toBe(PROMPT_NAME_MAX);
    expect(huge.tags.length).toBe(PROMPT_TAGS_MAX);
    expect(huge.tags.every((t) => t.length <= PROMPT_TAG_MAX)).toBe(true);
  });

  it("an ordinary prompt passes through untouched", async () => {
    const { normalizePrompt } = await import("./hooks/useSavedPrompts.js");
    const p = { name: "Review diff", body: "Review the staged diff for bugs.", tags: ["dev"] };
    expect(normalizePrompt(p)).toEqual(p);
  });

  it("missing/garbage input does not throw", async () => {
    const { normalizePrompt } = await import("./hooks/useSavedPrompts.js");
    expect(normalizePrompt(undefined)).toEqual({ name: "", body: "", tags: [] });
    expect(normalizePrompt({ tags: "not-an-array" }).tags).toEqual([]);
  });

  it("agent rules cap sits above the context builder's own rules share", async () => {
    const { AGENT_RULES_MAX } = await import("./AgentSection.jsx");
    const { RULES_SHARE } = await import("./agentContext.js");
    // Clamping below RULES_SHARE would silently shrink what the model can see.
    expect(AGENT_RULES_MAX).toBeGreaterThanOrEqual(RULES_SHARE);
  });
});
