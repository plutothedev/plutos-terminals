// (C)
// @vitest-environment happy-dom
//
// The REAL TerminalPane, mounted. Every other test that names this component
// either mocks it away or pins its source text; this one renders it, with only
// the things that cannot run here stubbed (xterm, its addons, the Tauri
// bridge, the two lazy modals). Written for the v0.7.6 lint cleanup, which
// moved this file's latest-value ref writes out of render and routed the main
// effect's props and helpers through a ref: the cases below pin what that
// change must not move.
//
//   1. PTYs survive React. A prop change that is not `cwd` never re-runs the
//      mount effect: one Terminal, one spawn, no kill.
//   2. The transport is read at mount. A pane mounted hidden spawns on first
//      reveal with the connection it MOUNTED with, not a later prop. A "live"
//      ref read inside the deferred spawn would flip this, silently.
//   3. The saved agent conversation the entry hands the spawn is also the
//      mount-time one (entry.ui.agentSession), for the same reason.
//   4. The live readers (auto-approve, visibility, project name) follow the
//      latest COMMITTED props, through the entry, without a respawn.
//   5. A cwd change re-attaches (park + attach) without a second spawn, and
//      an unmount parks: the remount re-attaches the same terminal.
//   6. The prop refs are written in a LAYOUT effect: a passive effect that
//      runs earlier in the same commit already sees the new visibility and
//      auto-approve (act() hides the difference from case 4).
//   7. Escape closes the find bar from its buttons as well as its input.
//
// Not pinned here on purpose: deleting the mount-time startSpawn call is an
// equivalent mutant in this harness (the reveal effect calls startSpawn in the
// same passive flush). The double-spawn guard is the registry's latch in
// paneRegistry.js, tested in paneRegistry.test.js.
import { useEffect } from "react";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";

const { invoke, terms } = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd) => {
    if (cmd === "ssh_spawn") return "pty-1";
    return null; // scrollback_load: nothing saved; everything else: ignored
  }),
  terms: [],
}));

vi.mock("@backend", () => ({
  invoke: (...a) => invoke(...a),
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));

// A stand-in xterm with just the surface TerminalPane touches on mount and
// spawn. `element` stays null: happy-dom gives the container no size, so the
// pane never open()s, which is also what a hidden pane does in the app.
vi.mock("@xterm/xterm", () => {
  const noop = () => {};
  const disposable = () => ({ dispose: noop });
  class Terminal {
    constructor(opts) {
      this.opts = opts;
      this.cols = 80;
      this.rows = 24;
      this.element = null;
      this.textarea = null;
      this.options = {};
      this.parser = {
        registerOscHandler: disposable,
        registerEscHandler: disposable,
        registerCsiHandler: disposable,
      };
      this.buffer = {
        active: { type: "normal", viewportY: 0, baseY: 0, cursorY: 0, length: 0, getLine: () => null },
        onBufferChange: disposable,
      };
      this.disposed = false;
      terms.push(this);
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider() { return disposable(); }
    onScroll() { return disposable(); }
    onData() { return disposable(); }
    onResize() { return disposable(); }
    write() {}
    writeln() {}
    open() {}
    focus() {}
    refresh() {}
    hasSelection() { return false; }
    dispose() { this.disposed = true; }
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { clearDecorations() {} } }));
vi.mock("./ErrorExplainer.jsx", () => ({ default: () => null }));
vi.mock("./ShareModal.jsx", () => ({ default: () => null }));

import TerminalPane from "./TerminalPane.jsx";
import { getEntry, destroyAll } from "./paneRegistry.js";

const PANE = "pane-lifecycle-1";
const conn = (host) => ({ host, port: 22, user: "me", auth: { method: "agent" } });

function props(over = {}) {
  return {
    visible: true,
    active: true,
    cwd: null,
    connection: conn("a.example"),
    serial: null,
    startCommands: [],
    systemPrompt: "",
    agentSession: { cli: "claude", id: "first" },
    onAgentSession: () => {},
    paneLabel: "label",
    xtermTheme: {},
    tabId: PANE,
    projectName: "proj",
    autoApprove: false,
    onCostUpdate: () => {},
    ...over,
  };
}

const calls = (cmd) => invoke.mock.calls.filter(([c]) => c === cmd);
// Lets the spawn IIFE's awaits (scrollback_load, ssh_spawn, three listen()s)
// settle so a "nothing more happened" assertion is not just "not yet".
const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });

