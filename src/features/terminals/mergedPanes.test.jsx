// (C)
// @vitest-environment happy-dom
// Drag-to-split for SSH and serial tabs. Folding a remote tab into another
// tab's split makes a NON-root leaf that runs a remote session, which breaks
// the old rule "every non-root leaf is a local shell" that several readers
// relied on. These tests pin the replacement: one reader of what a pane runs
// (paneSpawnConfig), one reader of what the tab-wide tools act on
// (activeSshContext), the stamp that makes a merged pane respawn as itself,
// the refusals, the password lifecycle, and the two consumers where getting it
// wrong costs the most: the broadcast picker (which machines a keystroke
// reaches) and the dock tools (which host gets the password).
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, renderHook, act, cleanup, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

const invoke = vi.fn(() => Promise.resolve());
vi.mock("@backend", () => ({ invoke: (...a) => invoke(...a), listen: vi.fn(async () => () => {}), isTauri: () => true }));

import { activeSshContext, leafSpawnConfig, paneSessionLabel, paneSpawnConfig } from "./activePane.js";
import { useWorkspaceTree, passwordKeysOf } from "./hooks/useWorkspaceTree.js";
import { useTunnels } from "./hooks/useTunnels.js";
import { paneProjectIds, projectIndexOf } from "./hooks/useTabTelemetry.js";
import { setProjectIndex, setPaneActivity, __testGetRollups, __resetActivityStore } from "./activityStore.js";
import { STATE_KEY_PREFIX } from "./storageKeys.js";
import { useSftpDock } from "./hooks/useSftpDock.js";
import { getTabPassword, setTabPassword, clearTabPassword } from "./ptyBridge.js";
import { getLayout, leafIds, leaves } from "./splitTree.js";
import BroadcastGroupModal from "./BroadcastGroupModal.jsx";

const PROD = { host: "prod.example", port: 22, user: "deploy", auth: { method: "password" } };
const LAB = { host: "lab.example", port: 2222, user: "pi", auth: { method: "key", keyPath: "~/.ssh/id_ed25519" } };
const SERIAL = { path: "/dev/tty.usbserial-1", baud: 115200 };

const row = (a, b, id = "s1") => ({ id, dir: "row", ratio: 0.5, a, b });

// A local tab with an SSH tab already folded into its split (what
// moveTabIntoSplit produces), plus a plain SSH tab, plus an SSH tab split with
// an ordinary local pane.
function workspace() {
  return {
    panels: [{
      id: "panel-1",
      activeTabId: "tab-local",
      tabs: [
        {
          id: "tab-local", label: "work", cwd: "/home/me", startCommands: [],
          layout: row({ id: "tab-local" }, { id: "tab-prod", cwd: "/srv/app", connection: PROD, startCommands: ["tmux attach"] }),
          activePaneId: "tab-prod",
        },
        { id: "tab-ssh", label: "lab", cwd: null, connection: LAB, startCommands: [] },
        {
          id: "tab-split", label: "prod2", cwd: null, connection: PROD, startCommands: [],
          layout: row({ id: "tab-split" }, { id: "pane-local", cwd: "/tmp" }, "s2"),
          activePaneId: "pane-local",
        },
      ],
    }],
    activePanelId: "panel-1",
    gridMode: "auto",
  };
}

function mountTree(state) {
  const persist = vi.fn();
  const toast = { info: vi.fn(), error: vi.fn(), success: vi.fn() };
  const { result } = renderHook(() => useWorkspaceTree({ state, persist, toast }));
  return { api: result.current, persist, toast, last: () => persist.mock.calls.at(-1)?.[0] };
}

const tabOf = (st, id) => st.panels.flatMap((p) => p.tabs).find((t) => t.id === id);

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(() => Promise.resolve());
  for (const id of ["tab-local", "tab-prod", "tab-ssh", "tab-split", "pane-local", "tab-a", "tab-b", "pane-x"]) clearTabPassword(id);
});
afterEach(cleanup);

