// (C)
// Copy / paste keys for the terminal, Windows Terminal style.
//
// Before this the terminal had no copy key at all: Ctrl+C always went to the
// PTY as ^C, so a Windows user who highlighted text and pressed Ctrl+C
// interrupted whatever was running (a Claude Code session quit on them) and
// copied nothing. The rules now:
//
//   Ctrl+C          copies when text is selected; with no selection it is
//                   still ^C, so interrupting a program keeps working.
//                   Not on macOS, where Cmd+C copies and Ctrl+C is always ^C.
//   Ctrl+Shift+C    always a copy key, never ^C (no-op with no selection).
//   Ctrl+Shift+V    paste.
//
// Plain Ctrl+V is left alone: the browser's own paste event already reaches
// xterm's textarea for it (see assistiveInput.js).

const isLetter = (ev, letter) => {
  const k = typeof ev.key === "string" ? ev.key.toLowerCase() : "";
  if (k === letter) return true;
  // Non-Latin layouts report the layout's own character in `key`; fall back
  // to the physical key so Ctrl+C still copies on, say, a Russian layout.
  return !/^[a-z]$/.test(k) && ev.code === `Key${letter.toUpperCase()}`;
};

// Returns "copy", "paste", or null (null = let xterm handle the key as usual).
export function clipboardKeyAction(ev, { hasSelection, isMac }) {
  if (!ev || ev.type !== "keydown") return null;
  if (!ev.ctrlKey || ev.altKey || ev.metaKey) return null;
  if (ev.shiftKey) {
    if (isLetter(ev, "c")) return "copy";
    if (isLetter(ev, "v")) return "paste";
    return null;
  }
  if (!isMac && hasSelection && isLetter(ev, "c")) return "copy";
  return null;
}

// What a right-click on the terminal does: copy when text is selected,
// otherwise the PuTTY-style paste the app has always done.
export function rightClickAction({ hasSelection }) {
  return hasSelection ? "copy" : "paste";
}
