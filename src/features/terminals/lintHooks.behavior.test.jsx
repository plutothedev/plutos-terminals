// (C)
// @vitest-environment happy-dom
// Pins the open/key/prop-change behaviour of components whose "reset on open"
// state moved from a synchronous setState inside an effect to an adjustment
// during render (react-hooks/set-state-in-effect cleanup, v0.7.6). Each test
// would fail if the reset stopped happening on the transition it guards.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";

const { invokeMock, readUserStMock, llmStreamMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  readUserStMock: vi.fn(() => ({})),
  llmStreamMock: vi.fn(),
}));
vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));
vi.mock("./storageKeys.js", async (orig) => ({ ...(await orig()), readUserSt: readUserStMock }));
vi.mock("./llmStream.js", () => ({ llmStream: llmStreamMock }));

import SerialModal from "./SerialModal.jsx";
import VncConnectModal from "./VncConnectModal.jsx";
import DiffView from "./DiffView.jsx";
import ErrorExplainer from "./ErrorExplainer.jsx";
import AskBar from "./AskBar.jsx";
import KeybindingsSection from "./KeybindingsSection.jsx";
import SharingSection from "./SharingSection.jsx";
import LockScreen from "./LockScreen.jsx";

beforeEach(() => {
  invokeMock.mockReset();
  llmStreamMock.mockReset();
  readUserStMock.mockReset();
  readUserStMock.mockReturnValue({});
});
afterEach(cleanup);

describe("SerialModal", () => {
  test("scans on open (once), shows Scanning while it loads, and Rescan scans again", async () => {
    let resolve;
    invokeMock.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { getByText, getByLabelText } = render(<SerialModal open onConnect={() => {}} onClose={() => {}} />);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("serial_list");
    expect(getByText("Scanning…")).toBeTruthy();
    await act(async () => { resolve(["COM3"]); });
    await waitFor(() => expect(document.querySelector("option[value=COM3]")).toBeTruthy());
    invokeMock.mockResolvedValue(["COM3", "COM4"]);
    fireEvent.click(getByLabelText("Rescan ports"));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.querySelector("option[value=COM4]")).toBeTruthy());
  });
});

describe("VncConnectModal", () => {
  test("pre-fills from `initial` on open and again when `initial` changes", () => {
    const a = { host: "alpha.test", port: 5901 };
    const b = { host: "beta.test", port: 5902 };
    const { container, rerender } = render(<VncConnectModal open initial={a} onConnect={() => {}} onClose={() => {}} />);
    const host = () => container.ownerDocument.querySelector("input[placeholder='localhost']");
    expect(host().value).toBe("alpha.test");
    rerender(<VncConnectModal open initial={b} onConnect={() => {}} onClose={() => {}} />);
    expect(host().value).toBe("beta.test");
  });
});

describe("DiffView", () => {
  test("loads the diff once per worktree and drops the old diff when the worktree changes", async () => {
    let resolveB;
    invokeMock.mockImplementation((cmd, args) => {
      if (args.path === "/a") return Promise.resolve("+line-from-a\n");
      return new Promise((r) => { resolveB = r; });
    });
    const wa = { path: "/a", branch: "a" };
    const wb = { path: "/b", branch: "b" };
    const { queryByText, rerender } = render(<DiffView open worktree={wa} onClose={() => {}} />);
    await waitFor(() => expect(queryByText("+line-from-a")).toBeTruthy());
    expect(invokeMock.mock.calls.filter((c) => c[0] === "git_diff")).toHaveLength(1);
    rerender(<DiffView open worktree={wb} onClose={() => {}} />);
    expect(queryByText("+line-from-a")).toBeNull();
    expect(invokeMock.mock.calls.filter((c) => c[0] === "git_diff")).toHaveLength(2);
    await act(async () => { resolveB("+line-from-b\n"); });
    await waitFor(() => expect(queryByText("+line-from-b")).toBeTruthy());
  });
});

