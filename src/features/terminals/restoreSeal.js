// (C)
// Sealing a restored terminal at a session boundary.
//
// A pane's saved history is the raw PTY output of every past session, back to
// back. Each session opens with its own screen clear (ConPTY's first frame is
// ESC[2J; a restored shell's display line clears too), and xterm's ED2 blanks
// the visible rows WITHOUT moving them into scrollback. Replayed as one
// stream, every session therefore erased the last screen of the one before it,
// and the new shell's own clear erased the last screen of the newest one.
//
// A seal makes the terminal look like a new one without losing what is on it:
// leave the alternate screen, put the modes a dead program left behind back to
// their defaults, move the used rows of the normal screen into scrollback, and
// home the cursor. Whatever clears next finds nothing to erase.
//
// Every seal happens during the replay, before the new shell is started: by
// the time the shell prints its first byte the screen is empty and all of the
// history is in scrollback. A later resize does not bring it back while the
// screen stays empty: xterm pulls scrollback rows down only when there is no
// blank row below the cursor, and a seal leaves the cursor at home with a
// blank screen under it. (Once new output has filled the screen a taller
// resize can pull history back; `pushBackHistory` covers the one clear that
// can still arrive then.)
//
// What a seal does NOT undo: a session that cleared its own scrollback
// (ESC[3J: Clear-Host, `clear`, some full-screen redraws) or did a full reset
// (ESC c). Replayed, it wipes what was restored before it, exactly as it did
// live. What was cleared stays cleared.
//
// The control bytes are built from char codes on purpose: no raw control byte
// and no escape that a tool could decode ever sits in this file.

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CAN = String.fromCharCode(24);
const SI = String.fromCharCode(15);
const LF = String.fromCharCode(10);
const CSI = ESC + "[";
const ST = ESC + String.fromCharCode(92);

// Written by the Rust reader thread at the start of every LOCAL session
// (pty.rs, ScrollbackWriter::mark_session_start). An OSC xterm ignores, in the
// same private family as the boot marker.
export const SESSION_SENTINEL = ESC + "]1337;PlutoSession=1" + BEL;

// Everything a program that died mid-run can leave set.
// CAN first: it aborts a half-finished escape sequence. ESC alone would end a
// half-written OSC as if it were complete, and xterm would act on the
// truncated text (half a window title, for one).
// Never ESC c: a full reset erases scrollback, the thing being protected.
export const SEAL_RESET = CAN + [
  CSI + "?1049l",  // back to the normal screen (vim, less, an agent's full-screen UI)
  CSI + "r",       // scroll region: whole screen
  CSI + "?6l",     // origin mode off
  CSI + "m",       // colours and attributes
  ESC + "]8;;" + ST, // close a hyperlink left open
  CSI + "?25h",    // cursor visible
  CSI + "5 q",     // cursor shape back to the pane's own (blinking bar, as constructed in TerminalPane)
  CSI + "4l",      // insert mode off
  CSI + "20l",     // line feed is a line feed again (LNM off)
  CSI + "?7h",     // autowrap on
  CSI + "?9l", CSI + "?1000l", CSI + "?1002l", CSI + "?1003l", // mouse reporting off
  CSI + "?1006l", CSI + "?1016l", // mouse report encoding back to the default
  CSI + "?1004l",  // focus reports off
  CSI + "?2004l",  // bracketed paste off
  CSI + "?1l",     // cursor keys back to normal mode
  ESC + ">",       // keypad back to numeric mode
  ESC + "(B", ESC + ")B", SI, // both character sets back to ASCII, G0 selected
].join("");

// Cursor to the last row whatever the size is by the time this is parsed (a
// row number past the end is clamped), so a resize between measuring and
// writing cannot aim it at the wrong row.
const TO_LAST_ROW = CSI + "9999;1H";
const HOME = CSI + "H";
const ERASE_LINE = CSI + "2K";

// Last row of the normal screen that holds anything, or -1 for a blank screen.
// Read from buffer.normal, never buffer.active: the history may have ended in
// the alternate screen, and it is the normal screen's rows that must be kept.
export function lastUsedRow(term) {
  const buf = term.buffer.normal;
  for (let y = term.rows - 1; y >= 0; y--) {
    const line = buf.getLine(buf.baseY + y);
    // trim(): a row holding only spaces that something wrote is still blank.
    if (line && line.translateToString(true).trim().length > 0) return y;
  }
  return -1;
}

