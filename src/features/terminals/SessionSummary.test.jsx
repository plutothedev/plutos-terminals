// (C)
// @vitest-environment happy-dom
// The handoff gate in "Summarize session": which panes a summary may be
// pasted into, and when. The model call and the PTY bridge are stand-ins;
// the gate, the target list and the payload are the real ones.
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const writeToTab = vi.fn(() => true);
const entries = {};

vi.mock("./providers.js", async (orig) => ({
  ...(await orig()),
  resolveActiveLLM: () => ({ kind: "anthropic", baseUrl: "", apiKey: "k", model: "test-model" }),
}));
vi.mock("./llmStream.js", () => ({
  llmStream: () => ({ promise: Promise.resolve("Fixed the build.\nNext: run the tests."), cancel: () => {} }),
}));
vi.mock("./ptyBridge.js", async (orig) => ({
  ...(await orig()),
  getLiveTabIds: () => ["src", "loc", "rem"],
  writeToTab: (...a) => writeToTab(...a),
}));
vi.mock("./paneRegistry.js", async (orig) => ({
  ...(await orig()),
  getEntry: (id) => entries[id],
}));

import SessionSummary from "./SessionSummary.jsx";

const ESC = String.fromCharCode(27);
const panels = [
  {
    id: "p1",
    tabs: [
      { id: "src", label: "source" },
      { id: "loc", label: "local" },
      { id: "rem", label: "prod", connection: { host: "prod.example", user: "deploy" } },
    ],
  },
];

function pane({ state = "working", shown = "active", bracketed = true, command = "claude" } = {}) {
  return {
    agent: { runningAgent: () => (state ? { state, app: "claude-code" } : null), shown },
    term: { modes: { bracketedPasteMode: bracketed } },
    blocks: { current: command === null ? null : { command } },
  };
}

async function openOn(paneId) {
  render(<SessionSummary open text="make: ok" sourceId="src" panels={panels} onClose={() => {}} />);
  const select = await screen.findByLabelText("Pane to hand the summary to");
  fireEvent.change(select, { target: { value: paneId } });
  return select;
}

const pasteButton = () => screen.queryByRole("button", { name: /^Paste into/ });

beforeEach(() => {
  writeToTab.mockClear();
  entries.src = pane();
  entries.loc = pane();
  entries.rem = pane();
});
afterEach(cleanup);

describe("handing a summary to another pane", () => {
  test("pastes into a local agent pane as a bracketed paste, with no Enter", async () => {
    await openOn("loc");
    fireEvent.click(pasteButton());
    expect(writeToTab).toHaveBeenCalledTimes(1);
    const [id, payload] = writeToTab.mock.calls[0];
    expect(id).toBe("loc");
    expect(payload.startsWith(ESC + "[200~")).toBe(true);
    expect(payload.endsWith(ESC + "[201~")).toBe(true);
    expect(payload).not.toContain(String.fromCharCode(13));
    expect(await screen.findByText(/Pasted into local\./)).toBeTruthy();
  });

  test("a remote pane needs the person to confirm the agent is still running there", async () => {
    const select = await openOn("rem");
    const box = screen.getByRole("checkbox");
    expect(box.closest("label").textContent).toContain("deploy@prod.example");
    expect(pasteButton().disabled).toBe(true);
    fireEvent.click(pasteButton());
    expect(writeToTab).not.toHaveBeenCalled();
    fireEvent.click(box);
    expect(pasteButton().disabled).toBe(false);
    // Unticking takes the confirmation back.
    fireEvent.click(box);
    expect(pasteButton().disabled).toBe(true);
    fireEvent.click(box);
    fireEvent.click(pasteButton());
    expect(writeToTab).toHaveBeenCalledWith("rem", expect.any(String));
    // Choosing another pane and coming back asks again.
    fireEvent.change(select, { target: { value: "loc" } });
    fireEvent.change(select, { target: { value: "rem" } });
    expect(screen.getByRole("checkbox").checked).toBe(false);
    expect(pasteButton().disabled).toBe(true);
  });

  test("a local pane whose shell reported claude asks for no confirmation", async () => {
    await openOn("loc");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(pasteButton().disabled).toBe(false);
  });

  test("a local pane running ssh, or one whose shell reported nothing, needs a confirmation", async () => {
    for (const command of ["ssh deploy@prod", null]) {
      entries.loc = pane({ command });
      await openOn("loc");
      const box = screen.getByRole("checkbox");
      expect(box.closest("label").textContent).toContain("cannot see whether it quit");
      expect(pasteButton().disabled).toBe(true);
      fireEvent.click(box);
      fireEvent.click(pasteButton());
      expect(writeToTab).toHaveBeenLastCalledWith("loc", expect.any(String));
      cleanup();
    }
  });

  test("refuses a pane whose agent reports it is waiting on an answer", async () => {
    entries.loc = pane({ state: "blocked", shown: "waiting" });
    await openOn("loc");
    expect(pasteButton()).toBeNull();
    expect(screen.getByText(/waiting on an answer/)).toBeTruthy();
  });

  test("refuses a pane showing a dialog its agent did not report", async () => {
    entries.loc = pane({ state: "working", shown: "waiting" });
    await openOn("loc");
    expect(pasteButton()).toBeNull();
    expect(screen.getByText(/waiting on an answer/)).toBeTruthy();
  });

  test("refuses a pane whose program has bracketed paste off", async () => {
    entries.loc = pane({ bracketed: false });
    await openOn("loc");
    expect(pasteButton()).toBeNull();
    expect(screen.getByText(/bracketed paste is off/)).toBeTruthy();
  });

  test("lists no pane where no agent reports it is running", async () => {
    entries.loc = pane({ state: null });
    entries.rem = pane({ state: null });
    render(<SessionSummary open text="make: ok" sourceId="src" panels={panels} onClose={() => {}} />);
    expect(await screen.findByText(/open a pane running an agent/)).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByLabelText("Pane to hand the summary to")).toBeNull();
  });
});
