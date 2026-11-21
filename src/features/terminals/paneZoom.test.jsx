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
// The rule: when the active tab is zoomed (its panel's zoomed pane is one of
// this tab's panes) the command is "Restore split (un-zoom)" and restores,
// whichever pane is active; otherwise it is "Zoom pane" and zooms the active
// pane. Either way focus ends in the active pane's terminal.
//
// The harness wires usePaneZoom, TerminalPanel, usePaletteCommands and MenuBar
// as TerminalsTab does, and keeps the workspace in state so a mousedown on a
// pane activates it (TerminalPanel's onActivatePane), as in the app.
import { describe, test, expect, afterEach, vi } from "vitest";
import { useCallback, useLayoutEffect, useState } from "react";
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
import MenuBar from "./chrome/MenuBar.jsx";
import { usePaletteCommands } from "./chrome/usePaletteCommands.jsx";
import { usePaneZoom } from "./hooks/usePaneZoom.js";

const noop = () => {};
const LAYOUT = { type: "split", id: "s1", dir: "row", ratio: 0.5, a: { type: "leaf", id: "t1" }, b: { type: "leaf", id: "p2" } };
const split = (activePaneId = "p2", extra = {}) => ({ id: "t1", label: "one", activePaneId, layout: LAYOUT, ...extra });
const stateOf = (tab) => ({ activePanelId: "panel_1", panels: [{ id: "panel_1", activeTabId: tab.id, tabs: [tab] }] });
const withActive = (st, paneId) => ({
  ...st,
  panels: st.panels.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === p.activeTabId ? { ...t, activePaneId: paneId } : t)) })),
});
const menuProps = {
  addTab: noop, addHomeTab: noop, addNotebookTab: noop, addPanel: noop, canAddPanel: true,
  splitPane: noop, equalizePanes: noop, closeTab: noop, switchTabRel: noop, activeSsh: null,
  importSshConfig: noop, selectRibbon: noop, openTunnels: noop, broadcast: false, toggleBroadcast: noop, ribbon: null,
  toggleTheme: noop, exitApp: noop, onStartTour: noop,
};

// Published after each commit (as CommandPalette would read them), never
// written during render.
const seen = { commands: [], toggle: null, setState: null, zoomed: null };
function Harness({ initial, withMenu = false }) {
  const [state, setState] = useState(initial);
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
  // TerminalPanel's mousedown-capture activation, as useWorkspaceTree does it.
  const onActivatePane = useCallback((tabId, paneId) => {
    setState((s) => ({ ...s, panels: s.panels.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t)) })) }));
  }, []);
  useLayoutEffect(() => { seen.setState = setState; }, []);
  useLayoutEffect(() => { seen.commands = commands; seen.toggle = zoom.toggleActivePaneZoom; seen.zoomed = zoom.zoomedPanes; }, [commands, zoom.toggleActivePaneZoom, zoom.zoomedPanes]);
  return (
    <>
      {withMenu && (
        <MenuBar
          {...menuProps}
          activeTabId={activeTab?.id} activePaneId={activeTab?.activePaneId} activeTab={activeTab}
          panels={state.panels} activePanelId={state.activePanelId}
          canZoomActivePane={zoom.canZoomActivePane} activePaneZoomed={zoom.activePaneZoomed} toggleActivePaneZoom={zoom.toggleActivePaneZoom}
        />
      )}
      {state.panels.map((panel) => (
        <TerminalPanel
          key={panel.id}
          panel={panel}
          isActive
          canClosePanel={false}
          xtermTheme={{ background: "#000" }}
          onActivate={noop} onAddTab={noop} onCloseTab={noop} onSwitchTab={noop} onClosePanel={noop}
          onRenameTab={noop} onSetTabColor={noop} onDuplicateTab={noop} onDetachTab={noop} onCloseOthers={noop}
          onTabCostUpdate={noop} onSplitPane={noop} onClosePane={noop} onActivatePane={onActivatePane}
          zoomedPaneId={zoom.zoomedPanes[panel.id] ?? null}
          onSetPaneZoom={zoom.setPaneZoom}
        />
      ))}
    </>
  );
}

