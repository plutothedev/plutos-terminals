// (C)
// Pure markdown block model for runnable notebooks. No Tauri imports — this
// module only knows about text in, text out. A "block" is a fenced code
// block whose lang is shell-family (sh|bash|powershell|pwsh|cmd). An
// immediately-following fence of lang `output` (0 or 1 blank line gap, no
// intervening prose, no non-runnable fence in between) is that block's OWNED
// output, rewritten in place on rerun — writeOutput never touches anything
// outside that owned range. Frontmatter is a minimal leading `---` block
// understanding a single key (`targetPane`) — no YAML dependency.
//
// Fence scanning is a SINGLE linear pass (state machine: either "not inside
// a fence" or "inside a fence waiting for its close"), CommonMark-ish:
//   - Only a LANG-BEARING backtick line (3+ backticks + a non-empty first
//     token) can OPEN a fence. A bare backtick-only line can never open one
//     — real notebook fences always carry a lang (sh/bash/powershell/pwsh/
//     cmd/output); treating a bare ``` as an opener means a single stray
//     close-shaped line anywhere in the document swallows everything up to
//     the next same-length backtick run as its "body", silently eating real
//     blocks (REGRESSION, fixed 2026-07-21).
//   - The OPEN line may carry a trailing info string (CommonMark rule) —
//     the notebook's own `output` header packs "(<timestamp>, exit <exit>)"
//     after the lang word, so trailing content must be allowed there.
//   - The CLOSE line must be backticks and nothing else (only trailing
//     whitespace), with a run at least as long as the opening run — this is
//     what lets a wider fence safely contain a literal, shorter backtick run
//     in its body (4-plus-backtick code fences; output content that itself
//     contains ``` — see writeOutput's backtick-run sizing below).
//   - An unclosed fence swallows the rest of the document as its body (real
//     CommonMark semantics) and is dropped (not a valid block) at EOF.
//
// Frontmatter detection is fence-AWARE: a leading `---` line is only ever
// treated as a frontmatter opener if a matching bare `---` closer is found
// BEFORE the first code fence in the document. Pluto's own vault page
// format uses a bare leading `---` as a compiled-truth/timeline divider (not
// YAML), and a heredoc body (`cat <<EOF` / `---` / `EOF`) inside a code
// fence can contain a `---` line too — without this guard either pattern
// can make the parser swallow real code fences into "frontmatter",
// silently losing every block in the document (REGRESSION, fixed
// 2026-07-21).
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

const TARGET_PANE_RE = /^targetPane:[ \t]*(.*?)[ \t]*$/m;
const DASH_LINE_RE = /^---[ \t]*$/;

// OPEN allows a full info string after the lang token (CommonMark rule).
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

// Slice that never strands a lone UTF-16 high surrogate at the cut point
// (mirrors agentContext.js's safeSlice — same failure mode, same fix).
function safeSlice(s, n) {
  if (s.length <= n) return s;
  let end = n;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

// Longest run of consecutive backticks anywhere in `s`. Used to size a
// freshly-written fence wide enough that no backtick run already present in
// the content can be mistaken for (or prematurely trigger) its close.
function longestBacktickRun(s) {
  let max = 0;
  let cur = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "`") {
      cur++;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}

function isDashLine(t) {
  return DASH_LINE_RE.test(t);
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

// Single linear pass over the document's lines producing every fenced
// region (any lang) in document order. O(n) in line count — no re-scanning
// from each candidate open, which is what made the old implementation
// quadratic on documents with many close-shaped lines (re-parsed on every
// notebook edit).
function scanFences(text) {
  const lines = splitLines(text);
  const fences = [];
  let open = null; // { ticks, lang, openIdx } while inside a fence, else null
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i].text;
    if (open) {
      if (matchFenceClose(lineText, open.ticks)) {
        fences.push({
          lang: open.lang,
          code: text.slice(lines[open.openIdx].end, lines[i].start),
          start: lines[open.openIdx].start,
          end: lines[i].end,
          openIdx: open.openIdx,
          closeIdx: i,
        });
        open = null;
      }
      // else: ordinary content line, still inside the open fence.
      continue;
    }
    const candidate = matchFenceOpen(lineText);
    if (candidate && candidate.lang) open = { ticks: candidate.ticks, lang: candidate.lang, openIdx: i };
    // A bare (empty-lang) backtick-only line here is inert — never an opener.
  }
  // `open` left non-null at EOF means an unterminated fence: real CommonMark
  // semantics say it swallows the rest of the document; we simply don't
  // record it as a fence (not a valid block either way).
  return { fences, lines };
}

