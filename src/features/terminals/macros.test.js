// (C)
// Locks the keystroke-macro capture: tab scoping and the memory cap added in the
// 2026-07-01 hardening pass (recordInput must not grow the buffer without bound).
import { describe, it, expect, afterEach } from "vitest";
import {
  startMacroRecording,
  stopMacroRecording,
  cancelMacroRecording,
  recordInput,
  isMacroRecording,
  previewMacro,
} from "./macros.js";

describe("previewMacro", () => {
  const ch = (n) => String.fromCharCode(n);
  it("shows CR, Tab and every ESC as symbols and other C0 controls as a dot", () => {
    const raw = "ls" + ch(13) + ch(9) + ch(27) + "[1m" + ch(27) + "[0m" + ch(1) + ch(0) + "x";
    expect(previewMacro(raw)).toBe("ls⏎⇥␛[1m␛[0m··x");
  });
  it("truncates to max with an ellipsis", () => {
    expect(previewMacro("abcdef", 3)).toBe("abc…");
  });
});

afterEach(() => cancelMacroRecording());

describe("macros capture", () => {
  it("captures only the armed tab's keystrokes", () => {
    startMacroRecording("tab-a");
    recordInput("tab-a", "ls");
    recordInput("tab-b", "SECRET"); // a different tab — must be ignored
    recordInput("tab-a", "\r");
    expect(stopMacroRecording()).toBe("ls\r");
  });

  it("null-armed tab captures any tab (back-compat)", () => {
    startMacroRecording(null);
    recordInput("whatever", "x");
    expect(stopMacroRecording()).toBe("x");
  });

  it("caps the buffer so a runaway recording can't grow unbounded", () => {
    startMacroRecording("t");
    const cap = 256 * 1024;
    // Push well past the cap in chunks; the buffer must stop at exactly the cap.
    for (let i = 0; i < 40; i++) recordInput("t", "a".repeat(10 * 1024));
    const out = stopMacroRecording();
    expect(out.length).toBe(cap);
  });

  it("stop/cancel reset recording state", () => {
    startMacroRecording("t");
    expect(isMacroRecording()).toBe(true);
    stopMacroRecording();
    expect(isMacroRecording()).toBe(false);
  });
});
