// (C)
// @vitest-environment happy-dom
//
// The terminal tab strip's keyboard contract (audit A11Y-05, DOM half) and the
// invariant that pays for it (invariant 1: PTYs survive React).
//
// These render the REAL TerminalPanel. TerminalPane is the only child that is
// mocked, and it is mocked to be a MOUNT COUNTER rather than a stub, because
// the thing most likely to break here is not the ARIA attributes. It is a
// future refactor that reaches for useState to track the focused tab and
// silently starts remounting live panes on every arrow keypress. A test that
// only read role="tab" off the DOM would not notice that at all.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useEffect, useState } from "react";

// Per-pane mount ledger. TerminalPane's real module pulls in xterm, the pane
// registry and the Tauri bridge; none of that can run here, and none of it is
// what these tests are about.
const { mounts, unmounts } = vi.hoisted(() => ({ mounts: new Map(), unmounts: new Map() }));
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

vi.mock("./TerminalPane", () => ({
  default: ({ tabId }) => {
    useEffect(() => {
      bump(mounts, tabId);
      return () => bump(unmounts, tabId);
    }, [tabId]);
    return <div data-testid={`pane-body-${tabId}`} />;
  },
  todayDate: () => "2026-08-21",
  transcriptName: (project, tabId) => `${project || "tab"}-${tabId}`,
}));
vi.mock("@backend", () => ({ invoke: vi.fn(async () => ""), listen: vi.fn(async () => () => {}), isTauri: () => true }));
vi.mock("./VncView", () => ({ default: () => <div /> }));
vi.mock("./RdpView", () => ({ default: () => <div /> }));
vi.mock("./MobaHomeScreen", () => ({ default: () => <div /> }));
vi.mock("./NotebookView", () => ({ default: () => <div /> }));
vi.mock("./ShareModal.jsx", () => ({ default: () => <div /> }));
vi.mock("../../components/ErrorBoundary.jsx", () => ({ PaneBoundary: ({ children }) => <>{children}</> }));

import TerminalPanel, { swatchRing, SWATCH_CLEAR_GLYPH } from "./TerminalPanel.jsx";
import { shouldPaneTakeFocus, releaseTabStripFocus } from "./tabStripFocus.js";

const mkTab = (id, label, extra = {}) => ({ id, label, ...extra });

/**
 * Harness: holds the one piece of state TerminalPanel does not own (which tab
 * is active) so a switch actually re-renders, the way TerminalsTab's reducer
 * does in the app. The spies record what the panel asked for.
 */
function Harness({ tabs, onSwitchTab, onCloseTab, onAddTab, ...rest }) {
  const [activeTabId, setActiveTabId] = useState(tabs[0].id);
  const [closed, setClosed] = useState([]);
  const live = tabs.filter((t) => !closed.includes(t.id));
  return (
    <TerminalPanel
      panel={{ id: "panel_1", activeTabId, tabs: live }}
      isActive
      canClosePanel
      xtermTheme={{ background: "#000" }}
      onActivate={() => {}}
      onAddTab={onAddTab}
      onCloseTab={(panelId, tabId) => { onCloseTab?.(panelId, tabId); setClosed((c) => [...c, tabId]); }}
      onSwitchTab={(panelId, tabId) => { onSwitchTab?.(panelId, tabId); setActiveTabId(tabId); }}
      onClosePanel={() => {}}
      onTabCostUpdate={() => {}}
      onRenameTab={() => {}}
      onSetTabColor={() => {}}
      onDuplicateTab={() => {}}
      onDetachTab={() => {}}
      onCloseOthers={() => {}}
      {...rest}
    />
  );
}

function mount(tabs, spies = {}) {
  return render(<Harness tabs={tabs} {...spies} />);
}

const tabEls = () => [...document.querySelectorAll('[role="tab"].moba-tab')];
const tabEl = (id) => tabEls().find((el) => el.dataset.tabId === id);
// One macrotask. The rename editor focuses itself, and gives focus back, on a
// deferred task rather than inline (see refocusTabAfterRename), so a
// synchronous assertion would read the instant before either happened.
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { mounts.clear(); unmounts.clear(); });
afterEach(cleanup);

