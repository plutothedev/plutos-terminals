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
// Every seal happens during the replay, before the new shell is started, so
// the live output path needs no change: by the time the shell prints its
// first byte the screen is empty and all of the history is in scrollback. A
// later resize cannot bring it back on screen: xterm pulls scrollback rows
// down only when there is no blank row below the cursor, and a seal leaves
// the cursor at home with a blank screen under it.
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
  CSI + "?9l", CSI + "?1000l", CSI + "?1002l", CSI + "?1003l", CSI + "?1006l", CSI + "?1016l", // mouse reporting off
  CSI + "?1004l",  // focus reports off
  CSI + "?2004l",  // bracketed paste off
  CSI + "?1l",     // cursor keys back to normal mode
  ESC + ">",       // keypad back to numeric mode
  ESC + "(B", SI,  // character set back to ASCII
].join("");

// Cursor to the last row whatever the size is by the time this is parsed (a
// row number past the end is clamped), so a resize between measuring and
// writing cannot aim it at the wrong row.
const TO_LAST_ROW = CSI + "9999;1H";
const HOME = CSI + "H";

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

// Seals the terminal, writes `after` (if any) on the now empty screen, then
// calls `done` once xterm has parsed it all.
//
// An empty write comes first: xterm parses asynchronously and runs a write's
// callback right after that write, so the callback sees the screen exactly as
// everything queued before the seal left it. The rows are measured there (the
// reset never changes what the normal screen holds), and the whole seal then
// goes out as ONE write, so nothing can land between its reset and its push.
//
// The push: cursor to the last row, then one line feed per used row. A line
// feed on the bottom row of a full-screen scroll region moves the top row into
// scrollback, so exactly the used rows leave and no blank line is added.
//
// The callback body is guarded: xterm calls it with no protection of its own,
// and a throw in there would stop that terminal parsing for good.
export function sealScreen(term, done, after = "") {
  term.write("", () => {
    let seal = "";
    try {
      seal = SEAL_RESET + TO_LAST_ROW + LF.repeat(lastUsedRow(term) + 1) + HOME + after;
    } catch {
      seal = "";
    }
    if (!seal) { done(); return; }
    try {
      term.write(seal, done);
    } catch {
      done();
    }
  });
}

// One line, written on the empty screen a seal leaves, then moved into
// scrollback itself: the screen is empty again and the line is the last thing
// in the history.
const lineThenPush = (line) => line + TO_LAST_ROW + LF + HOME;

// Promises on xterm's own write callbacks. No timers: a wait that gave up
// early would let the next write overtake a seal and lose the screen it was
// protecting. A terminal disposed part-way never calls back, and the caller
// (a spawn that must not happen for a pane that is gone) then never continues.
const writeParsed = (term, data) => new Promise((resolve) => {
  try { term.write(data, resolve); } catch { resolve(); }
});
const sealParsed = (term, after) => new Promise((resolve) => sealScreen(term, resolve, after));

// Replays a saved history into `term`: every session in order, a seal at each
// session mark, and a last seal that leaves `endLine` as the final line of the
// history above an empty screen. Returns false when there was nothing to
// replay (no text at all, or only session marks): the pane is then a fresh
// one, not a restored one. `isLive` stops the replay when the pane is
// destroyed part-way.
export async function replaySaved(term, saved, isLive = () => true, endLine = "") {
  let wrote = false;
  for (const text of saved.split(SESSION_SENTINEL)) {
    if (!text) continue;
    if (!isLive()) return wrote;
    // Nothing on the terminal yet means nothing to protect: a file that starts
    // with a session mark replays exactly like one that does not.
    if (wrote) await sealParsed(term);
    if (!isLive()) return wrote;
    await writeParsed(term, text);
    wrote = true;
  }
  if (wrote && isLive()) await sealParsed(term, endLine ? lineThenPush(endLine) : "");
  return wrote;
}
