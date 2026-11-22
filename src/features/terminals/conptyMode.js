// (C)
// xterm's Windows mode for local panes.
//
// A local pane on Windows is fed by ConPTY, and ConPTY has its own idea of the
// screen: when the window gets taller it keeps its text at the top, adds blank
// rows at the bottom, and repaints the whole view. xterm by default does the
// opposite on a taller resize (it pulls scrollback rows down to the top), and
// ConPTY's repaint then overwrites the rows that were pulled: a full screen
// made taller lost lines (seen in the v0.7.7 live check: 60 lines, a taller
// window, lines 13 to 25 gone). `windowsPty.backend` tells xterm which model
// it is talking to, and in xterm 5.5 that changes exactly one thing: a taller
// resize adds blank rows at the bottom (Buffer.resize).
//
// The build number is left out on purpose. With one, xterm also turns text
// rewrapping off and its wrapped-line guesses on for builds below 21376
// (Windows 10), which changes how copied lines join; that has not been tried
// on a Windows 10 machine, and for Windows 11 a build number changes nothing.
//
// SSH and serial panes are not fed by ConPTY and never get this.
// True where a local shell is fed by ConPTY (every local pane on Windows).
export const isConptyHost = () => typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

export function applyConptyMode(term) {
  if (!isConptyHost()) return;
  try {
    term.options.windowsPty = { backend: "conpty" };
  } catch { /* a disposed terminal takes no options */ }
}
