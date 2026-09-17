// (C)
// @vitest-environment happy-dom
//
// Where keyboard focus ends up ONE FRAME LATER.
//
// A separate file from TerminalPanel.a11y.test.jsx, and the split is the whole
// point. That file mocks TerminalPane down to a bare <div> with no focus
// behaviour, so every focus assertion in it reads the SYNCHRONOUS instant right
// after the keydown. That instant was always correct. The bug lived 30ms later:
// the switch reveals the target pane, TerminalPane's reveal effect focuses its
// xterm on a `setTimeout(…, 30)`, and focus left the tab strip for a live PTY.
// Roving tab navigation therefore survived exactly one keypress, and the second
// ArrowRight was ESC[C typed at whatever agent was running in that tab.
//
// So this file's pane mock has focus behaviour, and every assertion here is
// made AFTER the timers have run. The mock reproduces the reveal effect's
// shape, but it does NOT reproduce its decision: it calls the real
// shouldPaneTakeFocus() from production, so what is under test is TerminalPanel
// actually arming the signal. That the real TerminalPane consults the same
// helper is checked separately, by parsing it, in tabStripFocus.test.js.
// Asserting it against a mock's copy of itself is the failure mode this repo
// already has three of.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { shouldPaneTakeFocus, releaseTabStripFocus } from "./tabStripFocus.js";

vi.mock("./TerminalPane", () => {
  // Named, not an inline arrow on `default`: react-hooks/rules-of-hooks only
  // recognises a component by its capitalised name, and an anonymous one turns
  // three legitimate hook calls into three lint errors.
  function PaneMock({ tabId, visible, active }) {
    const ta = useRef(null);
    const activeRef = useRef(active);
    useEffect(() => { activeRef.current = active; });
    useEffect(() => {
      if (!visible) return;
      const t = setTimeout(() => {
        if (activeRef.current && shouldPaneTakeFocus()) {
          try { ta.current?.focus(); } catch { /* ignore */ }
        }
      }, 30);
      return () => clearTimeout(t);
    }, [visible]);
    // A textarea because that is what xterm focuses: Terminal.focus() forwards
    // to its hidden textarea, which is why the stolen keystrokes reached a PTY
    // instead of going nowhere.
    return <textarea ref={ta} data-testid={`xterm-${tabId}`} readOnly />;
  }
  return {
    default: PaneMock,
    todayDate: () => "2026-08-21",
    transcriptName: (project, tabId) => `${project || "tab"}-${tabId}`,
  };
});
vi.mock("@backend", () => ({ invoke: vi.fn(async () => ""), listen: vi.fn(async () => () => {}), isTauri: () => true }));
vi.mock("./VncView", () => ({ default: () => <div /> }));
vi.mock("./RdpView", () => ({ default: () => <div /> }));
vi.mock("./MobaHomeScreen", () => ({ default: () => <div /> }));
vi.mock("./NotebookView", () => ({ default: () => <div /> }));
vi.mock("./ShareModal.jsx", () => ({ default: () => <div /> }));
vi.mock("../../components/ErrorBoundary.jsx", () => ({ PaneBoundary: ({ children }) => <>{children}</> }));

import TerminalPanel from "./TerminalPanel.jsx";

const mkTab = (id, label, extra = {}) => ({ id, label, ...extra });

function Harness({ tabs, ...rest }) {
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
      onAddTab={() => {}}
      onCloseTab={(panelId, tabId) => setClosed((c) => [...c, tabId])}
      onSwitchTab={(panelId, tabId) => setActiveTabId(tabId)}
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

const tabEls = () => [...document.querySelectorAll('[role="tab"].moba-tab')];
const tabEl = (id) => tabEls().find((el) => el.dataset.tabId === id);
// A label for whatever holds focus, so a failure names the culprit instead of
// printing two opaque element objects.
const focusName = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return "BODY";
  return el.getAttribute("data-testid") || (el.dataset?.tabId ? `tab:${el.dataset.tabId}` : el.tagName);
};
// Run out the pane's 30ms reveal timer (and any timer chained behind it).
const settle = async () => { await vi.advanceTimersByTimeAsync(120); };

