// (C)
// @vitest-environment happy-dom
import { describe, test, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import CollapsedRail from "./CollapsedRail.jsx";

afterEach(cleanup);

const mount = (onExpand = () => {}) =>
  render(<CollapsedRail glyph="›" label="Sessions" title="Show sessions panel" onExpand={onExpand} />);

describe("CollapsedRail: the expand half of A11Y-02", () => {
  test("is a button in the tab order, named by its title, not by the decorative caption", () => {
    mount();
    const rail = screen.getByRole("button", { name: "Show sessions panel" });
    expect(rail.tabIndex).toBe(0);
    expect(rail.getAttribute("aria-label")).toBe("Show sessions panel");
    expect(rail.querySelector(".lbl").getAttribute("aria-hidden")).toBe("true");
  });

  test("Enter, Space and click expand; other keys do not, and the activating keys are swallowed", () => {
    const onExpand = vi.fn();
    mount(onExpand);
    const rail = screen.getByRole("button", { name: "Show sessions panel" });
    const enter = fireEvent.keyDown(rail, { key: "Enter" });
    const space = fireEvent.keyDown(rail, { key: " " });
    fireEvent.keyDown(rail, { key: "ArrowDown" });
    fireEvent.keyDown(rail, { key: "Tab" });
    fireEvent.keyDown(rail, { key: "Escape" });
    expect(onExpand).toHaveBeenCalledTimes(2);
    // fireEvent returns false when preventDefault was called: Space must not
    // scroll the terminal grid underneath the rail.
    expect(enter).toBe(false);
    expect(space).toBe(false);
    fireEvent.click(rail);
    expect(onExpand).toHaveBeenCalledTimes(3);
  });
});
