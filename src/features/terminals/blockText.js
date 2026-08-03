// (C)
// Reconstruct a command block's output from an xterm buffer, honoring soft-wrap.
// SECURITY INVARIANT: a run of characters that is contiguous on screen must stay
// contiguous in the returned string. blockText output is fed to scanSecrets()
// before a gist upload; the scanner's token patterns are newline-free, so any \n
// injected mid-token (e.g. a secret that soft-wrapped across the pane width)
// would silently defeat masking. Rows i and i+1 are the same logical line exactly
// when getLine(i+1).isWrapped is true. Do not separate them with \n, and do not
// trimRight a row that wraps into the next (its trailing column is real content).
export function blockOutputText(buf, startLine, endLine) {
  const end = endLine != null ? endLine : startLine;
  let out = "";
  for (let i = startLine + 1; i <= end && i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    // NOTE: at i === end this peeks ONE row past the block boundary. Assumed
    // safe because OSC-133 block ends are shell-controlled: the D marker closes
    // the block's true last content row, so the row after `end` never wraps
    // back into it. The wrap-continuity invariant above rests on this.
    const next = buf.getLine(i + 1);
    const wrapsIntoNext = !!(next && next.isWrapped);
    out += line.translateToString(!wrapsIntoNext);
    if (!wrapsIntoNext) out += "\n";
  }
  return out.replace(/\s+$/, "");
}
