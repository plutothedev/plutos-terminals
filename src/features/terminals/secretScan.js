// (C)
// Shared secret scanner. Stream A masks the agent context block with it before
// anything reaches an LLM provider; Stream D reuses it for gist-share preview.
// High-confidence shapes only — a false positive masks a harmless string, a
// false negative ships a secret, so patterns stay conservative but the set is
// easy to extend. (A generic high-entropy heuristic was considered for the
// share flow and dropped for v1: command output legitimately contains hashes/
// base64/UUIDs, so entropy scanning there is high-false-positive.)

const PATTERNS = [
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-pat", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "github-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: "provider-key", re: /\bsk[-_][A-Za-z0-9_-]{20,}\b/g },
  { name: "slack-token", re: /\bx(?:ox[abprs]|app)-[A-Za-z0-9-]{10,}\b/g },
  { name: "pem-private-key", re: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]+?-----END \1PRIVATE KEY-----/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

// ── Unpaired-banner fallback (line-classified) ────────────────────────────
// A banner whose partner never pairs — truncated paste, mismatched key type,
// or an UPSTREAM truncation that severed the block (the transcript read cap
// drops whole days BEFORE any masking runs) — is invisible to the spanning
// pem-private-key pattern above. Flagging the BANNER alone is not enough: a
// banner is public boilerplate, the body is the key, and maskSecrets replaces
// exact match text. So the fallback must cover the adjacent body.
//
// This is deliberately LINE-CLASSIFIED rather than regex line-adjacency.
// Three review rounds of adjacency rules each closed one gap and opened the
// next (padding after the banner, a blank line mid-body, a short line
// mid-body, a second key past a blank run), and the backward rule was
// quadratic — a non-sticky `$`-anchored regex re-run over a fresh
// `slice(0, index)` per END banner (~77 s on a 256 KB share). Classifying
// every line once, then walking line indices, removes that whole class:
// no backtracking, no slicing, and "what continues a key body" is one
// predicate instead of two mirrored regexes.
const BEGIN_BANNER_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const END_BANNER_RE = /-----END [A-Z ]*PRIVATE KEY-----/;
// A body line: base64 (standard alphabet — PEM never uses base64url), long
// enough that prose can't be mistaken for one, after stripping the horizontal
// whitespace raw PTY output pads lines with.
const BODY_LINE_RE = /^[A-Za-z0-9+/]{16,}={0,2}$/;
// A line that interrupts a body without ending it: blank, or a short base64
// remnant (a key's final line, or a truncation artifact).
const GAP_LINE_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_GAP_LINES = 2; // consecutive interruptions tolerated inside one body
const MAX_SPAN_LINES = 400; // bounds worst-case work; a PEM key is ~30-70 lines

// Split once into lines with their absolute offsets, classifying each.
function classifyLines(s) {
  const out = [];
  let start = 0;
  for (;;) {
    let nl = s.indexOf("\n", start);
    const hardEnd = nl === -1 ? s.length : nl;
    const end = hardEnd > start && s[hardEnd - 1] === "\r" ? hardEnd - 1 : hardEnd;
    const raw = s.slice(start, end);
    const t = raw.trim();
    const kind = BEGIN_BANNER_RE.test(t) ? "begin"
      : END_BANNER_RE.test(t) ? "end"
      : BODY_LINE_RE.test(t) ? "body"
      : GAP_LINE_RE.test(t) ? "gap" // blank or short base64 remnant
      : "other";
    out.push({ start, end, kind });
    if (nl === -1) break;
    start = nl + 1;
  }
  return out;
}

// Walk out from a banner line over body lines, tolerating a bounded run of
// gap lines. `step` is +1 (forward from BEGIN) or -1 (backward from END).
// Returns the index of the furthest BODY line claimed, or the banner's own
// line when no body is adjacent.
function walkBody(lines, bannerLine, step) {
  let last = bannerLine;
  let gap = 0;
  for (let i = bannerLine + step, n = 0; i >= 0 && i < lines.length && n < MAX_SPAN_LINES; i += step, n++) {
    const k = lines[i].kind;
    if (k === "body") { last = i; gap = 0; continue; }
    if (k === "gap" && gap < MAX_GAP_LINES) { gap++; continue; }
    break; // "other" content, another banner, or too many gaps: the body ended
  }
  return last;
}

