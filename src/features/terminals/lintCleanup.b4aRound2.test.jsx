// (C)
// @vitest-environment happy-dom
// v0.7.6 lint cleanup, batch B4a, review fix round 2 (dialogs). Each describe
// pins one review item; each test was run against the code before its fix and
// failed there (the batch report holds the red/green lines).
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async (u) => `data:image/png;base64,${u}`) } }));
// No Monaco under happy-dom: the editor falls back to its plain textarea.
vi.mock("./monacoSetup.js", () => { throw new Error("no monaco in tests"); });
// ModalHost always renders AgentMode (its loop lives in component state); a
// stub keeps that whole subsystem out of the wiring tests below.
vi.mock("./AgentMode", () => ({ default: () => null }));

import { ToastProvider } from "../../components/Toast.jsx";
import { ConfirmProvider } from "../../components/ConfirmModal.jsx";
import RemoteControlModal from "./RemoteControlModal.jsx";
import RemoteEditor from "./RemoteEditor.jsx";
import ProjectDialog from "./ProjectDialog.jsx";
import RdpConnectModal from "./RdpConnectModal.jsx";
import SshPasswordModal from "./SshPasswordModal.jsx";
import HistorySearch from "./HistorySearch.jsx";
import ModalHost from "./chrome/ModalHost.jsx";

const wrap = (ui) => (
  <ToastProvider>
    <ConfirmProvider>{ui}</ConfirmProvider>
  </ToastProvider>
);

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const writes = () => invokeMock.mock.calls.filter(([c]) => c === "sftp_write_file");
const textarea = () => document.querySelector("textarea");

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});
afterEach(cleanup);

// The minimum ModalHost needs to render with every modal closed.
const hostBase = {
  userSt: { terminalsOnboarded: true },
  projects: [],
  panels: [],
  workspaces: [],
  paletteCommands: [],
};

