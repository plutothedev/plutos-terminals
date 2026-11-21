// (C)
// @vitest-environment happy-dom
// Pins the open/key/prop-change behaviour of components whose "reset on open"
// state moved from a synchronous setState inside an effect to an adjustment
// during render (react-hooks/set-state-in-effect cleanup, v0.7.6). Each test
// would fail if the reset stopped happening on the transition it guards.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { useLayoutEffect, StrictMode } from "react";

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
import SessionSummary from "./SessionSummary.jsx";
import AgentDashboard from "./AgentDashboard.jsx";

const MODEL = {
  activeModel: { providerId: "anthropic", model: "claude-test" },
  providerKeys: { anthropic: "sk-test" },
};

// Runs `fire` from a layout effect. Rendered as a later sibling, its layout
// effect runs after the component under test has committed and before any
// passive effect (where a stream's cleanup lives): the window in which a late
// stream delta can land in the real app, since passive effects run after paint.
function LateDelta({ fire }) {
  useLayoutEffect(() => { fire?.(); }, [fire]);
  return null;
}

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
    // Exact text: the loading line ("Asking the model…") would also match a
    // loose /model/ pattern, so the old assertion passed with this branch broken.
    expect(container.textContent).toContain("No model configured. Open the Models picker (toolbar) first.");
    expect(container.textContent).not.toContain("Asking");
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

  test("under StrictMode (effect re-run) the restarted stream completes and the answer shows", async () => {
    readUserStMock.mockReturnValue(MODEL);
    // Each call gets its own promise; a cancelled stream never settles, like a dropped connection.
    llmStreamMock.mockImplementation(() => {
      let done = false;
      const promise = new Promise((resolve) => { setTimeout(() => { if (!done) resolve("Use the fix."); }, 0); });
      return { promise, cancel: () => { done = true; } };
    });
    const { container } = render(
      <StrictMode><ErrorExplainer block={block("k1")} onClose={() => {}} onRun={() => {}} /></StrictMode>
    );
    await waitFor(() => expect(container.textContent).toContain("Use the fix."));
    expect(container.textContent).not.toContain("Asking");
  });

  test("a new block object with the same key keeps the running stream", () => {
    readUserStMock.mockReturnValue(MODEL);
    const cancel = vi.fn();
    llmStreamMock.mockReturnValue({ promise: new Promise(() => {}), cancel });
    const props = { onClose: () => {}, onRun: () => {} };
    const { rerender } = render(<ErrorExplainer block={block("k1")} {...props} />);
    rerender(<ErrorExplainer block={{ ...block("k1") }} {...props} />);
    expect(cancel).not.toHaveBeenCalled();
    expect(llmStreamMock).toHaveBeenCalledTimes(1);
  });

  test("resolves the model once per block: the stream uses the model the header shows", () => {
    // Render read claude-a; a second readUserSt() in the effect would see claude-b.
    readUserStMock
      .mockReturnValueOnce({ ...MODEL, activeModel: { providerId: "anthropic", model: "claude-a" } })
      .mockReturnValue({ ...MODEL, activeModel: { providerId: "anthropic", model: "claude-b" } });
    llmStreamMock.mockReturnValue({ promise: new Promise(() => {}), cancel: () => {} });
    const { container } = render(<ErrorExplainer block={block("k1")} onClose={() => {}} onRun={() => {}} />);
    expect(container.textContent).toContain("via claude-a");
    expect(llmStreamMock).toHaveBeenCalledTimes(1);
    expect(llmStreamMock.mock.calls[0][0].model).toBe("claude-a");
  });

  test("a delta from the previous block that lands after the key changed is dropped", () => {
    readUserStMock.mockReturnValue(MODEL);
    llmStreamMock.mockImplementation(() => ({ promise: new Promise(() => {}), cancel: () => {} }));
    const props = { onClose: () => {}, onRun: () => {} };
    const { container, rerender } = render(
      <>
        <ErrorExplainer block={block("k1")} {...props} />
        <LateDelta />
      </>
    );
    const k1Token = llmStreamMock.mock.calls[0][1];
    // k1's delta arrives after the k2 commit but before passive effects (where
    // the old stream's cleanup runs): a sibling's layout effect is that moment.
    rerender(
      <>
        <ErrorExplainer block={block("k2")} {...props} />
        <LateDelta fire={() => k1Token("STALE k1 text")} />
      </>
    );
    expect(container.textContent).not.toContain("STALE");
    expect(container.textContent).toContain("Asking claude-test…");
    const k2Token = llmStreamMock.mock.calls[1][1];
    act(() => { k2Token("fresh k2 text"); });
    expect(container.textContent).toContain("fresh k2 text");
  });

  test("after the model is removed, a new failed block offers no Run fix from the previous answer", async () => {
    // BEHAVIOUR CHANGE (v0.7.6 fix round 1): the no-model branch kept the old
    // answer, so the header still offered the PREVIOUS block's fix command.
    readUserStMock.mockReturnValue(MODEL);
    llmStreamMock.mockReturnValue({
      promise: Promise.resolve("Missing deps.\n```bash\nnpm ci\n```"),
      cancel: () => {},
    });
    const onRun = vi.fn();
    const { findByText, queryByText, container, rerender } = render(
      <ErrorExplainer block={block("k1")} onClose={() => {}} onRun={onRun} />
    );
    expect(await findByText("Run fix ▶")).toBeTruthy();
    readUserStMock.mockReturnValue({});
    rerender(<ErrorExplainer block={block("k2")} onClose={() => {}} onRun={onRun} />);
    expect(container.textContent).toContain("No model configured. Open the Models picker (toolbar) first.");
    expect(queryByText("Run fix ▶")).toBeNull();
    expect(queryByText("Copy")).toBeNull();
    expect(container.textContent).not.toContain("via claude-test");
  });
});