beforeEach(() => {
  releaseTabStripFocus();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe("keyboard tab navigation survives the pane's reveal", () => {
  test("focus is still on a tab after the reveal timer runs", async () => {
    render(<Harness tabs={[mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")]} />);
    tabEl("t1").focus();
    fireEvent.keyDown(tabEl("t1"), { key: "ArrowRight" });
    await settle();
    expect(focusName()).toBe("tab:t2");
  });

  test("a SECOND arrow key still moves tabs instead of typing into the shell", async () => {
    // The shipped bug in one test. One press worked; the strip had lost focus
    // by the time the second arrived, so it went to the PTY as ESC[C.
    render(<Harness tabs={[mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")]} />);
    tabEl("t1").focus();
    fireEvent.keyDown(tabEl("t1"), { key: "ArrowRight" });
    await settle();
    fireEvent.keyDown(document.activeElement, { key: "ArrowRight" });
    await settle();
    expect(focusName()).toBe("tab:t3");
    expect(tabEl("t3").getAttribute("aria-selected")).toBe("true");
  });

  test("Home and End keep the strip too", async () => {
    render(<Harness tabs={[mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")]} />);
    tabEl("t1").focus();
    fireEvent.keyDown(tabEl("t1"), { key: "End" });
    await settle();
    expect(focusName()).toBe("tab:t3");
    fireEvent.keyDown(document.activeElement, { key: "Home" });
    await settle();
    expect(focusName()).toBe("tab:t1");
  });

  test("Enter activates without handing focus to the terminal", async () => {
    // Enter moves no focus, so it never reaches focusTabIn; it still reveals a
    // pane, so it still needed arming. ARIA activation leaves focus on the tab.
    render(<Harness tabs={[mkTab("t1", "one"), mkTab("t2", "two")]} />);
    tabEl("t2").focus();
    fireEvent.keyDown(tabEl("t2"), { key: "Enter" });
    await settle();
    expect(focusName()).toBe("tab:t2");
    expect(tabEl("t2").getAttribute("aria-selected")).toBe("true");
  });

  test("Delete leaves focus on the neighbour and it is still there a frame later", async () => {
    // Closing a tab reveals the neighbour's pane, so the 30ms steal fired on
    // this path too: the neighbour held focus for one frame and then Delete
    // became ESC[3~ in the newly-revealed shell.
    render(<Harness tabs={[mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")]} />);
    tabEl("t2").focus();
    fireEvent.keyDown(tabEl("t2"), { key: "Delete" });
    await settle();
    expect(focusName()).toBe("tab:t3");
  });

  test("the close button's Enter keeps the strip after the reveal too", async () => {
    render(<Harness tabs={[mkTab("t1", "one"), mkTab("t2", "two")]} />);
    fireEvent.keyDown(screen.getByLabelText("Close one"), { key: "Enter" });
    await settle();
    expect(focusName()).toBe("tab:t2");
  });
});

describe("the mouse still wins", () => {
  test("clicking a tab hands the caret to that tab's terminal", async () => {
    // The reveal steal exists FOR this path. A guard that turned it off for
    // everyone would trade a keyboard bug for a mouse one.
    render(<Harness tabs={[mkTab("t1", "one"), mkTab("t2", "two")]} />);
    fireEvent.mouseDown(tabEl("t2"), { button: 0 });
    fireEvent.click(tabEl("t2"));
    await settle();
    expect(focusName()).toBe("xterm-t2");
  });

  test("a click inside the armed window still wins", async () => {
    // Arrow-key first, then grab the mouse a few milliseconds later. Without an
    // explicit release the half-second window would swallow the click's focus
    // and the user would type into nothing.
    render(<Harness tabs={[mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")]} />);
    tabEl("t1").focus();
    fireEvent.keyDown(tabEl("t1"), { key: "ArrowRight" });
    fireEvent.mouseDown(tabEl("t3"), { button: 0 });
    fireEvent.click(tabEl("t3"));
    await settle();
    expect(focusName()).toBe("xterm-t3");
  });
});

describe("invariant 1 holds on the settled path as well", () => {
  test("no pane node is replaced across a keyboard switch that runs its timers", async () => {
    render(<Harness tabs={[mkTab("t1", "one"), mkTab("t2", "two"), mkTab("t3", "three")]} />);
    const before = new Map(["t1", "t2", "t3"].map((id) => [id, screen.getByTestId(`xterm-${id}`)]));
    tabEl("t1").focus();
    fireEvent.keyDown(tabEl("t1"), { key: "ArrowRight" });
    await settle();
    fireEvent.keyDown(document.activeElement, { key: "ArrowRight" });
    await settle();
    for (const [id, node] of before) {
      // Same DOM object, not merely an equal one: a remount would produce a
      // fresh element the same selector still finds, and would have killed
      // that pane's PTY on the way.
      expect(screen.getByTestId(`xterm-${id}`)).toBe(node);
    }
  });
});
