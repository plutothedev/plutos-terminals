// (C)
// Pure permission-prompt detector for the auto-approve path (extracted from
// TerminalPane in P2-T5's review round so the safety-critical logic is
// testable — this exact needs-you bug class regressed before, at v0.6.0).
//
// All FOUR markers must be present together in the ANSI-stripped recent
// output: this is anchored to Claude's real permission framing so arbitrary
// attacker-influenced output that merely echoes "❯ 1." / "Yes" / "(esc)"
// can't forge an auto-confirmation (defense-in-depth atop the away-gate).
//
// The cheap prefilter is sound because "❯" is a REQUIRED marker below and a
// single character — ANSI interleaving can't split it in the raw buffer, and
// stripAnsi only ever REMOVES characters, so raw-not-containing implies
// stripped-not-containing. A prefilter miss is therefore exactly a full-scan
// miss: same false return, and the caller's waiting→active un-block branch
// runs identically.

// Byte-identical to the regex TerminalPane used inline (the write side
// imports from HERE now, so the two can't drift).
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

export function stripAnsi(s) {
  return s.replace(ANSI_RE, "");
}

export function detectPendingPrompt(rawRecentOut) {
  if (!rawRecentOut || !rawRecentOut.includes("❯")) return false;
  const text = stripAnsi(rawRecentOut);
  return (
    /❯\s*1[.)]/.test(text) &&
    /\bYes\b/.test(text) &&
    (/\(esc\)/i.test(text) || /\[esc\]/i.test(text)) &&
    /Do you want\b/i.test(text)
  );
}
