// (C)
// @vitest-environment happy-dom
// SetupChecker probes node, npm and claude each time it opens and on
// "Re-run checks", showing "checking…" until each answer lands. Pinned before
// the v0.7.6 lint pass moved the reset-to-pending out of the open effect.
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup, waitFor } from "@testing-library/react";

const { invokeMock, answers } = vi.hoisted(() => {
  const answers = { node: "v22.1.0", npm: "10.2.0", claude: null };
  const invokeMock = vi.fn(async (cmd, args) => {
    if (cmd !== "check_command_version") return null;
    const v = answers[args.name];
    if (v instanceof Error) throw v;
    return v;
  });
  return { invokeMock, answers };
});
vi.mock("@backend", () => ({ invoke: (...a) => invokeMock(...a), listen: vi.fn(async () => () => {}), isTauri: () => true }));
vi.mock("../appMeta.js", () => ({ openExternal: vi.fn() }));

import SetupChecker from "./SetupChecker.jsx";
import { ToastProvider } from "./Toast.jsx";

const probes = () => invokeMock.mock.calls.filter(([c]) => c === "check_command_version").map(([, a]) => a.name);

beforeEach(() => {
  invokeMock.mockClear();
  answers.node = "v22.1.0";
  answers.npm = "10.2.0";
  answers.claude = null;
});
afterEach(() => cleanup());

function Harness({ open }) {
  return <ToastProvider><SetupChecker open={open} onClose={() => {}} /></ToastProvider>;
}

test("opening probes all three in order and shows each answer", async () => {
  render(<Harness open />);
  await waitFor(() => expect(screen.getByText("v22.1.0")).toBeTruthy());
  await waitFor(() => expect(screen.getByText("10.2.0")).toBeTruthy());
  await waitFor(() => expect(screen.getByText("not found")).toBeTruthy());
  expect(probes()).toEqual(["node", "npm", "claude"]);
});

test("closed, it probes nothing", async () => {
  render(<Harness open={false} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(probes()).toEqual([]);
});

test("reopening resets every row to checking and probes again", async () => {
  const { rerender } = render(<Harness open />);
  await waitFor(() => expect(screen.getByText("not found")).toBeTruthy());
  rerender(<Harness open={false} />);
  answers.claude = "2.1.0";
  let release;
  const gate = new Promise((r) => { release = r; });
  invokeMock.mockImplementationOnce(async () => { await gate; return "v22.1.0"; });
  rerender(<Harness open />);
  // Before any answer lands, nothing from the last run is still on screen.
  expect(screen.getAllByText("checking…")).toHaveLength(3);
  expect(screen.queryByText("v22.1.0")).toBeNull();
  await act(async () => { release(); });
  await waitFor(() => expect(screen.getByText("2.1.0")).toBeTruthy());
  expect(probes()).toEqual(["node", "npm", "claude", "node", "npm", "claude"]);
});

// v0.7.6 lint fix round 1: probes carry a run generation, so an older run that
// answers late can never paint over a newer run's result.
test("a slow probe from an earlier run does not overwrite a Re-run's answer", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  invokeMock.mockImplementationOnce(async () => { await gate; return "v18.0.0-stale"; });
  render(<Harness open />);
  fireEvent.click(screen.getByRole("button", { name: "Re-run checks" }));
  await waitFor(() => expect(screen.getByText("v22.1.0")).toBeTruthy());
  await waitFor(() => expect(screen.getByText("not found")).toBeTruthy());
  await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
  expect(screen.queryByText("v18.0.0-stale")).toBeNull();
  expect(screen.getByText("v22.1.0")).toBeTruthy();
});

test("a slow probe from before a close does not overwrite the reopened run", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  invokeMock.mockImplementationOnce(async () => { await gate; return "v18.0.0-stale"; });
  const { rerender } = render(<Harness open />);
  rerender(<Harness open={false} />);
  rerender(<Harness open />);
  await waitFor(() => expect(screen.getByText("v22.1.0")).toBeTruthy());
  await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
  expect(screen.queryByText("v18.0.0-stale")).toBeNull();
  expect(screen.getByText("v22.1.0")).toBeTruthy();
});

test("Re-run checks resets to checking and probes again; a throw reads as not found", async () => {
  render(<Harness open />);
  await waitFor(() => expect(screen.getByText("not found")).toBeTruthy());
  answers.node = new Error("spawn failed");
  let release;
  const gate = new Promise((r) => { release = r; });
  invokeMock.mockImplementationOnce(async () => { await gate; throw new Error("spawn failed"); });
  fireEvent.click(screen.getByRole("button", { name: "Re-run checks" }));
  expect(screen.getAllByText("checking…")).toHaveLength(3);
  await act(async () => { release(); });
  await waitFor(() => expect(screen.getAllByText("not found")).toHaveLength(2));
  expect(probes()).toHaveLength(6);
});