export function scanSecrets(text) {
  const s = String(text ?? "");
  const hits = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      hits.push({ name, match: m[0], index: m.index });
      if (m.index === re.lastIndex) re.lastIndex++; // zero-width safety
    }
  }
  // Unpaired-banner fallback: one pass over classified lines. Each banner not
  // already inside a paired hit claims its adjacent body; overlapping claims
  // MERGE into one span, which is what makes the two directions agree without
  // a "does this END belong to that BEGIN" heuristic (the previous version's
  // guess suppressed a genuinely separate second key).
  const pemHits = hits.filter((h) => h.name === "pem-private-key");
  const covered = (i) => pemHits.some((h) => i >= h.index && i < h.index + h.match.length);
  const lines = classifyLines(s);
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    const { kind, start, end } = lines[i];
    if (kind !== "begin" && kind !== "end") continue;
    if (covered(start)) continue;
    const far = walkBody(lines, i, kind === "begin" ? 1 : -1);
    spans.push(
      kind === "begin"
        ? { from: start, to: lines[far].end, name: "pem-unpaired-begin" }
        : { from: lines[far].start, to: end, name: "pem-unpaired-end" }
    );
  }
  spans.sort((a, b) => a.from - b.from);
  for (const sp of spans) {
    const prev = hits[hits.length - 1];
    const mergeable = prev && prev.pemSpan && sp.from <= prev.index + prev.match.length;
    if (mergeable) {
      const to = Math.max(prev.index + prev.match.length, sp.to);
      prev.match = s.slice(prev.index, to);
      continue;
    }
    hits.push({ name: sp.name, match: s.slice(sp.from, sp.to), index: sp.from, pemSpan: true });
  }
  for (const h of hits) delete h.pemSpan;
  return hits.sort((a, b) => a.index - b.index);
}

// Keep only the hits whose placeholder actually SURVIVES into `finalText`.
// Both callers mask before they cut to a budget, so a secret living only in
// the dropped region is masked-then-discarded — counting it would tell the
// user "N secrets masked in the upload above" about text that isn't there.
// Counts placeholders per name (they're indistinguishable once masked) and
// keeps that many hits of that name.
//
// CONTRACT: the returned COUNT (and the set of names) is authoritative; the
// per-hit IDENTITY is not. When two distinct secrets share a pattern name and
// only some survive, the kept entries are the first N of that name by scan
// order, which may not be the ones whose placeholders remain. Today every
// consumer only counts or groups by name (ShareModal's secretNameCounts,
// AgentMode's unique-match tally), so this is inert — but do not build
// "which file did this secret come from" on hits[].match/.index without
// fixing the attribution first.
export function visibleHits(finalText, hits) {
  const text = String(finalText ?? "");
  const names = new Set((hits || []).map((h) => h.name));
  const out = [];
  for (const name of names) {
    const ph = `[masked ${name}]`;
    let count = 0;
    for (let i = text.indexOf(ph); i !== -1; i = text.indexOf(ph, i + ph.length)) count++;
    out.push(...hits.filter((h) => h.name === name).slice(0, count));
  }
  return out.sort((a, b) => a.index - b.index);
}

export function maskSecrets(text, hits) {
  const out0 = String(text ?? "");
  if (!hits || !hits.length) return out0;
  let out = out0;
  // Replace longest-first so overlapping/nested matches can't resurrect bytes.
  // Assumes no partial (crossing) overlaps: every pattern anchors on a distinct
  // literal prefix, so matches never partially cross; revisit if a pattern
  // without a literal prefix is added.
  const uniq = [...new Set(hits.map((h) => h.match))].sort((a, b) => b.length - a.length);
  for (const m of uniq) {
    const name = (hits.find((h) => h.match === m) || {}).name || "secret";
    out = out.split(m).join(`[masked ${name}]`);
  }
  return out;
}
