// (C)
// @vitest-environment happy-dom
//
// Zoom's keyboard path (v0.7.6 visual pass). The pane hover control is not
// reachable by Tab in a real window (it sits between xterm inputs, and xterm
// keeps Tab), so the command palette ("Zoom pane" / "Restore split (un-zoom)")
// and the Terminal menu are the keyboard paths. Zoom state lives in
// usePaneZoom (TerminalsTab), shared by the hover control, the palette and the
// menu, so the three always agree.
//
// The harness wires usePaneZoom, TerminalPanel and usePaletteCommands exactly
// as TerminalsTab does (zoomedPaneId per panel, onSetPaneZoom, and the three
// palette fields).
import { describe, test, expect, afterEach, vi } from "vitest";
import { useLayoutEffect } from "react";
import { render, fireEvent, cleanup, screen, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("./TerminalPane", () => ({
  // xterm's own input element stands in for the terminal.
  default: (props) => <div><textarea className="xterm-helper-textarea" aria-label={`terminal ${props.tabId}`} /></div>,
  todayDate: () => "2026-11-21",
  transcriptName: (project, tabId) => `${project || "tab"}-${tabId}`,
}));
vi.mock("@backend", () => ({ invoke: vi.fn(async () => ""), listen: vi.fn(async () => () => {}), isTauri: () => true }));
vi.mock("./VncView", () => ({ default: () => <div /> }));
vi.mock("./RdpView", () => ({ default: () => <div /> }));
vi.mock("./MobaHomeScreen", () => ({ default: () => <div /> }));
vi.mock("./NotebookView", () => ({ default: () => <div /> }));
vi.mock("./ShareModal.jsx", () => ({ default: () => <div /> }));
vi.mock("../../components/ErrorBoundary.jsx", () => ({ PaneBoundary: ({ children }) => <>{children}</> }));
vi.mock("../../components/ConfirmModal.jsx", () => ({ useConfirm: () => vi.fn(async () => false) }));
// The live xterm lives in the pane registry; here its focus() focuses the
// stand-in textarea of that pane.
vi.mock("./paneRegistry.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getEntry: (id) => ({ term: { focus: () => document.querySelector(`[aria-label="terminal ${id}"]`)?.focus() } }),
}));

import TerminalPanel from "./TerminalPanel.jsx";
import { usePaletteCommands } from "./chrome/usePaletteCommands.jsx";
import { usePaneZoom } from "./hooks/usePaneZoom.js";

const noop = () => {};
const split = (activePaneId = "p2") => ({
  id: "t1", label: "one", activePaneId,
  layout: { type: "split", id: "s1", dir: "row", ratio: 0.5, a: { type: "leaf", id: "t1" }, b: { type: "leaf", id: "p2" } },
});
const stateOf = (tab) => ({ activePanelId: "panel_1", panels: [{ id: "panel_1", activeTabId: tab.id, tabs: [tab] }] });

// The latest palette list, published after each commit (as CommandPalette
// would read it), never written during render.
const seen = { commands: [] };
function Harness({ state }) {
  const zoom = usePaneZoom(state);
  const activePanel = state.panels.find((p) => p.id === state.activePanelId);
  const activeTab = activePanel?.tabs.find((t) => t.id === activePanel.activeTabId);
  const commands = usePaletteCommands({
    scOf: () => undefined, state, persist: noop,
    addTab: noop, addPanel: noop, splitPane: noop, equalizePanes: noop, closePane: noop, importSshConfig: noop,
    switchTab: noop, switchTabRel: noop, selectRibbon: noop, focusFilesDock: noop, openTunnels: noop,
    stopAndSaveRecording: noop, startRecordingActive: noop, setActivePanel: noop, toggleBroadcast: noop,
    activeTab, activeTabId: activeTab?.id, activePaneId: activeTab?.activePaneId,
    canZoomActivePane: zoom.canZoomActivePane, activePaneZoomed: zoom.activePaneZoomed, toggleActivePaneZoom: zoom.toggleActivePaneZoom,
  });
  useLayoutEffect(() => { seen.commands = commands; });
  return state.panels.map((panel) => (
    <TerminalPanel
      key={panel.id}
      panel={panel}
      isActive
      canClosePanel={false}
      xtermTheme={{ background: "#000" }}
      onActivate={noop} onAddTab={noop} onCloseTab={noop} onSwitchTab={noop} onClosePanel={noop}
      onRenameTab={noop} onSetTabColor={noop} onDuplicateTab={noop} onDetachTab={noop} onCloseOthers={noop}
      onTabCostUpdate={noop} onSplitPane={noop} onClosePane={noop}
      zoomedPaneId={zoom.zoomedPanes[panel.id] ?? null}
      onSetPaneZoom={zoom.setPaneZoom}
    />
  ));
}

