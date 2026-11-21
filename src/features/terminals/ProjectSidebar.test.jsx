// (C)
// @vitest-environment happy-dom
//
// Pins what the 2026-11-20 lint pass changed in ProjectSidebar:
//
// - The "finished" shake (tg-shake) is detected during render and cleared by
//   its own timer. The old effect cleared the timer whenever ANY project's
//   activity changed, so a second project flipping within 420 ms left the
//   first one's class on for good, and that project never shook again.
// - Session rows and folder headers are keyboard controls (role=button,
//   Enter/Space), the colour swatches in the right-click menu too.
// - Double-click rename still focuses and selects the rename field.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, screen, act } from "@testing-library/react";

vi.mock("@backend", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), isTauri: () => true }));

import ProjectSidebar from "./ProjectSidebar.jsx";
import { setPaneActivity, setProjectIndex, __resetActivityStore } from "./activityStore.js";

const noop = () => {};
const handlers = () => ({
  onToggleCollapse: noop, onCollapse: noop, onClickProject: vi.fn(), onAddProject: noop,
  onRemoveProject: vi.fn(), onEditProject: vi.fn(), onColorProject: vi.fn(), onRenameProject: vi.fn(),
  onDropProject: noop, onRunScript: noop, onForgetPassword: noop, onSetFolder: noop, onNewWorktreeAgent: noop,
});
const projects = [
  { id: "a", name: "Alpha", path: "C:/a" },
  { id: "b", name: "Beta", path: "C:/b" },
  { id: "c", name: "Gamma", path: "C:/c", folder: "Work" },
];
const row = (name) => screen.getByRole("button", { name });
// Found by text, not by role, so the same check runs against the pre-fix markup.
const shaking = (name) => screen.getByText(name).closest(".tg-shake") !== null;

beforeEach(() => {
  __resetActivityStore();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  act(() => { setProjectIndex(new Map([["pa", "a"], ["pb", "b"]])); });
});
afterEach(() => { cleanup(); vi.useRealTimers(); __resetActivityStore(); });

describe("the finished shake", () => {
  test("a project going active -> done shakes, then the class clears", async () => {
    render(<ProjectSidebar projects={projects} docked {...handlers()} />);
    act(() => { setPaneActivity("pa", "active"); });
    expect(shaking("Alpha")).toBe(false);
    act(() => { setPaneActivity("pa", "done"); });
    expect(shaking("Alpha")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(shaking("Alpha")).toBe(false);
  });

  test("another project's activity changing meanwhile does not leave the class stuck", async () => {
    render(<ProjectSidebar projects={projects} docked {...handlers()} />);
    act(() => { setPaneActivity("pa", "active"); });
    act(() => { setPaneActivity("pa", "done"); });
    expect(shaking("Alpha")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    act(() => { setPaneActivity("pb", "active"); }); // unrelated flip inside the 420 ms
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(shaking("Alpha")).toBe(false);
    // And it shakes again on its next finish.
    act(() => { setPaneActivity("pa", "active"); });
    act(() => { setPaneActivity("pa", "done"); });
    expect(shaking("Alpha")).toBe(true);
  });

  test("done without having been active does not shake", () => {
    render(<ProjectSidebar projects={projects} docked {...handlers()} />);
    act(() => { setPaneActivity("pa", "done"); });
    expect(shaking("Alpha")).toBe(false);
  });
});

describe("keyboard access", () => {
  test("Enter or Space on a session row opens it; other keys do not", () => {
    const h = handlers();
    render(<ProjectSidebar projects={projects} docked {...h} />);
    const alpha = row("Alpha");
    expect(alpha.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(alpha, { key: "Enter" });
    expect(h.onClickProject).toHaveBeenLastCalledWith("a");
    fireEvent.keyDown(row("Beta"), { key: " " });
    expect(h.onClickProject).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(alpha, { key: "x" });
    expect(h.onClickProject).toHaveBeenCalledTimes(2);
  });

  test("a folder header toggles with Enter/Space and reports its state", () => {
    render(<ProjectSidebar projects={projects} docked {...handlers()} />);
    const header = screen.getByRole("button", { name: /Work/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("button", { name: "Gamma" })).not.toBeNull();
    fireEvent.keyDown(header, { key: "Enter" });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Gamma" })).toBeNull();
    fireEvent.click(header);
    expect(screen.queryByRole("button", { name: "Gamma" })).not.toBeNull();
  });

  test("a colour swatch in the right-click menu works from the keyboard", () => {
    const h = handlers();
    render(<ProjectSidebar projects={projects} docked {...h} />);
    fireEvent.contextMenu(row("Alpha"));
    fireEvent.keyDown(screen.getByRole("button", { name: "Color: green" }), { key: "Enter" });
    expect(h.onColorProject).toHaveBeenCalledWith("a", "green");
    fireEvent.contextMenu(row("Alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Clear color" }));
    expect(h.onColorProject).toHaveBeenLastCalledWith("a", null);
  });
});

describe("rename", () => {
  test("double-click focuses and selects the rename field", async () => {
    render(<ProjectSidebar projects={projects} docked {...handlers()} />);
    fireEvent.doubleClick(row("Alpha"));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const input = document.activeElement;
    expect(input?.tagName).toBe("INPUT");
    expect(input.value).toBe("Alpha");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
  });
});
