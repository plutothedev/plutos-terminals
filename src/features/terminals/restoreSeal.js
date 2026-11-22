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
const SEAL_RESET = CAN + [
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
//
// Then it looks again. xterm parses in time slices, and a resize can land
// between the measure and the push: a taller terminal pulls scrollback rows
// back down, more rows than were measured are on screen, and the push leaves
// some behind for the next clear to erase. So the seal's own callback measures
// once more and seals again until the screen is empty (a few passes at most;
// when nothing moved, the second look costs no write).
const SEAL_PASSES = 4;
export function sealScreen(term, done) {
  let passes = 0;
  const pass = guarded(() => {
    const used = lastUsedRow(term) + 1;
    if (passes > 0 && (used === 0 || passes >= SEAL_PASSES)) { done(); return; }
    passes += 1;
    term.write(SEAL_RESET + TO_LAST_ROW + LF.repeat(used) + HOME, pass);
  }, done);
  try { term.write("", pass); } catch { done(); }
}

// Written by the Rust side into a LOCAL pane's saved file: right after each
// session mark with the size the PTY was created at, before every resize of
// that PTY, and again every so often so a long session always has one nearby
// (pty.rs, ScrollbackWriter::mark_size). On Windows every resize makes ConPTY
// repaint its whole view (home, then one line per row), and each paint is in
// the saved file. A paint recorded for a taller window scrolls when it is
// replayed into a shorter terminal, the block lands in scrollback, and the
// next paint draws it again: lines repeated after a restart. So the replay
// resizes the terminal to each part's own size before writing it.
const SIZE_MARK_START = ESC + "]1337;PlutoSize=";
// The PTY side records sizes from 40 x 10 up. The ceiling is here because the
// marks are plain bytes in the output stream and any program can print one:
// xterm allocates a cell for every column of every line it holds. A full-width
// pane on a very wide display is some 650 columns.
const SIZE_LIMITS = { minCols: 10, maxCols: 1000, minRows: 3, maxRows: 500 };
// "<cols>;<rows>" and the BEL that ends the mark, directly after the prefix.
// Anything else after the prefix is not a mark, and the prefix is just text:
// looking for "the next BEL" instead would swallow output up to a BEL that
// belongs to something else.
const SIZE_MARK_BODY = new RegExp("^(\\d{1,4});(\\d{1,4})" + BEL);

// ConPTY's answer to a resize, as read from real captures of the app: hide the
// cursor, optional colours, home, then exactly `rows` lines (the first rows-1
// ending in CR LF), then a cursor position with a row and a column.
const PAINT_START = new RegExp(ESC + "\\[\\?25l(?:" + ESC + "\\[[0-9;]*m)*" + ESC + "\\[H", "g");
const CURSOR_TO = new RegExp(ESC + "\\[\\d+;\\d+H");

// Where in `text` ConPTY's repaint for a view `rows` tall begins, or -1.
function paintStart(text, rows) {
  PAINT_START.lastIndex = 0;
  for (let m = PAINT_START.exec(text); m; m = PAINT_START.exec(text)) {
    const body = text.slice(m.index + m[0].length);
    const end = body.search(CURSOR_TO);
    if (end >= 0 && body.slice(0, end).split("\r\n").length === rows) return m.index;
  }
  return -1;
}

// "<mark>text<mark>text" -> [{ size: [cols, rows] } | { text }]. A mark that
// is not a sane size is dropped. Marks with no text between them (a window
// being dragged) collapse into the last one.
//
// `conpty`: the size is applied where ConPTY's repaint for it begins, not
// where the mark sits. The mark is written the moment the resize is asked
// for, but output ConPTY had already produced at the old size is still on its
// way and lands in the file after the mark. Resizing at the mark would print
// those late lines into the rows a taller terminal has just gained, without
// scrolling, and the repaint (whose view did scroll) would then be drawn over
// lines the live terminal had moved into scrollback. So what comes between
// the mark and the repaint is written at the old size. With no repaint of the
// right height after a mark, the size applies at the mark.
function replaySteps(sessionText, conpty) {
  const steps = [];
  const pushText = (text) => {
    if (!text) return;
    const last = steps[steps.length - 1];
    if (last && last.text !== undefined) last.text += text; else steps.push({ text });
  };
  let rest = sessionText;
  for (;;) {
    const at = rest.indexOf(SIZE_MARK_START);
    if (at < 0) break;
    const after = rest.slice(at + SIZE_MARK_START.length);
    const body = SIZE_MARK_BODY.exec(after.slice(0, 12));
    if (!body) {
      // Not a mark: keep the prefix as the text it is and look further on.
      pushText(rest.slice(0, at + SIZE_MARK_START.length));
      rest = after;
      continue;
    }
    pushText(rest.slice(0, at));
    const cols = Number(body[1]);
    const rows = Number(body[2]);
    if (cols >= SIZE_LIMITS.minCols && cols <= SIZE_LIMITS.maxCols && rows >= SIZE_LIMITS.minRows && rows <= SIZE_LIMITS.maxRows) {
      const last = steps[steps.length - 1];
      if (last && last.size) last.size = [cols, rows]; else steps.push({ size: [cols, rows] });
    }
    rest = after.slice(body[0].length);
  }
  pushText(rest);
  if (!conpty) return steps;
  // Move each size to the start of its repaint.
  const moved = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const next = steps[i + 1];
    if (step.size && next && next.text !== undefined) {
      const at = paintStart(next.text, step.size[1]);
      if (at > 0) {
        const late = next.text.slice(0, at);
        const prev = moved[moved.length - 1];
        if (prev && prev.text !== undefined) prev.text += late; else moved.push({ text: late });
        moved.push(step, { text: next.text.slice(at) });
        i += 1;
        continue;
      }
    }
    moved.push(step);
  }
  return moved;
}