const zoomCmd = () => seen.commands.find((c) => c.id === "zoom-pane");
const zoomCtl = (paneId) => [...document.querySelector(`[data-pane-id="${paneId}"]`).querySelectorAll(".phn-pane-ctl")].find((c) => /zoom/i.test(c.title));
const isZoomed = (paneId) => zoomCtl(paneId).title === "Restore split (un-zoom)" && zoomCtl(paneId).closest(".phn-pane-controls").hasAttribute("data-zoomed");
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
// The palette closes, then runs the action a task later; focus moves one more task later.
const runPalette = async () => {
  await act(async () => { zoomCmd().action(); });
  await settle();
};
const setWorkspace = (next) => act(() => { seen.setState(next); });
const terminal = (paneId) => screen.getByLabelText(`terminal ${paneId}`);
// A real click: the browser fires mousedown (TerminalPanel's capture handler
// activates the pane) before the click.
const realClick = (el) => { fireEvent.mouseDown(el); fireEvent.mouseUp(el); fireEvent.click(el); };

afterEach(() => { cleanup(); seen.commands = []; seen.toggle = null; seen.setState = null; seen.zoomed = null; });

describe("the palette's zoom command", () => {
  test("is listed only when the active tab has more than one pane", () => {
    render(<Harness initial={stateOf({ id: "t1", label: "solo" })} />);
    expect(zoomCmd()).toBeUndefined();
    setWorkspace(stateOf({ id: "t1", label: "leaf", layout: { type: "leaf", id: "t1" } }));
    expect(zoomCmd()).toBeUndefined();
    setWorkspace(stateOf(split()));
    expect(zoomCmd()?.label).toBe("Zoom pane");
  });

  test.each([
    ["home", { home: true }],
    ["RDP", { rdp: { host: "h" } }],
    ["VNC", { vnc: { host: "h" } }],
    ["notebook", { notebook: "notes.md" }],
  ])("is not offered on a %s tab, even one carrying a two-pane layout", (_name, extra) => {
    render(<Harness initial={stateOf(split("p2", extra))} />);
    expect(zoomCmd()).toBeUndefined();
  });

  test("zooms the active pane, and run again restores the split", async () => {
    render(<Harness initial={stateOf(split("p2"))} />);
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
    render(<><button>chrome</button><Harness initial={stateOf(split("p2"))} /></>);
    screen.getByText("chrome").focus();
    await runPalette(); // zoom
    expect(document.activeElement).toBe(terminal("p2"));
    screen.getByText("chrome").focus();
    await runPalette(); // restore
    expect(document.activeElement).toBe(terminal("p2"));
  });

  test("acts on whichever pane is active", async () => {
    render(<Harness initial={stateOf(split("t1"))} />);
    await runPalette();
    expect(isZoomed("t1")).toBe(true);
    expect(isZoomed("p2")).toBe(false);
  });

  test("when the active pane is not the zoomed one (the focusPane shortcut moved it), it offers Restore and restores", async () => {
    render(<><button>chrome</button><Harness initial={stateOf(split("p2"))} /></>);
    await runPalette();
    expect(isZoomed("p2")).toBe(true);
    setWorkspace(withActive(stateOf(split("p2")), "t1")); // t1 active, hidden under the zoomed p2
    expect(zoomCmd().label).toBe("Restore split (un-zoom)");
    screen.getByText("chrome").focus();
    await runPalette();
    expect(isZoomed("p2")).toBe(false);
    expect(isZoomed("t1")).toBe(false); // restored, not re-zoomed onto t1
    expect(zoomCmd().label).toBe("Zoom pane");
    expect(document.activeElement).toBe(terminal("t1")); // the active pane, visible again
  });
});

describe("toggleActivePaneZoom", () => {
  test("keeps one identity across workspace changes (memo(MenuBar) is not re-rendered for it) and acts on the latest state", async () => {
    render(<Harness initial={stateOf(split("p2"))} />);
    const first = seen.toggle;
    setWorkspace(withActive(stateOf(split("p2")), "t1"));
    expect(seen.toggle).toBe(first);
    await act(async () => { first(); });
    await settle();
    expect(isZoomed("t1")).toBe(true); // the pane active NOW, not when the callback was made
    expect(isZoomed("p2")).toBe(false);
  });
});

describe("closed panels", () => {
  test("their zoom entries are dropped on the next zoom change", async () => {
    render(<Harness initial={stateOf(split("p2"))} />);
    await runPalette();
    expect(Object.keys(seen.zoomed)).toEqual(["panel_1"]);
    const other = { activePanelId: "panel_2", panels: [{ id: "panel_2", activeTabId: "u1", tabs: [{ id: "u1", label: "two", activePaneId: "u2", layout: { type: "split", id: "s9", dir: "col", ratio: 0.5, a: { type: "leaf", id: "u1" }, b: { type: "leaf", id: "u2" } } }] }] };
    setWorkspace(other); // panel_1 closed
    await runPalette();
    expect(Object.keys(seen.zoomed)).toEqual(["panel_2"]);
  });
});

