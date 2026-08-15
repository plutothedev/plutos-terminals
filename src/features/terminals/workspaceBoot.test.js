// (C)
import { describe, test, expect } from "vitest";
import { parseWorkspace } from "./workspaceBoot.js";

describe("parseWorkspace", () => {
  test("absent / empty is empty state, not corruption", () => {
    expect(parseWorkspace(null)).toEqual({ state: {}, corrupt: false });
    expect(parseWorkspace("")).toEqual({ state: {}, corrupt: false });
  });

  test("valid object parses through", () => {
    const r = parseWorkspace('{"panels":[1,2],"skin":"oled"}');
    expect(r.corrupt).toBe(false);
    expect(r.state).toEqual({ panels: [1, 2], skin: "oled" });
  });

  test("the Rust store 'null' sentinel is empty, not corrupt", () => {
    expect(parseWorkspace("null")).toEqual({ state: {}, corrupt: false });
  });

  test("valid-but-non-object JSON is empty, not corrupt", () => {
    expect(parseWorkspace("42")).toEqual({ state: {}, corrupt: false });
    expect(parseWorkspace('"a string"')).toEqual({ state: {}, corrupt: false });
  });

  test("a non-empty string that fails to parse IS corruption", () => {
    const r = parseWorkspace('{"panels":[1,2],"skin":'); // truncated
    expect(r.corrupt).toBe(true);
    expect(r.state).toEqual({});
  });
});