describe("tab strip semantics (A11Y-05)", () => {
  test("the strip is a tablist and every tab is a tab with aria-selected", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")]);
    const strip = document.querySelector('[role="tablist"].moba-tabstrip');
    expect(strip).toBeTruthy();
    expect(tabEls()).toHaveLength(3);
    expect(tabEl("t1").getAttribute("aria-selected")).toBe("true");
    expect(tabEl("t2").getAttribute("aria-selected")).toBe("false");
  });

  test("roving tabIndex: exactly one tab is in the tab order, and it is the selected one", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")]);
    const tabbable = tabEls().filter((el) => el.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].dataset.tabId).toBe("t1");
    expect(tabEl("t2").tabIndex).toBe(-1);

    fireEvent.keyDown(tabEl("t1"), { key: "ArrowRight" });
    const after = tabEls().filter((el) => el.tabIndex === 0);
    expect(after).toHaveLength(1);
    expect(after[0].dataset.tabId).toBe("t2");
  });

  test("a stale activeTabId still leaves the strip reachable", () => {
    // If nothing matched, the whole strip would drop out of the tab order and
    // the keyboard route would be gone again.
    render(
      <TerminalPanel
        panel={{ id: "p", activeTabId: "gone", tabs: [mkTab("t1", "one"), mkTab("t2", "two")] }}
        isActive canClosePanel xtermTheme={{ background: "#000" }}
        onActivate={() => {}} onAddTab={() => {}} onCloseTab={() => {}} onSwitchTab={() => {}}
        onClosePanel={() => {}} onTabCostUpdate={() => {}} onRenameTab={() => {}}
        onDuplicateTab={() => {}} onDetachTab={() => {}} onCloseOthers={() => {}}
      />
    );
    expect(tabEls().filter((el) => el.tabIndex === 0)).toHaveLength(1);
  });

  test("each tab points at its own tabpanel, and the panel points back", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    const controls = tabEl("t2").getAttribute("aria-controls");
    const panelEl = document.getElementById(controls);
    expect(panelEl).toBeTruthy();
    expect(panelEl.getAttribute("role")).toBe("tabpanel");
    expect(panelEl.getAttribute("aria-labelledby")).toBe(tabEl("t2").id);
  });

  test("the tab's name is its label alone, not its label plus the close button's", () => {
    mount([mkTab("t1", "api-server"), mkTab("t2", "two")]);
    expect(tabEl("t1").getAttribute("aria-label")).toBe("api-server");
  });

  test("a split tab announces its pane count", () => {
    mount([
      mkTab("t1", "api-server", { layout: { id: "s1", dir: "row", ratio: 0.5, a: { id: "t1" }, b: { id: "p2" } } }),
      mkTab("t2", "two"),
    ]);
    expect(tabEl("t1").getAttribute("aria-label")).toBe("api-server, 2 panes");
  });

  test("close, new-tab and close-panel all have real accessible names", () => {
    mount([mkTab("t1", "api-server"), mkTab("t2", "two")]);
    expect(screen.getByLabelText("Close api-server")).toBeTruthy();
    expect(screen.getByLabelText("New tab in this panel")).toBeTruthy();
    expect(screen.getByLabelText("Close this panel")).toBeTruthy();
  });
});

