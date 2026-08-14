// (C)
// @vitest-environment jsdom
import { describe, test, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { formatWindowTitle, useWindowTitle } from "./independentEffects.js";

describe("formatWindowTitle", () => {
  test("active tab label leads, app name trails (MobaXterm-style)", () => {
    expect(formatWindowTitle("ssh: root@vps")).toBe("ssh: root@vps - Pluto's Terminal");
  });

  test("no label falls back to the bare app name", () => {
    expect(formatWindowTitle(null)).toBe("Pluto's Terminal");
    expect(formatWindowTitle(undefined)).toBe("Pluto's Terminal");
    expect(formatWindowTitle("")).toBe("Pluto's Terminal");
  });

  test("whitespace-only label treated as absent", () => {
    expect(formatWindowTitle("   ")).toBe("Pluto's Terminal");
  });
});

describe("useWindowTitle", () => {
  test("mirrors the active tab label into document.title and tracks changes", () => {
    const { rerender, unmount } = renderHook(({ l }) => useWindowTitle(l), {
      initialProps: { l: "Notebook" },
    });
    expect(document.title).toBe("Notebook - Pluto's Terminal");
    rerender({ l: "ssh: root@vps" });
    expect(document.title).toBe("ssh: root@vps - Pluto's Terminal");
    rerender({ l: null });
    expect(document.title).toBe("Pluto's Terminal");
    unmount();
  });
});
