// (C)
// @vitest-environment happy-dom
// v0.7.6 lint cleanup, batch "terminals modals": a dozen dialogs used to reset
// their form state in an effect that ran on every open (setState in an effect).
// They now mount their body fresh on each open (Modal renders nothing while
// closed) or take their start state from props. These tests pin the behaviours
// that must not change: a reopen starts clean, the password never outlives its
// prompt, preferences that were kept across a close are still kept, and the
// keyboard paths that replaced click-only targets work.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

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

import { ToastProvider } from "../../components/Toast.jsx";
import { ConfirmProvider } from "../../components/ConfirmModal.jsx";
import SshPasswordModal from "./SshPasswordModal.jsx";
import WorkspacesModal from "./WorkspacesModal.jsx";
import HistorySearch from "./HistorySearch.jsx";
import RemoteControlModal from "./RemoteControlModal.jsx";
import RdpConnectModal from "./RdpConnectModal.jsx";
import RemoteEditor from "./RemoteEditor.jsx";
import NetToolsModal from "./NetToolsModal.jsx";
import MacrosModal from "./MacrosModal.jsx";
import SnippetsDrawer from "./SnippetsDrawer.jsx";
import LocalFileBrowser from "./LocalFileBrowser.jsx";
import SftpBrowser from "./SftpBrowser.jsx";
import NotebookView from "./NotebookView.jsx";
import ShareModal from "./ShareModal.jsx";
import ProjectDialog from "./ProjectDialog.jsx";

