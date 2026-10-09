// (C)
// @vitest-environment happy-dom
// The saves that used to hand App a copy of the rendered user state, now
// updaters over the live state (saveUserUpdaters.test.js forbids the old
// shape). Each is run here against a state that has moved on since the last
// render: a key that reached App (the launch load, another window) and, for
// the list-shaped settings, an entry another window added. The save must keep
// both, and still do its own job.
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { useState } from "react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@backend", () => ({
  invoke: (...args) => invokeMock(...args),
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));

import KeybindingsSection from "./KeybindingsSection.jsx";
import ThemesSection from "./ThemesSection.jsx";
import { useWorkspaces } from "./hooks/useWorkspaces.js";
import { ToastProvider } from "../../components/Toast.jsx";
import { ConfirmProvider } from "../../components/ConfirmModal.jsx";

// User state held the way App holds it: a live ref every updater reads (App's
// userStRef), and the copy the component last rendered. `moveOn` changes the
// live state without a re-render, the moment App's ref is ahead of React.
function renderWithUserState(initial, ui) {
  const live = { current: initial };
  const saves = [];
  function Host() {
    const [userSt, setUserSt] = useState(initial);
    const saveUser = (next) => {
      const resolved = typeof next === "function" ? next(live.current) : next;
      saves.push(resolved);
      live.current = resolved;
      setUserSt(resolved);
    };
    return (
      <ToastProvider>
        <ConfirmProvider>{ui({ userSt, saveUser })}</ConfirmProvider>
      </ToastProvider>
    );
  }
  render(<Host />);
  return {
    saves,
    live,
    moveOn(change) {
      live.current = { ...live.current, ...change(live.current) };
    },
  };
}

const KEYS = { anthropic: "A-KEY" };
const ARRIVED = { anthropic: "A-KEY", moonshot: "M-KEY" };
const arrived = () => ({ providerKeys: ARRIVED });

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockClear();
});
afterEach(cleanup);

describe("Keybindings", () => {
  const row = (label) => screen.getByText(label).parentElement;

  test("disabling a shortcut keeps a key that arrived, and another shortcut set elsewhere", () => {
    const h = renderWithUserState({ providerKeys: KEYS, keybindings: {} }, (p) => <KeybindingsSection {...p} />);
    h.moveOn((u) => ({ ...arrived(u), keybindings: { history: "Ctrl+Shift+H" } }));
    fireEvent.click(within(row("Command palette")).getByTitle("Unbind this shortcut"));
    expect(h.saves.at(-1)).toEqual({ providerKeys: ARRIVED, keybindings: { history: "Ctrl+Shift+H", commandPalette: null } });
  });

  test("resetting a shortcut removes only that override", () => {
    const h = renderWithUserState(
      { providerKeys: KEYS, keybindings: { commandPalette: "Ctrl+Shift+P", find: "Ctrl+Shift+F" } },
      (p) => <KeybindingsSection {...p} />,
    );
    h.moveOn(arrived);
    fireEvent.click(within(row("Command palette")).getByTitle(/^Reset to default/));
    // Strict: a reset deletes the override, rather than leaving it undefined
    // (the summon row checks for the key itself).
    expect(h.saves.at(-1)).toStrictEqual({ providerKeys: ARRIVED, keybindings: { find: "Ctrl+Shift+F" } });
  });

  test("the summon hotkey: disable, then reset, each over the live state", () => {
    const h = renderWithUserState({ providerKeys: KEYS, keybindings: { summon: "Ctrl+Alt+P" } }, (p) => <KeybindingsSection {...p} />);
    h.moveOn(arrived);
    fireEvent.click(screen.getByTitle("Unbind the summon hotkey"));
    expect(h.saves.at(-1)).toEqual({ providerKeys: ARRIVED, keybindings: { summon: null } });
    expect(invokeMock).toHaveBeenCalledWith("set_summon_shortcut", { combo: "" });
    const summonRow = screen.getByTitle("Unbind the summon hotkey").parentElement;
    fireEvent.click(within(summonRow).getByTitle(/^Reset to default/));
    expect(h.saves.at(-1)).toStrictEqual({ providerKeys: ARRIVED, keybindings: {} });
  });
});

