// (C)
// Decides whether an `input` event on xterm's helper textarea is an assistive
// insertion that xterm will otherwise drop on the floor.
//
// WHY THIS EXISTS. Wispr Flow (voice dictation) did not work inside this
// terminal, reported by a paying customer. Measured on the installed v0.7.0
// build by driving the real OS input paths against the running app and reading
// back both the DOM events and the shell's persisted scrollback:
//
//   - simulated keystrokes        -> reach the shell. WORKS.
//   - clipboard + Ctrl+V          -> reach the shell. WORKS.
//   - UI Automation ValuePattern.SetValue on the focused element
//     (the accessibility text-insertion path that dictation tools, screen
//     readers and other assistive software use)
//                                 -> SILENTLY LOST. The call succeeds and
//     reading the value back through UIA returns the inserted text, but
//     nothing ever reaches the shell.
//
// DOM listeners on .xterm-helper-textarea during a real UIA insert captured
// exactly why:
//
//   input   value="echo WISPR_DIAG3_UIA"   <- fires, inputType is null
//   change  value="echo WISPR_DIAG3_UIA"   <- fires
//   keydown key=Enter value=""             <- by now xterm has cleared it
//   keyup   key=Enter value=""
//
// So the text DOES arrive in the page, on the helper textarea, as an `input`
// event with no `beforeinput` and no `keydown`. xterm 5.5 only consumes that
// textarea on keydown/keypress and during IME composition, so it ignores the
// insertion entirely and the value is discarded on the next clear. Any
// assistive tool inserting through the accessibility layer is silently
// dropped, which makes this ours to fix rather than the tool's.
//
// THE THREE SOURCES OF AN `input` EVENT ON THAT TEXTAREA, and why only one of
// them needs forwarding:
//
//   1. IME composition (Japanese/Chinese/Korean input, and dead keys). xterm
//      subscribes to compositionstart/update/end and reads the textarea
//      itself. Forwarding would type every composed word TWICE.
//   2. A real clipboard paste. xterm handles `paste` on the textarea. Same
//      double-insert hazard.
//   3. An assistive/programmatic insertion (UIA SetValue, and anything else
//      that sets .value directly). NOBODY handles this. This is the one that
//      has to be forwarded.
//
// A keystroke is a fourth path in principle, but xterm calls preventDefault on
// keydown so no `input` event normally survives it. The watcher is defensive
// about it anyway (see BEFORE_INPUT below), because a double-typed character
// is a worse bug than a dropped dictation.
//
// KNOWN LIMITATION, deliberate: the rule below refuses every `insertText` event
// carrying data, which is broader than the set xterm actually consumes (xterm
// additionally requires screen-reader mode to be off and the event not to be a
// composed one mid-composition), so an assistive tool that inserts with
// inputType "insertText" under those narrower conditions stays unsupported;
// loosening the rule to match xterm exactly would type ordinary insertText
// events twice whenever that reading is wrong, which is the worse failure.
//
// WHY A PURE MODULE. The whole decision is event ordering plus a clock, so
// keeping it out of the pane makes it testable without a browser, an xterm or
// a PTY. No DOM globals at module scope, no app imports, injected clock.

// A trailing `input` lands right after `compositionend` (the browser fires the
// end first, then the input that commits the composed text). 150ms is well
// clear of that pair and still far below the human gap between finishing an
// IME word and dictating a separate sentence.
export const COMPOSITION_GRACE_MS = 150;

// Same shape for paste: the `paste` event precedes any `input` the browser
// might still emit for it. Cost of the slack is that a dictation insert landing
// within 150ms of a real Ctrl+V is declined; that is the right trade, because
// the failure on the other side is the pasted text going in twice.
export const PASTE_GRACE_MS = 150;

// `beforeinput` fires immediately before its own `input`, in the same task, so
// this window only has to survive a tick. It is short on purpose: a
// `beforeinput` whose `input` never arrives (xterm preventDefault'd it) must
// not be able to block a dictation insert that follows a moment later. The
// flag is also consumed by the first `input` it blocks, so one `beforeinput`
// can never suppress two insertions.
export const BEFORE_INPUT_GRACE_MS = 50;

// A ceiling on the `composing` flag. The two windows above self-heal on a
// clock; `composing` is set by compositionstart and cleared by compositionend,
// so a compositionend that never arrives (the IME is dropped, the terminal host
// is re-parented mid-composition, the pane closes mid-composition) would pin
// the flag true for the whole life of that terminal and silently refuse every
// later dictation. That is the original customer bug again, with no way out
// short of opening a new tab, so the flag gets a bound.
//
// WHY TWO MINUTES. Cutting a live composition short is the worse failure of the
// two (the composed text would be typed twice), so the limit belongs far past
// any genuine composition rather than close to it. An IME commits per phrase
// and converts every few words, so a single uncommitted composition buffer is
// alive for seconds; two minutes is more than an order of magnitude past that,
// and a buffer still open after it has been abandoned by the human or orphaned
// by the DOM. Textarea `blur` clears the flag too and covers the common orphan
// cases immediately, so this ceiling is the last-resort backstop underneath
// blur, not the path anything normally takes.
export const COMPOSITION_MAX_MS = 120_000;

