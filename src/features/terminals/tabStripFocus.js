// (C)
// A one-way signal from the tab strip's keyboard handlers to TerminalPane's
// reveal effect: "focus is deliberately parked on a tab, do not take it".
//
// WHY THIS EXISTS. Switching tabs makes the target tab's pane visible, and
// TerminalPane's reveal effect focuses that pane's xterm 30ms later so a MOUSE
// click on a tab lands the caret in the shell. A keyboard switch produces the
// identical reveal, so without a signal the two are indistinguishable and the
// steal fires either way. Measured, not reasoned: with the real TerminalPanel
// and a pane that reproduces the reveal effect, one ArrowRight left focus on
// the tab at the synchronous instant and on the terminal's textarea 60ms later.
// Roving tab navigation therefore survived exactly ONE keypress: the second
// ArrowRight was already ESC[C into a live PTY, Delete was ESC[3~, and F2 was
// an escape sequence. For a workstation whose core case is many concurrent
// agent terminals, that is arrow keys leaking into an agent's shell.
//
// WHY A MODULE AND NOT A PROP. The strip lives in TerminalPanel and the steal
// lives in TerminalPane, and invariant 1 (PTYs survive React) rules out routing
// this through state either component renders on: a prop or a context value
// that changed on every arrow keypress would re-render the pane tree on every
// arrow keypress, which is the exact thing the roving tabIndex was built as
// derived state to avoid. This is module scope, so nothing React observes
// changes at all.
//
// WHY A TIMESTAMP AND NOT A BOOLEAN. Nothing has to remember to clear it, a
// missed clear cannot wedge the app into never-focus-the-terminal, and the
// window is bounded by construction rather than by a timer that could be
// cancelled by an unmount mid-switch.

let armedAt = 0;

// 500ms, not 30. The steal fires 30ms after the switch COMMITS, and the commit
// is a render of a panel full of panes, which is not bounded: a tight window
// would put the bug back on a loaded machine, which is precisely the machine
// with twenty agent tabs open. The cost of the slack is that a pane revealed
// for some unrelated reason within half a second of a tab-strip keypress also
// declines to steal focus, and declining is the right answer there too.
export const TAB_STRIP_FOCUS_WINDOW_MS = 500;

// Called by the tab strip whenever a KEYSTROKE puts (or keeps) focus on a tab.
// Deliberately not called by the Ctrl+Tab / Ctrl+N keybindings: those are typed
// while focus is in the terminal, and their whole point is to leave it there.
export function armTabStripFocus(now = Date.now()) {
  armedAt = now;
}

// Called when the mouse takes over, so a click on a tab within half a second of
// an arrow key still hands the caret to the shell the way a click always has.
export function releaseTabStripFocus() {
  armedAt = 0;
}

// The question TerminalPane's reveal effect asks before focusing its terminal.
export function shouldPaneTakeFocus(now = Date.now()) {
  if (armedAt === 0) return true;
  return now - armedAt >= TAB_STRIP_FOCUS_WINDOW_MS;
}