describe("paneSpawnConfig: what a pane runs", () => {
  const st = workspace();
  const local = tabOf(st, "tab-local");

  test("the root leaf runs the tab's own fields", () => {
    expect(paneSpawnConfig(local, "tab-local")).toEqual({
      cwd: "/home/me", connection: null, serial: null, startCommands: [], systemPrompt: null,
    });
  });

  test("a folded-in leaf runs its own fields, by identity", () => {
    const cfg = paneSpawnConfig(local, "tab-prod");
    expect(cfg.connection).toBe(PROD); // same object: a memoized pane sees no change
    expect(cfg.cwd).toBe("/srv/app");
    expect(cfg.startCommands).toEqual(["tmux attach"]);
  });

  test("an ordinary split leaf of an SSH tab is local", () => {
    expect(paneSpawnConfig(tabOf(st, "tab-split"), "pane-local").connection).toBeNull();
  });

  test("an unknown pane runs nothing", () => {
    expect(paneSpawnConfig(local, "nope")).toEqual(leafSpawnConfig(null));
    expect(paneSpawnConfig(null, "x").connection).toBeNull();
  });
});

describe("activeSshContext: what the dock tools act on", () => {
  const st = workspace();

  test("a focused folded-in SSH pane is the context, keyed by its own pane id", () => {
    expect(activeSshContext(tabOf(st, "tab-local"))).toEqual({ connection: PROD, paneId: "tab-prod" });
  });

  test("focusing the local root of that tab means no SSH context", () => {
    expect(activeSshContext({ ...tabOf(st, "tab-local"), activePaneId: "tab-local" })).toBeNull();
  });

  test("a plain SSH tab is unchanged: its connection, keyed by the tab id", () => {
    expect(activeSshContext(tabOf(st, "tab-ssh"))).toEqual({ connection: LAB, paneId: "tab-ssh" });
  });

  test("a local pane split off an SSH tab keeps the dock on that host, as before", () => {
    expect(activeSshContext(tabOf(st, "tab-split"))).toEqual({ connection: PROD, paneId: "tab-split" });
  });

  test("no tab, or a tab with no SSH anywhere, means no context", () => {
    expect(activeSshContext(null)).toBeNull();
    expect(activeSshContext({ id: "h", home: true })).toBeNull();
  });
});

