// @vitest-environment happy-dom
// (C)
import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/xterm";
import { clipboardKeyAction, rightClickAction } from "./clipboardKeys.js";

const key = (k, mods = {}, extra = {}) => ({
  type: "keydown", key: k, code: `Key${k.toUpperCase()}`,
  ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
  ...mods, ...extra,
});
const win = { isMac: false };
const mac = { isMac: true };

describe("clipboardKeyAction", () => {
  it("Ctrl+C copies when text is selected on Windows/Linux", () => {
    expect(clipboardKeyAction(key("c", { ctrlKey: true }), { ...win, hasSelection: true })).toBe("copy");
  });
  it("Ctrl+C with no selection stays ^C", () => {
    expect(clipboardKeyAction(key("c", { ctrlKey: true }), { ...win, hasSelection: false })).toBe(null);
  });
  it("Ctrl+C on macOS is always ^C (Cmd+C copies there)", () => {
    expect(clipboardKeyAction(key("c", { ctrlKey: true }), { ...mac, hasSelection: true })).toBe(null);
  });
  it("Ctrl+Shift+C copies and Ctrl+Shift+V pastes, selection or not", () => {
    expect(clipboardKeyAction(key("C", { ctrlKey: true, shiftKey: true }), { ...win, hasSelection: false })).toBe("copy");
    expect(clipboardKeyAction(key("V", { ctrlKey: true, shiftKey: true }), { ...win, hasSelection: false })).toBe("paste");
    expect(clipboardKeyAction(key("V", { ctrlKey: true, shiftKey: true }), { ...mac, hasSelection: false })).toBe("paste");
  });
  it("leaves plain Ctrl+V, AltGr, Cmd and keyup to xterm", () => {
    expect(clipboardKeyAction(key("v", { ctrlKey: true }), { ...win, hasSelection: true })).toBe(null);
    expect(clipboardKeyAction(key("c", { ctrlKey: true, altKey: true }), { ...win, hasSelection: true })).toBe(null);
    expect(clipboardKeyAction(key("c", { ctrlKey: true, metaKey: true }), { ...win, hasSelection: true })).toBe(null);
    expect(clipboardKeyAction({ ...key("c", { ctrlKey: true }), type: "keyup" }, { ...win, hasSelection: true })).toBe(null);
    expect(clipboardKeyAction(key("x", { ctrlKey: true }), { ...win, hasSelection: true })).toBe(null);
  });
  it("matches the physical C key on a non-Latin layout", () => {
    expect(clipboardKeyAction(key("с", { ctrlKey: true }, { code: "KeyC" }), { ...win, hasSelection: true })).toBe("copy");
  });
});

describe("rightClickAction", () => {
  it("copies a selection, otherwise pastes", () => {
    expect(rightClickAction({ hasSelection: true })).toBe("copy");
    expect(rightClickAction({ hasSelection: false })).toBe("paste");
  });
});

// The wiring TerminalPane relies on, against the real xterm: a custom key
// handler that returns false keeps ^C from reaching the PTY.
describe("xterm with the copy handler attached", () => {
  const setup = async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ allowProposedApi: true });
    term.open(host);
    await new Promise((r) => term.write("hello world", r));
    const sent = [];
    term.onData((d) => sent.push(d));
    let copied = null;
    term.attachCustomKeyEventHandler((ev) => {
      if (clipboardKeyAction(ev, { hasSelection: term.hasSelection(), isMac: false }) === "copy") {
        ev.preventDefault();
        copied = term.getSelection();
        term.clearSelection();
        return false;
      }
      return true;
    });
    const press = () => {
      const ev = new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(ev, "keyCode", { value: 67 }); // xterm maps keys by keyCode
      term.textarea.dispatchEvent(ev);
    };
    return { term, sent, press, copied: () => copied };
  };

  it("Ctrl+C with a selection copies it and sends nothing to the shell", async () => {
    const { term, sent, press, copied } = await setup();
    term.select(0, 0, 5);
    press();
    expect(copied()).toBe("hello");
    expect(sent).toEqual([]);
    expect(term.hasSelection()).toBe(false);
    term.dispose();
  });

  it("Ctrl+C with no selection still sends ^C", async () => {
    const { term, sent, press } = await setup();
    press();
    expect(sent).toEqual([String.fromCharCode(3)]);
    term.dispose();
  });
});
