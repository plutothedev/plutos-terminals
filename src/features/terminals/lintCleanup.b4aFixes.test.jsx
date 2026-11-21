// (C)
// @vitest-environment happy-dom
// v0.7.6 lint cleanup, batch B4a, review fix round 1. Each describe pins one
// review item; every test that claims a behaviour change was checked to fail on
// the code before the change (see the batch report for the red/green lines).
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { useState } from "react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async (u) => `data:image/png;base64,${u}`) } }));
vi.mock("./notebookIo.js", () => ({
  readNotebook: vi.fn(async (name) => `content of ${name}`),
  noteWrite: vi.fn(async () => {}),
}));
// No Monaco under happy-dom: the editors fall back to their plain textarea.
vi.mock("./monacoSetup.js", () => { throw new Error("no monaco in tests"); });

import QRCode from "qrcode";
import { noteWrite } from "./notebookIo.js";
import { hasUnsavedRemoteEdits } from "./remoteEditDirty.js";
import { ToastProvider } from "../../components/Toast.jsx";
import { ConfirmProvider } from "../../components/ConfirmModal.jsx";
import RemoteControlModal from "./RemoteControlModal.jsx";
import RemoteEditor from "./RemoteEditor.jsx";
import NotebookView from "./NotebookView.jsx";
import ProjectDialog from "./ProjectDialog.jsx";
import RdpConnectModal from "./RdpConnectModal.jsx";
import SshPasswordModal from "./SshPasswordModal.jsx";
import LocalFileBrowser from "./LocalFileBrowser.jsx";
import SftpBrowser from "./SftpBrowser.jsx";
import SnippetsDrawer from "./SnippetsDrawer.jsx";
import OnboardingOverlay from "./OnboardingOverlay.jsx";
import WorkspacesModal from "./WorkspacesModal.jsx";
import NetToolsModal from "./NetToolsModal.jsx";
import VncView from "./VncView.jsx";
import RdpView from "./RdpView.jsx";
import PromptEditor from "./PromptEditor.jsx";

const wrap = (ui) => (
  <ToastProvider>
    <ConfirmProvider>{ui}</ConfirmProvider>
  </ToastProvider>
);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const textareaValues = () => [...document.querySelectorAll("textarea")].map((t) => t.value).join("|");

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});
afterEach(cleanup);

