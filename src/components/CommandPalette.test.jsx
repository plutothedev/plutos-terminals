// (C)
// @vitest-environment happy-dom
// A11Y-06: the command palette's arrow-key highlight must be scrolled into
// view.
//
// WHY THIS IS A REAL BUG AND NOT A POLISH ITEM. The result list is a 360px box
// (CommandPalette.jsx) and a row is ~62-68px, so about five of the ~33 commands
// are on screen at once. Holding ArrowDown moved a highlight that had already
// left the viewport: every visible row looked unselected, the palette read as
// frozen, and Enter fired whatever invisible row the counter had landed on,
// with the shipped ordering that includes "Reset workspace" near the end.
//
// WHY THE TEST IS SHAPED LIKE THIS. It renders the REAL component and asserts
// on which DOM NODE scrollIntoView was invoked against, matched back to the
// command label a user would see highlighted. It deliberately does not import,
// re-implement or assert on any scroll helper, because there isn't one and
// there must not be: three tests in this repo have shipped asserting against a
// copy of the logic they were meant to guard. Removing `data-idx`, removing the
// list ref, dropping the effect, or scrolling the wrong index each turn this
// red, and each of those is exactly one of the ways the bug came back.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

import CommandPalette from "./CommandPalette.jsx";

// Records (element, options) per call. happy-dom does not implement scrolling,
// so this is an install rather than a spy over an existing method. Asserting
// on the receiver is the whole point, hence a plain function over vi.spyOn.
let calls = [];
function installScrollProbe() {
  calls = [];
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function scrollIntoView(opts) {
      calls.push({ el: this, opts });
    },
  });
}

const cmds = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `cmd-${i}`,
    label: `Command ${i}`,
    hint: `does thing ${i}`,
    action: vi.fn(),
  }));

/** The palette's search box: the element that owns the arrow-key handler. */
const searchBox = () => document.querySelector('input[type="text"]');
const arrowDown = () => fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
const arrowUp = () => fireEvent.keyDown(searchBox(), { key: "ArrowUp" });
const last = () => calls[calls.length - 1];

/** Label text of the row the component chose to scroll to, as a user sees it. */
const scrolledLabel = () => last()?.el?.textContent?.match(/Command \d+/)?.[0] ?? null;

beforeEach(installScrollProbe);
afterEach(cleanup);

describe("CommandPalette keeps the highlighted row on screen (A11Y-06)", () => {
  test("the highlight is scrolled into view on open", () => {
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    expect(calls.length).toBeGreaterThan(0);
    expect(scrolledLabel()).toBe("Command 0");
  });

  test("every ArrowDown scrolls the row that is now highlighted", () => {
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    // Far past the ~5 rows that fit in the 360px box: row 12 is the case the
    // finding is about, where the old build left the selection below the fold.
    for (let i = 1; i <= 12; i++) {
      arrowDown();
      expect(scrolledLabel(), `after ${i} ArrowDown press(es)`).toBe(`Command ${i}`);
    }
  });

  test("ArrowUp scrolls back the other way", () => {
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    for (let i = 0; i < 9; i++) arrowDown();
    expect(scrolledLabel()).toBe("Command 9");
    for (let i = 0; i < 4; i++) arrowUp();
    expect(scrolledLabel()).toBe("Command 5");
  });

  test('scrolls with block:"nearest" so the palette does not jump the page', () => {
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    arrowDown();
    expect(last().opts).toEqual({ block: "nearest" });
  });

  test("the scrolled node is the highlighted row, not merely a row", () => {
    // The highlight is drawn with an accent border; if the effect ever scrolls
    // a different row than the one it paints, the user is back to guessing.
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    for (let i = 0; i < 7; i++) arrowDown();
    const el = last().el;
    expect(el.getAttribute("data-idx")).toBe("7");
    expect(el.style.border).not.toContain("transparent");
  });

  test("filtering re-targets the scroll at whatever row the index now means", () => {
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    for (let i = 0; i < 6; i++) arrowDown();
    expect(scrolledLabel()).toBe("Command 6");
    // Typing does NOT reset the highlight in this component (unlike
    // HistorySearch, which zeroes it on every keystroke); it only clamps.
    // "Command 2" matches 2 and 20-29, so index 6 of the filtered list is
    // "Command 25": a different NODE wearing the same data-idx. That is
    // precisely why filtered.length is a dependency of the scroll effect;
    // without it the box stays parked on the old row's position.
    fireEvent.change(searchBox(), { target: { value: "Command 2" } });
    expect(scrolledLabel()).toBe("Command 25");
  });

  test("a highlight clamped by a shrinking list still gets scrolled", () => {
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    for (let i = 0; i < 20; i++) arrowDown();
    expect(scrolledLabel()).toBe("Command 20");
    // One match only: the clamp drops the highlight from 20 to 0, and the
    // surviving row has to be scrolled to or the box is left where it was.
    fireEvent.change(searchBox(), { target: { value: "Command 17" } });
    expect(scrolledLabel()).toBe("Command 17");
  });
});