// ── Item 1: RemoteControlModal keeps Escape after Start / Stop ─────────────
describe("RemoteControlModal: Escape after the pressed button goes away", () => {
  test("Start -> running -> Escape closes (focus is not left on <body>)", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "companion_status") return { running: false };
      if (cmd === "companion_start") return { running: true, url: "http://b:2", token: "t2", port: 2, host: "b" };
      return undefined;
    });
    const onClose = vi.fn();
    render(<RemoteControlModal open onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("Start server")).toBeTruthy());
    const startBtn = screen.getByText("Start server");
    act(() => { startBtn.focus(); });
    await act(async () => { fireEvent.click(startBtn); });
    await waitFor(() => expect(screen.getByText("Stop server")).toBeTruthy());
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    await act(async () => { fireEvent.keyDown(document.activeElement, { key: "Escape" }); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Stop -> stopped -> Escape closes", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "companion_status") return { running: true, url: "http://a:1", token: "t", port: 1, host: "a" };
      return undefined;
    });
    const onClose = vi.fn();
    render(<RemoteControlModal open onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("Stop server")).toBeTruthy());
    const stopBtn = screen.getByText("Stop server");
    act(() => { stopBtn.focus(); });
    await act(async () => { fireEvent.click(stopBtn); });
    await waitFor(() => expect(screen.getByText("Start server")).toBeTruthy());
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    await act(async () => { fireEvent.keyDown(document.activeElement, { key: "Escape" }); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── Item 2: RdpConnectModal keyed on the saved session, refocus on switch ──
describe("RdpConnectModal keyed on the saved session", () => {
  // Same host and port, different user: the old `${host}:${port}` key matched.
  const a = { host: "box", port: 3389, username: "alice", domain: "" };
  const b = { host: "box", port: 3389, username: "bob", domain: "" };

  test("a password typed for saved session A is not submitted for B on the same host and port", () => {
    const onConnect = vi.fn();
    const { rerender } = render(<RdpConnectModal open lockConnection targetId="pa" initial={a} onConnect={onConnect} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw-for-alice" } });
    rerender(<RdpConnectModal open lockConnection targetId="pb" initial={b} onConnect={onConnect} onClose={() => {}} />);
    expect(screen.getByLabelText("Username").value).toBe("bob");
    expect(screen.getByLabelText("Password").value).toBe("");
    fireEvent.click(screen.getByText("Connect"));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect.mock.calls[0][0]).toMatchObject({ username: "bob", password: "" });
  });

  test("without a target id the fallback key still tells two users on one host apart", () => {
    const onConnect = vi.fn();
    const { rerender } = render(<RdpConnectModal open lockConnection initial={a} onConnect={onConnect} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw-for-alice" } });
    rerender(<RdpConnectModal open lockConnection initial={b} onConnect={onConnect} onClose={() => {}} />);
    expect(screen.getByLabelText("Password").value).toBe("");
  });

  test("after a switch while open, focus lands on the new form's marked field, not <body>", async () => {
    const { rerender } = render(<RdpConnectModal open lockConnection targetId="pa" initial={a} onConnect={() => {}} onClose={() => {}} />);
    await act(async () => {});
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
    await act(async () => {
      rerender(<RdpConnectModal open lockConnection targetId="pb" initial={b} onConnect={() => {}} onClose={() => {}} />);
    });
    expect(screen.getByLabelText("Username").value).toBe("bob");
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
    // Saved session -> quick connect: the marked field is Host now.
    await act(async () => {
      rerender(<RdpConnectModal open onConnect={() => {}} onClose={() => {}} />);
    });
    expect(document.activeElement).toBe(screen.getByLabelText("Host"));
  });

  test("a switch does not steal focus that is already inside the dialog", async () => {
    const { rerender } = render(<RdpConnectModal open targetId="quick" onConnect={() => {}} onClose={() => {}} />);
    await act(async () => {});
    const close = screen.getByRole("button", { name: "Close dialog" });
    act(() => { close.focus(); });
    await act(async () => {
      rerender(<RdpConnectModal open lockConnection targetId="pb" initial={b} onConnect={() => {}} onClose={() => {}} />);
    });
    expect(document.activeElement).toBe(close);
  });

  test("ModalHost keys the RDP form on the saved project id", () => {
    // Two saved sessions with identical fields: only the project id tells
    // them apart, so this fails unless ModalHost passes it through.
    const pA = { id: "pa", name: "A", rdp: { ...a } };
    const pB = { id: "pb", name: "B", rdp: { ...a } };
    const props = { ...hostBase, launchRdp: vi.fn(), setRdpOpen: () => {}, setRdpLaunch: () => {} };
    const { rerender } = render(wrap(<ModalHost {...props} rdpLaunch={{ project: pA }} />));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw-for-A" } });
    rerender(wrap(<ModalHost {...props} rdpLaunch={{ project: pB }} />));
    expect(screen.getByLabelText("Password").value).toBe("");
  });
});

// ── Item 3: RemoteEditor never writes a buffer it did not load ─────────────
describe("RemoteEditor save guards", () => {
  test("Ctrl+S while the file is still loading writes nothing", async () => {
    const read = deferred();
    invokeMock.mockImplementation(async (cmd) => (cmd === "sftp_read_file" ? read.promise : undefined));
    render(wrap(<RemoteEditor open sessionId="s" path="/a" name="a" onClose={() => {}} />));
    expect(screen.getByText("Loading a…")).toBeTruthy();
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    expect(writes()).toHaveLength(0);
    await act(async () => { read.resolve("remote body"); });
    expect(writes()).toHaveLength(0);
  });

  test("Ctrl+S after a read error writes nothing", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "sftp_read_file") throw new Error("permission denied");
      return undefined;
    });
    render(wrap(<RemoteEditor open sessionId="s" path="/a" name="a" onClose={() => {}} />));
    await waitFor(() => expect(screen.queryByText("Loading a…")).toBeNull());
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    expect(writes()).toHaveLength(0);
  });

  test("Ctrl+S on a clean buffer writes nothing (matches the disabled Saved button)", async () => {
    invokeMock.mockImplementation(async (cmd) => (cmd === "sftp_read_file" ? "orig" : undefined));
    render(wrap(<RemoteEditor open sessionId="s" path="/a" name="a" onClose={() => {}} />));
    await waitFor(() => expect(textarea()?.value).toBe("orig"));
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    expect(writes()).toHaveLength(0);
    fireEvent.change(textarea(), { target: { value: "edited" } });
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    expect(writes()).toHaveLength(1);
  });

  test("close while a save of an OLDER snapshot is in flight asks before discarding", async () => {
    const write = deferred();
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "sftp_read_file") return "orig";
      if (cmd === "sftp_write_file") return write.promise;
      return undefined;
    });
    const onClose = vi.fn();
    render(wrap(<RemoteEditor open sessionId="s" path="/a" name="a" onClose={onClose} />));
    await waitFor(() => expect(textarea()?.value).toBe("orig"));
    fireEvent.change(textarea(), { target: { value: "v1" } });
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    expect(writes()).toHaveLength(1);
    // Typed after the snapshot the in-flight save carries.
    fireEvent.change(textarea(), { target: { value: "v2" } });
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Close dialog" })[0]); });
    expect(await screen.findByText(/has unsaved changes/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { write.resolve(undefined); });
  });

  // Round 3 changed when this close happens: it now waits for the covering
  // save and closes once it lands (a failure keeps the editor open, pinned in
  // lintCleanup.b4aRound3.test.jsx). Still never asks.
  test("close while the save in flight carries exactly the current text closes without asking", async () => {
    const write = deferred();
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "sftp_read_file") return "orig";
      if (cmd === "sftp_write_file") return write.promise;
      return undefined;
    });
    const onClose = vi.fn();
    render(wrap(<RemoteEditor open sessionId="s" path="/a" name="a" onClose={onClose} />));
    await waitFor(() => expect(textarea()?.value).toBe("orig"));
    fireEvent.change(textarea(), { target: { value: "v1" } });
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Close dialog" })[0]); });
    expect(screen.queryByText(/has unsaved changes/)).toBeNull();
    await act(async () => { write.resolve(undefined); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/has unsaved changes/)).toBeNull();
  });

  test("close after the in-flight save FAILED asks (the edits are still unsaved)", async () => {
    const write = deferred();
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "sftp_read_file") return "orig";
      if (cmd === "sftp_write_file") return write.promise;
      return undefined;
    });
    const onClose = vi.fn();
    render(wrap(<RemoteEditor open sessionId="s" path="/a" name="a" onClose={onClose} />));
    await waitFor(() => expect(textarea()?.value).toBe("orig"));
    fireEvent.change(textarea(), { target: { value: "v1" } });
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    await act(async () => { write.reject(new Error("disk full")); });
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Close dialog" })[0]); });
    expect(await screen.findByText(/has unsaved changes/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ── Item 4: SshPasswordModal keyed on the tab; Escape owned by Modal ───────
describe("SshPasswordModal", () => {
  test("a password typed for one tab is not kept for another tab on the same user@host (another port)", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<SshPasswordModal open targetId="tab-1" host="box" user="u" onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "pw-for-22" } });
    rerender(<SshPasswordModal open targetId="tab-2" host="box" user="u" onSubmit={onSubmit} onCancel={() => {}} />);
    expect(screen.getByPlaceholderText("Password").value).toBe("");
    fireEvent.keyDown(screen.getByPlaceholderText("Password"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalledWith("pw-for-22", expect.anything());
  });

  test("Escape in the password field cancels exactly once", async () => {
    const onCancel = vi.fn();
    render(<SshPasswordModal open targetId="tab-1" host="box" user="u" onSubmit={() => {}} onCancel={onCancel} />);
    const pw = screen.getByPlaceholderText("Password");
    act(() => { pw.focus(); });
    await act(async () => { fireEvent.keyDown(pw, { key: "Escape" }); });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("ModalHost keys the prompt on the tab id", () => {
    const conn = { host: "box", user: "u", port: 22 };
    const props = { ...hostBase, setSshPrompt: () => {}, submitSshPassword: vi.fn() };
    const { rerender } = render(wrap(<ModalHost {...props} sshPrompt={{ panelId: "p", tab: { id: "t1" }, project: { connection: conn } }} />));
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "pw-for-t1" } });
    rerender(wrap(<ModalHost {...props} sshPrompt={{ panelId: "p", tab: { id: "t2" }, project: { connection: { ...conn, port: 2222 } } }} />));
    expect(screen.getByPlaceholderText("Password").value).toBe("");
  });
});