describe("hover control and palette share one zoom state", () => {
  test("zoom by click, restore by palette", async () => {
    render(<Harness initial={stateOf(split("p2"))} />);
    realClick(zoomCtl("p2"));
    expect(isZoomed("p2")).toBe(true);
    expect(zoomCmd().label).toBe("Restore split (un-zoom)");
    await runPalette();
    expect(isZoomed("p2")).toBe(false);
  });

  test("zoom by palette, restore by click", async () => {
    render(<Harness initial={stateOf(split("p2"))} />);
    await runPalette();
    expect(isZoomed("p2")).toBe(true);
    realClick(zoomCtl("p2"));
    expect(isZoomed("p2")).toBe(false);
    expect(zoomCmd().label).toBe("Zoom pane");
  });

  test("hover-zoom of a pane that was NOT active (mousedown, then click), then palette Restore", async () => {
    render(<><button>chrome</button><Harness initial={stateOf(split("p2"))} /></>);
    realClick(zoomCtl("t1")); // the mousedown makes t1 active, the click zooms it
    expect(isZoomed("t1")).toBe(true);
    expect(isZoomed("p2")).toBe(false);
    expect(zoomCmd().label).toBe("Restore split (un-zoom)");
    screen.getByText("chrome").focus();
    await runPalette();
    expect(isZoomed("t1")).toBe(false);
    expect(zoomCmd().label).toBe("Zoom pane");
    expect(document.activeElement).toBe(terminal("t1"));
  });
});

describe("palette and Terminal menu agree", () => {
  const menuItem = () => {
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    const it = screen.queryByRole("button", { name: "Zoom pane" }) || screen.queryByRole("button", { name: "Restore split (un-zoom)" });
    const out = it && { label: it.textContent, disabled: it.disabled };
    fireEvent.click(screen.getByRole("button", { name: "Terminal" })); // close it again
    return out;
  };
  test.each([
    ["a one-pane tab", () => stateOf({ id: "t1", label: "solo" }), false],
    ["an RDP tab with a layout", () => stateOf(split("p2", { rdp: { host: "h" } })), false],
    ["a split tab", () => stateOf(split("p2")), true],
  ])("enabled together, with the same label: %s", (_name, make, enabled) => {
    render(<Harness initial={make()} withMenu />);
    const menu = menuItem();
    expect(menu.disabled).toBe(!enabled);
    expect(Boolean(zoomCmd())).toBe(enabled);
    if (enabled) expect(menu.label).toBe(zoomCmd().label);
  });

  test("the label follows the zoom in both", async () => {
    render(<Harness initial={stateOf(split("p2"))} withMenu />);
    await runPalette();
    expect(zoomCmd().label).toBe("Restore split (un-zoom)");
    expect(menuItem().label).toBe("Restore split (un-zoom)");
  });
});

describe("TerminalsTab wiring (no test renders TerminalsTab, so its source is pinned)", () => {
  const src = readFileSync(path.join(process.cwd(), "src/features/terminals/TerminalsTab.jsx"), "utf8");
  const between = (from, to) => {
    const a = src.indexOf(from);
    return a < 0 ? "" : src.slice(a, src.indexOf(to, a));
  };
  const FIELDS = ["canZoomActivePane", "activePaneZoomed", "toggleActivePaneZoom"];
  test("usePaneZoom runs once, over the workspace state", () => {
    expect(src.split("usePaneZoom(").length - 1).toBe(1);
    expect(between("usePaneZoom(", ")")).toContain("state");
  });
  test("each TerminalPanel gets its zoomed pane and the setter", () => {
    const panel = between("<TerminalPanel", "/>");
    expect(panel).toContain("zoomedPaneId=");
    expect(panel).toContain("zoomedPanes");
    expect(panel).toContain("onSetPaneZoom=");
    expect(panel).toContain("setPaneZoom");
  });
  test("the palette and the Terminal menu get the three zoom fields", () => {
    const palette = between("usePaletteCommands({", "});");
    const menu = between("<MenuBar", "/>");
    for (const f of FIELDS) {
      expect(palette).toContain(f);
      expect(menu).toContain(`${f}=`);
    }
  });
});