describe("Themes", () => {
  const themes = (p) => <ThemesSection st={{ headerSkin: "oled" }} save={() => {}} {...p} />;

  test("following the OS keeps a key that arrived", () => {
    const h = renderWithUserState({ providerKeys: KEYS }, themes);
    h.moveOn(arrived);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(h.saves.at(-1)).toEqual({ providerKeys: ARRIVED, themeFollowOS: true });
  });

  test("choosing the dark-mode skin keeps a key that arrived", () => {
    const h = renderWithUserState({ providerKeys: KEYS, themeFollowOS: true }, themes);
    h.moveOn(arrived);
    const select = screen.getByText("When OS is dark").querySelector("select");
    fireEvent.change(select, { target: { value: "moba-light" } });
    expect(h.saves.at(-1)).toEqual({ providerKeys: ARRIVED, themeFollowOS: true, themeDark: "moba-light" });
  });

  test("importing a theme adds it to the live list, keeps the key, and turns OS sync off", () => {
    const mine = { id: "t-mine", name: "Mine" };
    const theirs = { id: "t-theirs", name: "Theirs" };
    const h = renderWithUserState({ providerKeys: KEYS, customThemes: [mine], themeFollowOS: true }, themes);
    h.moveOn((u) => ({ ...arrived(u), customThemes: [mine, theirs] }));
    fireEvent.click(screen.getByText("Load example (Dracula)"));
    fireEvent.click(screen.getByText("Import & apply"));
    const saved = h.saves.at(-1);
    expect(saved.providerKeys).toEqual(ARRIVED);
    expect(saved.themeFollowOS).toBe(false);
    expect(saved.customThemes.slice(0, 2)).toEqual([mine, theirs]);
    expect(saved.customThemes.length).toBeGreaterThan(2);
  });

  test("applying a custom theme while following the OS turns sync off and keeps the key", () => {
    const mine = { id: "t-mine", name: "Mine", colors: {} };
    const h = renderWithUserState({ providerKeys: KEYS, customThemes: [mine], themeFollowOS: true }, themes);
    h.moveOn(arrived);
    fireEvent.click(screen.getByText("Apply"));
    expect(h.saves.at(-1)).toEqual({ providerKeys: ARRIVED, customThemes: [mine], themeFollowOS: false });
  });
});

describe("Workspaces", () => {
  function Probe({ userSt, saveUser, api }) {
    const toast = { success: () => {}, error: () => {} };
    api.current = useWorkspaces({ state: { panels: [{ id: "p1" }], activePanelId: "p1" }, persist: () => {}, userSt, saveUser, toast });
    return null;
  }
  const ws = (name) => ({ name, panels: [], activePanelId: null, savedAt: 1 });

  test("saving replaces the named workspace in the live list and keeps the key", () => {
    const api = { current: null };
    const h = renderWithUserState({ providerKeys: KEYS, workspaces: [ws("a")] }, (p) => <Probe {...p} api={api} />);
    h.moveOn((u) => ({ ...arrived(u), workspaces: [ws("a"), ws("b")] }));
    act(() => api.current.saveWorkspace("a"));
    const saved = h.saves.at(-1);
    expect(saved.providerKeys).toEqual(ARRIVED);
    expect(saved.workspaces.map((w) => w.name)).toEqual(["b", "a"]);
    expect(saved.workspaces[1].panels).toEqual([{ id: "p1" }]);
  });

  test("deleting removes only the named workspace from the live list and keeps the key", () => {
    const api = { current: null };
    const h = renderWithUserState({ providerKeys: KEYS, workspaces: [ws("a")] }, (p) => <Probe {...p} api={api} />);
    h.moveOn((u) => ({ ...arrived(u), workspaces: [ws("a"), ws("b")] }));
    act(() => api.current.deleteWorkspace("a"));
    expect(h.saves.at(-1)).toEqual({ providerKeys: ARRIVED, workspaces: [ws("b")] });
  });
});