const zoomCmd = () => seen.commands.find((c) => c.id === "zoom-pane");
const zoomCtl = (paneId) => [...document.querySelector(`[data-pane-id="${paneId}"]`).querySelectorAll(".phn-pane-ctl")].find((c) => /zoom/i.test(c.title));
const isZoomed = (paneId) => zoomCtl(paneId).title === "Restore split (un-zoom)" && zoomCtl(paneId).closest(".phn-pane-controls").hasAttribute("data-zoomed");
// The palette closes, then runs the action a task later; focus moves one more task later.
const runPalette = async () => {
  await act(async () => { zoomCmd().action(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
};

afterEach(() => { cleanup(); seen.commands = []; });

describe("the palette's zoom command", () => {
  test("is listed only when the active tab has more than one pane", () => {
    const { rerender } = render(<Harness state={stateOf({ id: "t1", label: "solo" })} />);
    expect(zoomCmd()).toBeUndefined();
    rerender(<Harness state={stateOf({ id: "t1", label: "leaf", layout: { type: "leaf", id: "t1" } })} />);
    expect(zoomCmd()).toBeUndefined();
    rerender(<Harness state={stateOf(split())} />);
    expect(zoomCmd()?.label).toBe("Zoom pane");
  });

  test("zooms the active pane, and run again restores the split", async () => {
    render(<Harness state={stateOf(split("p2"))} />);
    expect(isZoomed("p2")).toBe(false);
    await runPalette();
    expect(isZoomed("p2")).toBe(true);
    expect(isZoomed("t1")).toBe(false); // the other pane is covered, not zoomed
    expect(zoomCmd().label).toBe("Restore split (un-zoom)");
    await runPalette();
    expect(isZoomed("p2")).toBe(false);
    expect(zoomCmd().label).toBe("Zoom pane");
  });

  test("leaves keyboard focus in the active pane's terminal, never in a covered one", async () => {
    render(<><button>chrome</button><Harness state={stateOf(split("p2"))} /></>);
    screen.getByText("chrome").focus();
    await runPalette(); // zoom
    expect(document.activeElement).toBe(screen.getByLabelText("terminal p2"));
    screen.getByText("chrome").focus();
    await runPalette(); // restore
    expect(document.activeElement).toBe(screen.getByLabelText("terminal p2"));
  });

  test("acts on whichever pane is active", async () => {
    render(<Harness state={stateOf(split("t1"))} />);
    await runPalette();
    expect(isZoomed("t1")).toBe(true);
    expect(isZoomed("p2")).toBe(false);
  });
});

describe("hover control and palette share one zoom state", () => {
  test("zoom by click, restore by palette", async () => {
    render(<Harness state={stateOf(split("p2"))} />);
    fireEvent.click(zoomCtl("p2"));
    expect(isZoomed("p2")).toBe(true);
    expect(zoomCmd().label).toBe("Restore split (un-zoom)");
    await runPalette();
    expect(isZoomed("p2")).toBe(false);
  });

  test("zoom by palette, restore by click", async () => {
    render(<Harness state={stateOf(split("p2"))} />);
    await runPalette();
    expect(isZoomed("p2")).toBe(true);
    fireEvent.click(zoomCtl("p2"));
    expect(isZoomed("p2")).toBe(false);
    expect(zoomCmd().label).toBe("Zoom pane");
  });
});

describe("TerminalsTab wiring (no test renders TerminalsTab, so its source is pinned)", () => {
  const src = readFileSync(path.join(process.cwd(), "src/features/terminals/TerminalsTab.jsx"), "utf8").replace(/\r\n/g, "\n");
  test("one usePaneZoom over the workspace state", () => {
    expect(src).toMatch(/const paneZoom = usePaneZoom\(state\);/);
  });
  test("each TerminalPanel gets its own zoomed pane and the shared setter", () => {
    expect(src).toMatch(/zoomedPaneId=\{paneZoom\.zoomedPanes\[panel\.id\] \?\? null\}/);
    expect(src).toMatch(/onSetPaneZoom=\{paneZoom\.setPaneZoom\}/);
  });
  test("the palette and the Terminal menu get the three zoom fields", () => {
    const palette = src.slice(src.indexOf("usePaletteCommands({"), src.indexOf("});", src.indexOf("usePaletteCommands({")));
    for (const f of ["canZoomActivePane", "activePaneZoomed", "toggleActivePaneZoom"]) expect(palette).toContain(f);
    const menu = src.slice(src.indexOf("<MenuBar"), src.indexOf("/>", src.indexOf("<MenuBar")));
    for (const f of ["canZoomActivePane", "activePaneZoomed", "toggleActivePaneZoom"]) expect(menu).toContain(`${f}={paneZoom.${f}}`);
  });
});