// xterm calls a write callback with no protection of its own, and a throw in
// there stops that terminal parsing for good. Every callback in this file
// goes through this: on a throw, `bail` runs instead (and may not throw).
const guarded = (fn, bail) => () => {
  try { fn(); } catch { bail(); }
};

// Seals the terminal, then calls `done` once xterm has parsed the seal.
//
// An empty write comes first: xterm parses asynchronously and runs a write's
// callback right after that write, so the callback sees the screen exactly as
// everything queued before the seal left it. The rows are measured there (the
// reset never changes what the normal screen holds), and the whole seal then
// goes out as ONE write. A write issued from inside a write callback is parsed
// in the same pass, so nothing can land between the measure and the seal, or
// between the seal's reset and its push.
//
// The push: cursor to the last row, then one line feed per used row. A line
// feed on the bottom row of a full-screen scroll region moves the top row into
// scrollback, so exactly the used rows leave and no blank line is added.
export function sealScreen(term, done) {
  const measureAndSeal = guarded(() => {
    term.write(SEAL_RESET + TO_LAST_ROW + LF.repeat(lastUsedRow(term) + 1) + HOME, done);
  }, done);
  try { term.write("", measureAndSeal); } catch { done(); }
}

// Replays a saved history into `term`: every session in order, a seal at each
// session mark, and a last seal that leaves `endLine` as the final line of the
// history above an empty screen. Resolves when xterm has parsed all of it:
// true for a restore, false when there was nothing to replay (no text at all,
// or only session marks: a fresh pane, not a restored one). `isLive` stops the
// replay when the pane is destroyed part-way.
//
// One promise for the whole replay, and every step is issued from the
// previous step's write callback. That keeps the whole replay in one parsing
// pass of xterm's: a promise per step would cost a timer round trip each, and
// a hidden window's timers run about once a second, so a pane with dozens of
// past sessions would wait minutes before its shell could start. No timers of
// its own either: a wait that gave up early would let the next write overtake
// a seal and lose the screen it was protecting.
export function replaySaved(term, saved, isLive = () => true, endLine = "") {
  const sessions = saved.split(SESSION_SENTINEL).filter((text) => text.length > 0);
  return new Promise((resolve) => {
    let next = 0; // index of the next session to write
    const restoredSoFar = () => resolve(next > 0); // read when called, not when bound
    const restored = () => resolve(true);
    // After the last session: seal, write the end line on the empty screen,
    // then seal again. The second seal measures how many rows the line took
    // (it wraps in a narrow pane), so all of it leaves the screen.
    const writeEndLine = guarded(() => {
      if (!isLive() || !endLine) { resolve(true); return; }
      // Erase first: the row can carry a wrapped-line flag from what was
      // there before, which would glue the line to the history above it.
      term.write(ERASE_LINE + endLine, guarded(() => sealScreen(term, restored), restored));
    }, restored);
    const step = guarded(() => {
      if (!isLive()) { resolve(next > 0); return; }
      if (next === sessions.length) { sealScreen(term, writeEndLine); return; }
      const text = sessions[next];
      const writeSession = guarded(() => { next += 1; term.write(text, step); }, restoredSoFar);
      // Nothing on the terminal yet means nothing to protect: a file that
      // starts with a session mark replays exactly like one that does not.
      if (next > 0) sealScreen(term, writeSession); else writeSession();
    }, restoredSoFar);
    if (sessions.length === 0) resolve(false); else step();
  });
}

// The one clear a seal cannot be ahead of. A shell slower than the pane's boot
// gate (4 s) has its banner and echoed setup shown; once that fills the screen
// the cursor sits on the last row, and a taller resize (a hidden pane being
// revealed) then makes xterm pull the newest history rows back on screen. The
// shell's display line clears right after its boot marker, and that clear
// would erase them.
//
// `endMarker` is an xterm marker on the history's last line (the end line
// replaySaved wrote). Returns the bytes that move exactly the history rows
// that are back on screen into scrollback again, or "" when none are. Written
// right before the clear; the cursor is saved and restored around it (xterm
// restores it onto the same line of text, which has moved up with the push).
export function pushBackHistory(term, endMarker) {
  if (!endMarker || endMarker.isDisposed || endMarker.line < 0) return "";
  const onScreen = endMarker.line - term.buffer.normal.baseY + 1;
  if (onScreen <= 0) return "";
  return ESC + "7" + TO_LAST_ROW + LF.repeat(Math.min(onScreen, term.rows)) + ESC + "8";
}