// ── Item 1 + 7 + backdrop: RemoteControlModal ──────────────────────────────
describe("RemoteControlModal", () => {
  test("a QR that resolves late for the previous url never shows for the new one", async () => {
    const qrA = deferred();
    QRCode.toDataURL.mockImplementation((u) => (u === "http://a:1" ? qrA.promise : Promise.resolve(`data:image/png;base64,FRESH-${u}`)));
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "companion_status") return { running: true, url: "http://a:1", token: "t", port: 1, host: "a" };
      if (cmd === "companion_start") return { running: true, url: "http://b:2", token: "t2", port: 2, host: "b" };
      return undefined;
    });
    render(<RemoteControlModal open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Stop server")).toBeTruthy());
    fireEvent.click(screen.getByText("Stop server"));
    await waitFor(() => expect(screen.getByText("Start server")).toBeTruthy());
    fireEvent.click(screen.getByText("Start server"));
    await waitFor(() => expect(screen.getByAltText("pairing QR").getAttribute("src")).toContain("FRESH-http://b:2"));
    await act(async () => { qrA.resolve("data:image/png;base64,STALE-A"); });
    const srcs = [...document.querySelectorAll("img")].map((i) => i.getAttribute("src")).join("|");
    expect(srcs).not.toContain("STALE-A");
    expect(srcs).toContain("FRESH-http://b:2");
    QRCode.toDataURL.mockImplementation(async (u) => `data:image/png;base64,${u}`);
  });

  function Host({ onClose }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <input aria-label="behind" />
        <button onClick={() => setOpen(true)}>opener</button>
        {open && <RemoteControlModal open onClose={() => { onClose(); setOpen(false); }} />}
      </>
    );
  }

  test("focus moves into the card; an Escape meant for the terminal behind does not close it; Escape in the card does, and focus returns to the opener", async () => {
    invokeMock.mockResolvedValue({ running: false });
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const opener = screen.getByText("opener");
    opener.focus();
    await act(async () => { fireEvent.click(opener); });
    await waitFor(() => expect(screen.getByText("Start server")).toBeTruthy());
    const card = screen.getByRole("dialog");
    expect(card.contains(document.activeElement)).toBe(true);
    // An Escape typed into vim / xterm behind the dialog.
    fireEvent.keyDown(screen.getByLabelText("behind"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(document.activeElement, { key: "Escape" }); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  test("a drag from inside the card released on the backdrop does not close it; a press and release on the backdrop does", async () => {
    invokeMock.mockResolvedValue({ running: false });
    const onClose = vi.fn();
    const { container } = render(<RemoteControlModal open onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("Start server")).toBeTruthy());
    const overlay = container.firstChild;
    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── Items 1, 8, 12: RemoteEditor ───────────────────────────────────────────
describe("RemoteEditor", () => {
  test("a save of the previous file that lands after switching files neither marks the new file saving nor dirty", async () => {
    const write = deferred();
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "sftp_read_file") return `body of ${args.path}`;
      if (cmd === "sftp_write_file") return write.promise;
      return undefined;
    });
    const { rerender } = render(wrap(<RemoteEditor open sessionId="s" path="/a" name="a" onClose={() => {}} />));
    await waitFor(() => expect(textareaValues()).toContain("body of /a"));
    fireEvent.change(document.querySelector("textarea"), { target: { value: "edited a" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    expect(invokeMock).toHaveBeenCalledWith("sftp_write_file", { id: "s", path: "/a", content: "edited a" });

    rerender(wrap(<RemoteEditor open sessionId="s" path="/b" name="b" onClose={() => {}} />));
    await waitFor(() => expect(textareaValues()).toContain("body of /b"));
    // b's own session: nothing in flight for it.
    expect(screen.getByRole("button", { name: "Saved" })).toBeTruthy();
    await act(async () => { write.resolve(undefined); });
    // a's write landing must not set b's "last saved" text to a's content.
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("b");
    expect(screen.getByRole("button", { name: "Saved" })).toBeTruthy();
  });

  test("a second Ctrl+S while a slow save is in flight sends no second write", async () => {
    const write = deferred();
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "sftp_read_file") return "orig";
      if (cmd === "sftp_write_file") return write.promise;
      return undefined;
    });
    render(wrap(<RemoteEditor open sessionId="s" path="/a" name="a" onClose={() => {}} />));
    await waitFor(() => expect(textareaValues()).toContain("orig"));
    fireEvent.change(document.querySelector("textarea"), { target: { value: "changed" } });
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    const writes = () => invokeMock.mock.calls.filter(([c]) => c === "sftp_write_file").length;
    expect(writes()).toBe(1);
    await act(async () => { write.resolve(undefined); });
    // The mutex is released once the write lands: a later save goes through.
    fireEvent.change(document.querySelector("textarea"), { target: { value: "changed again" } });
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    expect(writes()).toBe(2);
  });

  test("the dirty registry is marked while the buffer is dirty and cleared on a clean buffer, on close and on unmount", async () => {
    invokeMock.mockImplementation(async (cmd) => (cmd === "sftp_read_file" ? "orig" : undefined));
    const props = { sessionId: "s", path: "/a", name: "a", onClose: () => {} };
    const { rerender, unmount } = render(wrap(<RemoteEditor open {...props} />));
    await waitFor(() => expect(textareaValues()).toContain("orig"));
    expect(hasUnsavedRemoteEdits()).toBe(false);
    fireEvent.change(document.querySelector("textarea"), { target: { value: "x" } });
    expect(hasUnsavedRemoteEdits()).toBe(true);
    fireEvent.change(document.querySelector("textarea"), { target: { value: "orig" } });
    expect(hasUnsavedRemoteEdits()).toBe(false);
    fireEvent.change(document.querySelector("textarea"), { target: { value: "y" } });
    expect(hasUnsavedRemoteEdits()).toBe(true);
    rerender(wrap(<RemoteEditor open={false} {...props} />));
    expect(hasUnsavedRemoteEdits()).toBe(false);
    rerender(wrap(<RemoteEditor open {...props} />));
    await waitFor(() => expect(textareaValues()).toContain("orig"));
    fireEvent.change(document.querySelector("textarea"), { target: { value: "z" } });
    expect(hasUnsavedRemoteEdits()).toBe(true);
    unmount();
    expect(hasUnsavedRemoteEdits()).toBe(false);
  });
});

// ── Items 1 + 2: NotebookView unmount flush on a name switch ───────────────
describe("NotebookView name switch", () => {
  const view = (name) => wrap(<NotebookView name={name} tabId="t1" visible={false} paneTitles={{}} />);

  test("an edit to one.md is saved to one.md when the view switches to two.md, never to two.md", async () => {
    noteWrite.mockClear();
    const { rerender } = render(view("one.md"));
    await waitFor(() => expect(textareaValues()).toContain("content of one.md"));
    fireEvent.change(document.querySelector("textarea"), { target: { value: "EDITED" } });
    rerender(view("two.md"));
    await waitFor(() => expect(textareaValues()).toContain("content of two.md"));
    expect(noteWrite).toHaveBeenCalledWith("one.md", "EDITED");
    expect(noteWrite).not.toHaveBeenCalledWith("two.md", "EDITED");
    expect(noteWrite.mock.calls.every(([n]) => n === "one.md")).toBe(true);
  });

  test("with a save of one.md still in flight, the switch queues the newer text after it, both under one.md", async () => {
    noteWrite.mockClear();
    const first = deferred();
    noteWrite.mockImplementationOnce(() => first.promise);
    const { rerender } = render(view("one.md"));
    await waitFor(() => expect(textareaValues()).toContain("content of one.md"));
    fireEvent.change(document.querySelector("textarea"), { target: { value: "S1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(noteWrite.mock.calls).toEqual([["one.md", "S1"]]);
    fireEvent.change(document.querySelector("textarea"), { target: { value: "S2" } });
    rerender(view("two.md"));
    await waitFor(() => expect(textareaValues()).toContain("content of two.md"));
    expect(noteWrite.mock.calls).toEqual([["one.md", "S1"], ["one.md", "S2"]]);
    await act(async () => { first.resolve(undefined); });
    expect(noteWrite.mock.calls).toEqual([["one.md", "S1"], ["one.md", "S2"]]);
  });
});

// ── Item 3: form bodies keyed on their target ──────────────────────────────
describe("forms keyed on their target", () => {
  test("ProjectDialog: switching to another session while open shows that session, not the fields typed for the first", () => {
    const a = { id: "a", type: "local", name: "alpha", path: "/a" };
    const b = { id: "b", type: "ssh", name: "beta", connection: { host: "hb", port: 2222, user: "ub" } };
    const { rerender } = render(<ProjectDialog open initial={a} onSave={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByDisplayValue("alpha"), { target: { value: "typed for a" } });
    rerender(<ProjectDialog open initial={b} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByDisplayValue("beta")).toBeTruthy();
    expect(screen.getByDisplayValue("2222")).toBeTruthy();
    expect(screen.queryByDisplayValue("typed for a")).toBeNull();
  });

  test("ProjectDialog: Add switching from a local preset to an RDP preset starts the RDP form", () => {
    const { rerender } = render(<ProjectDialog open initial={null} onSave={() => {}} onClose={() => {}} />);
    rerender(<ProjectDialog open initial={{ type: "rdp" }} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByDisplayValue("3389")).toBeTruthy();
  });

  test("RdpConnectModal: a password typed for one saved session is not sent to the next", () => {
    const onConnect = vi.fn();
    const a = { host: "a.host", port: 3389, username: "ua", domain: "" };
    const b = { host: "b.host", port: 3389, username: "ub", domain: "" };
    const { rerender } = render(<RdpConnectModal open lockConnection initial={a} onConnect={onConnect} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw-for-a" } });
    rerender(<RdpConnectModal open lockConnection initial={b} onConnect={onConnect} onClose={() => {}} />);
    expect(screen.getByLabelText("Host").value).toBe("b.host");
    expect(screen.getByLabelText("Password").value).toBe("");
    fireEvent.click(screen.getByText("Connect"));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect.mock.calls[0][0]).toMatchObject({ host: "b.host", username: "ub", password: "" });
  });

  test("SshPasswordModal: a password typed for host A is never sent to host B", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<SshPasswordModal open host="a.host" user="u" onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "pw-for-a" } });
    rerender(<SshPasswordModal open host="b.host" user="u" onSubmit={onSubmit} onCancel={() => {}} />);
    expect(screen.getByPlaceholderText("Password").value).toBe("");
    fireEvent.keyDown(screen.getByPlaceholderText("Password"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalledWith("pw-for-a", expect.anything());
  });
});

// ── Item 5: keyboard focus after a folder navigation ───────────────────────
describe("file browsers keep keyboard focus across a folder navigation", () => {
  test("LocalFileBrowser: Enter on a folder lands focus on the first entry of the new listing; a mouse click does not move focus", async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== "list_directory") return undefined;
      if (args.path === "/home/p/sub") return ["/home/p/sub", [{ name: "inner", path: "/home/p/sub/inner", is_dir: true, size: 0, mtime: 0 }], false];
      if (args.path === "/home/p/other") return ["/home/p/other", [{ name: "x.txt", path: "/home/p/other/x.txt", is_dir: false, size: 1, mtime: 0 }], false];
      return ["/home/p", [
        { name: "sub", path: "/home/p/sub", is_dir: true, size: 0, mtime: 0 },
        { name: "other", path: "/home/p/other", is_dir: true, size: 0, mtime: 0 },
      ], false];
    });
    render(<LocalFileBrowser onSendToTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByText("sub")).toBeTruthy());
    screen.getByText("sub").focus();
    fireEvent.keyDown(screen.getByText("sub"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("inner")).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByText("inner"));

    // Mouse navigation: back home by the crumb, then click a folder.
    fireEvent.click(screen.getByText("p"));
    await waitFor(() => expect(screen.getByText("other")).toBeTruthy());
    document.activeElement?.blur?.();
    fireEvent.click(screen.getByText("other"));
    await waitFor(() => expect(screen.getByText("x.txt")).toBeTruthy());
    expect(document.activeElement).not.toBe(screen.getByText("x.txt"));
  });

  test("SftpBrowser: Enter on a folder lands focus on the first folder of the new listing, or on the list when it is empty", async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "sftp_home") return "/home/u";
      if (cmd === "sftp_list") {
        if (args.path === "/home/u/dir") return [{ name: "deeper", path: "/home/u/dir/deeper", is_dir: true, size: 0, mtime: 0 }];
        if (args.path === "/home/u/dir/deeper") return [];
        return [{ name: "dir", path: "/home/u/dir", is_dir: true, size: 0, mtime: 0 }];
      }
      return undefined;
    });
    render(wrap(<SftpBrowser open docked sessionId="s-focus" onClose={() => {}} />));
    await waitFor(() => expect(screen.getByText("dir")).toBeTruthy());
    screen.getByText("dir").focus();
    fireEvent.keyDown(screen.getByText("dir"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("deeper")).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByText("deeper"));
    fireEvent.keyDown(screen.getByText("deeper"), { key: " " });
    await waitFor(() => expect(screen.getByText("Empty folder.")).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByText("Empty folder.").parentElement);
  });
});