describe("moveTabIntoSplit with remote tabs", () => {
  function twoTabs(dragged) {
    return {
      panels: [{ id: "panel-1", activeTabId: "tab-a", tabs: [{ id: "tab-a", label: "a", cwd: "/a", startCommands: [] }, dragged] }],
      activePanelId: "panel-1", gridMode: "auto",
    };
  }

  test("an SSH tab folds in carrying what it runs, and the saved layout still carries it after a restart", () => {
    const dragged = { id: "tab-b", label: "prod", cwd: "/srv", connection: PROD, startCommands: ["tmux attach"], systemPrompt: "be terse" };
    const { api, last } = mountTree(twoTabs(dragged));
    act(() => api.moveTabIntoSplit("tab-b", "tab-a", "tab-a", "row"));
    const after = last();
    expect(after.panels[0].tabs.map((t) => t.id)).toEqual(["tab-a"]); // folded away as a tab
    const host = tabOf(after, "tab-a");
    expect(leafIds(getLayout(host))).toEqual(["tab-a", "tab-b"]);
    expect(host.activePaneId).toBe("tab-b");
    const cfg = paneSpawnConfig(host, "tab-b");
    expect(cfg.connection).toBe(PROD);
    expect(cfg).toMatchObject({ cwd: "/srv", startCommands: ["tmux attach"], systemPrompt: "be terse" });
    // What a restart reads back is plain JSON: the leaf still says SSH.
    const reloaded = JSON.parse(JSON.stringify(host));
    expect(paneSpawnConfig(reloaded, "tab-b").connection).toEqual(PROD);
    expect(activeSshContext(reloaded)).toEqual({ connection: PROD, paneId: "tab-b" });
  });

  test("a serial tab folds in carrying its port", () => {
    const { api, last } = mountTree(twoTabs({ id: "tab-b", label: "uart", serial: SERIAL, startCommands: [] }));
    act(() => api.moveTabIntoSplit("tab-b", "tab-a", "tab-a", "col"));
    expect(paneSpawnConfig(tabOf(last(), "tab-a"), "tab-b").serial).toBe(SERIAL);
  });

  test("a plain local tab folds in lean: no empty fields are stamped", () => {
    const { api, last } = mountTree(twoTabs({ id: "tab-b", label: "b", cwd: null, startCommands: [] }));
    act(() => api.moveTabIntoSplit("tab-b", "tab-a", "tab-a", "row"));
    const leaf = leaves(getLayout(tabOf(last(), "tab-a"))).find((l) => l.id === "tab-b");
    expect(leaf).toEqual({ id: "tab-b", cwd: null }); // getLayout's implicit leaf; nothing stamped
  });

  test("an agent worktree tab is refused: Discard could no longer find it", () => {
    const { api, persist } = mountTree(twoTabs({ id: "tab-b", label: "agent", cwd: "/repo/.wt/x", worktree: { path: "/repo/.wt/x", branch: "x", repo: "/repo" }, startCommands: [] }));
    act(() => api.moveTabIntoSplit("tab-b", "tab-a", "tab-a", "row"));
    expect(persist).not.toHaveBeenCalled();
  });

  test("a launch-screen tab is refused", () => {
    const { api, persist } = mountTree(twoTabs({ id: "tab-b", label: "home", home: true }));
    act(() => api.moveTabIntoSplit("tab-b", "tab-a", "tab-a", "row"));
    expect(persist).not.toHaveBeenCalled();
  });

  test("a tab whose root pane was closed away stamps nothing; its other panes keep their own", () => {
    const dragged = {
      id: "tab-b", label: "rest", connection: PROD, startCommands: [],
      layout: { id: "pane-x", cwd: "/x" }, // the root leaf "tab-b" is gone
    };
    const { api, last } = mountTree(twoTabs(dragged));
    act(() => api.moveTabIntoSplit("tab-b", "tab-a", "tab-a", "row"));
    const host = tabOf(last(), "tab-a");
    expect(leafIds(getLayout(host))).toEqual(["tab-a", "pane-x"]);
    expect(paneSpawnConfig(host, "pane-x")).toMatchObject({ cwd: "/x", connection: null });
  });

  test("folding keeps the tab's password under its pane id (a fold must not clear it)", () => {
    setTabPassword("tab-b", "hunter2");
    const { api } = mountTree(twoTabs({ id: "tab-b", label: "prod", connection: PROD, startCommands: [] }));
    act(() => api.moveTabIntoSplit("tab-b", "tab-a", "tab-a", "row"));
    expect(getTabPassword("tab-b")).toBe("hunter2");
  });

  test("folding a tab whose root pane was closed drops that pane's leftover password", () => {
    setTabPassword("tab-b", "root-pw"); // closePane kept it under the tab id
    const { api } = mountTree(twoTabs({ id: "tab-b", label: "rest", connection: PROD, startCommands: [], layout: { id: "pane-x" } }));
    act(() => api.moveTabIntoSplit("tab-b", "tab-a", "tab-a", "row"));
    expect(getTabPassword("tab-b")).toBeNull();
  });

  test("nothing folds INTO an agent worktree tab either", () => {
    const st = {
      panels: [{ id: "panel-1", activeTabId: "tab-a", tabs: [
        { id: "tab-a", label: "agent", cwd: "/repo/.wt/x", worktree: { path: "/repo/.wt/x", branch: "x", repo: "/repo" }, startCommands: [] },
        { id: "tab-b", label: "prod", connection: PROD, startCommands: [] },
      ] }],
      activePanelId: "panel-1", gridMode: "auto",
    };
    const { api, persist } = mountTree(st);
    act(() => api.moveTabIntoSplit("tab-b", "tab-a", "tab-a", "row"));
    expect(persist).not.toHaveBeenCalled();
  });

  test("a folded pane keeps its saved session, so its auto-approve and transcript name carry on", () => {
    const { api, last } = mountTree(twoTabs({ id: "tab-b", label: "prod", connection: PROD, projectId: "proj-prod", startCommands: [] }));
    act(() => api.moveTabIntoSplit("tab-b", "tab-a", "tab-a", "row"));
    const host = tabOf(last(), "tab-a");
    expect(leaves(getLayout(host)).find((l) => l.id === "tab-b").projectId).toBe("proj-prod");
    expect(paneProjectIds(host)).toEqual([["tab-b", "proj-prod"]]);
    expect(paneProjectIds({ ...host, projectId: "proj-a" })).toEqual([["tab-a", "proj-a"], ["tab-b", "proj-prod"]]);
  });

  test("detaching a tab keeps its folded-in remote pane, which re-spawns as itself in the new window", async () => {
    localStorage.clear();
    const { api } = mountTree(workspace());
    await act(async () => { await api.detachTab("panel-1", "tab-local"); });
    let key = null;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`${STATE_KEY_PREFIX}:`)) key = k;
    }
    expect(key).not.toBeNull();
    const seeded = JSON.parse(localStorage.getItem(key)).terminalsState.panels[0].tabs[0];
    expect(leafIds(getLayout(seeded))).toEqual(["tab-local", "tab-prod"]);
    expect(paneSpawnConfig(seeded, "tab-prod").connection).toEqual(PROD);
    expect(seeded.activePaneId).toBe("tab-prod");
  });
});