describe("tab strip keyboard navigation (A11Y-05)", () => {
  test("ArrowRight selects and focuses the next tab", () => {
    const onSwitchTab = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")], { onSwitchTab });
    fireEvent.keyDown(tabEl("t1"), { key: "ArrowRight" });
    expect(onSwitchTab).toHaveBeenCalledWith("panel_1", "t2");
    expect(document.activeElement).toBe(tabEl("t2"));
  });

  test("ArrowRight wraps from the last tab to the first", () => {
    const onSwitchTab = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two")], { onSwitchTab });
    fireEvent.keyDown(tabEl("t1"), { key: "ArrowRight" });
    fireEvent.keyDown(tabEl("t2"), { key: "ArrowRight" });
    expect(onSwitchTab).toHaveBeenLastCalledWith("panel_1", "t1");
    expect(document.activeElement).toBe(tabEl("t1"));
  });

  test("ArrowLeft wraps backwards from the first tab to the last", () => {
    const onSwitchTab = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")], { onSwitchTab });
    fireEvent.keyDown(tabEl("t1"), { key: "ArrowLeft" });
    expect(onSwitchTab).toHaveBeenCalledWith("panel_1", "t3");
    expect(document.activeElement).toBe(tabEl("t3"));
  });

  test("Home and End jump to the ends", () => {
    const onSwitchTab = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")], { onSwitchTab });
    fireEvent.keyDown(tabEl("t1"), { key: "End" });
    expect(onSwitchTab).toHaveBeenLastCalledWith("panel_1", "t3");
    fireEvent.keyDown(tabEl("t3"), { key: "Home" });
    expect(onSwitchTab).toHaveBeenLastCalledWith("panel_1", "t1");
    expect(document.activeElement).toBe(tabEl("t1"));
  });

  test("Enter activates the focused tab without moving", () => {
    const onSwitchTab = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two")], { onSwitchTab });
    fireEvent.keyDown(tabEl("t2"), { key: "Enter" });
    expect(onSwitchTab).toHaveBeenCalledWith("panel_1", "t2");
  });

  test("Delete closes the focused tab and leaves focus on its neighbour", () => {
    const onCloseTab = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")], { onCloseTab });
    fireEvent.keyDown(tabEl("t2"), { key: "Delete" });
    expect(onCloseTab).toHaveBeenCalledWith("panel_1", "t2");
    expect(document.activeElement).toBe(tabEl("t3"));
    expect(document.activeElement).not.toBe(document.body);
  });

  test("Delete is inert on the last remaining tab", () => {
    const onCloseTab = vi.fn();
    mount([mkTab("t1", "one")], { onCloseTab });
    fireEvent.keyDown(tabEl("t1"), { key: "Delete" });
    expect(onCloseTab).not.toHaveBeenCalled();
  });

  test("the close button activates on Enter and keeps focus in the strip", () => {
    const onCloseTab = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two")], { onCloseTab });
    fireEvent.keyDown(screen.getByLabelText("Close one"), { key: "Enter" });
    expect(onCloseTab).toHaveBeenCalledWith("panel_1", "t1");
    expect(document.activeElement).toBe(tabEl("t2"));
  });

  test("the new-tab + activates on Space", () => {
    const onAddTab = vi.fn();
    mount([mkTab("t1", "one")], { onAddTab });
    fireEvent.keyDown(screen.getByLabelText("New tab in this panel"), { key: " " });
    expect(onAddTab).toHaveBeenCalledWith("panel_1");
  });

  test("F2 opens the inline rename editor on the focused tab", async () => {
    // Shipped untested: deleting the whole `case "F2"` block from
    // handleTabKeyDown left every test in this file green, so the one rename
    // route a keyboard user has could have gone out in a bad merge in silence.
    // Double-click, its mouse twin, was covered. F2 was not.
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    expect(screen.queryByLabelText("Rename tab")).toBeNull();
    fireEvent.keyDown(tabEl("t1"), { key: "F2" });
    const input = screen.getByLabelText("Rename tab");
    expect(input.value).toBe("one");
    await tick();
    expect(document.activeElement).toBe(input);
  });

  test("Enter commits the rename and hands focus back to the tab, not <body>", async () => {
    // A browser moves focus nowhere when the focused node is removed, so
    // unmounting the input dropped the keyboard user out of every control in
    // the app: no tab, no strip, nothing left to arrow from.
    const onRenameTab = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two")], { onRenameTab });
    fireEvent.keyDown(tabEl("t1"), { key: "F2" });
    const input = screen.getByLabelText("Rename tab");
    // The editor focuses itself on a deferred task, so wait for it: pressing
    // Enter at an input that never held focus cannot exercise its onBlur, and
    // onBlur is half of what makes the commit path delicate.
    await tick();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "api-server" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameTab).toHaveBeenCalledTimes(1);
    expect(onRenameTab).toHaveBeenCalledWith("t1", "api-server");
    await tick();
    expect(document.activeElement).toBe(tabEl("t1"));
    expect(document.activeElement).not.toBe(document.body);
  });

  test("Escape cancels without committing, and still hands focus back", async () => {
    // The deferral in refocusTabAfterRename is load-bearing here: focusing the
    // tab while the input is still mounted blurs it, and the input's onBlur IS
    // commitRename, reading a `renamingId` React has not cleared yet. An inline
    // refocus would make Escape save the edit it was cancelling.
    const onRenameTab = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two")], { onRenameTab });
    fireEvent.keyDown(tabEl("t1"), { key: "F2" });
    const input = screen.getByLabelText("Rename tab");
    // Focus really has to be IN the input, or the tab-focus call below cannot
    // blur it and the ordering this test exists for is never exercised.
    await tick();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "should-not-stick" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRenameTab).not.toHaveBeenCalled();
    await tick();
    expect(document.activeElement).toBe(tabEl("t1"));
  });

  test("arrow keys typed into the inline rename input do NOT move between tabs", () => {
    // The input is a CHILD of the tab, so its keydown bubbles through the tab's
    // handler. Without the renaming guard, editing a tab name would jump tabs
    // on every ArrowLeft.
    const onSwitchTab = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two")], { onSwitchTab });
    fireEvent.doubleClick(tabEl("t1"));
    const input = screen.getByLabelText("Rename tab");
    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    fireEvent.keyDown(input, { key: "Home" });
    expect(onSwitchTab).not.toHaveBeenCalled();
  });
});