// The bytes that move the top `count` rows of the screen into scrollback and
// leave the cursor on the line of text it was on (that line moves up with the
// push). By position, not by save and restore: the shell may have a saved
// cursor of its own.
function pushRowsUp(term, count) {
  const buf = term.buffer.normal;
  const rows = Math.min(count, term.rows);
  const row = Math.max(buf.cursorY - rows, 0) + 1;
  const col = Math.min(buf.cursorX, term.cols - 1) + 1;
  return TO_LAST_ROW + LF.repeat(rows) + CSI + row + ";" + col + "H";
}

// Resizes the terminal and returns the bytes (possibly none) that must be
// written before anything else.
//
// On ConPTY (`conpty`), the resize has to leave the screen the way ConPTY's
// side of the conversation assumes. ConPTY never gives a row back once it has
// scrolled off: on a resize it keeps its view and repaints it. xterm can pull
// scrollback rows down into view: on a taller resize when the screen is full
// (unless its Windows mode is set), and on a wider one whenever a wrapped line
// on screen becomes one row and frees a row. The repaint that follows in the
// saved stream would then be drawn over the rows that came down, and those
// rows, real lines of an earlier session, would be gone. So the place where
// the screen began is marked before the resize; how far it has moved down
// afterwards is exactly how many rows came down, and that many are pushed back
// up. (Not "how much the scrollback shrank": it also shrinks when wrapped
// scrollback lines merge, with nothing coming down.)
//
// The mark sits on the first row of the line the top screen row belongs to.
// When the screen begins in the middle of a wrapped line, a wider resize
// merges that row into the one above and a marker on it would vanish; the
// line's first row survives. The part of that line that was above the screen
// (`above` rows of the old width) stays above it after the resize, in however
// many rows of the new width it now takes; a row it shares with the part that
// was on screen counts as above, so ConPTY's repaint of its top row lands
// under it and not on it (the tail of that one line then shows twice, which
// loses nothing).
//
// Elsewhere (macOS, Linux) nothing repaints after a resize and the live
// terminal did pull those rows down, so the replay does the plain resize too.
function resizeForReplay(term, cols, rows, conpty) {
  if (term.cols === cols && term.rows === rows) return "";
  let head = null;
  let above = 0;
  const oldCols = term.cols;
  if (conpty) {
    try {
      if (term.buffer.active.type === "normal") {
        const buf = term.buffer.normal;
        let first = buf.baseY;
        while (first > 0 && buf.getLine(first)?.isWrapped) first -= 1;
        above = buf.baseY - first;
        head = term.registerMarker(first - buf.baseY - buf.cursorY);
      }
    } catch { head = null; }
  }
  try { term.resize(cols, rows); } catch { /* a size xterm refuses changes nothing */ }
  let cameDown = 0;
  if (head) {
    if (!head.isDisposed && head.line >= 0) {
      const screenBegan = head.line + Math.ceil((above * oldCols) / term.cols);
      cameDown = screenBegan - term.buffer.normal.baseY;
    }
    try { head.dispose(); } catch { /* already gone with its line */ }
  }
  return cameDown > 0 ? pushRowsUp(term, cameDown) : "";
}