describe("SessionSummary", () => {
  const props = { sourceId: null, panels: [], onClose: () => {} };
  const body = () => document.body.textContent;

  test("mounted open with a model, it streams once", () => {
    readUserStMock.mockReturnValue(MODEL);
    llmStreamMock.mockReturnValue({ promise: new Promise(() => {}), cancel: () => {} });
    render(<SessionSummary open text="make: ok" {...props} />);
    expect(llmStreamMock).toHaveBeenCalledTimes(1);
    expect(llmStreamMock.mock.calls[0][0].prompt).toContain("make: ok");
    expect(body()).toContain("Reading the terminal and summarizing…");
  });

  test("a text change while open cancels the old stream and starts exactly one new one", () => {
    readUserStMock.mockReturnValue(MODEL);
    const cancelA = vi.fn();
    const cancelB = vi.fn();
    llmStreamMock
      .mockReturnValueOnce({ promise: new Promise(() => {}), cancel: cancelA })
      .mockReturnValueOnce({ promise: new Promise(() => {}), cancel: cancelB });
    const { rerender } = render(<SessionSummary open text="A output" {...props} />);
    rerender(<SessionSummary open text="B output" {...props} />);
    expect(cancelA).toHaveBeenCalledTimes(1);
    expect(cancelB).not.toHaveBeenCalled();
    expect(llmStreamMock).toHaveBeenCalledTimes(2);
    expect(llmStreamMock.mock.calls[1][0].prompt).toContain("B output");
  });

  test("empty text shows the empty message and never streams", () => {
    readUserStMock.mockReturnValue(MODEL);
    render(<SessionSummary open text={"  \n "} {...props} />);
    expect(body()).toContain("Nothing in this terminal to summarize yet.");
    expect(body()).not.toContain("Reading the terminal");
    expect(llmStreamMock).not.toHaveBeenCalled();
  });

  test("no model shows the no-model message and never streams", () => {
    render(<SessionSummary open text="make: ok" {...props} />);
    expect(body()).toContain("No model configured. Open the Models picker (toolbar) first.");
    expect(body()).not.toContain("Reading the terminal");
    expect(llmStreamMock).not.toHaveBeenCalled();
  });

  test("resolves the model once per text: the stream uses the model the header shows", () => {
    readUserStMock
      .mockReturnValueOnce({ ...MODEL, activeModel: { providerId: "anthropic", model: "claude-a" } })
      .mockReturnValue({ ...MODEL, activeModel: { providerId: "anthropic", model: "claude-b" } });
    llmStreamMock.mockReturnValue({ promise: new Promise(() => {}), cancel: () => {} });
    render(<SessionSummary open text="make: ok" {...props} />);
    expect(body()).toContain("via claude-a");
    expect(llmStreamMock).toHaveBeenCalledTimes(1);
    expect(llmStreamMock.mock.calls[0][0].model).toBe("claude-a");
  });

  test("a delta from the previous text that lands after the text changed is dropped", () => {
    readUserStMock.mockReturnValue(MODEL);
    llmStreamMock.mockImplementation(() => ({ promise: new Promise(() => {}), cancel: () => {} }));
    const { rerender } = render(
      <>
        <SessionSummary open text="A output" {...props} />
        <LateDelta />
      </>
    );
    const aToken = llmStreamMock.mock.calls[0][1];
    rerender(
      <>
        <SessionSummary open text="B output" {...props} />
        <LateDelta fire={() => aToken("STALE summary of A")} />
      </>
    );
    expect(body()).not.toContain("STALE");
    expect(body()).toContain("Reading the terminal and summarizing…");
    const bToken = llmStreamMock.mock.calls[1][1];
    act(() => { bToken("summary of B"); });
    expect(body()).toContain("summary of B");
  });

  test("after the model is removed, new text offers no Copy of the previous summary", async () => {
    // BEHAVIOUR CHANGE (v0.7.6 fix round 1): the no-model and empty branches
    // kept the old answer, so Copy and Hand off still offered the old summary.
    readUserStMock.mockReturnValue(MODEL);
    llmStreamMock.mockReturnValue({ promise: Promise.resolve("Summary of A."), cancel: () => {} });
    const { findByText, queryByText, rerender } = render(<SessionSummary open text="A output" {...props} />);
    expect(await findByText("Copy")).toBeTruthy();
    readUserStMock.mockReturnValue({});
    rerender(<SessionSummary open text="B output" {...props} />);
    expect(body()).toContain("No model configured. Open the Models picker (toolbar) first.");
    expect(queryByText("Copy")).toBeNull();
    expect(body()).not.toContain("Summary of A.");
    expect(body()).not.toContain("via claude-test");
  });

  test("emptied text offers no Copy of the previous summary", async () => {
    readUserStMock.mockReturnValue(MODEL);
    llmStreamMock.mockReturnValue({ promise: Promise.resolve("Summary of A."), cancel: () => {} });
    const { findByText, queryByText, rerender } = render(<SessionSummary open text="A output" {...props} />);
    expect(await findByText("Copy")).toBeTruthy();
    rerender(<SessionSummary open text="" {...props} />);
    expect(body()).toContain("Nothing in this terminal to summarize yet.");
    expect(queryByText("Copy")).toBeNull();
  });
});

