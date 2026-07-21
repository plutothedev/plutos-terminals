// (C)
// Pure markdown block model for runnable notebooks. No Tauri imports — this
// module only knows about text in, text out. A "block" is a fenced code
// block whose lang is shell-family (sh|bash|powershell|pwsh|cmd). An
// immediately-following fence of lang `output` (0 or 1 blank line gap, no
// intervening prose, no non-runnable fence in between) is that block's OWNED
// output, rewritten in place on rerun — writeOutput never touches anything
// outside that owned range. Frontmatter is a minimal regex-only leading
// `---` block understanding a single key (`targetPane`) — no YAML dependency.
//
// Fence scanning is line-anchored (CommonMark-ish): a line only opens/closes
// a fence when, after up to 3 leading spaces, it consists of a run of 3+
// backticks (optionally followed by an info string for the OPEN line only —
// the CLOSE line must be backticks + trailing whitespace ONLY). A closing
// run must have at least as many backticks as the opening run, which is what
// lets a 4-plus-backtick fence safely contain a literal ``` in its body.
//
// runnableKind is deliberately NOT a shell lexer (DESIGN DECISION 2026-07-21,
// post three audit rounds): it reduces code to "runnable lines" (drop blanks
// + sh-family `#` comments) and classifies "multiline" whenever more than one
// runnable line remains, OR exactly one remains but is lexically incomplete
// per a fixed, closed 5-lang continuation-char table. Only a lone complete
// line is "single" — the only kind v1 ever sends to a live pane (via
// runAndCapture, unchanged, elsewhere). Accepted documented gap: an unclosed
// quote/paren on a single line is not detected (would require real lexing);
// such a line can hang the pane at a continuation prompt until timeout.

const RUNNABLE_LANGS = new Set(["sh", "bash", "powershell", "pwsh", "cmd"]);
const SH_FAMILY = new Set(["sh", "bash"]);
const MAX_OUTPUT_CHARS = 256 * 1024;
const TRUNCATE_MARKER = "[...truncated at 256KB]";

// Fixed lang -> continuation-char table (closed 5-lang enum, not a grammar).
// cmd/powershell trailing "\" is deliberately EXCLUDED here: it's a Windows
// path separator there (`cd C:\Users\pluto\` is a complete line), not a
// continuation — only sh/bash treat trailing "\" as line continuation.
const CONTINUATION_CHAR = { sh: "\\", bash: "\\", powershell: "`", pwsh: "`", cmd: "^" };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const TARGET_PANE_RE = /^targetPane:[ \t]*(.*?)[ \t]*$/m;