// ── Item 6: snippet rows click anywhere ────────────────────────────────────
describe("SnippetsDrawer row", () => {
  test("the insert button carries the row inset, so it fills the whole row", () => {
    const onInsert = vi.fn();
    render(<SnippetsDrawer open onClose={() => {}} onInsert={onInsert} snippets={[{ id: "a", name: "Say hi", command: "echo hi" }]} onSnippetsChange={() => {}} />);
    const btn = screen.getByTitle("Insert into active terminal: echo hi");
    const row = btn.closest(".phn-snippet-item");
    expect(row.style.padding).toMatch(/^0(px)?$/);
    expect(btn.style.padding).toBe("7px 10px");
    expect(btn.style.width).toBe("100%");
    fireEvent.click(btn);
    expect(onInsert).toHaveBeenCalledWith("echo hi");
  });
});

// ── Item 9 + backdrop: ProjectDialog dialog contract ───────────────────────
describe("ProjectDialog dialog contract", () => {
  function Host({ onClose }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>opener</button>
        <ProjectDialog open={open} initial={null} onSave={() => {}} onClose={() => { onClose(); setOpen(false); }} />
      </>
    );
  }

  test("is a labelled modal dialog; focus moves in; Escape closes and focus returns to the opener", async () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const opener = screen.getByText("opener");
    opener.focus();
    await act(async () => { fireEvent.click(opener); });
    const dialog = screen.getByRole("dialog", { name: "ADD SESSION" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => { fireEvent.keyDown(document.activeElement, { key: "Escape" }); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  test("a drag from inside released on the backdrop does not close; a press and release on the backdrop does", () => {
    const onClose = vi.fn();
    render(<ProjectDialog open initial={null} onSave={() => {}} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement;
    fireEvent.mouseDown(dialog);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── Backdrop: OnboardingOverlay ────────────────────────────────────────────
describe("OnboardingOverlay backdrop", () => {
  test("a drag from inside the card released on the backdrop does not dismiss; a press and release on the backdrop does", () => {
    const onDismiss = vi.fn();
    const { container } = render(<OnboardingOverlay onDismiss={onDismiss} />);
    const overlay = container.firstChild;
    fireEvent.mouseDown(overlay.firstChild);
    fireEvent.click(overlay);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// ── Item 11: data-autofocus instead of autoFocus ───────────────────────────
describe("initial focus through Modal's data-autofocus", () => {
  test("WorkspacesModal: the name field gets focus, and closing hands focus back to the opener", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>opener</button>
          <WorkspacesModal open={open} workspaces={[]} onClose={() => setOpen(false)} onSave={() => {}} onLoad={() => {}} onDelete={() => {}} />
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByText("opener");
    opener.focus();
    await act(async () => { fireEvent.click(opener); });
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/Save current layout/));
    await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(screen.queryByPlaceholderText(/Save current layout/)).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("NetToolsModal: the host field gets focus, not the first tool chip", async () => {
    await act(async () => { render(<NetToolsModal open initialHost="h" onClose={() => {}} />); });
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/host or IP/));
  });

  test("RdpConnectModal: a saved-session launch focuses the password (the only editable field); quick connect focuses Host", async () => {
    const initial = { host: "a.host", port: 3389, username: "u", domain: "" };
    await act(async () => { render(<RdpConnectModal open lockConnection initial={initial} onConnect={() => {}} onClose={() => {}} />); });
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
    cleanup();
    await act(async () => { render(<RdpConnectModal open onConnect={() => {}} onClose={() => {}} />); });
    expect(document.activeElement).toBe(screen.getByLabelText("Host"));
  });
});

// ── Item 12: tests for changed code that had none ──────────────────────────
describe("remote-desktop key forwarding", () => {
  test("VncView: mapped keys go down then up with preventDefault; unmapped keys pass; nothing is sent before a session id", async () => {
    const conn = deferred();
    invokeMock.mockImplementation((cmd) => (cmd === "vnc_connect" ? conn.promise : Promise.resolve(undefined)));
    render(<VncView host="h" port={5900} tabId="t-vnc" visible={false} />);
    const surface = screen.getByRole("application", { name: "Remote desktop (VNC)" });
    // Before connect resolves there is no session id: nothing sent, not swallowed.
    expect(fireEvent.keyDown(surface, { key: "a" })).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("vnc_key", expect.anything());
    await act(async () => { conn.resolve(["v1", 8, 8]); });
    expect(fireEvent.keyDown(surface, { key: "a" })).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("vnc_key", { id: "v1", keysym: 97, down: true });
    expect(fireEvent.keyUp(surface, { key: "Enter" })).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("vnc_key", { id: "v1", keysym: 0xff0d, down: false });
    const sent = invokeMock.mock.calls.filter(([c]) => c === "vnc_key").length;
    expect(fireEvent.keyDown(surface, { key: "Unidentified" })).toBe(true);
    expect(invokeMock.mock.calls.filter(([c]) => c === "vnc_key").length).toBe(sent);
  });

  test("RdpView: mapped codes go down then up with preventDefault; unmapped codes pass; nothing is sent before a session id", async () => {
    const conn = deferred();
    invokeMock.mockImplementation((cmd) => (cmd === "rdp_connect" ? conn.promise : Promise.resolve(undefined)));
    render(<RdpView host="h" port={3389} username="u" domain="" tabId="t-rdp" visible={false} />);
    const surface = screen.getByRole("application", { name: "Remote desktop (RDP)" });
    expect(fireEvent.keyDown(surface, { code: "KeyA", key: "a" })).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("rdp_key", expect.anything());
    await act(async () => { conn.resolve(["r1", 8, 8]); });
    expect(fireEvent.keyDown(surface, { code: "KeyA", key: "a" })).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("rdp_key", { id: "r1", scancode: 0x1e, down: true });
    expect(fireEvent.keyUp(surface, { code: "KeyA", key: "a" })).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("rdp_key", { id: "r1", scancode: 0x1e, down: false });
    const sent = invokeMock.mock.calls.filter(([c]) => c === "rdp_key").length;
    expect(fireEvent.keyDown(surface, { code: "IntlRo", key: "ro" })).toBe(true);
    expect(invokeMock.mock.calls.filter(([c]) => c === "rdp_key").length).toBe(sent);
  });
});

describe("PromptEditor", () => {
  test("Enter calls the newest onSubmit after the prop changes, with the typed text", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const props = { visible: true, top: 0, left: 0, width: 400, height: 40, theme: {}, cwd: "/", vimMode: false, onEscape: () => {}, onCtrlC: () => {}, onClear: () => {} };
    const { rerender, container } = render(<PromptEditor {...props} onSubmit={first} />);
    rerender(<PromptEditor {...props} onSubmit={second} />);
    const content = container.querySelector(".cm-content");
    expect(content).toBeTruthy();
    fireEvent.keyDown(content, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith("");
    expect(first).not.toHaveBeenCalled();
  });
});

describe("SshPasswordModal submit", () => {
  test("Enter calls onSubmit exactly once with the password, and the field is empty after", () => {
    const onSubmit = vi.fn();
    render(<SshPasswordModal open host="h" user="u" onSubmit={onSubmit} onCancel={() => {}} />);
    const pw = screen.getByPlaceholderText("Password");
    fireEvent.change(pw, { target: { value: "pw" } });
    fireEvent.keyDown(pw, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("pw", false);
    expect(screen.getByPlaceholderText("Password").value).toBe("");
  });
});
