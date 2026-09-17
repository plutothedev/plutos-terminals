// (C)
// @vitest-environment happy-dom
//
// Audit FE-1, the Share-transcript half. Transcripts are written by TerminalPane
// under its own LEAF id (`transcriptName(liveProjectName(), tabIdRef.current)`),
// and the project-name half of that stem only reaches the ROOT leaf, because
// TerminalPanel passes `projectName={isRoot ? tabProjectNames[tab.id] : null}`.
// The tab context menu's "Share transcript…" read it back keyed on tab.id, which
// reproduces both FE-1 failure modes: on a split tab it could only ever surface
// pane 1, and once the ORIGINAL pane is closed (removeLeaf collapses onto the
// sibling, so no leaf id equals tab.id) it either claims "Nothing recorded yet."
// for a tab with a live shell, or serves the DEAD pane's on-disk history while
// the user is looking at the live one.
//
// These render the REAL TerminalPanel and assert on the ARGUMENTS it hands the
// stem builder, not on the stem's format. `transcriptName` is stubbed to a
// structural echo (JSON of its two inputs) rather than a re-implementation of
// the real "<project-or-tab>-<last6>" formula on purpose: a stub that copied the
// formula would let this file pass while production and test agreed on the wrong
// id, which is the exact defect class this suite exists to catch. What is under
// test is WHICH pane and WHICH project name get addressed.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { splitLeaf, removeLeaf, getLayout } from "./splitTree.js";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => "some recorded output\n") }));

// TerminalPane's real module pulls in xterm, the pane registry and the Tauri
// bridge; none of that can run here and none of it is what this file is about.
vi.mock("./TerminalPane", () => ({
  default: ({ tabId }) => <div data-testid={`pane-body-${tabId}`} />,
  todayDate: () => "2026-08-21",
  transcriptName: (projectName, paneId) => JSON.stringify({ projectName, paneId }),
}));
vi.mock("@backend", () => ({ invoke: (...a) => invoke(...a), listen: vi.fn(async () => () => {}), isTauri: () => true }));
vi.mock("./VncView", () => ({ default: () => <div /> }));
vi.mock("./RdpView", () => ({ default: () => <div /> }));
vi.mock("./MobaHomeScreen", () => ({ default: () => <div /> }));
vi.mock("./NotebookView", () => ({ default: () => <div /> }));
vi.mock("./ShareModal.jsx", () => ({ default: () => <div data-testid="share-modal" /> }));
vi.mock("../../components/ErrorBoundary.jsx", () => ({ PaneBoundary: ({ children }) => <>{children}</> }));

import TerminalPanel from "./TerminalPanel.jsx";

// The shape useWorkspaceTree writes after Ctrl+Shift+D: splitLeaf keeps the
// EXISTING leaf's id (= tab.id) and adds the new leaf beside it; focus moves to
// the new leaf.
function splitTab(extra = {}) {
  const base = { id: "tab1", label: "prod-db", cwd: null };
  return {
    ...base,
    layout: splitLeaf(getLayout(base), "tab1", "row", { id: "pane2", cwd: null }, "split1"),
    activePaneId: "pane2",
    ...extra,
  };
}

function mount(tab, tabProjectNames) {
  return render(
    <TerminalPanel
      panel={{ id: "panel_1", activeTabId: tab.id, tabs: [tab] }}
      isActive
      canClosePanel
      xtermTheme={{ background: "#000" }}
      tabProjectNames={tabProjectNames}
      notify={notify}
      onActivate={() => {}}
      onAddTab={() => {}}
      onCloseTab={() => {}}
      onSwitchTab={() => {}}
      onClosePanel={() => {}}
      onTabCostUpdate={() => {}}
      onRenameTab={() => {}}
      onSetTabColor={() => {}}
      onDuplicateTab={() => {}}
      onDetachTab={() => {}}
      onCloseOthers={() => {}}
    />
  );
}

const notify = vi.fn();

// Right-click the tab, then click "Share transcript…", and report the
// {projectName, paneId} the panel asked transcript_read_all for.
async function shareFrom(tab, tabProjectNames) {
  mount(tab, tabProjectNames);
  const tabEl = document.querySelector(`.moba-tab[data-tab-id="${tab.id}"]`);
  expect(tabEl).toBeTruthy();
  fireEvent.contextMenu(tabEl);
  fireEvent.click(screen.getByText("Share transcript…"));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("transcript_read_all", expect.anything()));
  const call = invoke.mock.calls.find((c) => c[0] === "transcript_read_all");
  return JSON.parse(call[1].name);
}

beforeEach(() => { invoke.mockClear(); notify.mockClear(); });
afterEach(cleanup);

describe("Share transcript addresses a PANE (audit FE-1)", () => {
  test("an unsplit tab reads its own id, carrying the project name", async () => {
    // The one case where tab id and pane id coincide. It has to keep working:
    // the project-name half of the stem is only correct for the root leaf.
    const tab = { id: "tab1", label: "prod-db", cwd: null };
    expect(await shareFrom(tab, { tab1: "checkout-api" })).toEqual({
      projectName: "checkout-api",
      paneId: "tab1",
    });
  });

  test("a split tab reads the FOCUSED pane, not pane 1", async () => {
    const tab = splitTab(); // activePaneId: "pane2"
    // tab.id is still a live leaf here, which is why the old form looked fine.
    expect(tab.id).toBe("tab1");
    const asked = await shareFrom(tab, { tab1: "checkout-api" });
    expect(asked.paneId).toBe("pane2");
    // …and pane 2 never received the project name, so claiming it here would
    // build a stem no transcript was ever written under.
    expect(asked.projectName).toBeNull();
  });

  test("after the ORIGINAL pane is closed it reads the survivor, not the dead id", async () => {
    // removeLeaf collapsed the tree onto the sibling: the shell is live, but no
    // leaf id equals tab.id. Reading tab.id here surfaces the closed pane's
    // on-disk history, or nothing at all, under the live pane's tab.
    const tab = splitTab();
    const collapsed = { ...tab, layout: removeLeaf(tab.layout, "tab1"), activePaneId: "tab1" };
    const asked = await shareFrom(collapsed, { tab1: "checkout-api" });
    expect(asked.paneId).toBe("pane2");
    expect(asked.paneId).not.toBe(collapsed.id);
  });

  test("an empty transcript still opens no share modal", async () => {
    // Fail-closed guard, unchanged by the re-addressing: nothing leaves the app
    // when there is nothing recorded.
    invoke.mockResolvedValueOnce("   \n  ");
    const tab = { id: "tab1", label: "prod-db", cwd: null };
    mount(tab, {});
    fireEvent.contextMenu(document.querySelector('.moba-tab[data-tab-id="tab1"]'));
    fireEvent.click(screen.getByText("Share transcript…"));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("info", "Nothing recorded yet."));
    expect(screen.queryByTestId("share-modal")).toBeNull();
  });
});
