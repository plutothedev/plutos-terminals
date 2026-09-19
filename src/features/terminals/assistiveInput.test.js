// (C)
// Tests for the assistive-insertion watcher (Wispr Flow / dictation / screen
// readers) and for its wiring into TerminalPane.
//
// The bug these lock down, measured on the installed v0.7.0 build by driving
// the real OS input paths at the running app: a UI Automation
// ValuePattern.SetValue on the focused element lands the text on xterm's
// helper textarea as an `input` event with NO `beforeinput` and NO `keydown`,
// and xterm 5.5 — which only reads that textarea on keydown/keypress and
// during IME composition — discards it. Keystrokes and Ctrl+V both reached the
// shell; the accessibility insertion path was silently lost.
//
// The watcher is pure so the decision is testable without a browser: the whole
// question is "is this `input` event one xterm already handled, or one it is
// about to drop", and that is answerable from event ordering plus a clock.
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createAssistiveInputWatcher,
  isModalOpen,
  COMPOSITION_GRACE_MS,
  COMPOSITION_MAX_MS,
  PASTE_GRACE_MS,
  BEFORE_INPUT_GRACE_MS,
} from "./assistiveInput.js";

// A fake clock, so the grace windows are asserted rather than slept through.
function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const ev = (value) => ({ target: { value } });

