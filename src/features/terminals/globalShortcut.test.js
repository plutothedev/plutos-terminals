// (C)
// The global shortcut dispatcher's decision (TerminalsTab's capture-phase
// keydown handler), v0.7.6 audit. Confirms queue FIFO, so a held shortcut's
// auto-repeats stacked one identical confirm per repeat (Ctrl+Shift+W held on
// a tab with an unsaved remote edit). A repeat is swallowed without running,
// except for pure navigation, where holding the key to keep moving is the
// point and nothing can stack.
import { test, expect } from "vitest";
import { globalShortcutFor, resolveBindings } from "./keybindings.js";

const { byCombo } = resolveBindings(null);
const key = (k, extra = {}) => ({ key: k, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, repeat: false, ...extra });

test("a first press of a bound combo runs its action", () => {
  const hit = globalShortcutFor(key("W", { shiftKey: true }), byCombo);
  expect(hit.action.fn).toBe("closeActiveTab");
  expect(hit.run).toBe(true);
});

test("an auto-repeat of a bound combo is swallowed without running", () => {
  const hit = globalShortcutFor(key("W", { shiftKey: true, repeat: true }), byCombo);
  expect(hit.action.fn).toBe("closeActiveTab");
  expect(hit.run).toBe(false); // still a hit: the caller swallows it, so it never reaches the terminal
});

test("the palette (Reset workspace's way in) does not reopen on repeat", () => {
  expect(globalShortcutFor(key("k", { repeat: true }), byCombo).run).toBe(false);
});

test("navigation keeps repeating while held", () => {
  expect(globalShortcutFor(key("Tab", { repeat: true }), byCombo).run).toBe(true);
  expect(globalShortcutFor(key("ArrowLeft", { altKey: true, repeat: true }), byCombo).run).toBe(true);
});

test("plain typing and unbound combos are not shortcuts", () => {
  expect(globalShortcutFor({ key: "w", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, byCombo)).toBeNull();
  expect(globalShortcutFor({ key: "W", ctrlKey: false, shiftKey: true, altKey: false, metaKey: false }, byCombo)).toBeNull();
  expect(globalShortcutFor(key("F12"), byCombo)).toBeNull();
});
