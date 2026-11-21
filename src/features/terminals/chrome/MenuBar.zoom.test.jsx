// (C)
// @vitest-environment happy-dom
//
// The Terminal menu lists the pane-zoom toggle beside Split right / Split down
// / Equalize, running the same action as the palette's "Zoom pane"
// (hooks/usePaneZoom.js). Like the menu's other split items it is disabled,
// not hidden, when the active tab has one pane.
import { describe, test, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";

vi.mock("@backend", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), isTauri: () => true }));

import MenuBar from "./MenuBar.jsx";

const noop = () => {};
const base = {
  addTab: noop, addHomeTab: noop, addNotebookTab: noop, addPanel: noop, canAddPanel: true,
  splitPane: noop, equalizePanes: noop, closeTab: noop,
  activeTabId: "t1", activePaneId: "p2", activeTab: { id: "t1" }, panels: [{ id: "panel_1", tabs: [{ id: "t1" }], activeTabId: "t1" }],
  activePanelId: "panel_1", switchTabRel: noop, activeSsh: null,
  importSshConfig: noop, selectRibbon: noop, openTunnels: noop, broadcast: false, toggleBroadcast: noop, ribbon: null,
  toggleTheme: noop, exitApp: noop, onStartTour: noop,
};
const openTerminalMenu = () => fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
const item = (name) => screen.getByRole("button", { name });

afterEach(cleanup);

describe("Terminal menu: pane zoom", () => {
  test("Zoom pane runs the shared toggle", () => {
    const toggle = vi.fn();
    render(<MenuBar {...base} canZoomActivePane activePaneZoomed={false} toggleActivePaneZoom={toggle} />);
    openTerminalMenu();
    expect(item("Zoom pane").disabled).toBe(false);
    fireEvent.click(item("Zoom pane"));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  test("reads Restore split (un-zoom) while the active pane is zoomed", () => {
    const toggle = vi.fn();
    render(<MenuBar {...base} canZoomActivePane activePaneZoomed toggleActivePaneZoom={toggle} />);
    openTerminalMenu();
    fireEvent.click(item("Restore split (un-zoom)"));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  test("is disabled on a one-pane tab", () => {
    render(<MenuBar {...base} canZoomActivePane={false} activePaneZoomed={false} toggleActivePaneZoom={noop} />);
    openTerminalMenu();
    expect(item("Zoom pane").disabled).toBe(true);
  });
});