// OPEN allows a full info string after the lang token (CommonMark rule; the
// notebook's own `output` fence header packs "(<timestamp>, exit <exit>)"
// after the lang word, so trailing content must be permitted here).
const FENCE_OPEN_RE = /^ {0,3}(`{3,})[ \t]*([^\s`]*).*$/;
// CLOSE must be backticks and nothing else (only trailing spaces/tabs).
const FENCE_CLOSE_RE = /^ {0,3}(`{3,})[ \t]*$/;

function dominantEOL(text) {
  const s = String(text ?? "");
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") {
      if (s[i - 1] === "\r") crlf++;
      else lf++;
    }
  }
  return crlf > lf ? "\r\n" : "\n";
}

// Splits into lines carrying absolute char offsets. Each line's `end`
// includes its own terminator (1 char for lone \n or \r, 2 for \r\n). A
// final line with no terminator still gets an entry (end === text.length);
// text ending exactly on a terminator does NOT synthesize a phantom empty
// trailing line (matches how the "EOF, no trailing newline" fixtures read).
function splitLines(text) {
  const lines = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && text.charCodeAt(j) !== 10 && text.charCodeAt(j) !== 13) j++;
    let end = j;
    if (j < n) end = text[j] === "\r" && text[j + 1] === "\n" ? j + 2 : j + 1;
    lines.push({ text: text.slice(i, j), start: i, end });
    i = end;
  }
  return lines;
}

function matchFenceOpen(line) {
  const m = FENCE_OPEN_RE.exec(line);
  if (!m) return null;
  return { ticks: m[1].length, lang: m[2].toLowerCase() };
}

function matchFenceClose(line, minTicks) {
  const m = FENCE_CLOSE_RE.exec(line);
  return !!m && m[1].length >= minTicks;
}

function parseFrontmatter(text) {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { frontmatter: {}, bodyStart: 0 };
  const frontmatter = {};
  const tp = TARGET_PANE_RE.exec(m[1]);
  if (tp) frontmatter.targetPane = tp[1];
  return { frontmatter, bodyStart: m[0].length };
}

// All fenced regions in document order (any lang), scanned only from
// `fromOffset` onward so frontmatter content is never mistaken for a fence.
function scanFences(text, fromOffset) {
  const lines = splitLines(text);
  let idx = lines.findIndex((l) => l.start >= fromOffset);
  if (idx === -1) idx = lines.length;
  const fences = [];
  while (idx < lines.length) {
    const open = matchFenceOpen(lines[idx].text);
    if (!open) {
      idx++;
      continue;
    }
    let closeIdx = -1;
    for (let k = idx + 1; k < lines.length; k++) {
      if (matchFenceClose(lines[k].text, open.ticks)) {
        closeIdx = k;
        break;
      }
    }
    if (closeIdx === -1) {
      // Unterminated fence: not a valid block. Treat the open line as
      // ordinary text and keep scanning (never crash, never misparse).
      idx++;
      continue;
    }
    fences.push({
      lang: open.lang,
      code: text.slice(lines[idx].end, lines[closeIdx].start),
      start: lines[idx].start,
      end: lines[closeIdx].end,
      openIdx: idx,
      closeIdx,
    });
    idx = closeIdx + 1;
  }
  return { fences, lines };
}

export function parseBlocks(md) {
  const text = String(md ?? "");
  const { frontmatter, bodyStart } = parseFrontmatter(text);
  const { fences, lines } = scanFences(text, bodyStart);

  const blocks = [];
  let runnableIndex = 0;
  for (let fi = 0; fi < fences.length; fi++) {
    const fence = fences[fi];
    if (!RUNNABLE_LANGS.has(fence.lang)) continue;

    let outputFence = null;
    const next = fences[fi + 1];
    if (next && next.lang === "output") {
      const gap = next.openIdx - fence.closeIdx - 1; // lines strictly between
      const gapIsBlank = gap === 1 && lines[fence.closeIdx + 1].text.trim() === "";
      if (gap === 0 || gapIsBlank) outputFence = { start: next.start, end: next.end };
    }

    blocks.push({
      index: runnableIndex++,
      lang: fence.lang,
      code: fence.code,
      start: fence.start,
      end: fence.end,
      outputFence,
    });
  }
  return { blocks, frontmatter };
}

export function writeOutput(md, blockIndex, { output, exit, timestamp }) {
  const text = String(md ?? "");
  const { blocks } = parseBlocks(text);
  const block = blocks[blockIndex];
  if (!block) throw new Error(`writeOutput: no block at index ${blockIndex}`);

  const NL = dominantEOL(text);
  const raw = String(output ?? "");
  const sliced = raw.length > MAX_OUTPUT_CHARS ? raw.slice(0, MAX_OUTPUT_CHARS) : raw;
  const withMarker = raw.length > MAX_OUTPUT_CHARS ? `${sliced}\n${TRUNCATE_MARKER}` : sliced;
  const content = withMarker.replace(/\r\n|\r|\n/g, NL);

  const header = `\`\`\`output (${timestamp}, exit ${exit})`;
  const newFence = `${header}${NL}${content}${NL}\`\`\`${NL}`;

  if (block.outputFence) {
    return text.slice(0, block.outputFence.start) + newFence + text.slice(block.outputFence.end);
  }
  let before = text.slice(0, block.end);
  if (before.length && !/[\r\n]$/.test(before)) before += NL; // code fence was at EOF, no terminator yet
  return before + newFence + text.slice(block.end);
}

export function setFrontmatterTarget(md, paneId) {
  const text = String(md ?? "");
  const NL = dominantEOL(text);
  const m = FRONTMATTER_RE.exec(text);
  if (!m) {
    return `---${NL}targetPane: ${paneId}${NL}---${NL}${text}`;
  }
  let fmContent = m[1];
  if (TARGET_PANE_RE.test(fmContent)) {
    fmContent = fmContent.replace(TARGET_PANE_RE, `targetPane: ${paneId}`);
  } else {
    const sep = fmContent.length && !/[\r\n]$/.test(fmContent) ? NL : "";
    fmContent = `${fmContent}${sep}targetPane: ${paneId}`;
  }
  return `---${NL}${fmContent}${NL}---${NL}${text.slice(m[0].length)}`;
}

export function runnableKind(code, lang) {
  const rawLines = String(code ?? "").split(/\r\n|\r|\n/);
  const isShFamily = SH_FAMILY.has(lang);
  const runnable = rawLines
    .map((l) => l.replace(/[ \t]+$/, "")) // trailing-whitespace trim, for suffix checks below
    .filter((l) => {
      const t = l.trim();
      if (t === "") return false;
      if (isShFamily && t.startsWith("#")) return false;
      return true;
    });

  if (runnable.length === 0) return "single"; // nothing to run; trivially not incomplete
  if (runnable.length > 1) return "multiline";

  const line = runnable[0];
  const contChar = CONTINUATION_CHAR[lang];
  const incomplete =
    (!!contChar && line.endsWith(contChar)) ||
    line.includes("<<") ||
    line.endsWith("&&") ||
    line.endsWith("||") ||
    line.endsWith("|");
  return incomplete ? "multiline" : "single";
}