describe("passwords leave with the panes that held them", () => {
  test("passwordKeysOf covers the tab id and every pane, including a collapsed-away root", () => {
    expect(passwordKeysOf(tabOf(workspace(), "tab-local"))).toEqual(["tab-local", "tab-prod"]);
    expect(passwordKeysOf({ id: "t", layout: { id: "p" } })).toEqual(["t", "p"]);
    expect(passwordKeysOf(null)).toEqual([]);
  });

  test("closing a tab clears every pane's password, and reopening restores them", () => {
    setTabPassword("tab-local", "root-pw");
    setTabPassword("tab-prod", "merged-pw");
    const { api, last } = mountTree(workspace());
    act(() => api.closeTab("panel-1", "tab-local"));
    expect(getTabPassword("tab-local")).toBeNull();
    expect(getTabPassword("tab-prod")).toBeNull();
    expect(tabOf(last(), "tab-local")).toBeUndefined();
    act(() => api.reopenTab());
    expect(getTabPassword("tab-local")).toBe("root-pw");
    expect(getTabPassword("tab-prod")).toBe("merged-pw");
  });

  test("closing a merged SSH pane clears its password; closing a root pane keeps the tab's", () => {
    setTabPassword("tab-prod", "merged-pw");
    setTabPassword("tab-split", "root-pw");
    const { api } = mountTree(workspace());
    act(() => api.closePane("tab-local", "tab-prod"));
    expect(getTabPassword("tab-prod")).toBeNull();
    act(() => api.closePane("tab-split", "tab-split"));
    expect(getTabPassword("tab-split")).toBe("root-pw");
  });

  test("closing other tabs, a panel, or a batch clears merged panes' passwords too", () => {
    setTabPassword("tab-prod", "merged-pw");
    mountTree(workspace()).api.closeOtherTabs("panel-1", "tab-ssh");
    expect(getTabPassword("tab-prod")).toBeNull();

    setTabPassword("tab-prod", "merged-pw");
    mountTree(workspace()).api.closePanel("panel-1");
    expect(getTabPassword("tab-prod")).toBeNull();

    setTabPassword("tab-prod", "merged-pw");
    mountTree(workspace()).api.closeTabs([{ panelId: "panel-1", tabId: "tab-local" }]);
    expect(getTabPassword("tab-prod")).toBeNull();
  });
});