// Detects a real frontmatter block: the document's first line must be a
// bare `---`, AND a matching bare `---` closer must appear at a line whose
// start precedes the first fence in the document (fence-aware — see the
// module header for why). Returns null when there is no frontmatter.
function detectFrontmatter(fences, lines, text) {
  if (!lines.length || !isDashLine(lines[0].text)) return null;
  const firstFenceStart = fences.length ? fences[0].start : Infinity;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].start >= firstFenceStart) return null; // hit a real fence before any closer
    if (isDashLine(lines[i].text)) {
      return { contentStart: lines[0].end, contentEnd: lines[i].start, blockEnd: lines[i].end };
    }
  }
  return null;
}

export function parseBlocks(md) {
  const text = String(md ?? "");
  const { fences, lines } = scanFences(text);
  const fm = detectFrontmatter(fences, lines, text);

  const frontmatter = {};
  if (fm) {
    const tp = TARGET_PANE_RE.exec(text.slice(fm.contentStart, fm.contentEnd));
    if (tp) frontmatter.targetPane = tp[1];
  }

  // NOTE: fences never need filtering by the frontmatter boundary here — by
  // construction, detectFrontmatter only returns non-null when its closer
  // line starts strictly before fences[0].start, so every fence already
  // starts at or after the frontmatter's end.
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
  const needsTruncation = raw.length > MAX_OUTPUT_CHARS;
  const sliced = needsTruncation ? safeSlice(raw, MAX_OUTPUT_CHARS) : raw;
  const withMarker = needsTruncation ? `${sliced}\n${TRUNCATE_MARKER}` : sliced;
  const content = withMarker.replace(/\r\n|\r|\n/g, NL);

  // Size the fence wider than any backtick run already present in the
  // content (which is arbitrary command output — `cat *.md`/`git diff` on
  // markdown routinely contains its own ``` fences) so the written fence
  // can never be mis-closed by its own body on the next parse.
  const ticks = Math.max(3, longestBacktickRun(content) + 1);
  const marker = "`".repeat(ticks);
  const header = `${marker}output (${timestamp}, exit ${exit})`;
  const newFence = `${header}${NL}${content}${NL}${marker}${NL}`;

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
  const { fences, lines } = scanFences(text);
  const fm = detectFrontmatter(fences, lines, text);

  if (!fm) {
    return `---${NL}targetPane: ${paneId}${NL}---${NL}${text}`;
  }
  let fmContent = text.slice(fm.contentStart, fm.contentEnd);
  if (TARGET_PANE_RE.test(fmContent)) {
    // Function replacer: paneId is inserted LITERALLY. A string replacer
    // interprets "$&"/"$1"/"$$" etc. in paneId as replacement patterns,
    // corrupting the frontmatter (REGRESSION, fixed 2026-07-21).
    fmContent = fmContent.replace(TARGET_PANE_RE, () => `targetPane: ${paneId}`);
  } else {
    const sep = fmContent.length && !/[\r\n]$/.test(fmContent) ? NL : "";
    fmContent = `${fmContent}${sep}targetPane: ${paneId}`;
  }
  return `---${NL}${fmContent}${NL}---${NL}${text.slice(fm.blockEnd)}`;
}

// The line reducer, EXPORTED as the single source of truth (release-audit
// fix): NotebookView imports this instead of hand-copying the reduction —
// runnability classification and the line actually sent to the pane can
// never drift apart. Trailing whitespace is trimmed (the suffix checks in
// runnableKind depend on it); leading indent is preserved.
export function runnableLines(code, lang) {
  const isShFamily = SH_FAMILY.has(lang);
  return String(code ?? "")
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/[ \t]+$/, ""))
    .filter((l) => {
      const t = l.trim();
      if (t === "") return false;
      if (isShFamily && t.startsWith("#")) return false;
      return true;
    });
}

export function runnableKind(code, lang) {
  const runnable = runnableLines(code, lang);

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