describe("tab context menu has a keyboard exit (A11Y-12)", () => {
  // Focusable tabs opened a route into this menu that did not exist before the
  // roving tabIndex: Chromium dispatches `contextmenu` at the FOCUSED element
  // for the Menu key and Shift+F10. The menu's only dismissals were the
  // backdrop's onMouseDown and onContextMenu, both mouse-only, and the backdrop
  // blocks pointer events rather than keys, so a keyboard user could open a
  // menu they could not close while the arrows kept switching tabs underneath
  // it. `fireEvent.contextMenu` on the tab is exactly what that key produces.
  //
  // The first pass at that fix left two holes, which the tests below pin: it
  // listened for Escape ON THE MENU ELEMENT, so the exit died the moment focus
  // moved off it, and Tab moved focus off it in ONE keypress because Tab was
  // also the only way to reach five of the menu's six items. Escape is now a
  // window listener scoped to the topmost menu, arrows do the walking, and Tab
  // dismisses.
  const menuItem = (name) => screen.queryByRole("menuitem", { name });
  const menuEl = () => document.querySelector("[data-tab-ctx-menu]");
  const swatches = () => [...document.querySelectorAll('[role="menuitemradio"]')];

  test("opening the menu moves focus into it", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    tabEl("t1").focus();
    fireEvent.contextMenu(tabEl("t1"));
    expect(document.activeElement).toBe(menuItem("Rename"));
  });

  test("activating an item with Enter hands focus back to the tab, not <body>", () => {
    // A native <button role="menuitem"> turns Enter into click, so the click
    // IS the keyboard path. "Close others" moves focus nowhere on its own,
    // which is exactly the case that used to end on <body>.
    const onCloseOthers = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two")], { onCloseOthers });
    tabEl("t1").focus();
    fireEvent.contextMenu(tabEl("t1"));
    fireEvent.click(menuItem("Close others"));
    expect(onCloseOthers).toHaveBeenCalledTimes(1);
    expect(menuItem("Close others")).toBeNull();
    expect(document.activeElement).toBe(tabEl("t1"));
    expect(document.activeElement).not.toBe(document.body);
  });

  test("Close from the menu moves focus to the neighbouring tab", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    tabEl("t1").focus();
    fireEvent.contextMenu(tabEl("t1"));
    fireEvent.click(menuItem("Close"));
    expect(tabEl("t1")).toBeUndefined();
    expect(document.activeElement).toBe(tabEl("t2"));
  });

  test("Escape closes the menu and returns focus to the tab it opened on", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    tabEl("t1").focus();
    fireEvent.contextMenu(tabEl("t1"));
    expect(menuItem("Rename")).toBeTruthy();
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    expect(menuItem("Rename")).toBeNull();
    expect(document.activeElement).toBe(tabEl("t1"));
    expect(document.activeElement).not.toBe(document.body);
  });

  test("Escape returns focus to the tab the menu was pinned to, not the selected one", () => {
    // The menu carries its own tabId; closing it has to go back there, or a
    // Shift+F10 on tab three lands the user on tab one.
    mount([mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")]);
    fireEvent.contextMenu(tabEl("t3"));
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    expect(document.activeElement).toBe(tabEl("t3"));
  });

  test("arrow keys stop switching tabs while the menu is open", () => {
    const onSwitchTab = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")], { onSwitchTab });
    tabEl("t1").focus();
    fireEvent.contextMenu(tabEl("t1"));
    fireEvent.keyDown(document.activeElement, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement, { key: "End" });
    expect(onSwitchTab).not.toHaveBeenCalled();
  });

  test("Escape still closes the menu after focus has left it", () => {
    // THE REGRESSION. A menu-element listener never sees this keydown: the tab
    // is not a descendant of the menu. With focus parked outside and Escape
    // dead, a keyboard user sat behind a full-screen backdrop with no key that
    // dismissed it and no pointer to click it away with.
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    tabEl("t1").focus();
    fireEvent.contextMenu(tabEl("t1"));
    expect(menuItem("Rename")).toBeTruthy();
    tabEl("t2").focus(); // exactly where Tab used to leave it
    expect(menuEl().contains(document.activeElement)).toBe(false);
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    expect(menuItem("Rename")).toBeNull();
    expect(document.activeElement).toBe(tabEl("t1"));
  });

  test("Tab dismisses the menu instead of walking out of an open one", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    tabEl("t1").focus();
    fireEvent.contextMenu(tabEl("t1"));
    fireEvent.keyDown(document.activeElement, { key: "Tab" });
    expect(menuItem("Rename")).toBeNull();
    expect(document.activeElement).toBe(tabEl("t1"));
    expect(document.activeElement).not.toBe(document.body);
  });

  test("it is a real ARIA menu, not a stack of plain buttons", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    fireEvent.contextMenu(tabEl("t1"));
    const el = screen.getByRole("menu");
    expect(el.getAttribute("aria-label")).toBe("one actions");
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(1);
    // Nothing inside an open menu is in the document tab sequence: arrows do
    // the walking and Tab leaves. A stop left at 0 here would put the trap back.
    for (const node of el.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')) {
      expect(node.tabIndex).toBe(-1);
    }
    // The role really is on the elements, not merely implied by <button>.
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  test("ArrowDown and ArrowUp move between items, so Tab does not have to", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    fireEvent.contextMenu(tabEl("t1"));
    expect(document.activeElement).toBe(menuItem("Rename"));
    fireEvent.keyDown(document.activeElement, { key: "ArrowDown" });
    // The eight colour swatches are one HORIZONTAL row, so they cost Down a
    // single press, not eight.
    expect(document.activeElement.getAttribute("role")).toBe("menuitemradio");
    fireEvent.keyDown(document.activeElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(menuItem("Duplicate"));
    fireEvent.keyDown(document.activeElement, { key: "ArrowUp" });
    expect(document.activeElement.getAttribute("role")).toBe("menuitemradio");
    fireEvent.keyDown(document.activeElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(menuItem("Rename"));
  });

  test("Left and Right walk the colour row and wrap inside it", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    fireEvent.contextMenu(tabEl("t1"));
    fireEvent.keyDown(document.activeElement, { key: "ArrowDown" });
    const row = swatches();
    expect(row).toHaveLength(8);
    expect(document.activeElement).toBe(row[0]);
    fireEvent.keyDown(document.activeElement, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(row[7]);
    fireEvent.keyDown(document.activeElement, { key: "ArrowRight" });
    expect(document.activeElement).toBe(row[0]);
  });

  test("the colour row applies a colour from the keyboard and hands focus back", () => {
    // The row was click-only. It is eight of the menu's stops, and recolouring
    // moves focus nowhere by itself, so the hand-back is what stops this new
    // keyboard route from ending on <body>.
    const onSetTabColor = vi.fn();
    mount([mkTab("t1", "one"), mkTab("t2", "two")], { onSetTabColor });
    tabEl("t1").focus();
    fireEvent.contextMenu(tabEl("t1"));
    fireEvent.keyDown(document.activeElement, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement, { key: "ArrowRight" });
    const target = document.activeElement;
    expect(target.getAttribute("title")).toBe("Color this tab");
    fireEvent.keyDown(target, { key: "Enter" });
    expect(onSetTabColor).toHaveBeenCalledWith("t1", "#ef4444");
    expect(menuItem("Rename")).toBeNull();
    expect(document.activeElement).toBe(tabEl("t1"));
    expect(document.activeElement).not.toBe(document.body);
  });

  test("End lands on the last ENABLED item, never on a disabled one", () => {
    // A disabled <button> cannot take focus, so a ring that still contained
    // "Close others" / "Close" on a single-tab panel would drop the user on
    // <body> — the same dead end by a different route.
    mount([mkTab("t1", "one")]);
    fireEvent.contextMenu(tabEl("t1"));
    fireEvent.keyDown(document.activeElement, { key: "End" });
    expect(menuItem("Close")).toBeTruthy();
    expect(menuItem("Close").disabled).toBe(true);
    expect(document.activeElement).toBe(menuItem(/Share transcript/));
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("invariant 1: keyboard tab switching never remounts a pane", () => {
  test("an arrow-key switch remounts nothing and preserves every pane node", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")]);
    // All three tabs' panes are mounted at once; only CSS display hides them.
    expect([...mounts.keys()].sort()).toEqual(["t1", "t2", "t3"]);
    const before = new Map(mounts);
    const nodes = new Map([...mounts.keys()].map((id) => [id, document.querySelector(`[data-pane-id="${id}"]`)]));

    fireEvent.keyDown(tabEl("t1"), { key: "ArrowRight" });
    fireEvent.keyDown(tabEl("t2"), { key: "ArrowRight" });
    fireEvent.keyDown(tabEl("t3"), { key: "ArrowLeft" });

    expect([...mounts.entries()].sort()).toEqual([...before.entries()].sort());
    expect(unmounts.size).toBe(0);
    for (const [id, node] of nodes) {
      // Same DOM object, not merely an equal one: a remount would produce a
      // fresh element even though the selector still matches.
      expect(document.querySelector(`[data-pane-id="${id}"]`)).toBe(node);
    }
  });

  test("moving focus alone (no switch) remounts nothing", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    const before = new Map(mounts);
    tabEl("t2").focus();
    fireEvent.focus(tabEl("t2"));
    tabEl("t1").focus();
    fireEvent.focus(tabEl("t1"));
    expect([...mounts.entries()].sort()).toEqual([...before.entries()].sort());
    expect(unmounts.size).toBe(0);
  });

  test("a split tab keeps both of its panes mounted across a switch", () => {
    mount([
      mkTab("t1", "one", { layout: { id: "s1", dir: "row", ratio: 0.5, a: { id: "t1" }, b: { id: "t1b" } } }),
      mkTab("t2", "two"),
    ]);
    expect([...mounts.keys()].sort()).toEqual(["t1", "t1b", "t2"]);
    const before = new Map(mounts);
    fireEvent.keyDown(tabEl("t1"), { key: "ArrowRight" });
    expect([...mounts.entries()].sort()).toEqual([...before.entries()].sort());
    expect(unmounts.size).toBe(0);
  });
});

describe("colour-swatch selection ring (A11Y-11)", () => {
  // The contract is asserted against the exported builder rather than computed
  // style, for the reason headerSkins.tokens.test.js already documents: neither
  // happy-dom nor jsdom performs custom-property substitution, so a DOM read
  // proves nothing about what fourteen skins will paint. happy-dom in fact
  // DISCARDS `1px solid rgba(var(--phn-wash-rgb, 255,255,255), 0.25)` outright
  // while Chromium defers it to computed-value time, so the DOM here is not
  // even a faithful copy of the declaration. The last test below is the wiring
  // check that keeps the builder from becoming an orphan the JSX ignores.
  test("selected and unselected differ in WIDTH, so they never collapse on a skin where the two tokens meet", () => {
    const selected = swatchRing("#22c55e", "#22c55e");
    const unselected = swatchRing("#22c55e", "#ef4444");
    expect(parseFloat(selected)).toBeGreaterThan(parseFloat(unselected));
  });

  test("both rings resolve through per-skin tokens, so neither is frozen white on the light menus", () => {
    const selected = swatchRing("#22c55e", "#22c55e");
    const unselected = swatchRing("#22c55e", "#ef4444");
    // The colour component, with the width/style prefix removed, has to BEGIN
    // with a token reference. The original defect was a bare literal there
    // ("2px solid #fff"), which is ~1.06:1 on the light skins' #ececec menu;
    // a literal sitting inside a var() fallback is fine, since only the twelve
    // dark skins ever reach it.
    const ink = (ring) => ring.replace(/^\d+(?:\.\d+)?px\s+solid\s+/, "");
    expect(ink(selected).startsWith("var(--phn-")).toBe(true);
    expect(ink(unselected).startsWith("rgba(var(--phn-")).toBe(true);
    expect(selected).not.toBe(unselected);
  });

  test("the clear-colour glyph keeps its literal mid grey rather than a token that inverts", () => {
    expect(SWATCH_CLEAR_GLYPH).toBe("#999");
    expect(SWATCH_CLEAR_GLYPH).not.toMatch(/^var\(/);
  });

  test("the rendered swatch row actually uses the builder", () => {
    // This test used to assert only that the selected swatch's style contained
    // "2px" and the others did not. Reverting the whole change to HEAD's frozen
    // `2px solid #fff` / `1px solid rgba(255,255,255,0.25)` satisfied every one
    // of those assertions identically, so the light-skin regression could walk
    // straight back in. Mutation-proved: that revert survived all 24 tests.
    // The assertions below read the DECLARATION TEXT, which is what actually
    // differs, out of getAttribute("style") rather than computed style.
    mount([mkTab("t1", "one", { color: "#22c55e" }), mkTab("t2", "two")]);
    fireEvent.contextMenu(tabEl("t1"));
    const all = [...document.querySelectorAll('[title="Color this tab"], [title="Clear color"]')];
    expect(all).toHaveLength(8);
    const style = (el) => el.getAttribute("style") || "";
    const selected = all.find((el) => style(el).includes("#22c55e"));

    // The selected ring's colour has to come from the token. happy-dom mangles
    // `2px solid var(--phn-ink, #ffffff)` into a shorthand plus three longhands
    // and strips the space after the comma, so match the token name, not the
    // authored string. HEAD's `2px solid #fff` does not contain it.
    expect(style(selected)).toMatch(/var\(--phn-ink/);
    expect(style(selected)).toContain("2px");

    for (const el of all) {
      if (el === selected) continue;
      expect(style(el)).not.toContain("2px");
      if (el.getAttribute("title") === "Clear color") continue;
      // The unselected rings cannot be asserted positively here: happy-dom
      // cannot parse `rgba(var(--phn-wash-rgb, 255,255,255), 0.25)` and DROPS
      // the declaration, so the attribute carries no border at all (measured,
      // and the reason the exported builder is unit-tested above). What it can
      // still prove is the negative that matters: the ring is not a frozen
      // white literal. HEAD's serialises as `rgba(255, 255, 255, 0.25)`, and
      // the token form never can: what follows `rgba(` there is `var`.
      expect(style(el)).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255/);
    }
    expect(style(all.find((el) => el.getAttribute("title") === "Clear color"))).toContain(SWATCH_CLEAR_GLYPH);
  });
});

describe("context-menu activation and the pane's reveal-focus guard", () => {
  // dismissTabCtxMenu hands focus to the tab through focusTabIn, which arms the
  // guard that stops a revealed pane from stealing focus for 500 ms. Right for
  // a keystroke, wrong for a mouse click: right-click then "Duplicate" with the
  // mouse must end with the caret in the new shell, as a click on a tab always
  // has. The re-review of the 2026-09-17 batch caught the mouse path armed.
  const duplicate = () => screen.getByRole("menuitem", { name: "Duplicate" });
  beforeEach(() => releaseTabStripFocus());

  test("a mouse click on an item releases the guard", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    fireEvent.contextMenu(tabEl("t1"));
    fireEvent.click(duplicate(), { detail: 1 });
    expect(shouldPaneTakeFocus()).toBe(true);
  });

  test("keyboard activation keeps the guard armed", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    tabEl("t1").focus();
    fireEvent.contextMenu(tabEl("t1"));
    fireEvent.click(duplicate(), { detail: 0 });
    expect(shouldPaneTakeFocus()).toBe(false);
  });

  test("dismissing on the backdrop with the mouse releases the guard", () => {
    mount([mkTab("t1", "one"), mkTab("t2", "two")]);
    fireEvent.contextMenu(tabEl("t1"));
    const backdrop = document.querySelector("[data-tab-ctx-menu]").previousElementSibling;
    fireEvent.mouseDown(backdrop);
    expect(document.querySelector("[data-tab-ctx-menu]")).toBeNull();
    expect(shouldPaneTakeFocus()).toBe(true);
  });
});