describe("createAssistiveInputWatcher", () => {
  test("forwards a bare assistive insert (no composition, no paste, no beforeinput)", () => {
    const w = createAssistiveInputWatcher();
    expect(w.shouldForward(ev("echo WISPR_DIAG3_UIA"))).toBe(true);
  });

  test("refuses an insert while an IME composition is open (xterm owns it)", () => {
    const w = createAssistiveInputWatcher();
    w.onCompositionStart();
    expect(w.shouldForward(ev("にほんご"))).toBe(false);
  });

  test("refuses the trailing input that arrives right after compositionend", () => {
    const clock = fakeClock();
    const w = createAssistiveInputWatcher({ now: clock.now });
    w.onCompositionStart();
    w.onCompositionEnd();
    clock.advance(1); // the trailing `input` lands on the very next tick
    expect(w.shouldForward(ev("にほんご"))).toBe(false);
  });

  test("refuses an insert inside the grace window after a real paste (xterm owns it)", () => {
    const clock = fakeClock();
    const w = createAssistiveInputWatcher({ now: clock.now });
    w.onPaste();
    clock.advance(1);
    expect(w.shouldForward(ev("pasted text"))).toBe(false);
  });

  test("refuses an insert preceded by beforeinput (a genuine user edit path)", () => {
    const clock = fakeClock();
    const w = createAssistiveInputWatcher({ now: clock.now });
    w.onBeforeInput();
    expect(w.shouldForward(ev("typed"))).toBe(false);
  });

  test("refuses an empty value", () => {
    const w = createAssistiveInputWatcher();
    expect(w.shouldForward(ev(""))).toBe(false);
    expect(w.shouldForward({ target: {} })).toBe(false);
    expect(w.shouldForward(undefined)).toBe(false);
  });

  test("the composition grace window expires, so a later dictation insert forwards", () => {
    const clock = fakeClock();
    const w = createAssistiveInputWatcher({ now: clock.now });
    w.onCompositionStart();
    w.onCompositionEnd();
    clock.advance(COMPOSITION_GRACE_MS + 1);
    expect(w.shouldForward(ev("echo later"))).toBe(true);
  });

  test("the paste grace window expires, so a later dictation insert forwards", () => {
    const clock = fakeClock();
    const w = createAssistiveInputWatcher({ now: clock.now });
    w.onPaste();
    clock.advance(PASTE_GRACE_MS + 1);
    expect(w.shouldForward(ev("echo later"))).toBe(true);
  });

  test("a beforeinput with no input behind it cannot wedge the next insert", () => {
    const clock = fakeClock();
    const w = createAssistiveInputWatcher({ now: clock.now });
    w.onBeforeInput(); // xterm preventDefault'd the keydown, no `input` follows
    clock.advance(BEFORE_INPUT_GRACE_MS + 1);
    expect(w.shouldForward(ev("echo later"))).toBe(true);
  });

  test("one beforeinput covers only one input event", () => {
    const w = createAssistiveInputWatcher();
    w.onBeforeInput();
    expect(w.shouldForward(ev("typed"))).toBe(false); // consumed here
    expect(w.shouldForward(ev("dictated"))).toBe(true);
  });

  // The composition flag is the one guard with no clock of its own: a
  // compositionend that never arrives used to pin it true for the life of the
  // terminal, which is the original dropped-dictation bug with no way out.
  test("an orphaned composition expires instead of refusing dictation forever", () => {
    const clock = fakeClock();
    const w = createAssistiveInputWatcher({ now: clock.now });
    w.onCompositionStart(); // compositionend never arrives
    clock.advance(COMPOSITION_MAX_MS - 1);
    expect(w.shouldForward(ev("echo still blocked"))).toBe(false);
    clock.advance(2);
    expect(w.shouldForward(ev("echo unblocked"))).toBe(true);
  });

  test("an expired composition stays cleared, it is not re-tested per call", () => {
    const clock = fakeClock();
    const w = createAssistiveInputWatcher({ now: clock.now });
    w.onCompositionStart();
    clock.advance(COMPOSITION_MAX_MS + 1);
    expect(w.shouldForward(ev("first"))).toBe(true);
    expect(w.shouldForward(ev("second"))).toBe(true); // clock has not moved
  });

  test("the ceiling measures one composition, so a live IME is never cut short", () => {
    const clock = fakeClock();
    const w = createAssistiveInputWatcher({ now: clock.now });
    w.onCompositionStart();
    clock.advance(COMPOSITION_MAX_MS - 1);
    w.onCompositionEnd();
    clock.advance(COMPOSITION_GRACE_MS + 1);
    w.onCompositionStart(); // a second composition, freshly stamped
    clock.advance(COMPOSITION_MAX_MS - 1);
    expect(w.shouldForward(ev("にほんご"))).toBe(false);
  });

  test("blur clears a composition the IME never ended, behind the trailing-input grace", () => {
    const clock = fakeClock();
    const w = createAssistiveInputWatcher({ now: clock.now });
    w.onCompositionStart();
    w.onBlur();
    clock.advance(1);
    // A commit `input` can still land right behind the blur; xterm owns it.
    expect(w.shouldForward(ev("にほんご"))).toBe(false);
    clock.advance(COMPOSITION_GRACE_MS);
    expect(w.shouldForward(ev("echo after blur"))).toBe(true);
  });

  test("a blur outside a composition does not open a hole in dictation", () => {
    const clock = fakeClock();
    const w = createAssistiveInputWatcher({ now: clock.now });
    w.onBlur();
    clock.advance(1);
    expect(w.shouldForward(ev("echo hi"))).toBe(true);
  });

  test("composition reopening after an end re-blocks", () => {
    const clock = fakeClock();
    const w = createAssistiveInputWatcher({ now: clock.now });
    w.onCompositionStart();
    w.onCompositionEnd();
    clock.advance(COMPOSITION_GRACE_MS + 1);
    w.onCompositionStart();
    expect(w.shouldForward(ev("にほ"))).toBe(false);
  });

  test("reads a bare {value} shape as well as a DOM event's target", () => {
    const w = createAssistiveInputWatcher();
    expect(w.shouldForward({ value: "echo hi" })).toBe(true);
  });

  // xterm 5.5 registers its OWN capture-phase `input` listener and consumes
  // events whose inputType is "insertText" with data. Its cancel() is a no-op
  // because the cancelEvents option defaults to false, so such an event still
  // propagates to our listener: forwarding it would send the text twice.
  test("refuses an input event xterm consumes itself (insertText with data)", () => {
    const w = createAssistiveInputWatcher();
    expect(w.shouldForward({ inputType: "insertText", data: "a", target: { value: "a" } })).toBe(false);
  });

  test("forwards the measured UIA signature (no inputType, no data)", () => {
    const w = createAssistiveInputWatcher();
    const measured = { inputType: null, data: null, target: { value: "echo WISPR_DIAG3_UIA" } };
    expect(w.shouldForward(measured)).toBe(true);
  });

  test("forwards an insertion whose inputType xterm does not consume", () => {
    const w = createAssistiveInputWatcher();
    expect(w.shouldForward({ inputType: "insertFromPaste", data: "x", target: { value: "x" } })).toBe(true);
  });
});

// The modal probe the window-focus handler leans on. Pure and document-injected
// precisely so this is a behavior test and not another source grep.
describe("isModalOpen", () => {
  const docWith = (selectors) => ({
    querySelector: (sel) => (selectors.includes(sel) ? { nodeType: 1 } : null),
  });

  test("true when Modal.jsx's overlay is in the document", () => {
    expect(isModalOpen(docWith([".phn-modal-overlay"]))).toBe(true);
  });

  test("false when no overlay is mounted", () => {
    expect(isModalOpen(docWith([]))).toBe(false);
  });

  test("reads the same class Modal.jsx renders, not some near-miss", () => {
    expect(isModalOpen(docWith([".modal-overlay", ".phn-modal"]))).toBe(false);
  });

  test("false rather than throwing with no usable document", () => {
    expect(isModalOpen({})).toBe(false);
    expect(isModalOpen()).toBe(false); // node env: no global document
  });
});