describe("ErrorExplainer", () => {
  const block = (key) => ({ key, exitCode: 1, text: "boom" });

  test("with no model configured it shows the no-model message and never streams", () => {
    const { container } = render(<ErrorExplainer block={block("k1")} onClose={() => {}} onRun={() => {}} />);
    expect(llmStreamMock).not.toHaveBeenCalled();
    expect(container.textContent.toLowerCase()).toMatch(/model|key/);
  });

  test("streams once per block key, and again for a new key", () => {
    readUserStMock.mockReturnValue({
      activeModel: { providerId: "anthropic", model: "claude-test" },
      providerKeys: { anthropic: "sk-test" },
    });
    llmStreamMock.mockReturnValue({ promise: new Promise(() => {}), cancel: () => {} });
    const props = { onClose: () => {}, onRun: () => {} };
    const { rerender } = render(<ErrorExplainer block={block("k1")} {...props} />);
    expect(llmStreamMock).toHaveBeenCalledTimes(1);
    rerender(<ErrorExplainer block={{ ...block("k1") }} {...props} />);
    expect(llmStreamMock).toHaveBeenCalledTimes(1);
    rerender(<ErrorExplainer block={block("k2")} {...props} />);
    expect(llmStreamMock).toHaveBeenCalledTimes(2);
  });
});

describe("AskBar", () => {
  test("starts clean each time it re-opens", () => {
    const props = { onClose: () => {}, onRun: () => {}, onInsert: () => {}, shellName: "bash", cwd: "/" };
    const { rerender, container } = render(<AskBar open {...props} />);
    const input = () => container.ownerDocument.querySelector("input[placeholder^='Type a command']");
    fireEvent.change(input(), { target: { value: "ls -la" } });
    expect(input().value).toBe("ls -la");
    rerender(<AskBar open={false} {...props} />);
    rerender(<AskBar open {...props} />);
    expect(input().value).toBe("");
  });
});

describe("KeybindingsSection", () => {
  const TITLE = "Click, then press the new shortcut (Esc to cancel)";

  test("a rejected key shows a message; starting a new recording clears it", () => {
    const { getAllByTitle, queryByText } = render(<KeybindingsSection userSt={{}} saveUser={() => {}} />);
    fireEvent.click(getAllByTitle(TITLE)[0]);
    fireEvent.keyDown(window, { key: "a" }); // no Ctrl/Alt: not bindable
    expect(queryByText(/Use Ctrl or Alt/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" }); // stop recording; message stays
    expect(queryByText(/Use Ctrl or Alt/)).toBeTruthy();
    fireEvent.click(getAllByTitle(TITLE)[0]); // new recording clears it
    expect(queryByText(/Use Ctrl or Alt/)).toBeNull();
  });

  test("a valid combo is saved through a functional updater and recording ends", () => {
    const saveUser = vi.fn();
    const { getAllByTitle, queryAllByText } = render(<KeybindingsSection userSt={{}} saveUser={saveUser} />);
    fireEvent.click(getAllByTitle(TITLE)[0]);
    expect(queryAllByText("Press keys…")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "F9", code: "F9", ctrlKey: true, altKey: true });
    expect(saveUser).toHaveBeenCalledTimes(1);
    expect(typeof saveUser.mock.calls[0][0]).toBe("function");
    expect(queryAllByText("Press keys…")).toHaveLength(0);
  });
});

describe("SharingSection", () => {
  test("reads the auth source on mount", async () => {
    invokeMock.mockResolvedValue({ source: "gh" });
    const { findByText } = render(<SharingSection />);
    expect(await findByText("Using gh CLI")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("gist_auth_available");
  });
});

describe("LockScreen", () => {
  test("focuses the password field on mount", () => {
    const { container } = render(<LockScreen expectedHash="x" onUnlock={() => {}} />);
    const input = container.querySelector("input[type=password]");
    expect(container.ownerDocument.activeElement).toBe(input);
  });
});
