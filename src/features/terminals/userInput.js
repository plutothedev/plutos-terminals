// (C)
// Telling a person's input from xterm's own answers to a program. Both arrive
// through onData. xterm 5.5 fires its internal coreService.onUserInput just
// before onData for keys, paste, IME and mouse, and never for its replies
// (device attributes, mode, cursor, color, status and focus reports), so a
// mark set by that signal says whose the next onData is. It is private API:
// xtermInput.test.js pins it against the real xterm.
//
// watchUserInput(term) -> { classifies, take(fallbackIsReply) }. Call take()
// first in every onData: it says whether that data is the person's, and
// clears the mark so it can never carry over to the next onData. When the
// signal is missing (an xterm that moved it), `fallbackIsReply` decides: the
// caller's own guess from the queries it saw the program send.
export function watchUserInput(term) {
  const signal = term?._core?.coreService?.onUserInput;
  const classifies = typeof signal === "function";
  let marked = false;
  if (classifies) {
    signal(() => {
      marked = true;
    });
  }
  return {
    classifies,
    take(fallbackIsReply) {
      const fromUser = classifies ? marked : !fallbackIsReply;
      marked = false;
      return fromUser;
    },
  };
}

// A mouse report xterm sends through onData once a program turns mouse
// tracking on: SGR (CSI < b;x;y M or m) or urxvt (CSI b;x;y M), one or
// several in a row. (The default X10 encoding goes to onBinary, not onData.)
const ESC = String.fromCharCode(27);
const MOUSE_REPORT = new RegExp("^(?:" + ESC + "[[](?:<[0-9]+;[0-9]+;[0-9]+[Mm]|[0-9]+;[0-9]+;[0-9]+M))+$");
const SGR_REPORT = new RegExp(ESC + "[[]<([0-9]+);[0-9]+;[0-9]+([Mm])", "g");
const URXVT_REPORT = new RegExp(ESC + "[[]([0-9]+);[0-9]+;[0-9]+M", "g");

export function isMouseReport(data) {
  return typeof data === "string" && MOUSE_REPORT.test(data);
}

// Whether mouse reports hold a button press: not a release, not motion
// (button bit 32) and not the wheel (bit 64). A click can answer a dialog.
export function isMouseClick(data) {
  if (!isMouseReport(data)) return false;
  for (const m of data.matchAll(SGR_REPORT)) {
    if (m[2] === "M" && (Number(m[1]) & 96) === 0) return true;
  }
  for (const m of data.matchAll(URXVT_REPORT)) {
    const b = Number(m[1]) - 32;
    if (b >= 0 && (b & 96) === 0 && (b & 3) !== 3) return true;
  }
  return false;
}

// What one onData is, and so where it goes:
// - "reply": xterm answering a program. Its own pane only; not typing.
// - "click": a mouse press. Its own pane only; not typing, so the resume hold
//   stays, but it can answer a dialog, so a matched prompt is dropped.
// - "mouse": any other mouse report. Its own pane only; nothing else.
// - "user": typing, paste or IME. Broadcast when on, recorded, typing.
export function inputKind(data, fromUser) {
  if (!fromUser) return "reply";
  if (isMouseClick(data)) return "click";
  if (isMouseReport(data)) return "mouse";
  return "user";
}

// What a write from the phone companion means for this pane, which never sees
// it go by (companion.rs sends `companion-input://<id>` once it landed):
// - answers: it may have answered a dialog, so a matched prompt is dropped and
//   "waiting" ends. Anything but a mouse move, wheel or focus report.
// - typed: the phone says a person typed it on its own terminal: activity
//   tracking turns on, as for typing here. The resume hold stays (the flag is
//   the phone's word; TerminalPane).
// - started: the phone put the text there (a snippet, "cd here"), like the
//   desktop's own snippets: tracking starts.
// The payload carries the bytes only for a short write; a longer one is a
// paste, never a mouse report, and `len` gives its length either way. An
// empty write answered nothing.
export function phoneInputEffect(payload) {
  const data = typeof payload?.data === "string" ? payload.data : "";
  const len = Number.isInteger(payload?.len) ? payload.len : data.length;
  const typed = payload?.typed === true;
  const none = { answers: false, typed: false, started: false };
  if (len <= 0) return none;
  if (data === ESC + "[I" || data === ESC + "[O") return none;
  const kind = inputKind(data, true);
  if (kind === "mouse") return none;
  if (kind === "click") return { answers: true, typed: false, started: false };
  return { answers: true, typed, started: !typed };
}