describe("CommandPalette announces the highlight to assistive tech (A11Y-06)", () => {
  // Scrolling the highlight into view is only half the finding: it fixes the
  // sighted keyboard user. A screen-reader user perceives an arrow-key
  // selection only through aria-activedescendant, because focus never leaves
  // the search box. Without it the palette is silent past the first row.
  const byId = (id) => [...document.querySelectorAll("[id]")].find((n) => n.id === id) || null;
  const active = () => byId(searchBox().getAttribute("aria-activedescendant"));
  // Exact label, not a substring: "Command 1" is a prefix of "Command 12", so
  // a toContain() assertion here would pass for the wrong row.
  const activeLabel = () => active()?.textContent?.match(/Command \d+/)?.[0] ?? null;

  test("the search box is a combobox owning the results list", () => {
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    const input = searchBox();
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const list = byId(input.getAttribute("aria-controls"));
    expect(list).not.toBeNull();
    expect(list.getAttribute("role")).toBe("listbox");
  });

  test("aria-activedescendant follows the arrow keys onto the right row", () => {
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    expect(activeLabel()).toBe("Command 0");
    for (let i = 1; i <= 7; i++) {
      arrowDown();
      expect(activeLabel(), `after ${i} press(es)`).toBe(`Command ${i}`);
    }
    arrowUp();
    expect(activeLabel()).toBe("Command 6");
  });

  test("the announced row is the same row that is painted and scrolled", () => {
    // Three views of one selection (aria, the highlight style, and the scroll
    // target) must not be allowed to drift apart.
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    for (let i = 0; i < 9; i++) arrowDown();
    const el = active();
    expect(el.getAttribute("aria-selected")).toBe("true");
    expect(el.getAttribute("data-idx")).toBe("9");
    expect(el).toBe(last().el);
    const selected = [...document.querySelectorAll('[role="option"][aria-selected="true"]')];
    expect(selected).toHaveLength(1);
  });

  test("every row is an option and only the highlight is selected", () => {
    render(<CommandPalette open commands={cmds(6)} onClose={() => {}} />);
    const opts = [...document.querySelectorAll('[role="option"]')];
    expect(opts).toHaveLength(6);
    expect(opts.map((o) => o.getAttribute("aria-selected")))
      .toEqual(["true", "false", "false", "false", "false", "false"]);
  });

  test("an empty result set is not announced as an empty listbox", () => {
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    fireEvent.change(searchBox(), { target: { value: "no such command" } });
    const input = searchBox();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    expect(byId(input.getAttribute("aria-controls")).getAttribute("role")).toBeNull();
  });
});

describe("CommandPalette hover cannot outvote the arrow keys (A11Y-06 follow-on)", () => {
  // The scroll fix above created this one. Before it the list never moved, so
  // a pointer parked over the palette produced no further boundary events;
  // now every ArrowDown past the fold drags a ~59px row under a cursor that
  // never moved, the browser re-hit-tests after the scroll and replays pointer
  // state onto whatever landed there, and a plain `onMouseEnter` handler would
  // hand the highlight to that row. The user then presses Enter on a command
  // they did not choose, in the palette that carries "Reset workspace".
  //
  // These assertions drive the REAL component through the same event sequence
  // the browser produces, and read the selection off the rendered aria, not
  // off any state the component exposes.
  const rows = () => [...document.querySelectorAll('[role="option"]')];
  const selected = () =>
    rows().findIndex((r) => r.getAttribute("aria-selected") === "true");
  /** One pointer sample over row `i`. Coordinates are the whole point. */
  const point = (i, x, y) => fireEvent.mouseMove(rows()[i], { clientX: x, clientY: y });

  test("a row that slides under a stationary pointer cannot take the highlight", () => {
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    // The cursor arrives over row 3 and stops there.
    point(3, 120, 300);
    point(3, 121, 300);
    expect(selected()).toBe(3);

    // ArrowDown: the user picks row 4 and the effect scrolls. The replayed
    // pointer lands on row 2 at the SAME coordinates, because the content
    // moved and the mouse did not.
    arrowDown();
    expect(selected()).toBe(4);
    point(2, 121, 300);
    expect(selected()).toBe(4);

    // And it holds for a run of them, which is how the bug is actually hit.
    for (const row of [1, 0, 1]) {
      arrowDown();
      point(row, 121, 300);
    }
    expect(selected()).toBe(7);
  });

  test("moving the pointer onto a row still highlights it", () => {
    // The gate must not cost hover. Two samples: the first only records where
    // the pointer is, the second is movement.
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    point(5, 200, 260);
    point(5, 200, 261);
    expect(selected()).toBe(5);
  });

  test("the first real move after arrowing wins immediately", () => {
    // A keyboard-mode flag cleared by mousemove would have swallowed this,
    // because the browser dispatches boundary events ahead of the mousemove
    // that would clear it. Movement, not modality, is the gate.
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    point(3, 120, 300);
    point(3, 121, 300);
    arrowDown();
    arrowDown();
    expect(selected()).toBe(5);
    point(2, 121, 300);   // replayed by the scroll, ignored
    point(2, 121, 318);   // the user actually moved
    expect(selected()).toBe(2);
  });

  test("mouseenter alone does not move the selection", () => {
    // The regression guard proper: reinstating onMouseEnter turns this red.
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    fireEvent.mouseEnter(rows()[8]);
    expect(selected()).toBe(0);
  });

  test("the pointer's first appearance is a position sample, not a selection", () => {
    // Opening the palette under a resting cursor replays pointer state onto
    // the rows that just mounted. With no earlier sample there is nothing to
    // compare against, so that first event cannot be told apart from a real
    // move and must not be trusted with the selection.
    render(<CommandPalette open commands={cmds(30)} onClose={() => {}} />);
    point(6, 120, 300);
    expect(selected()).toBe(0);
  });

  test("reopening the palette re-arms the position sample", () => {
    const view = (open) =>
      <CommandPalette open={open} commands={cmds(30)} onClose={() => {}} />;
    const { rerender } = render(view(true));
    point(2, 500, 400);
    point(2, 501, 400);
    expect(selected()).toBe(2);

    rerender(view(false));
    rerender(view(true));
    // The cursor is somewhere else entirely now. A replay landing on row 6
    // must not read as movement merely by differing from last open's sample.
    point(6, 120, 300);
    expect(selected()).toBe(0);
  });
});