beforeEach(() => {
  invoke.mockClear();
  terms.length = 0;
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  destroyAll();
  vi.unstubAllGlobals();
});

describe("TerminalPane lifecycle (PTYs survive React)", () => {
  test("a prop change that is not cwd never re-runs the spawn", async () => {
    const { rerender } = render(<TerminalPane {...props()} />);
    await waitFor(() => expect(calls("ssh_spawn")).toHaveLength(1));
    const entry = getEntry(PANE);
    // Every run of the mount effect repoints entry.ui (even a re-attach that
    // keeps the PTY), so the table's identity tells whether it re-ran.
    const ui = entry.ui;

    rerender(
      <TerminalPane
        {...props({
          connection: conn("b.example"),
          autoApprove: true,
          onCostUpdate: () => {},
          onAgentSession: () => {},
          agentSession: { cli: "claude", id: "second" },
          startCommands: ["echo later"],
          systemPrompt: "later",
          projectName: "renamed",
          xtermTheme: { background: "#000" },
        })}
      />
    );
    await settle();

    expect(terms).toHaveLength(1);
    expect(calls("ssh_spawn")).toHaveLength(1);
    expect(calls("ssh_spawn")[0][1].host).toBe("a.example");
    expect(calls("pty_kill")).toHaveLength(0);
    expect(getEntry(PANE)).toBe(entry);
    expect(entry.ui).toBe(ui);
    expect(terms[0].disposed).toBe(false);
  });

  test("a pane mounted hidden spawns on first reveal with the transport it mounted with", async () => {
    const { rerender } = render(<TerminalPane {...props({ visible: false, active: false })} />);
    await settle();
    expect(calls("ssh_spawn")).toHaveLength(0);

    rerender(<TerminalPane {...props({ visible: true, active: true, connection: conn("b.example") })} />);
    await waitFor(() => expect(calls("ssh_spawn")).toHaveLength(1));
    expect(calls("ssh_spawn")[0][1].host).toBe("a.example");
  });

  test("the saved conversation handed to the spawn is the mount-time one", async () => {
    const { rerender } = render(<TerminalPane {...props()} />);
    await waitFor(() => expect(calls("ssh_spawn")).toHaveLength(1));
    rerender(<TerminalPane {...props({ agentSession: { cli: "claude", id: "second" } })} />);
    await settle();
    expect(getEntry(PANE).ui.agentSession()).toEqual({ cli: "claude", id: "first" });
  });

  test("live readers follow the latest committed props without a respawn", async () => {
    const { rerender } = render(<TerminalPane {...props()} />);
    await waitFor(() => expect(calls("ssh_spawn")).toHaveLength(1));
    const ui = () => getEntry(PANE).ui;
    expect(ui().isAutoApprove()).toBe(false);
    expect(ui().isVisible()).toBe(true);
    expect(ui().isActive()).toBe(true);
    expect(ui().projectName()).toBe("proj");

    const onCost = vi.fn();
    rerender(<TerminalPane {...props({ autoApprove: true, visible: false, active: false, projectName: "renamed", onCostUpdate: onCost })} />);
    expect(ui().isAutoApprove()).toBe(true);
    expect(ui().isVisible()).toBe(false);
    expect(ui().isActive()).toBe(false);
    expect(ui().projectName()).toBe("renamed");
    ui().onCost({ tokens: 1, cost: 2 });
    expect(onCost).toHaveBeenCalledWith({ tokens: 1, cost: 2 });

    await settle();
    expect(calls("ssh_spawn")).toHaveLength(1);
    expect(terms).toHaveLength(1);
  });

  // The test above cannot tell useLayoutEffect from useEffect for the prop-ref
  // writes: act() flushes both before it returns. This one can. A sibling
  // rendered BEFORE the pane runs its passive effect after every layout effect
  // of the commit but before the pane's own passive effects, so it reads the
  // entry in the window where a useEffect write would still be stale. That
  // window is real in the app: anything that consults auto-approve or
  // visibility from a passive effect or a callback queued at commit would see
  // "visible, auto-approve off" for a pane that was just hidden with
  // auto-approve on, and "auto-approve only when away" is the rule it guards.
  test("the live readers are current for a passive effect earlier in the same commit", async () => {
    const seen = [];
    function Before({ tick }) {
      useEffect(() => {
        const e = getEntry(PANE);
        if (e?.ui) seen.push({ tick, visible: e.ui.isVisible(), autoApprove: e.ui.isAutoApprove() });
      }, [tick]);
      return null;
    }
    const tree = (tick, over) => (
      <>
        <Before tick={tick} />
        <TerminalPane {...props(over)} />
      </>
    );
    const { rerender } = render(tree(0, {}));
    await waitFor(() => expect(calls("ssh_spawn")).toHaveLength(1));

    rerender(tree(1, { visible: false, active: false, autoApprove: true }));
    expect(seen.filter((s) => s.tick === 1)).toEqual([{ tick: 1, visible: false, autoApprove: true }]);
  });

  // The find bar's ↑ ↓ ✕ are real buttons now, so Tab reaches them; Escape
  // must close the bar from any of them, exactly as from the input.
  test("Escape closes the find bar from its buttons as well as its input", async () => {
    const view = render(<TerminalPane {...props()} />);
    await waitFor(() => expect(calls("ssh_spawn")).toHaveLength(1));
    const open = () => act(() => { getEntry(PANE).ui.setSearchOpen(true); });

    for (const name of ["Close find", "Previous match", "Next match"]) {
      open();
      const btn = view.getByRole("button", { name });
      btn.focus();
      expect(document.activeElement).toBe(btn);
      fireEvent.keyDown(btn, { key: "Escape" });
      expect(view.queryByRole("search")).toBeNull();
    }

    open();
    fireEvent.keyDown(view.getByPlaceholderText("Find in terminal…"), { key: "Escape" });
    expect(view.queryByRole("search")).toBeNull();
  });

  test("a cwd change re-attaches without a second spawn", async () => {
    const { rerender } = render(<TerminalPane {...props({ cwd: "/a" })} />);
    await waitFor(() => expect(calls("ssh_spawn")).toHaveLength(1));
    const entry = getEntry(PANE);
    const firstUi = entry.ui;

    rerender(<TerminalPane {...props({ cwd: "/b" })} />);
    await settle();

    expect(getEntry(PANE)).toBe(entry);
    expect(entry.ui).not.toBe(firstUi); // the effect re-ran and repointed the table
    expect(terms).toHaveLength(1);
    expect(calls("ssh_spawn")).toHaveLength(1);
    expect(calls("pty_kill")).toHaveLength(0);
  });

  test("an unmount parks a live pane and a remount re-attaches the same terminal", async () => {
    const first = render(<TerminalPane {...props()} />);
    await waitFor(() => expect(calls("ssh_spawn")).toHaveLength(1));
    await waitFor(() => expect(getEntry(PANE).spawnState).toBe("live"));
    const entry = getEntry(PANE);
    first.unmount();

    expect(getEntry(PANE)).toBe(entry);
    expect(terms[0].disposed).toBe(false);

    render(<TerminalPane {...props({ connection: conn("b.example") })} />);
    await settle();
    expect(getEntry(PANE)).toBe(entry);
    expect(terms).toHaveLength(1);
    expect(calls("ssh_spawn")).toHaveLength(1);
    expect(calls("pty_kill")).toHaveLength(0);
  });
});
