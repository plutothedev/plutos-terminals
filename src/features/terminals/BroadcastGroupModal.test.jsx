// (C)
// @vitest-environment happy-dom
// Audit FE-1, broadcast-picker half. `liveTabIds` is ptyBridge.getLiveTabIds(),
// i.e. `[...writers.keys()]`, and every writer is registered by a TerminalPane
// under its LEAF id. The picker filtered `panel.tabs` by `t.id` against that
// set, so it listed only the panes that happen to share their tab's id.
//
// Renders the REAL component and counts the rows it produces, rather than
// testing an extracted helper the component might forget to call.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import BroadcastGroupModal from "./BroadcastGroupModal.jsx";
import { splitLeaf, removeLeaf, getLayout } from "./splitTree.js";

afterEach(cleanup);

// The shape useWorkspaceTree writes after a split: the existing leaf keeps
// tab.id, the new leaf is added beside it.
function splitTab(id, label, connection = null) {
  const base = { id, label, cwd: null, ...(connection ? { connection } : {}) };
  return { ...base, layout: splitLeaf(getLayout(base), id, "row", { id: `${id}-p2`, cwd: null }, `${id}-s`) };
}

const rows = () => Array.from(document.querySelectorAll('input[type="checkbox"]'));
const labels = () => Array.from(document.querySelectorAll('input[type="checkbox"]')).map(
  (el) => el.closest("label")?.textContent?.trim()
);

function mount(props) {
  return render(
    <BroadcastGroupModal
      open
      current={null}
      onClose={() => {}}
      onApply={() => {}}
      onUseAllVisible={() => {}}
      {...props}
    />
  );
}

describe("BroadcastGroupModal targets panes, not tabs", () => {
  it("offers one row per live pane of a split tab", () => {
    mount({
      panels: [{ id: "p1", tabs: [splitTab("tab1", "shell")] }],
      liveTabIds: ["tab1", "tab1-p2"],
    });
    expect(rows()).toHaveLength(2);
    expect(labels()).toEqual(["1. shell ·1", "2. shell ·2"]);
  });

  it("still lists a tab whose ORIGINAL pane was closed", () => {
    // removeLeaf collapsed the tree to the sibling: the shell is live and
    // writable, but no leaf id equals tab.id any more. The old filter dropped
    // the tab from the picker entirely.
    const tab = splitTab("tab1", "shell");
    const collapsed = { ...tab, layout: removeLeaf(tab.layout, "tab1") };
    mount({
      panels: [{ id: "p1", tabs: [collapsed] }],
      liveTabIds: ["tab1-p2"],
    });
    expect(rows()).toHaveLength(1);
    expect(labels()).toEqual(["1. shell"]); // single surviving pane, no ·N suffix
  });

  it("chips the SSH host on the root pane only; every other pane is a local shell", () => {
    // TerminalPanel gives the transport to the root leaf alone
    // (`connection={isRoot ? tab.connection : null}`, isRoot = node.id === tab.id)
    // and TerminalPane with a null connection falls through to pty_spawn. So
    // pane 2 of a split SSH tab is the user's OWN machine. This is the picker
    // that decides which machines a fanned-out keystroke reaches, so a host name
    // on the wrong row is a command run against the wrong box.
    mount({
      panels: [{ id: "p1", tabs: [splitTab("tab1", "prod-db", { host: "prod-db.internal" })] }],
      liveTabIds: ["tab1", "tab1-p2"],
    });
    const [root, second] = labels();
    expect(root).toContain("prod-db.internal");
    expect(second).not.toContain("prod-db.internal");
    // …and the host is claimed exactly once across the whole picker.
    expect(labels().filter((l) => l.includes("prod-db.internal"))).toHaveLength(1);
  });

  it("drops the host chip entirely once the ROOT pane is closed", () => {
    // removeLeaf collapsed onto the sibling, which was spawned by pty_spawn and
    // is still a local shell. No leaf id equals tab.id any more, so nothing on
    // screen may claim the remote host.
    const tab = splitTab("tab1", "prod-db", { host: "prod-db.internal" });
    const collapsed = { ...tab, layout: removeLeaf(tab.layout, "tab1") };
    mount({ panels: [{ id: "p1", tabs: [collapsed] }], liveTabIds: ["tab1-p2"] });
    expect(rows()).toHaveLength(1);
    expect(labels()[0]).not.toContain("prod-db.internal");
  });

  it("still hides panes with no live PTY writer", () => {
    mount({
      panels: [{ id: "p1", tabs: [splitTab("tab1", "shell"), { id: "home1", home: true, label: "Home" }] }],
      liveTabIds: ["tab1"], // second pane not spawned yet; home tab never spawns
    });
    expect(labels()).toEqual(["1. shell ·1"]);
  });

  it("applies the PANE ids, which is what writeBroadcast matches against", () => {
    const onApply = vi.fn();
    mount({
      panels: [{ id: "p1", tabs: [splitTab("tab1", "shell")] }],
      liveTabIds: ["tab1", "tab1-p2"],
      onApply,
    });
    fireEvent.click(rows()[1]);
    fireEvent.click(screen.getByText(/^Broadcast to/));
    expect(onApply).toHaveBeenCalledWith(["tab1-p2"]);
  });

  it("Select all covers every pane across every panel", () => {
    const onApply = vi.fn();
    mount({
      panels: [
        { id: "p1", tabs: [splitTab("tab1", "shell")] },
        { id: "p2", tabs: [{ id: "tab9", label: "ssh" }] },
      ],
      liveTabIds: ["tab1", "tab1-p2", "tab9"],
      onApply,
    });
    fireEvent.click(screen.getByText("Select all"));
    fireEvent.click(screen.getByText(/^Broadcast to/));
    expect(onApply.mock.calls[0][0].sort()).toEqual(["tab1", "tab1-p2", "tab9"]);
  });

  it("says so plainly when nothing is live", () => {
    mount({ panels: [{ id: "p1", tabs: [{ id: "tab1", label: "shell" }] }], liveTabIds: [] });
    expect(rows()).toHaveLength(0);
    expect(screen.getByText(/No live terminals/)).toBeTruthy();
  });
});
