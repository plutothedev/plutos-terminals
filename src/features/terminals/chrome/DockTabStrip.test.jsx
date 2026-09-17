// (C)
// @vitest-environment happy-dom
//
// Audit A11Y-07: the three right-dock tabs were click-only <span>s. That was
// not a "degraded" keyboard path, it was no path at all for two of the three:
// "files" is also reachable via F4, the Ctrl+K palette and the Files (SFTP)
// menu item, but nothing anywhere in the app calls setDockTab("assistant") or
// setDockTab("monitor"), so the AI Assistant chat and the CPU/MEM/DISK monitor
// were unreachable for a whole session without a mouse.
import { describe, test, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import DockTabStrip from "./DockTabStrip.jsx";

afterEach(cleanup);

const tabs = () => [...document.querySelectorAll('[role="tab"]')];
const byLabel = (l) => screen.getByLabelText(l);

function mount(dockTab = "files", spies = {}) {
  const setDockTab = spies.setDockTab || vi.fn();
  const collapseDock = spies.collapseDock || vi.fn();
  render(<DockTabStrip dockTab={dockTab} setDockTab={setDockTab} collapseDock={collapseDock} />);
  return { setDockTab, collapseDock };
}

describe("right-dock tab strip (A11Y-07)", () => {
  test("the strip is a tablist of three tabs with aria-selected tracking dockTab", () => {
    mount("assistant");
    expect(document.querySelector('[role="tablist"].moba-rd-tabs')).toBeTruthy();
    expect(tabs()).toHaveLength(3);
    expect(byLabel("Assistant").getAttribute("aria-selected")).toBe("true");
    expect(byLabel("SFTP").getAttribute("aria-selected")).toBe("false");
    expect(byLabel("Monitor").getAttribute("aria-selected")).toBe("false");
  });

  test("roving tabIndex puts exactly one dock tab in the tab order", () => {
    mount("monitor");
    const tabbable = tabs().filter((el) => el.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute("aria-label")).toBe("Monitor");
  });

  test("an unknown dockTab still leaves one tab stop", () => {
    // dockTab is persisted, so a value from an older build (or a future one)
    // must not strand the strip outside the tab order entirely.
    mount("something-else");
    expect(tabs().filter((el) => el.tabIndex === 0)).toHaveLength(1);
  });

  test("ArrowRight reaches Assistant and Monitor, the two panels with no other route", () => {
    const { setDockTab } = mount("files");
    fireEvent.keyDown(byLabel("SFTP"), { key: "ArrowRight" });
    expect(setDockTab).toHaveBeenCalledWith("assistant");
    fireEvent.keyDown(byLabel("Assistant"), { key: "ArrowRight" });
    expect(setDockTab).toHaveBeenLastCalledWith("monitor");
  });

  test("ArrowRight wraps from the last tab and ArrowLeft wraps from the first", () => {
    const { setDockTab } = mount("monitor");
    fireEvent.keyDown(byLabel("Monitor"), { key: "ArrowRight" });
    expect(setDockTab).toHaveBeenLastCalledWith("files");
    fireEvent.keyDown(byLabel("SFTP"), { key: "ArrowLeft" });
    expect(setDockTab).toHaveBeenLastCalledWith("monitor");
  });

  test("Home and End jump to the ends", () => {
    const { setDockTab } = mount("assistant");
    fireEvent.keyDown(byLabel("Assistant"), { key: "End" });
    expect(setDockTab).toHaveBeenLastCalledWith("monitor");
    fireEvent.keyDown(byLabel("Assistant"), { key: "Home" });
    expect(setDockTab).toHaveBeenLastCalledWith("files");
  });

  test("Enter and Space activate the focused tab", () => {
    const { setDockTab } = mount("files");
    fireEvent.keyDown(byLabel("Monitor"), { key: "Enter" });
    expect(setDockTab).toHaveBeenLastCalledWith("monitor");
    fireEvent.keyDown(byLabel("Assistant"), { key: " " });
    expect(setDockTab).toHaveBeenLastCalledWith("assistant");
  });

  test("arrow navigation moves focus, not just selection", () => {
    mount("files");
    fireEvent.keyDown(byLabel("SFTP"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(byLabel("Assistant"));
  });

  test("an unhandled key is left alone for the app's own shortcuts", () => {
    const { setDockTab } = mount("files");
    fireEvent.keyDown(byLabel("SFTP"), { key: "a" });
    fireEvent.keyDown(byLabel("SFTP"), { key: "Tab" });
    expect(setDockTab).not.toHaveBeenCalled();
  });

  test("the collapse control has a real name, not just a chevron", () => {
    const { collapseDock } = mount();
    const btn = byLabel("Collapse side panel");
    expect(btn.tagName).toBe("BUTTON");
    fireEvent.click(btn);
    expect(collapseDock).toHaveBeenCalledWith(true);
  });
});