// Accepts a DOM event ({target:{value}}) or a bare {value} in tests.
function valueOf(event) {
  if (!event) return "";
  const v = event.target ? event.target.value : event.value;
  return typeof v === "string" ? v : "";
}

// The signature of an `input` event xterm 5.5 consumes ITSELF, read out of its
// source (browser/Terminal.ts, _inputEvent): `ev.data && ev.inputType ===
// 'insertText'`. It handles those by calling coreService.triggerDataEvent and
// then cancel(ev) — but cancel() is a NO-OP here, because it returns early
// unless the `cancelEvents` option is on and that option defaults to false (we
// never set it). So xterm neither preventDefaults nor stopPropagations, its
// listener is capture-phase, and the very same event goes on to reach a
// bubble-phase listener like ours. Forwarding one would type the text TWICE.
// The measured UIA insert is not one of these: its inputType was null, which
// is exactly why xterm dropped it. This rule is the seam between the two.
function xtermConsumesIt(event) {
  if (!event) return false;
  return event.inputType === "insertText" && typeof event.data === "string" && event.data.length > 0;
}

export function createAssistiveInputWatcher({ now = () => Date.now() } = {}) {
  let composing = false;
  let composingSince = 0;
  let compositionEndedAt = 0;
  let pastedAt = 0;
  let beforeInputAt = 0;

  return {
    onCompositionStart() {
      composing = true;
      // Restamped per composition, so COMPOSITION_MAX_MS measures THIS one and
      // never the time since the first composition the terminal ever saw.
      composingSince = now();
    },
    onCompositionEnd() {
      composing = false;
      compositionEndedAt = now();
    },
    // The helper textarea losing focus ends any composition we could still
    // believe in: the pane closed, the host was re-parented, the user clicked
    // away. Browsers should fire compositionend first, but that is precisely
    // the event this guard cannot count on. Treated as an end rather than a
    // bare clear, so the trailing commit `input` that can land right behind a
    // blur is still covered by COMPOSITION_GRACE_MS. A blur outside a
    // composition is left alone: ordinary focus changes must not open a
    // 150ms hole in dictation.
    onBlur() {
      if (!composing) return;
      composing = false;
      compositionEndedAt = now();
    },
    onPaste() {
      pastedAt = now();
    },
    onBeforeInput() {
      beforeInputAt = now();
    },

    // true  -> xterm is going to drop this text; the pane must forward it.
    // false -> xterm already owns it (or there is nothing to send).
    shouldForward(event) {
      const t = now();

      // Consume the beforeinput flag whatever the outcome: it belongs to this
      // one insertion, and leaving it set would suppress the next one too.
      const hadBeforeInput = beforeInputAt !== 0 && t - beforeInputAt < BEFORE_INPUT_GRACE_MS;
      beforeInputAt = 0;

      // Self-heal an orphaned composition rather than refusing forever. Cleared
      // for good, not re-tested on every call, so the recovered state is the
      // same one a real compositionend would have left behind.
      if (composing && t - composingSince >= COMPOSITION_MAX_MS) composing = false;

      if (composing) return false;                                   // (1) xterm's IME path
      if (compositionEndedAt !== 0 && t - compositionEndedAt < COMPOSITION_GRACE_MS) return false;
      if (pastedAt !== 0 && t - pastedAt < PASTE_GRACE_MS) return false; // (2) xterm's paste path
      if (xtermConsumesIt(event)) return false;                      // xterm's own _inputEvent
      if (hadBeforeInput) return false;                              // a genuine user edit path
      return valueOf(event).length > 0;                              // (3) the assistive insert
    },
  };
}

// Is a modal open right now? Modal.jsx renders every modal with
// className="phn-modal-overlay" and already queries for exactly that to gate
// its own Escape handling, so this is the app's existing probe rather than a
// new convention to keep in sync.
//
// The window-focus handler in TerminalPane needs it: a modal's focused child
// can unmount (a step advances, a list row disappears) and drop focus to
// <body>, which otherwise reads as idle, and taking focus down to the terminal
// underneath a live modal is exactly the focus steal those guards exist to
// prevent. Document injected so the decision is testable without a DOM.
export function isModalOpen(doc) {
  const d = doc || (typeof document === "undefined" ? null : document);
  if (!d || typeof d.querySelector !== "function") return false;
  return d.querySelector(".phn-modal-overlay") != null;
}