// Wiring guard. The watcher is worthless if the pane stops calling it, and a
// pane-level behavior test would need a real xterm + PTY, so read the shipped
// source the way releaseWorkflow.test.js and agentTools.test.js do.
//
// HOW THESE GO VACUOUS, learned the hard way by mutation: an unbounded slice
// lets something OTHER than the code under test satisfy the pattern. Two did.
// A prose comment above the focus handler contains the literal
// "shouldPaneTakeFocus()", so deleting the real guard left that test green; and
// the unrelated pasteFromClipboard helper contains its own `t.paste(text)`, so
// rewriting the dictation forward as `t.write(text)` left that one green too.
// Every slice below is therefore bounded to a single function body, and the
// assertions are whole statements rather than bare call text.
describe("TerminalPane wiring", () => {
  const SRC = readFileSync(fileURLToPath(new URL("./TerminalPane.jsx", import.meta.url)), "utf8");

  // Slice between two anchors, failing loudly if either anchor moved rather
  // than silently searching the wrong (or the whole) file.
  function between(startNeedle, endNeedle) {
    const start = SRC.indexOf(startNeedle);
    expect(start, `anchor not found in TerminalPane.jsx: ${startNeedle}`).toBeGreaterThan(-1);
    const end = SRC.indexOf(endNeedle, start + startNeedle.length);
    expect(end, `anchor not found in TerminalPane.jsx: ${endNeedle}`).toBeGreaterThan(-1);
    return SRC.slice(start, end + endNeedle.length);
  }

  // The listener registrations, bounded to attachAssistiveInput's body.
  const listeners = () => between("function attachAssistiveInput", "registerDestroyHook(paneId");

  test("imports the watcher", () => {
    expect(SRC).toMatch(/import\s*\{[^}]*createAssistiveInputWatcher[^}]*\}\s*from\s*"\.\/assistiveInput\.js"/);
  });

  test("listens for input on the helper textarea and cleans the listener up", () => {
    expect(SRC).toMatch(/addEventListener\("input"/);
    expect(SRC).toMatch(/removeEventListener\("input"/);
    expect(SRC).toMatch(/xterm-helper-textarea/);
  });

  test("tracks every event that means xterm already owns the insertion", () => {
    const src = listeners();
    for (const name of ["compositionstart", "compositionend", "paste", "beforeinput"]) {
      expect(src).toMatch(new RegExp(`ta\\.addEventListener\\("${name}"`));
    }
  });

  // Finding 1's fast self-heal: without this the composition guard only
  // recovers on the two-minute ceiling.
  test("clears the composition guard when the textarea loses focus", () => {
    expect(listeners()).toMatch(/ta\.addEventListener\("blur", onBlur\)/);
    expect(SRC).toMatch(/const onBlur = \(\) => watcher\.onBlur\(\);/);
    expect(SRC).toMatch(/ta\.removeEventListener\("blur", onBlur\)/);
  });

  test("forwards through term.paste so bracketed-paste mode is honored", () => {
    const forwarding = listeners();
    expect(forwarding).toMatch(/if \(!watcher\.shouldForward\(ev\)\) return;/);
    // The exact statement. `.paste(` alone is satisfied by pasteFromClipboard
    // further down the file, which is how this went vacuous.
    expect(forwarding).toMatch(/t\.paste\(text\);/);
  });

  // Part 2: the window-focus handler that puts a real text field under the
  // dictation tool at boot. The guards are the whole safety story: a refactor
  // that drops one turns a fix into a focus thief.
  test("refocuses the terminal on window focus, behind its guards", () => {
    const handler = between(
      "const onWindowFocus = () => {",
      'window.removeEventListener("focus", onWindowFocus)',
    );
    expect(handler).toMatch(/window\.addEventListener\("focus", onWindowFocus\)/);
    expect(handler).toMatch(/window\.removeEventListener\("focus", onWindowFocus\)/);
    // Whole statements. The bare call text /shouldPaneTakeFocus\(\)/ was
    // satisfied by the prose comment above the handler.
    expect(handler).toMatch(/if \(!activeRef\.current \|\| !visibleRef\.current\) return;/);
    expect(handler).toMatch(/if \(!shouldPaneTakeFocus\(\)\) return;/); // tab-strip guard
    expect(handler).toMatch(/const el = document\.activeElement;/);     // idle-focus only
    expect(handler).toMatch(/!isModalOpen\(\) &&/);                     // never under a modal
    expect(handler).toMatch(/if \(!idle\) return;/);
  });
});
