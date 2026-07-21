// (C)
import { describe, test, expect } from "vitest";
import { filterPrompts, menuKeyAction, clampIndex } from "./PromptSlashMenu.jsx";

const PROMPTS = [
  { id: "1", name: "Fix bug", body: "Please fix this bug:\n", tags: ["debug", "code"] },
  { id: "2", name: "Write tests", body: "Write unit tests for:\n", tags: ["testing"] },
  { id: "3", name: "Refactor module", body: "Refactor this for clarity:\n", tags: ["code", "cleanup"] },
];

describe("filterPrompts", () => {
  test('empty query returns every prompt unfiltered (browse mode for a bare "/")', () => {
    expect(filterPrompts(PROMPTS, "")).toEqual(PROMPTS);
  });

  test("matches by name substring", () => {
    expect(filterPrompts(PROMPTS, "bug").map((p) => p.id)).toEqual(["1"]);
  });

  test("matches by tag", () => {
    expect(filterPrompts(PROMPTS, "cleanup").map((p) => p.id)).toEqual(["3"]);
  });

  test("is case-insensitive", () => {
    expect(filterPrompts(PROMPTS, "BUG").map((p) => p.id)).toEqual(["1"]);
  });

  test("ranks an exact name match above a name-substring match", () => {
    const prompts = [
      { id: "b", name: "testing framework", tags: [] },
      { id: "a", name: "test", tags: [] },
    ];
    expect(filterPrompts(prompts, "test").map((p) => p.id)).toEqual(["a", "b"]);
  });

  test("ranks a name-prefix match above a plain substring match", () => {
    const prompts = [
      { id: "sub", name: "unit test helper", tags: [] },
      { id: "pre", name: "testing framework", tags: [] },
    ];
    expect(filterPrompts(prompts, "test").map((p) => p.id)).toEqual(["pre", "sub"]);
  });

  test("ranks a name match above a tag-only match", () => {
    const prompts = [
      { id: "tagOnly", name: "unrelated", tags: ["code"] },
      { id: "nameHit", name: "code review", tags: [] },
    ];
    expect(filterPrompts(prompts, "code").map((p) => p.id)).toEqual(["nameHit", "tagOnly"]);
  });

  test("no match returns an empty array", () => {
    expect(filterPrompts(PROMPTS, "zzz-nomatch")).toEqual([]);
  });

  test("tolerates missing/non-array prompts and a missing query", () => {
    expect(filterPrompts(undefined, "x")).toEqual([]);
    expect(filterPrompts(null, "")).toEqual([]);
    expect(filterPrompts(PROMPTS, undefined)).toEqual(PROMPTS);
  });

  test("tolerates prompts with missing name/tags fields", () => {
    const prompts = [{ id: "bare", body: "just a body" }];
    expect(filterPrompts(prompts, "")).toEqual(prompts);
    expect(filterPrompts(prompts, "zzz")).toEqual([]);
  });
});

describe("menuKeyAction", () => {
  // Audit-mandated pin: Enter with the menu OPEN must select — and that
  // decision is what lets the host skip its own Enter-to-send/start instead of
  // both firing (DockAssistant.jsx send() / AgentMode.jsx start()).
  test("Enter with the menu OPEN selects (does not reach the host's Enter-to-send)", () => {
    expect(menuKeyAction("Enter", true)).toBe("select");
  });

  test("Enter with the menu closed passes through to the host's Enter-to-send", () => {
    expect(menuKeyAction("Enter", false)).toBe("passthrough");
  });

  test("Escape with the menu open closes it", () => {
    expect(menuKeyAction("Escape", true)).toBe("close");
  });

  test("Escape with the menu closed is a no-op passthrough", () => {
    expect(menuKeyAction("Escape", false)).toBe("passthrough");
  });

  test("any other key passes through even while the menu is open (host owns Arrow handling separately)", () => {
    expect(menuKeyAction("ArrowDown", true)).toBe("passthrough");
    expect(menuKeyAction("ArrowUp", true)).toBe("passthrough");
    expect(menuKeyAction("a", true)).toBe("passthrough");
    expect(menuKeyAction("Tab", true)).toBe("passthrough");
  });

  // Quality-review fix: the menu can be legitimately OPEN with zero current
  // matches (rendering the "No saved prompts match" empty state). The old
  // 2-arg menuKeyAction reported "select" for Enter regardless, so the host
  // tried to insert `filtered[idx]` — undefined — and the keystroke vanished
  // silently instead of sending/starting. hasMatches defaults to true so every
  // existing 2-arg call above is unaffected.
  test("Enter with the menu open but zero matches passes through instead of a dead select", () => {
    expect(menuKeyAction("Enter", true, false)).toBe("passthrough");
  });

  test("Enter defaults hasMatches to true when the 3rd arg is omitted (back-compat)", () => {
    expect(menuKeyAction("Enter", true)).toBe("select");
  });

  test("Escape still closes even with zero matches (closing an empty menu isn't a trap)", () => {
    expect(menuKeyAction("Escape", true, false)).toBe("close");
  });
});

describe("clampIndex", () => {
  // THE single clamp both PromptSlashMenu's render highlight and
  // usePromptSlashMenu's Enter-selection call — this is what makes them
  // structurally unable to disagree (see the module comment in
  // PromptSlashMenu.jsx and hooks/usePromptSlashMenu.js for the bug this
  // replaced: two independently-written clamps that agreed only while the list
  // was stable).
  test("in-range index passes through unchanged", () => {
    expect(clampIndex(1, 3)).toBe(1);
  });

  test("a negative index clamps up to 0", () => {
    expect(clampIndex(-5, 3)).toBe(0);
  });

  test("an index at or past the end clamps down to the last valid index", () => {
    expect(clampIndex(2, 3)).toBe(2); // last valid index, unchanged
    expect(clampIndex(3, 3)).toBe(2); // one past the end
    expect(clampIndex(99, 3)).toBe(2); // the exact bug scenario: list shrank out from under a stale index
  });

  test("an empty or missing length clamps to 0", () => {
    expect(clampIndex(0, 0)).toBe(0);
    expect(clampIndex(5, 0)).toBe(0);
    expect(clampIndex(5, undefined)).toBe(0);
    expect(clampIndex(5, null)).toBe(0);
  });
});