describe("AgentDashboard", () => {
  const panels = [{
    id: "p1",
    activeTabId: "t1",
    tabs: [{ id: "t1", label: "build", worktree: { branch: "feat-x", path: "/w" } }],
  }];

  function mount() {
    const spies = { onFocusTab: vi.fn(), onSummarize: vi.fn(), onReviewDiff: vi.fn() };
    const utils = render(<AgentDashboard panels={panels} activePanelId="p1" tabCosts={{}} {...spies} />);
    return { ...utils, ...spies };
  }

  test("the row is not itself a button; the name area is a real button that focuses the tab", () => {
    const { container, getByRole, onFocusTab } = mount();
    const row = container.querySelector(".moba-agent-row");
    expect(row.getAttribute("role")).toBe("presentation"); // was "button" around two buttons
    expect(row.hasAttribute("tabindex")).toBe(false);
    const name = getByRole("button", { name: /feat-x/ });
    expect(name.tagName).toBe("BUTTON");
    expect(name.getAttribute("type")).toBe("button");
    expect(name.contains(row.querySelector(".moba-agent-dot"))).toBe(true);
    expect(name.contains(row.querySelector(".moba-agent-icon"))).toBe(true);
    // Keyboard: a focused native button turns Enter (and Space) into a click,
    // which happy-dom does not synthesise; the click is that activation.
    name.focus();
    expect(document.activeElement).toBe(name);
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.click(name);
    expect(onFocusTab).toHaveBeenCalledTimes(1);
    expect(onFocusTab).toHaveBeenCalledWith("p1", "t1");
  });

  test("a mouse click anywhere on the row still focuses the tab", () => {
    const { container, onFocusTab } = mount();
    fireEvent.click(container.querySelector(".moba-agent-status"));
    expect(onFocusTab).toHaveBeenCalledTimes(1);
    expect(onFocusTab).toHaveBeenCalledWith("p1", "t1");
  });

  test("Summarize and diff still work and do not focus the tab", () => {
    const { getByTitle, onFocusTab, onSummarize, onReviewDiff } = mount();
    fireEvent.click(getByTitle("AI-summarize this session"));
    expect(onSummarize).toHaveBeenCalledWith("t1");
    fireEvent.click(getByTitle("Review diff + open PR for feat-x"));
    expect(onReviewDiff).toHaveBeenCalledWith(panels[0].tabs[0].worktree);
    expect(onFocusTab).not.toHaveBeenCalled();
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

  test("a slow mount lookup that resolves after a save's refresh does not overwrite it", async () => {
    let resolveMount = null;
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "gist_auth_available") {
        if (!resolveMount) return new Promise((r) => { resolveMount = r; });
        return Promise.resolve({ source: "pat" });
      }
      return Promise.resolve(); // secret_set
    });
    const { container, findByText, getByText } = render(<SharingSection />);
    expect(getByText("Checking…")).toBeTruthy();
    fireEvent.change(container.querySelector("input[type=password]"), { target: { value: "ghp_test" } });
    fireEvent.click(getByText("Save token"));
    expect(await findByText("Using saved token")).toBeTruthy();
    // The mount lookup started first, so its answer is older than the refresh.
    await act(async () => { resolveMount({ source: "none" }); });
    expect(getByText("Using saved token")).toBeTruthy();
  });
});

describe("LockScreen", () => {
  test("focuses the password field on mount", () => {
    const { container } = render(<LockScreen expectedHash="x" onUnlock={() => {}} />);
    const input = container.querySelector("input[type=password]");
    expect(container.ownerDocument.activeElement).toBe(input);
  });
});
