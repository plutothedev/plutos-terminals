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

// Banner matches for the unpaired-BEGIN / unpaired-END fallbacks (scanSecrets
// post-pass below). Kept out of PATTERNS: bare-banner entries there would
// double-hit every well-formed BEGIN...END blob already caught by
// pem-private-key above.
const BEGIN_BANNER_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const END_BANNER_RE = /-----END [A-Z ]*PRIVATE KEY-----/g;

// A PEM body line: base64 with optional padding, long enough that ordinary
// prose can't be mistaken for one. Used to EXTEND an unpaired banner over the
// key material next to it — flagging a banner while shipping its base64 raw
// was the actual leak (a banner is public boilerplate; the body is the key).
// Documented residual: a final body line shorter than 16 chars is not spanned;
// <16 base64 chars (~11 bytes) is not reconstructable key material.
const BODY_AFTER_RE = /(?:\r?\n[A-Za-z0-9+/]{16,}={0,2})+/y; // sticky: from the banner forward
const BODY_BEFORE_RE = /(?:[A-Za-z0-9+/]{16,}={0,2}\r?\n)+$/; // anchored: back from the banner

// Grow an unpaired banner match to cover the adjacent key body.
function spanForward(s, index, banner) {
  BODY_AFTER_RE.lastIndex = index + banner.length;
  const m = BODY_AFTER_RE.exec(s);
  return m ? { index, match: banner + m[0] } : { index, match: banner };
}

function spanBackward(s, index, banner) {
  const m = BODY_BEFORE_RE.exec(s.slice(0, index));
  if (!m) return { index, match: banner };
  return { index: index - m[0].length, match: m[0] + banner };
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
  // Fail-open gap: a banner whose partner never pairs (truncated paste,
  // mismatched key type, or an UPSTREAM truncation that severed the block —
  // e.g. the transcript read cap dropping whole days) is invisible to the
  // spanning pem-private-key pattern above. Flag from EITHER banner, and span
  // the adjacent body so the key material is masked, not just the boilerplate.
  // Only where a paired hit doesn't already cover the banner.
  const pemHits = hits.filter((h) => h.name === "pem-private-key");
  const covered = (i) => pemHits.some((h) => i >= h.index && i < h.index + h.match.length);
  BEGIN_BANNER_RE.lastIndex = 0;
  let bm;
  while ((bm = BEGIN_BANNER_RE.exec(s))) {
    if (!covered(bm.index)) {
      hits.push({ name: "pem-unpaired-begin", ...spanForward(s, bm.index, bm[0]) });
    }
    if (bm.index === BEGIN_BANNER_RE.lastIndex) BEGIN_BANNER_RE.lastIndex++; // zero-width safety
  }
  // Unpaired END: the mirror case, and the one a head-dropping truncation
  // produces. Skip an END already covered by a paired hit OR already swallowed
  // by an unpaired-BEGIN span (a mismatched-type pair flags once, from BEGIN).
  const beginSpans = hits.filter((h) => h.name === "pem-unpaired-begin");
  END_BANNER_RE.lastIndex = 0;
  let em;
  while ((em = END_BANNER_RE.exec(s))) {
    const inBeginSpan = beginSpans.some((h) => em.index >= h.index && em.index < h.index + h.match.length);
    const hasBeginBefore = beginSpans.some((h) => h.index < em.index) || pemHits.some((h) => h.index < em.index);
    if (!covered(em.index) && !inBeginSpan && !hasBeginBefore) {
      hits.push({ name: "pem-unpaired-end", ...spanBackward(s, em.index, em[0]) });
    }
    if (em.index === END_BANNER_RE.lastIndex) END_BANNER_RE.lastIndex++; // zero-width safety
  }
  return hits.sort((a, b) => a.index - b.index);
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
