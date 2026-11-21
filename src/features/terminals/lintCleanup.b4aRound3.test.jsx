// (C)
// @vitest-environment happy-dom
// v0.7.6 lint cleanup, batch B4a, review fix round 3. Each describe pins one
// review item; each test marked RED was run against the code before its fix
// and failed there (the batch report holds the red/green lines).
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, renderHook, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));
// No Monaco under happy-dom: the editor falls back to its plain textarea.
vi.mock("./monacoSetup.js", () => { throw new Error("no monaco in tests"); });
// ModalHost always renders AgentMode; a stub keeps that subsystem out.
vi.mock("./AgentMode", () => ({ default: () => null }));

import { ToastProvider } from "../../components/Toast.jsx";
import { ConfirmProvider } from "../../components/ConfirmModal.jsx";
import RemoteEditor from "./RemoteEditor.jsx";
import ProjectDialog from "./ProjectDialog.jsx";
import ModalHost from "./chrome/ModalHost.jsx";
import { useProjects } from "./hooks/useProjects.js";

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
const closeBtn = () => screen.getAllByRole("button", { name: "Close dialog" })[0];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});
afterEach(cleanup);

const hostBase = {
  userSt: { terminalsOnboarded: true },
  projects: [],
  panels: [],
  workspaces: [],
  paletteCommands: [],
};

// ── Item 1: saving an edit whose session vanished adds it, never drops it ──
describe("upsertProject: the edited session is gone", () => {
  const state = { activePanelId: "p1", panels: [], projects: [] };
  const mkToast = () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() });

  function setup(projects) {
    const persist = vi.fn();
    const toast = mkToast();
    const { result } = renderHook(() =>
      useProjects({ state: { ...state, projects }, persist, projects, toast, selectRibbonRef: { current: () => {} } })
    );
    return { persist, toast, upsertProject: result.current.upsertProject };
  }

  test("RED: an unknown editing id adds the session under a new id and returns that id", () => {
    const other = { id: "proj_other", name: "other", color: "red" };
    const { persist, upsertProject } = setup([other]);
    let id;
    act(() => { id = upsertProject({ type: "local", name: "typed", path: "/t" }, "proj_gone"); });
    expect(persist).toHaveBeenCalledTimes(1);
    const next = persist.mock.calls[0][0].projects;
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(other);
    expect(next[1]).toMatchObject({ type: "local", name: "typed", path: "/t", color: null });
    expect(next[1].id).toBe(id);
    expect(id).toBeTruthy();
    expect(id).not.toBe("proj_gone");
    // Same shape as a plain Add (id from freshId("proj"), color null, data).
    let addId;
    act(() => { addId = upsertProject({ type: "local", name: "added" }, null); });
    expect(Object.keys(persist.mock.calls[1][0].projects[1]).sort())
      .toEqual(Object.keys({ id: addId, color: null, type: "local", name: "added" }).sort());
    expect(id.split("_")[0]).toBe(addId.split("_")[0]);
  });

  test("RED: the user is told the edit was saved as a new session", () => {
    const { toast, upsertProject } = setup([]);
    act(() => { upsertProject({ type: "local", name: "typed" }, "proj_gone"); });
    expect(toast.info).toHaveBeenCalledWith("That session was removed elsewhere; saved as a new session.");
  });

  test("control: an edit of a session that still exists edits it in place, no toast", () => {
    const a = { id: "proj_a", name: "a", color: "blue", path: "/a" };
    const { persist, toast, upsertProject } = setup([a]);
    let id;
    act(() => { id = upsertProject({ name: "a2" }, "proj_a"); });
    expect(id).toBe("proj_a");
    expect(persist.mock.calls[0][0].projects).toEqual([{ ...a, name: "a2" }]);
    expect(toast.info).not.toHaveBeenCalled();
  });
});

// ── Item 2: the Servers-button preset is an Add, not an Edit ───────────────
describe("ProjectDialog: a type preset is not an edit", () => {
  test("RED: initial { type: 'ssh' } shows ADD SESSION and an Add button", () => {
    render(<ProjectDialog open dialogKey="add:ssh" initial={{ type: "ssh" }} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "ADD SESSION" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  test("RED: through ModalHost, the SSH preset opens as Add", () => {
    const props = { ...hostBase, setDialog: () => {}, handleSaveDialog: () => {} };
    render(wrap(<ModalHost {...props} dialog={{ mode: "add", initialType: "ssh" }} dialogInitial={{ type: "ssh" }} />));
    expect(screen.getByRole("dialog", { name: "ADD SESSION" })).toBeTruthy();
  });

  test("control: a real edit (initial with an id) still says EDIT SESSION and Save", () => {
    const a = { id: "a", type: "ssh", name: "box", connection: { host: "h", port: 22, user: "u" } };
    render(<ProjectDialog open dialogKey="edit:a" initial={a} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "EDIT SESSION" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  test("control: the preset still seeds the SSH type", () => {
    render(<ProjectDialog open dialogKey="add:ssh" initial={{ type: "ssh" }} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByDisplayValue("22")).toBeTruthy();
  });
});

// ── Item 3: close during a covering save waits for it ──────────────────────
describe("RemoteEditor: close while the covering save is in flight", () => {
  function setupEditor() {
    const write = deferred();
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "sftp_read_file") return "orig";
      if (cmd === "sftp_write_file") return write.promise;
      return undefined;
    });
    const onClose = vi.fn();
    render(wrap(<RemoteEditor open sessionId="s" path="/a" name="a" onClose={onClose} />));
    return { write, onClose };
  }

  test("RED: the save then fails -> the editor stays open with the text", async () => {
    const { write, onClose } = setupEditor();
    await waitFor(() => expect(textarea()?.value).toBe("orig"));
    fireEvent.change(textarea(), { target: { value: "v1" } });
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    expect(writes()).toHaveLength(1);
    await act(async () => { fireEvent.click(closeBtn()); });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { write.reject(new Error("disk full")); });
    expect(onClose).not.toHaveBeenCalled();
    expect(textarea()?.value).toBe("v1");
    // The failed-save path: the next close asks before discarding.
    await act(async () => { fireEvent.click(closeBtn()); });
    expect(await screen.findByText(/has unsaved changes/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("the save then succeeds -> closes once, without asking", async () => {
    const { write, onClose } = setupEditor();
    await waitFor(() => expect(textarea()?.value).toBe("orig"));
    fireEvent.change(textarea(), { target: { value: "v1" } });
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    await act(async () => { fireEvent.click(closeBtn()); });
    await act(async () => { write.resolve(undefined); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/has unsaved changes/)).toBeNull();
  });

  test("edits typed while the close waits are not dropped silently", async () => {
    const { write, onClose } = setupEditor();
    await waitFor(() => expect(textarea()?.value).toBe("orig"));
    fireEvent.change(textarea(), { target: { value: "v1" } });
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    await act(async () => { fireEvent.click(closeBtn()); });
    fireEvent.change(textarea(), { target: { value: "v2" } });
    await act(async () => { write.resolve(undefined); });
    expect(await screen.findByText(/has unsaved changes/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("the Save button shows Saving… while the close waits", async () => {
    const { write } = setupEditor();
    await waitFor(() => expect(textarea()?.value).toBe("orig"));
    fireEvent.change(textarea(), { target: { value: "v1" } });
    await act(async () => { fireEvent.keyDown(window, { key: "s", ctrlKey: true }); });
    await act(async () => { fireEvent.click(closeBtn()); });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();
    await act(async () => { write.resolve(undefined); });
  });
});
