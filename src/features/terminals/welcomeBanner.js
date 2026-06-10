// (C)
// Pure string builders for the local-shell welcome experience.
//
// Extracted verbatim from TerminalPane.jsx's spawn effect (behavior-preserving
// refactor). These functions are side-effect-free and touch no React refs /
// state / xterm — everything they need is passed in as explicit args. The
// output bytes are byte-identical to the previous inline code.

// MobaXterm-style welcome box builder. Returns the raw box string (with leading
// and trailing newlines) exactly as the inline code produced it. `paneCols` is
// the terminal's current column count (was `term.cols || 80` at the call site).
export function buildWelcomeBanner({ paneCols }) {
  const E = "\x1b";
  // Per-segment colour: each line is a list of [text, ansiCode|null]
  // pairs (+ optional center / hang). The box edges align because the
  // inner width is measured on the PLAIN text (✓ ✗ · ► are all width 1)
  // and colour is layered on after. CRUCIALLY the box is sized to the
  // pane's actual column count and content is word-wrapped, so a narrow
  // split pane never wraps a line past the border. MobaXterm-style.
  const BORDER = "1;36";       // cyan box (MobaXterm header vibe)
  const TITLE_BG = "1;30;46";  // black-on-cyan title bar
  const wrap = (code, s) => (code ? `${E}[${code}m${s}${E}[0m` : s);
  const C = (c, t) => [t, c];  // coloured segment
  const T = (t) => [t, null];  // plain segment
  const lines = [
    { center: true, segs: [C(TITLE_BG, "  ✦ Pluto's Terminal ✦  ")] },
    { center: true, segs: [C("36", "free multi-terminal for the Pluto community")] },
    { segs: [] },
    { hang: 2, segs: [C("1;36", "► "), T("Saved sessions live in the "), C("1;33", "Sessions"), T(" panel — SSH · local · serial · RDP/VNC")] },
    { hang: 2, segs: [C("1;36", "► "), T("Scrollback is "), C("1;32", "persistent"), T(" — every tab is saved and replayed on restart")] },
    { hang: 2, segs: [C("1;36", "► "), C("1;35", "MultiExec"), T(" broadcasts your typing to every visible terminal at once")] },
    { hang: 2, segs: [C("1;36", "► "), C("1;36", "Models"), T(": route to any LLM — Claude · GPT · Gemini · GLM · Kimi · 16 providers")] },
    { hang: 2, segs: [C("1;36", "► "), T("Split panes, drag tabs and pin sessions to shape your workspace")] },
    { hang: 2, segs: [C("1;36", "► "), T("Tools, snippets and a file browser are one click away in the toolbar")] },
    { hang: 2, segs: [C("1;36", "► "), T("Command status shows as a symbol   ("), C("1;32", "✓"), T(" ok · "), C("1;31", "✗"), T(" failed)")] },
    { segs: [] },
    { hang: 2, segs: [C("1;36", "► "), C("1;31", "Tip!")] },
    { hang: 6, segs: [T("   Run "), C("1;33", "Claude Code"), T(", Codex and other AI agents side by side — each in")] },
    { hang: 6, segs: [T("   its own git worktree, on "), C("1;33", "any model"), T(" you pick.")] },
    { hang: 6, segs: [T("   Press "), C("1;33", "Ctrl+K"), T(" for the command palette, or "), C("1;36", "Home"), T(" to launch.")] },
    { segs: [] },
    { hang: 3, segs: [C("1;32", "➜ "), T("Docs: "), C("4;36", "https://github.com/plutothedev/plutos-terminals")] },
    { hang: 3, segs: [C("1;35", "➜ "), T("Community: "), C("4;35", "https://discord.gg/3cZQVgKF")] },
  ];
  const plainLen = (segs) => segs.reduce((n, [t]) => n + t.length, 0);
  // Fit to the pane: -6 leaves the border (space+│+space ... space+│) and
  // a 1-col right margin so terminals with a magic margin don't wrap.
  // Also clamp to a comfortable ABSOLUTE max: the box can't reflow once
  // printed to scrollback, so an absolute cap keeps it (a) a tidy card
  // rather than a sprawling banner, (b) the SAME width in every pane no
  // matter how wide that pane was when it was created — so a tab split
  // full-width and a pane born already-narrow get identical boxes that
  // line up, and (c) narrow enough to survive a 2-way split.
  const BOX_MAX = 60;
  const maxInner = Math.max(...lines.map((l) => plainLen(l.segs)));
  const W = Math.max(24, Math.min(maxInner, paneCols - 6, BOX_MAX));
  // Word-wrap coloured segments to width, hang-indenting continuations
  // and hard-splitting any token longer than a row (e.g. a URL).
  const wrapLine = (segs, width, hang = 0) => {
    const rows = [];
    let cur = [], curLen = 0;
    const startRow = (withHang) => { cur = []; curLen = 0; if (withHang && hang) { cur.push([" ".repeat(hang), null]); curLen = hang; } };
    startRow(false);
    for (const [t, c] of segs) {
      for (const tok of t.split(/(\s+)/)) {
        if (tok === "") continue;
        if (/^\s+$/.test(tok)) {
          if (curLen > 0 && curLen + tok.length <= width) { cur.push([tok, c]); curLen += tok.length; }
          continue;
        }
        let w = tok;
        while (w.length > width - curLen) {
          if (curLen > (hang || 0)) { rows.push(cur); startRow(true); continue; }
          const avail = Math.max(1, width - curLen);
          cur.push([w.slice(0, avail), c]); curLen += avail; w = w.slice(avail);
          rows.push(cur); startRow(true);
        }
        if (w.length) { cur.push([w, c]); curLen += w.length; }
      }
    }
    rows.push(cur);
    return rows;
  };
  const box = [" " + wrap(BORDER, "┌" + "─".repeat(W + 2) + "┐")];
  const pushRow = (rowSegs, center) => {
    const len = rowSegs.reduce((n, [t]) => n + t.length, 0);
    const left = center ? Math.max(0, Math.floor((W - len) / 2)) : 0;
    const right = Math.max(0, W - len - left);
    const inner = " ".repeat(left) + rowSegs.map(([t, c]) => wrap(c, t)).join("") + " ".repeat(right);
    box.push(" " + wrap(BORDER, "│") + " " + inner + " " + wrap(BORDER, "│"));
  };
  lines.forEach((l) => {
    if (!l.segs.length) { pushRow([[" ", null]], false); return; }
    const rows = wrapLine(l.segs, W, l.hang || 0);
    rows.forEach((rowSegs, idx) => pushRow(rowSegs, l.center && idx === 0));
  });
  box.push(" " + wrap(BORDER, "└" + "─".repeat(W + 2) + "┘"));
  return "\n" + box.join("\n") + "\n\n";
}