describe("the broadcast picker names the machine each pane runs on", () => {
  test("a folded-in SSH pane shows its host; local panes show none", () => {
    const st = workspace();
    render(
      <BroadcastGroupModal
        open panels={st.panels} liveTabIds={["tab-local", "tab-prod", "tab-split", "pane-local"]}
        current={[]} onClose={() => {}} onApply={() => {}} onUseAllVisible={() => {}}
      />,
    );
    const rowFor = (text) => screen.getByText(text).closest("label");
    expect(within(rowFor("1. work ·1")).queryByText(/example/)).toBeNull(); // local root
    expect(within(rowFor("2. work ·2")).getByText(/prod\.example/)).toBeTruthy(); // the merged SSH pane
    expect(within(rowFor("3. prod2 ·1")).getByText(/prod\.example/)).toBeTruthy(); // SSH root
    expect(within(rowFor("4. prod2 ·2")).queryByText(/example/)).toBeNull(); // local split of an SSH tab
  });
});

describe("session labels name the machine a remote pane types into", () => {
  const local = tabOf(workspace(), "tab-local");
  test("a folded-in SSH pane names its address; a local pane does not", () => {
    expect(paneSessionLabel(local, "tab-prod", 1, 2)).toBe("work ·2 (deploy@prod.example)");
    expect(paneSessionLabel(local, "tab-local", 0, 2)).toBe("work ·1");
  });
  test("a label that already names the address is left alone; a serial pane names its port", () => {
    expect(paneSessionLabel({ id: "t", label: "deploy@prod.example", connection: PROD }, "t", 0, 1)).toBe("deploy@prod.example");
    expect(paneSessionLabel({ id: "t", label: "uart", serial: SERIAL }, "t", 0, 1)).toBe("uart (/dev/tty.usbserial-1)");
  });
  test("a folded pane names its address even when the tab's label happens to contain it", () => {
    // The tab's label describes the tab's own first pane, never a folded one.
    const host = (label, h) => ({ id: "t", label, layout: row({ id: "t" }, { id: "p", connection: { ...PROD, host: h } }) });
    expect(paneSessionLabel(host("staging (deploy@prod mirror)", "prod"), "p", 1, 2)).toBe("staging (deploy@prod mirror) ·2 (deploy@prod)");
    expect(paneSessionLabel(host("deploy@db-10.0.0.50", "10.0.0.5"), "p", 1, 2)).toBe("deploy@db-10.0.0.50 ·2 (deploy@10.0.0.5)");
  });
  test("a root pane's label names its address only as a whole word, in any case", () => {
    const root = (label, conn) => paneSessionLabel({ id: "t", label, connection: conn }, "t", 0, 1);
    expect(root("deploy@10.0.0.50", { ...PROD, host: "10.0.0.5" })).toBe("deploy@10.0.0.50 (deploy@10.0.0.5)");
    expect(root("deploy@prod.example.org", PROD)).toBe("deploy@prod.example.org (deploy@prod.example)");
    expect(root("Deploy@PROD.example", PROD)).toBe("Deploy@PROD.example");
    expect(root("deploy@prod.example ·1", PROD)).toBe("deploy@prod.example ·1");
    // A label naming only the host leaves the account unsaid.
    expect(root("prod.example", PROD)).toBe("prod.example (deploy@prod.example)");
  });
  test("the address carries a port other than 22, and a longer address in the label does not count", () => {
    const root = (label, conn) => paneSessionLabel({ id: "t", label, connection: conn }, "t", 0, 1);
    // Two ports behind one NAT address are often two machines.
    expect(root("home", { ...PROD, host: "home.example", port: 2222, user: "root" })).toBe("home (root@home.example:2222)");
    expect(root("root@home.example:2222", { ...PROD, host: "home.example", port: "2222", user: "root" })).toBe("root@home.example:2222");
    // A port saved as text is still a number: "22" is the default, not ":22".
    expect(root("deploy@prod.example", { ...PROD, port: "22" })).toBe("deploy@prod.example");
    // The label names port 2222, the pane runs on 22.
    expect(root("deploy@prod.example:2222", PROD)).toBe("deploy@prod.example:2222 (deploy@prod.example)");
    // IPv6: the label names fe80::1:2, the pane runs on fe80::1; a port brackets the host.
    expect(root("admin@fe80::1:2", { ...PROD, host: "fe80::1", user: "admin" })).toBe("admin@fe80::1:2 (admin@fe80::1)");
    expect(root("admin@fe80::1", { ...PROD, host: "fe80::1", user: "admin" })).toBe("admin@fe80::1");
    expect(root("v6", { ...PROD, host: "fe80::1", port: 2200, user: "admin" })).toBe("v6 (admin@[fe80::1]:2200)");
    // No user on record: the host alone.
    expect(root("box", { host: "box.example", port: 22 })).toBe("box (box.example)");
  });
  test("a local pane in a tab named after a remote machine reads (local)", () => {
    const split = tabOf(workspace(), "tab-split");
    expect(paneSessionLabel(split, "pane-local", 1, 2)).toBe("prod2 ·2 (local)");
    expect(paneSessionLabel(split, "tab-split", 0, 2)).toBe("prod2 ·1 (deploy@prod.example)");
    // The SSH root pane closed away: the tab keeps its remote name, the pane is local.
    expect(paneSessionLabel({ ...split, layout: { id: "pane-local", cwd: "/tmp" } }, "pane-local", 0, 1)).toBe("prod2 (local)");
    expect(paneSessionLabel({ id: "t", label: "uart", serial: SERIAL, layout: row({ id: "t" }, { id: "p" }) }, "p", 1, 2)).toBe("uart ·2 (local)");
    // A local pane in a local tab says nothing extra.
    expect(paneSessionLabel(local, "tab-local", 0, 2)).toBe("work ·1");
    expect(paneSessionLabel({ id: "t", label: "work", layout: row({ id: "t" }, { id: "p" }) }, "p", 1, 2)).toBe("work ·2");
  });
});

