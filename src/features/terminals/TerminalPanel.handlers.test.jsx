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
import { describe, test, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";

const { paneProps } = vi.hoisted(() => ({ paneProps: new Map() }));

vi.mock("./TerminalPane", () => {
  function PaneMock(props) {
    const seen = paneProps.get(props.tabId) || [];
    seen.push(props);
    paneProps.set(props.tabId, seen);
    return <div data-testid={`pane-body-${props.tabId}`} />;
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
