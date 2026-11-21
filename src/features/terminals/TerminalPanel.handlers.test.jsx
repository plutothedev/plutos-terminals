// (C)
// @vitest-environment happy-dom
//
// Pins two things the 2026-11-20 lint pass restructured in TerminalPanel:
//
// 1. Per-pane handler props (onCostUpdate, onAgentSession) keep a PERMANENT
//    identity across re-renders, so memo(TerminalPane) is never defeated, and
//    they always reach the parent's LATEST callback. They used to live in a ref
//    read during render; they now live in a useState-held cache with the parent
//    callbacks behind layout-effect refs.
// 2. The per-pane hover controls (split right / split down / zoom / close) are
//    role="button" with Enter/Space activation, and still do what a click does.
// Fix round 1 (review of bd9eebc): a click on a hover control leaves focus
// where it was; a pane leaving the leaf set drops its cached handler.
// Fix round 2: zoom state is owned by TerminalsTab (hooks/usePaneZoom.js) and
// comes in as zoomedPaneId / onSetPaneZoom; every hover control is tabIndex -1
// (xterm keeps Tab, so none is reachable by it), and zoom's keyboard path is
// the palette (paneZoom.test.jsx).
import { describe, test, expect, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";

const { paneProps } = vi.hoisted(() => ({ paneProps: new Map() }));

vi.mock("./TerminalPane", () => {
  function PaneMock(props) {
    const seen = paneProps.get(props.tabId) || [];
    seen.push(props);
    paneProps.set(props.tabId, seen);
    // xterm's own input element, so focus hand-back can be observed.
    return <div data-testid={`pane-body-${props.tabId}`}><textarea className="xterm-helper-textarea" aria-label={`terminal ${props.tabId}`} /></div>;
  }
  return {
    default: PaneMock,
    todayDate: () => "2026-11-20",
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

const noop = () => {};
const baseProps = {
  isActive: true,
  canClosePanel: false,
  xtermTheme: { background: "#000" },
  onActivate: noop, onAddTab: noop, onCloseTab: noop, onSwitchTab: noop, onClosePanel: noop,
  onRenameTab: noop, onSetTabColor: noop, onDuplicateTab: noop, onDetachTab: noop, onCloseOthers: noop,
};
// A tab whose split tree holds two panes: its own root leaf and leaf "p2".
const splitTab = {
  id: "t1", label: "one", activePaneId: "t1",
  layout: { type: "split", id: "s1", dir: "row", ratio: 0.5, a: { type: "leaf", id: "t1" }, b: { type: "leaf", id: "p2" } },
};
const panelOf = (tabs) => ({ id: "panel_1", activeTabId: tabs[0].id, tabs });
const last = (id) => paneProps.get(id).at(-1);
// TerminalsTab owns zoom (usePaneZoom); this stands in for it with the same
// two props, so the hover control's zoom round-trips through the parent.
function ZoomHost(props) {
  const [zoomed, setZoomed] = useState({});
  const onSetPaneZoom = (panelId, paneId) => setZoomed((prev) => ({ ...prev, [panelId]: paneId }));
  return <TerminalPanel {...props} zoomedPaneId={zoomed[props.panel.id] ?? null} onSetPaneZoom={onSetPaneZoom} />;
}

afterEach(() => { cleanup(); paneProps.clear(); });

describe("per-pane handler props", () => {
  test("keep their identity across re-renders and call the latest parent callback", () => {
    const costA = vi.fn(), costB = vi.fn(), agentA = vi.fn(), agentB = vi.fn();
    const panel = panelOf([{ id: "t1", label: "one" }]);
    const { rerender } = render(<TerminalPanel {...baseProps} panel={panel} onTabCostUpdate={costA} onPaneAgentSession={agentA} />);
    const first = last("t1");
    rerender(<TerminalPanel {...baseProps} panel={{ ...panel }} onTabCostUpdate={costB} onPaneAgentSession={agentB} />);
    const second = last("t1");
    expect(paneProps.get("t1").length).toBeGreaterThan(1);
    expect(second.onCostUpdate).toBe(first.onCostUpdate);
    expect(second.onAgentSession).toBe(first.onAgentSession);
    first.onCostUpdate({ usd: 1 });
    first.onAgentSession({ id: "s" });
    expect(costA).not.toHaveBeenCalled();
    expect(agentA).not.toHaveBeenCalled();
    expect(costB).toHaveBeenCalledWith("t1", { usd: 1 });
    expect(agentB).toHaveBeenCalledWith("t1", { id: "s" });
  });

  test("a pane that leaves the leaf set loses its cached handler", () => {
    const cost = vi.fn();
    const single = { id: "t1", label: "one", activePaneId: "t1" };
    const { rerender } = render(<TerminalPanel {...baseProps} panel={panelOf([splitTab])} onTabCostUpdate={cost} />);
    const before = last("p2").onCostUpdate;
    const beforeAgent = last("p2").onAgentSession;
    rerender(<TerminalPanel {...baseProps} panel={panelOf([single])} onTabCostUpdate={cost} />); // p2 closed
    rerender(<TerminalPanel {...baseProps} panel={panelOf([splitTab])} onTabCostUpdate={cost} />); // a pane p2 again
    // Pruned, so the returning id is minted afresh (a kept entry would be the same function).
    expect(last("p2").onCostUpdate).not.toBe(before);
    expect(last("p2").onAgentSession).not.toBe(beforeAgent);
    // The surviving pane kept its handler throughout.
    expect(paneProps.get("t1").every((pp) => pp.onCostUpdate === paneProps.get("t1")[0].onCostUpdate)).toBe(true);
    last("p2").onCostUpdate({ usd: 3 });
    expect(cost).toHaveBeenCalledWith("p2", { usd: 3 });
  });

  test("each pane of a split tab gets its own handler, bound to its own id", () => {
    const cost = vi.fn();
    render(<TerminalPanel {...baseProps} panel={panelOf([splitTab])} onTabCostUpdate={cost} />);
    expect(last("t1").onCostUpdate).not.toBe(last("p2").onCostUpdate);
    last("p2").onCostUpdate({ usd: 2 });
    expect(cost).toHaveBeenCalledWith("p2", { usd: 2 });
  });
});

describe("per-pane hover controls", () => {
  test("are named role=button controls kept out of the Tab order", () => {
    render(<TerminalPanel {...baseProps} panel={panelOf([splitTab])} onTabCostUpdate={noop} onSplitPane={noop} onClosePane={noop} />);
    const ctl = screen.getAllByRole("button", { name: "Split right (Ctrl+Shift+D)" });
    expect(ctl.length).toBe(2); // one per pane
    for (const el of ctl) expect(el.getAttribute("tabindex")).toBe("-1");
  });

  test("a click on a hover control leaves focus where it was", () => {
    // The browser moves focus on mousedown unless it is prevented. These spans
    // are tabIndex -1, so a click used to leave focus on a control that then
    // faded out (opacity 0), and a later Enter meant for the terminal re-fired
    // it (click Zoom, press Enter: the pane un-zoomed).
    render(<><textarea aria-label="terminal input" /><TerminalPanel {...baseProps} panel={panelOf([splitTab])} onTabCostUpdate={noop} onSplitPane={noop} onClosePane={noop} /></>);
    const term = screen.getByLabelText("terminal input");
    const pane2 = document.querySelector('[data-pane-id="p2"]');
    const pressLikeBrowser = (el) => {
      term.focus();
      const notPrevented = fireEvent.mouseDown(el);
      if (notPrevented) el.closest("[tabindex]")?.focus();
      fireEvent.mouseUp(el);
      fireEvent.click(el);
      return document.activeElement;
    };
    // Zoom is the exception: it hands focus to the zoomed pane's own terminal
    // (next test), since the pane it zooms covers whatever had focus.
    const titles = ["Split right (Ctrl+Shift+D)", "Split down (Ctrl+Shift+S)", "Close this pane (Ctrl+Shift+X)"];
    for (const t of titles) {
      const el = [...pane2.querySelectorAll(".phn-pane-ctl")].find((c) => c.title === t);
      expect(el, t).toBeTruthy();
      expect(pressLikeBrowser(el), t).toBe(term);
    }
  });

  test("a click on zoom puts keyboard focus in the zoomed pane's terminal, never a pane it covers", () => {
    // Zooming pane 2 while pane 1's shell has focus used to leave focus (and
    // every keystroke, Enter included) in pane 1, now hidden behind pane 2.
    render(<ZoomHost {...baseProps} panel={panelOf([splitTab])} onTabCostUpdate={noop} onSplitPane={noop} onClosePane={noop} />);
    const pane2 = document.querySelector('[data-pane-id="p2"]');
    const zoomCtl = () => [...pane2.querySelectorAll(".phn-pane-ctl")].find((c) => /zoom/i.test(c.title));
    screen.getByLabelText("terminal t1").focus();
    fireEvent.mouseDown(zoomCtl());
    fireEvent.mouseUp(zoomCtl());
    fireEvent.click(zoomCtl());
    expect(zoomCtl().title).toBe("Restore split (un-zoom)");
    expect(document.activeElement).toBe(screen.getByLabelText("terminal p2"));
    // Un-zooming by click keeps focus in that same pane.
    fireEvent.mouseDown(zoomCtl());
    fireEvent.click(zoomCtl());
    expect(document.activeElement).toBe(screen.getByLabelText("terminal p2"));
  });

  test("zoom state comes from the parent: the control writes it there and every control stays out of the Tab order", () => {
    // xterm keeps Tab, so a Tab stop on the (zoomed, visible) control was never
    // reachable; the keyboard path is the palette, through the same state.
    const onSetPaneZoom = vi.fn();
    const { rerender } = render(<TerminalPanel {...baseProps} panel={panelOf([splitTab])} onTabCostUpdate={noop} onSplitPane={noop} onClosePane={noop} onSetPaneZoom={onSetPaneZoom} />);
    const pane2 = () => document.querySelector('[data-pane-id="p2"]');
    const zoomCtl = () => [...pane2().querySelectorAll(".phn-pane-ctl")].find((c) => /zoom/i.test(c.title));
    fireEvent.click(zoomCtl());
    expect(onSetPaneZoom).toHaveBeenLastCalledWith("panel_1", "p2");
    expect(zoomCtl().title).toBe("Zoom this pane to fill the tab"); // nothing local: unchanged until the parent says so
    rerender(<TerminalPanel {...baseProps} panel={panelOf([splitTab])} onTabCostUpdate={noop} onSplitPane={noop} onClosePane={noop} onSetPaneZoom={onSetPaneZoom} zoomedPaneId="p2" />);
    expect(zoomCtl().title).toBe("Restore split (un-zoom)");
    expect(zoomCtl().closest(".phn-pane-controls").hasAttribute("data-zoomed")).toBe(true);
    for (const c of document.querySelectorAll(".phn-pane-ctl")) expect(c.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(zoomCtl());
    expect(onSetPaneZoom).toHaveBeenLastCalledWith("panel_1", null);
  });

  test("Enter and Space do what a click does", () => {
    const onSplitPane = vi.fn(), onClosePane = vi.fn();
    render(<TerminalPanel {...baseProps} panel={panelOf([splitTab])} onTabCostUpdate={noop} onSplitPane={onSplitPane} onClosePane={onClosePane} />);
    const pane2 = document.querySelector('[data-pane-id="p2"]');
    const ctl = (title) => [...pane2.querySelectorAll(".phn-pane-ctl")].find((el) => el.title === title);
    fireEvent.keyDown(ctl("Split right (Ctrl+Shift+D)"), { key: "Enter" });
    expect(onSplitPane).toHaveBeenLastCalledWith("t1", "p2", "row");
    fireEvent.keyDown(ctl("Split down (Ctrl+Shift+S)"), { key: " " });
    expect(onSplitPane).toHaveBeenLastCalledWith("t1", "p2", "col");
    fireEvent.keyDown(ctl("Close this pane (Ctrl+Shift+X)"), { key: "Enter" });
    expect(onClosePane).toHaveBeenCalledWith("t1", "p2");
    // Other keys are left alone.
    fireEvent.keyDown(ctl("Close this pane (Ctrl+Shift+X)"), { key: "a" });
    expect(onClosePane).toHaveBeenCalledTimes(1);
    // And a click still works.
    fireEvent.click(ctl("Split right (Ctrl+Shift+D)"));
    expect(onSplitPane).toHaveBeenCalledTimes(3);
  });
});