describe("the broadcast picker shows each pane's full address", () => {
  test("user@host, and the port when it is not 22", () => {
    const st = {
      panels: [{ id: "panel-1", activeTabId: "tab-a", tabs: [{
        id: "tab-a", label: "nat", connection: { ...PROD, host: "home.example", user: "root", port: 2222 }, startCommands: [],
        layout: row({ id: "tab-a" }, { id: "tab-b", connection: { ...PROD, host: "home.example" } }),
      }] }],
    };
    render(
      <BroadcastGroupModal open panels={st.panels} liveTabIds={["tab-a", "tab-b"]} current={[]}
        onClose={() => {}} onApply={() => {}} onUseAllVisible={() => {}} />,
    );
    const rowFor = (text) => screen.getByText(text).closest("label");
    expect(within(rowFor("1. nat ·1")).getByText(/root@home\.example:2222/)).toBeTruthy();
    expect(within(rowFor("2. nat ·2")).getByText(/deploy@home\.example$/)).toBeTruthy();
  });
});

describe("a folded saved session keeps its project's status in the sidebar", () => {
  const panels = [{
    id: "panel-1",
    tabs: [
      { id: "tab-a", projectId: "proj-a", layout: row({ id: "tab-a" }, row({ id: "tab-b", connection: PROD, projectId: "proj-prod" }, { id: "pane-x" }, "s3")) },
      { id: "tab-c", label: "scratch" },
    ],
  }];
  test("the index covers every saved-session pane and no plain split pane", () => {
    expect([...projectIndexOf(panels)]).toEqual([["tab-a", "proj-a"], ["tab-b", "proj-prod"]]);
    expect(projectIndexOf(undefined).size).toBe(0);
  });
  test("a folded pane waiting on approval shows on its own project, and a plain split pane on none", () => {
    __resetActivityStore();
    setProjectIndex(projectIndexOf(panels));
    setPaneActivity("tab-b", "waiting");
    setPaneActivity("pane-x", "active");
    expect(__testGetRollups()).toEqual({ "proj-a": "idle", "proj-prod": "waiting" });
    __resetActivityStore();
  });
  test("TerminalsTab hands the store this index", () => {
    // TerminalsTab's effect cannot be mounted on its own; its one line is read
    // from source, as keybindings.tabs.test.js does for the shortcut wiring.
    const src = readFileSync(path.join(process.cwd(), "src/features/terminals/TerminalsTab.jsx"), "utf8");
    expect(src).toMatch(/setProjectIndex\(projectIndexOf\(state\.panels\)\)/);
    expect(src).not.toMatch(/idx\.set\(tab\.id, tab\.projectId\)/);
  });
});