// ── Item 5: ProjectDialog keyed on the dialog; real Tab trap ───────────────
describe("ProjectDialog", () => {
  const a = { id: "a", type: "local", name: "alpha", path: "/a" };

  test("the edited session disappearing while open keeps the typed fields and the EDIT title", () => {
    const { rerender } = render(<ProjectDialog open dialogKey="edit:a" initial={a} onSave={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByDisplayValue("alpha"), { target: { value: "typed" } });
    rerender(<ProjectDialog open dialogKey="edit:a" initial={null} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByDisplayValue("typed")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "EDIT SESSION" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  test("a different dialog opening (another key) still starts a fresh form", () => {
    const b = { id: "b", type: "local", name: "beta", path: "/b" };
    const { rerender } = render(<ProjectDialog open dialogKey="edit:a" initial={a} onSave={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByDisplayValue("alpha"), { target: { value: "typed" } });
    rerender(<ProjectDialog open dialogKey="edit:b" initial={b} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByDisplayValue("beta")).toBeTruthy();
    expect(screen.queryByDisplayValue("typed")).toBeNull();
  });

  test("ModalHost: the project vanishing from the list mid-edit does not reset the form", () => {
    const props = { ...hostBase, setDialog: () => {}, handleSaveDialog: () => {} };
    const dialog = { mode: "edit", projectId: "a" };
    const { rerender } = render(wrap(<ModalHost {...props} dialog={dialog} dialogInitial={a} projects={[a]} />));
    fireEvent.change(screen.getByDisplayValue("alpha"), { target: { value: "typed" } });
    rerender(wrap(<ModalHost {...props} dialog={dialog} dialogInitial={null} projects={[]} />));
    expect(screen.getByDisplayValue("typed")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "EDIT SESSION" })).toBeTruthy();
  });

  for (const shiftKey of [false, true]) {
    test(`${shiftKey ? "Shift+Tab from the first control wraps to the last" : "Tab from the last control wraps to the first"}`, async () => {
      await act(async () => { render(<ProjectDialog open initial={null} onSave={() => {}} onClose={() => {}} />); });
      const dialog = screen.getByRole("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      const items = [...dialog.querySelectorAll('a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')]
        .filter((el) => el.offsetParent !== null);
      expect(items.length).toBeGreaterThan(1);
      const first = items[0];
      const last = items[items.length - 1];
      const from = shiftKey ? first : last;
      act(() => { from.focus(); });
      const notPrevented = fireEvent.keyDown(from, { key: "Tab", shiftKey });
      expect(notPrevented).toBe(false);
      expect(document.activeElement).toBe(shiftKey ? last : first);
    });
  }

  test("Tab in the middle of the form is left to the browser", async () => {
    await act(async () => { render(<ProjectDialog open initial={null} onSave={() => {}} onClose={() => {}} />); });
    const name = screen.getByLabelText(/name/i);
    act(() => { name.focus(); });
    expect(fireEvent.keyDown(name, { key: "Tab" })).toBe(true);
  });
});

// ── Item 6: HistorySearch rows never take focus from the filter ────────────
describe("HistorySearch rows", () => {
  // No fake timers and no reliance on when the body's own 30 ms focus timer
  // fires: wait it out with a longer REAL timer first (Node runs timers in
  // expiry order, so a 30 ms timer set earlier always fires before a 100 ms
  // one set later, however loaded the machine is), then focus the field
  // explicitly. happy-dom has no mousedown default action, so the browser's
  // (focus the focusable element pressed on) is emulated: it runs only when no
  // handler cancelled the mousedown, which is exactly what the fix changes.
  test("a mousedown on a row (one that does not become a click) leaves focus in the filter field", async () => {
    render(<HistorySearch open history={["ls -la", "git status"]} onClose={() => {}} onInsert={() => {}} onRun={() => {}} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    const input = screen.getByPlaceholderText(/filter your command history/);
    act(() => { input.focus(); });
    expect(document.activeElement).toBe(input);
    const row = screen.getByText("git status").closest('[role="option"]');
    // fireEvent returns false when a handler called preventDefault.
    const notPrevented = fireEvent.mouseDown(row);
    if (notPrevented) act(() => { row.focus(); });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  });
});