// Replays a saved history into `term`: every session in order, each part at
// the size it was recorded at, a seal at each session mark, and a last seal
// that leaves `endLine` as the final line of the history above an empty
// screen, with the terminal back at the size it had at the start. Resolves
// when xterm has parsed all of it: true for a restore, false when there was
// nothing to replay (no text at all, or only marks: a fresh pane, not a
// restored one). `isLive` stops the replay when the pane is destroyed part-way.
//
// One promise for the whole replay, and every step is issued from the
// previous step's write callback. That keeps the whole replay in one parsing
// pass of xterm's: a promise per step would cost a timer round trip each, and
// a hidden window's timers run about once a second, so a pane with dozens of
// past sessions would wait minutes before its shell could start. No timers of
// its own either: a wait that gave up early would let the next write overtake
// a seal and lose the screen it was protecting.
//
// Sizes. A resize step runs inside the previous write's callback, so the
// screen is parsed up to that point when the size changes, exactly as it was
// live. Nothing else may resize the terminal while this runs: in the middle
// of a part it would replay the rest of that part at the wrong size. The pane
// guarantees it by holding its fits back until the replay is done (every
// resize in the app comes from the fit addon). A session with no size of its
// own (saved by an older build) replays at the terminal's own size, which is
// why a visible pane is opened and fitted before its replay starts.
//
// `conpty`: the saved stream came from ConPTY (a local pane on Windows). See
// replaySteps and resizeForReplay for what that changes.
export function replaySaved(term, saved, isLive = () => true, endLine = "", { conpty = false } = {}) {
  // One list of steps per session that has anything to show.
  const ownSize = [term.cols, term.rows];
  const sessions = saved.split(SESSION_SENTINEL)
    .map((text) => replaySteps(text, conpty))
    .filter((steps) => steps.some((s) => s.text))
    // No size recorded for a session (saved by an older build): it replays at
    // the terminal's own size, not at whatever the session before it ended at.
    .map((steps) => (steps[0].size ? steps : [{ size: ownSize }, ...steps]));
  return new Promise((resolve) => {
    if (sessions.length === 0) { resolve(false); return; }

    const canResize = typeof term.resize === "function";
    let s = 0;      // session being written
    let i = 0;      // next step in it
    let wrote = false;
    let run = null; // assigned below; the steps call back into it
    // Changes the size, then continues: at once when nothing came down, after
    // the push-back has been parsed when rows did.
    const resizeThen = ([cols, rows], next) => {
      const push = canResize ? resizeForReplay(term, cols, rows, conpty) : "";
      if (push) { term.write(push, next); return true; }
      return false;
    };
    // After the last session: seal (the screen is then empty, so going back
    // to the terminal's own size moves nothing), write the end line, then seal
    // again. The second seal measures how many rows the line took (it wraps in
    // a narrow pane), so all of it leaves the screen.
    const finish = guarded(() => {
      if (!isLive()) { resolve(true); return; }
      const writeEndLine = guarded(() => {
        if (!endLine) { resolve(true); return; }
        // Erase first: the row can carry a wrapped-line flag from what was
        // there before, which would glue the line to the history above it.
        term.write(ERASE_LINE + endLine, guarded(() => sealScreen(term, () => resolve(true)), () => resolve(true)));
      }, () => resolve(true));
      if (!resizeThen(ownSize, writeEndLine)) writeEndLine();
    }, () => resolve(true));
    run = guarded(() => {
      for (;;) {
        if (!isLive()) { resolve(wrote); return; }
        if (s === sessions.length) { sealScreen(term, finish); return; }
        const steps = sessions[s];
        if (i === steps.length) {
          s += 1;
          i = 0;
          // A seal at every session boundary. Nothing on the terminal yet
          // means nothing to protect: a file that starts with a session mark
          // replays exactly like one that does not.
          if (s < sessions.length && wrote) { sealScreen(term, run); return; }
          continue;
        }
        const step = steps[i];
        i += 1;
        if (step.size) {
          if (resizeThen(step.size, run)) return;
          continue;
        }
        wrote = true;
        term.write(step.text, run);
        return;
      }
    }, () => resolve(wrote));
    run();
  });
}

// The one clear a seal cannot be ahead of. A shell slower than the pane's boot
// gate (4 s) has its banner and echoed setup shown; once that fills the screen
// the cursor sits on the last row, and a taller resize (a hidden pane being
// revealed) then makes xterm pull the newest history rows back on screen. The
// shell's display line clears right after its boot marker, and that clear
// would erase them. (With xterm's Windows mode a taller resize pulls nothing;
// this covers the other systems.)
//
// `endMarker` is an xterm marker on the history's last line (the end line
// replaySaved wrote). Returns the bytes that move exactly the history rows
// that are back on screen into scrollback again, or "" when none are. Call it
// from an xterm write callback, when everything received so far has been
// parsed, and write the result at once: output still waiting to be parsed
// scrolls history up by itself, and a count taken earlier would push banner
// rows up with it.
export function pushBackHistory(term, endMarker) {
  if (!endMarker || endMarker.isDisposed || endMarker.line < 0) return "";
  // The push is line feeds on the screen that is showing. In the alternate
  // screen it would scroll that screen and leave the history where it is.
  if (term.buffer.active.type !== "normal") return "";
  const onScreen = endMarker.line - term.buffer.normal.baseY + 1;
  return onScreen > 0 ? pushRowsUp(term, onScreen) : "";
}