describe("the broadcast picker labels serial panes too", () => {
  test("a folded-in serial pane shows its device", () => {
    const st = {
      panels: [{ id: "panel-1", activeTabId: "tab-a", tabs: [{
        id: "tab-a", label: "bench", startCommands: [],
        layout: row({ id: "tab-a" }, { id: "tab-b", serial: SERIAL }),
      }] }],
    };
    render(
      <BroadcastGroupModal open panels={st.panels} liveTabIds={["tab-a", "tab-b"]} current={[]}
        onClose={() => {}} onApply={() => {}} onUseAllVisible={() => {}} />,
    );
    expect(within(screen.getByText("2. bench ·2").closest("label")).getByText(/usbserial-1/)).toBeTruthy();
    expect(within(screen.getByText("1. bench ·1").closest("label")).queryByText(/usbserial/)).toBeNull();
  });
});

describe("the dock tools use the focused pane's session and password", () => {
  test("the SFTP dock reconnects when focus moves to another SSH pane, not on an unrelated re-render", async () => {
    setTabPassword("tab-prod", "merged-pw");
    invoke.mockImplementation((cmd) => Promise.resolve(cmd === "sftp_connect" ? "sftp-1" : undefined));
    const connects = () => invoke.mock.calls.filter(([cmd]) => cmd === "sftp_connect").length;
    const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const first = activeSshContext(tabOf(workspace(), "tab-local"));
    const { rerender } = renderHook(({ ssh }) => useSftpDock({ ssh, dockTab: "files", setDockTab: () => {} }), { initialProps: { ssh: first } });
    await flush();
    expect(connects()).toBe(1);
    rerender({ ssh: { ...first } }); // a rebuilt tab object: same pane, same host
    await flush();
    expect(connects()).toBe(1);
    rerender({ ssh: activeSshContext(tabOf(workspace(), "tab-ssh")) }); // a different SSH pane
    await flush();
    expect(connects()).toBe(2);
  });

  test("tunnels go through the pane's host with the pane's password", async () => {
    setTabPassword("tab-prod", "merged-pw");
    const toast = { info: vi.fn(), error: vi.fn(), success: vi.fn() };
    const ssh = activeSshContext(tabOf(workspace(), "tab-local"));
    const { result } = renderHook(() => useTunnels({ ssh, toast }));
    await act(async () => { await result.current.startForward({ localPort: 8080, remoteHost: "127.0.0.1", remotePort: 80 }); });
    expect(invoke).toHaveBeenCalledWith("port_forward_start", expect.objectContaining({
      host: "prod.example", user: "deploy", auth: expect.objectContaining({ password: "merged-pw" }),
    }));
  });

  test("the SFTP dock connects to the pane's host with the pane's password", async () => {
    setTabPassword("tab-prod", "merged-pw");
    invoke.mockImplementation((cmd) => Promise.resolve(cmd === "sftp_connect" ? "sftp-1" : undefined));
    const ssh = activeSshContext(tabOf(workspace(), "tab-local"));
    renderHook(() => useSftpDock({ ssh, dockTab: "files", setDockTab: () => {} }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(invoke).toHaveBeenCalledWith("sftp_connect", expect.objectContaining({
      host: "prod.example", user: "deploy", auth: expect.objectContaining({ password: "merged-pw" }),
    }));
  });

  test("no SSH context means no SFTP connection", async () => {
    renderHook(() => useSftpDock({ ssh: null, dockTab: "files", setDockTab: () => {} }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(invoke).not.toHaveBeenCalledWith("sftp_connect", expect.anything());
  });
});