const wrap = (ui) => (
  <ToastProvider>
    <ConfirmProvider>{ui}</ConfirmProvider>
  </ToastProvider>
);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("SshPasswordModal", () => {
  test("a reopen starts with an empty field and remember off; the password is not kept", () => {
    const onSubmit = vi.fn();
    const props = { host: "h", user: "u", onSubmit, onCancel: () => {} };
    const { rerender } = render(<SshPasswordModal open {...props} />);
    const pw = () => screen.getByPlaceholderText("Password");
    fireEvent.change(pw(), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(pw().value).toBe("hunter2");

    rerender(<SshPasswordModal open={false} {...props} />);
    expect(screen.queryByPlaceholderText("Password")).toBeNull();
    // Nothing in the DOM holds the value once closed.
    expect(document.body.innerHTML).not.toContain("hunter2");

    rerender(<SshPasswordModal open {...props} />);
    expect(pw().value).toBe("");
    expect(screen.getByRole("checkbox").checked).toBe(false);
  });

  test("Enter submits the typed password and the remember flag", () => {
    const onSubmit = vi.fn();
    render(<SshPasswordModal open host="h" user="u" onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.keyDown(screen.getByPlaceholderText("Password"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("pw", true);
  });
});

describe("WorkspacesModal", () => {
  test("a reopen clears the name; Save sends the trimmed name", () => {
    const onSave = vi.fn();
    const props = { workspaces: [], onClose: () => {}, onSave, onLoad: () => {}, onDelete: () => {} };
    const { rerender } = render(<WorkspacesModal open {...props} />);
    const input = () => screen.getByPlaceholderText(/Save current layout/);
    fireEvent.change(input(), { target: { value: "  prod  " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith("prod");
    fireEvent.change(input(), { target: { value: "leftover" } });
    rerender(<WorkspacesModal open={false} {...props} />);
    rerender(<WorkspacesModal open {...props} />);
    expect(input().value).toBe("");
  });
});

describe("HistorySearch", () => {
  const history = ["git status", "git log", "ls -la"];
  test("filter narrows the list; typing resets the selection; reopen clears the query", () => {
    const onInsert = vi.fn();
    const props = { history, onClose: () => {}, onInsert, onRun: () => {} };
    const { rerender } = render(<HistorySearch open {...props} />);
    const input = () => screen.getByPlaceholderText(/Type to filter/);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.change(input(), { target: { value: "git" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onInsert).toHaveBeenCalledWith("git status");

    rerender(<HistorySearch open={false} {...props} />);
    rerender(<HistorySearch open {...props} />);
    expect(input().value).toBe("");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  test("the filter field points aria-activedescendant at the active option, following the arrow keys", () => {
    const onInsert = vi.fn();
    render(<HistorySearch open history={history} onClose={() => {}} onInsert={onInsert} onRun={() => {}} />);
    const input = screen.getByPlaceholderText(/Type to filter/);
    const listbox = screen.getByRole("listbox");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    const active = () => document.getElementById(input.getAttribute("aria-activedescendant"));
    expect(active().textContent).toContain("git status");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active().textContent).toContain("ls -la");
    expect(active().getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(active().textContent).toContain("git log");
    // A filter with no match leaves nothing to point at.
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    // Rows are mouse targets only; the keyboard path is the field.
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onInsert).toHaveBeenCalledWith("git log");
  });
});

describe("RemoteControlModal", () => {
  test("loads status on open, shows the QR for the running url, Escape and backdrop close, a click inside does not", async () => {
    invokeMock.mockResolvedValue({ running: true, url: "http://x:1", token: "tok", port: 1, host: "x" });
    const onClose = vi.fn();
    const { container } = render(<RemoteControlModal open onClose={onClose} />);
    await waitFor(() => expect(screen.getByAltText("pairing QR").getAttribute("src")).toContain("http://x:1"));
    fireEvent.mouseDown(screen.getByText("Remote control"));
    fireEvent.click(screen.getByText("Remote control"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(container.firstChild);
    fireEvent.click(container.firstChild);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Focus is in the card, so Escape typed there reaches the dialog.
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("stopping the server drops the QR, and a restart never shows the old code for the new url", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "companion_status") return { running: true, url: "http://a:1", token: "t", port: 1, host: "a" };
      if (cmd === "companion_stop") return undefined;
      if (cmd === "companion_start") return { running: true, url: "http://b:2", token: "t2", port: 2, host: "b" };
      return undefined;
    });
    render(<RemoteControlModal open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByAltText("pairing QR").getAttribute("src")).toContain("http://a:1"));
    fireEvent.click(screen.getByText("Stop server"));
    await waitFor(() => expect(screen.queryByAltText("pairing QR")).toBeNull());
    fireEvent.click(screen.getByText("Start server"));
    await waitFor(() => expect(screen.getByAltText("pairing QR").getAttribute("src")).toContain("http://b:2"));
  });

  test("an error from the status call is shown, and cleared on the next open", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    const { rerender } = render(<RemoteControlModal open onClose={() => {}} />);
    await waitFor(() => expect(document.body.textContent).toMatch(/boom/));
    invokeMock.mockResolvedValue({ running: false });
    rerender(<RemoteControlModal open={false} onClose={() => {}} />);
    rerender(<RemoteControlModal open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Start server")).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/boom/);
  });
});

describe("RdpConnectModal", () => {
  test("starts from the saved session, and a reopen goes back to it (not to what was typed)", () => {
    const initial = { host: "10.0.0.9", port: 3390, username: "admin", domain: "CORP" };
    const props = { initial, onConnect: () => {}, onClose: () => {} };
    const { rerender } = render(<RdpConnectModal open {...props} />);
    const host = () => screen.getByLabelText("Host");
    expect(host().value).toBe("10.0.0.9");
    expect(screen.getByLabelText("Port").value).toBe("3390");
    fireEvent.change(host(), { target: { value: "typed" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    rerender(<RdpConnectModal open={false} {...props} />);
    rerender(<RdpConnectModal open {...props} />);
    expect(host().value).toBe("10.0.0.9");
    expect(screen.getByLabelText("Password").value).toBe("");
  });
});

describe("NetToolsModal", () => {
  test("seeds the host; a reopen re-seeds it and starts with empty output and the default tool", async () => {
    invokeMock.mockImplementation(async (cmd) => (cmd === "net_dns" ? ["10.1.2.3"] : undefined));
    const props = { initialHost: "box.local", onClose: () => {} };
    const { rerender } = render(<NetToolsModal open {...props} />);
    const host = () => screen.getByPlaceholderText(/host or IP/);
    expect(host().value).toBe("box.local");
    fireEvent.click(screen.getByText("DNS lookup"));
    fireEvent.change(host(), { target: { value: "other" } });
    fireEvent.keyDown(host(), { key: "Enter" });
    await waitFor(() => expect(document.body.textContent).toContain("10.1.2.3"));
    rerender(<NetToolsModal open={false} {...props} />);
    rerender(<NetToolsModal open {...props} />);
    expect(host().value).toBe("box.local");
    expect(document.body.textContent).not.toContain("10.1.2.3");
    expect(document.body.textContent).toContain("Pick a tool, enter a host, and hit run.");
    // The tool is per-open too (ModalHost mounts this only while open).
    expect(screen.queryByPlaceholderText(/ports, e.g./)).toBeNull();
  });
});

describe("MacrosModal", () => {
  test("opens with the stored macros (read fresh on each open) and a delete control that is a real button", () => {
    const KEY = "plutos-terminals:macros:v0";
    localStorage.setItem(KEY, JSON.stringify([{ id: "m1", name: "one", data: "ls" + String.fromCharCode(13) }]));
    const props = { onClose: () => {}, onReplay: () => {}, canReplay: true, activePaneId: "p" };
    const { rerender } = render(wrap(<MacrosModal open {...props} />));
    expect(screen.getByRole("button", { name: "Delete macro one" }).tagName).toBe("BUTTON");
    rerender(wrap(<MacrosModal open={false} {...props} />));
    localStorage.setItem(KEY, JSON.stringify([{ id: "m2", name: "two", data: "pwd" }]));
    rerender(wrap(<MacrosModal open {...props} />));
    expect(screen.getByRole("button", { name: "Delete macro two" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete macro one" })).toBeNull();
    localStorage.clear();
  });
});

describe("SnippetsDrawer", () => {
  test("a row inserts its command; its delete button deletes without inserting", () => {
    const onInsert = vi.fn();
    const onSnippetsChange = vi.fn();
    const snippets = [{ id: "a", name: "Say hi", command: "echo hi" }];
    render(<SnippetsDrawer open onClose={() => {}} onInsert={onInsert} snippets={snippets} onSnippetsChange={onSnippetsChange} />);
    fireEvent.click(screen.getByText("Say hi"));
    expect(onInsert).toHaveBeenCalledWith("echo hi");
    onInsert.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Delete workflow Say hi" }));
    expect(onSnippetsChange).toHaveBeenCalledWith([]);
    expect(onInsert).not.toHaveBeenCalled();
  });

  test("prompts: delete is a button and removes by id", () => {
    const onRemovePrompt = vi.fn();
    render(
      <SnippetsDrawer open onClose={() => {}} snippets={[]} prompts={[{ id: "p1", name: "Explain", body: "explain it", tags: [] }]} onAddPrompt={() => {}} onRemovePrompt={onRemovePrompt} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete prompt Explain" }));
    expect(onRemovePrompt).toHaveBeenCalledWith("p1");
  });
});

describe("LocalFileBrowser keyboard access", () => {
  test("Enter on a folder name opens it; Space on a file name inserts its path; the root crumb is a button", async () => {
    const onSend = vi.fn();
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== "list_directory") return undefined;
      if (args.path === "/home/p/sub") return ["/home/p/sub", [], false];
      return ["/home/p", [
        { name: "sub", path: "/home/p/sub", is_dir: true, size: 0, mtime: 0 },
        { name: "a.txt", path: "/home/p/a.txt", is_dir: false, size: 1, mtime: 0 },
      ], false];
    });
    render(<LocalFileBrowser onSendToTerminal={onSend} />);
    await waitFor(() => expect(screen.getByText("a.txt")).toBeTruthy());
    expect(screen.getAllByRole("button", { name: "/" }).length).toBeGreaterThan(0);
    fireEvent.keyDown(screen.getByText("a.txt"), { key: " " });
    expect(onSend).toHaveBeenCalledWith("'/home/p/a.txt' ");
    fireEvent.keyDown(screen.getByText("sub"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Empty folder.")).toBeTruthy());
  });
});

describe("SftpBrowser keyboard access", () => {
  test("a folder name is keyboard-activatable, a file name is not a button", async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "sftp_home") return "/home/u";
      if (cmd === "sftp_list") {
        if (args.path === "/home/u/dir") return [];
        return [
          { name: "dir", path: "/home/u/dir", is_dir: true, size: 0, mtime: 0 },
          { name: "f.txt", path: "/home/u/f.txt", is_dir: false, size: 3, mtime: 0 },
        ];
      }
      return undefined;
    });
    render(wrap(<SftpBrowser open docked sessionId="s1" onClose={() => {}} />));
    await waitFor(() => expect(screen.getByText("dir")).toBeTruthy());
    expect(screen.getByText("f.txt").getAttribute("role")).toBeNull();
    expect(screen.getByText("dir").getAttribute("role")).toBe("button");
    fireEvent.keyDown(screen.getByText("dir"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Empty folder.")).toBeTruthy());
  });
});

describe("RemoteEditor", () => {
  test("loads the file, and a different file loads that file's text", async () => {
    invokeMock.mockImplementation(async (cmd, args) => (cmd === "sftp_read_file" ? `body of ${args.path}` : undefined));
    const { rerender } = render(wrap(<RemoteEditor open sessionId="s" path="/a" name="a" onClose={() => {}} />));
    await waitFor(() => expect(document.body.textContent + [...document.querySelectorAll("textarea")].map((t) => t.value).join()).toContain("body of /a"));
    rerender(wrap(<RemoteEditor open sessionId="s" path="/b" name="b" onClose={() => {}} />));
    await waitFor(() => expect([...document.querySelectorAll("textarea")].map((t) => t.value).join()).toContain("body of /b"));
    expect([...document.querySelectorAll("textarea")].map((t) => t.value).join()).not.toContain("body of /a");
  });

  test("closed renders nothing and reads nothing", () => {
    render(wrap(<RemoteEditor open={false} sessionId="s" path="/a" name="a" onClose={() => {}} />));
    expect(invokeMock).not.toHaveBeenCalledWith("sftp_read_file", expect.anything());
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});

describe("NotebookView", () => {
  test("loads its notebook, and a different name loads that notebook's content", async () => {
    const { rerender } = render(wrap(<NotebookView name="one.md" tabId="t1" visible={false} paneTitles={{}} />));
    await waitFor(() => expect(document.body.textContent).toContain("content of one.md"));
    rerender(wrap(<NotebookView name="two.md" tabId="t1" visible={false} paneTitles={{}} />));
    await waitFor(() => expect(document.body.textContent).toContain("content of two.md"));
    expect(document.body.textContent).not.toContain("content of one.md");
  });
});

describe("ShareModal", () => {
  test("a reopen goes back to the secret (unlisted) default", () => {
    const props = { kind: "block", title: "ls", rawText: "ls -la", dateStamp: "2026-11-20", onClose: () => {}, saveUser: () => {} };
    const { rerender } = render(wrap(<ShareModal open {...props} />));
    const [secret, pub] = screen.getAllByRole("radio");
    fireEvent.click(pub);
    expect(pub.checked).toBe(true);
    expect(secret.checked).toBe(false);
    rerender(wrap(<ShareModal open={false} {...props} />));
    rerender(wrap(<ShareModal open {...props} />));
    expect(screen.getAllByRole("radio")[0].checked).toBe(true);
  });
});

describe("ProjectDialog", () => {
  test("seeds every field from the session being edited, per type", () => {
    const initial = { type: "rdp", name: "box", rdp: { host: "h", port: 3390, username: "u", domain: "D" } };
    render(<ProjectDialog open initial={initial} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByDisplayValue("box")).toBeTruthy();
    expect(screen.getByDisplayValue("3390")).toBeTruthy();
    expect(screen.getByDisplayValue("D")).toBeTruthy();
  });

  test("a new session starts blank with the local type and the default SSH port ready", () => {
    render(<ProjectDialog open initial={null} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByText("ADD SESSION")).toBeTruthy();
    fireEvent.click(screen.getByText("SSH"));
    expect(screen.getByDisplayValue("22")).toBeTruthy();
  });
});
