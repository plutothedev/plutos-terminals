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
// Fix round 1 (review of bd9eebc): one shake timer per project; the session's
// button is its name block, so the arrow, chips, cross and rename field are not
// inside a button; tag chips and the cross no longer take focus on a click.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, screen, act } from "@testing-library/react";

vi.mock("@backend", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), isTauri: () => true }));

import { readFileSync } from "node:fs";
import path from "node:path";
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

  test("each project's shake clears 420 ms after its own finish, however close the next finishes are", async () => {
    // Fix round 1: one clear timer for the whole set restarted whenever another
    // project joined the set, so finishes under 420 ms apart kept the first
    // project's class on until the run of finishes stopped.
    const four = [...projects, { id: "d", name: "Delta", path: "C:/d" }];
    act(() => { setProjectIndex(new Map([["pa", "a"], ["pb", "b"], ["pc", "c"], ["pd", "d"]])); });
    render(<ProjectSidebar projects={four} docked {...handlers()} />);
    act(() => { for (const id of ["pa", "pb", "pc", "pd"]) setPaneActivity(id, "active"); });
    act(() => { setPaneActivity("pa", "done"); }); // t = 0
    expect(shaking("Alpha")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    act(() => { setPaneActivity("pb", "done"); }); // t = 300
    await act(async () => { await vi.advanceTimersByTimeAsync(150); }); // t = 450
    expect(shaking("Alpha")).toBe(false);
    expect(shaking("Beta")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    act(() => { setPaneActivity("pc", "done"); }); // t = 600
    await act(async () => { await vi.advanceTimersByTimeAsync(150); }); // t = 750
    expect(shaking("Beta")).toBe(false);
    expect(shaking("Gamma")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    act(() => { setPaneActivity("pd", "done"); }); // t = 900
    await act(async () => { await vi.advanceTimersByTimeAsync(150); }); // t = 1050
    expect(shaking("Gamma")).toBe(false);
    expect(shaking("Delta")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); }); // t = 1350
    expect(shaking("Delta")).toBe(false);
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

  test("the session's button is its name, not the whole row, so the row's other controls are not inside it", () => {
    render(<ProjectSidebar projects={projects} docked {...handlers()} />);
    const btn = row("Alpha");
    // Nothing focusable or interactive nests inside the button (a button's
    // children are presentational to a screen reader).
    expect(btn.querySelector("[role=button], [tabindex], input, button")).toBeNull();
    // The row itself (the mouse, drag and right-click surface) is not a button.
    const outer = btn.closest("[title*='double-click to rename']");
    expect(outer).not.toBeNull();
    expect(outer.getAttribute("role")).not.toBe("button");
    expect(outer.hasAttribute("tabindex")).toBe(false);
    // The recent-files arrow is a sibling control, not a child of the button.
    const arrow = screen.getByRole("button", { name: "Recent files in Alpha" });
    expect(btn.contains(arrow)).toBe(false);
    expect(outer.contains(arrow)).toBe(true);
  });

  test("Enter or Space typed in the rename field never opens the session", async () => {
    const h = handlers();
    render(<ProjectSidebar projects={projects} docked {...h} />);
    fireEvent.doubleClick(row("Alpha"));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const input = document.activeElement;
    expect(input?.tagName).toBe("INPUT");
    fireEvent.keyDown(input, { key: " " });
    fireEvent.change(input, { target: { value: "Alpha 2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onClickProject).not.toHaveBeenCalled();
    expect(h.onRenameProject).toHaveBeenCalledWith("a", "Alpha 2");
  });

  test("in the collapsed rail (dots only) the row is the button and Enter opens it", () => {
    const h = handlers();
    render(<ProjectSidebar projects={projects} collapsed {...h} />);
    const dotRow = screen.getByRole("button", { name: "Alpha" });
    expect(dotRow.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(dotRow, { key: "Enter" });
    expect(h.onClickProject).toHaveBeenLastCalledWith("a");
  });

  test("a mouse press on a tag chip or the row's remove cross does not take focus", () => {
    // The browser moves focus on mousedown unless it is prevented; these
    // controls are tabIndex -1, so a click used to leave focus on them (an
    // invisible stop that a later Enter would re-fire) instead of where it was.
    const tagged = [{ id: "a", name: "Alpha", path: "C:/a", tags: ["prod"] }];
    render(<><input aria-label="elsewhere" /><ProjectSidebar projects={tagged} docked {...handlers()} /></>);
    const elsewhere = screen.getByLabelText("elsewhere");
    const pressLikeBrowser = (el) => {
      elsewhere.focus();
      const notPrevented = fireEvent.mouseDown(el);
      if (notPrevented) el.closest("[tabindex]")?.focus();
      fireEvent.mouseUp(el);
      return document.activeElement;
    };
    const chip = screen.getByRole("button", { name: "#prod" });
    expect(pressLikeBrowser(chip)).toBe(elsewhere);
    fireEvent.mouseEnter(chip.closest("[title*='double-click to rename']"));
    const cross = screen.getByRole("button", { name: "✕" });
    expect(pressLikeBrowser(cross)).toBe(elsewhere);
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

// Visual pass 2026-11-21: the global [role="button"]:focus-visible ring sits
// 2px OUTSIDE the element, and the sidebar is overflow:hidden, so on a
// full-width row (folder header; a session row in the collapsed rail) its left
// and right edges were cut off. Those rows get an inset ring instead. Only the
// :focus-visible state changes, so nothing moves at rest.
describe("keyboard focus ring on full-width sidebar rows", () => {
  const css = readFileSync(path.join(process.cwd(), "src/features/terminals/terminals.css"), "utf8").replace(/\r\n/g, "\n");
  // Comments removed first: a comment above a rule is part of its "selector"
  // text when the file is cut at each closing brace.
  const stripComments = (t) => {
    let out = "";
    let i = 0;
    for (;;) {
      const a = t.indexOf("/*", i);
      if (a < 0) return out + t.slice(i);
      out += t.slice(i, a);
      const e = t.indexOf("*/", a + 2);
      i = e < 0 ? t.length : e + 2;
    }
  };
  const rules = stripComments(css);
  // The declarations of every rule whose selector list names this selector.
  const declsFor = (selector) => rules.split("}").filter((chunk) => {
    const head = chunk.slice(0, chunk.indexOf("{"));
    return head.split(",").map((x) => x.trim()).includes(selector);
  }).map((chunk) => chunk.slice(chunk.indexOf("{") + 1));
  // Inset, with a selector more specific than the global (0,2,0) rule, so it
  // wins whatever order the two stylesheets load in.
  test.each([
    ".phn-sidebar .phn-folder-header:focus-visible",
    '.phn-sidebar .phn-session-row[role="button"]:focus-visible',
  ])("%s draws its ring inside the row", (selector) => {
    const decls = declsFor(selector).join(";");
    expect(decls).toContain("outline-offset: -2px");
  });

  test("the folder header and a collapsed-rail row carry those classes inside .phn-sidebar", () => {
    const { unmount } = render(<ProjectSidebar projects={projects} docked {...handlers()} />);
    const header = screen.getByRole("button", { name: /Work/ });
    expect(header.classList.contains("phn-folder-header")).toBe(true);
    expect(header.closest(".phn-sidebar")).not.toBeNull();
    unmount();
    render(<ProjectSidebar projects={projects} collapsed {...handlers()} />);
    const dotRow = screen.getByRole("button", { name: "Alpha" });
    expect(dotRow.classList.contains("phn-session-row")).toBe(true);
    expect(dotRow.closest(".phn-sidebar")).not.toBeNull();
  });

  test("the shake class still rides the row alongside it", () => {
    act(() => { setPaneActivity("pa", "active"); });
    render(<ProjectSidebar projects={projects} collapsed {...handlers()} />);
    act(() => { setPaneActivity("pa", "done"); });
    const dotRow = screen.getByRole("button", { name: "Alpha" });
    expect(dotRow.classList.contains("tg-shake")).toBe(true);
    expect(dotRow.classList.contains("phn-session-row")).toBe(true);
  });
});
