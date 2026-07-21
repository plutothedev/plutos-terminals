// (C)
// Shared secret scanner. Stream A masks the agent context block with it before
// anything reaches an LLM provider; Stream D reuses it for gist-share preview.
// High-confidence shapes only — a false positive masks a harmless string, a
// false negative ships a secret, so patterns stay conservative but the set is
// easy to extend. Entropy heuristics live with Stream D (share flow), not here.

const PATTERNS = [
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-pat", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "github-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: "provider-key", re: /\bsk[-_][A-Za-z0-9_-]{20,}\b/g },
  { name: "slack-token", re: /\bx(?:ox[abprs]|app)-[A-Za-z0-9-]{10,}\b/g },
  { name: "pem-private-key", re: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]+?-----END \1PRIVATE KEY-----/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

// Banner-only match for the unpaired-BEGIN fallback (scanSecrets post-pass below).
// Kept out of PATTERNS: a bare-banner entry there would double-hit every
// well-formed BEGIN...END blob already caught by pem-private-key above.
const BEGIN_BANNER_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;

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
  // Fail-open gap: a BEGIN banner whose END never pairs (truncated paste,
  // mismatched key type) is invisible to the spanning pem-private-key pattern
  // above and would otherwise ship unmasked with zero hits. Flag the banner
  // itself, but only where a paired hit doesn't already cover it.
  const pemHits = hits.filter((h) => h.name === "pem-private-key");
  BEGIN_BANNER_RE.lastIndex = 0;
  let bm;
  while ((bm = BEGIN_BANNER_RE.exec(s))) {
    const covered = pemHits.some((h) => bm.index >= h.index && bm.index < h.index + h.match.length);
    if (!covered) hits.push({ name: "pem-unpaired-begin", match: bm[0], index: bm.index });
    if (bm.index === BEGIN_BANNER_RE.lastIndex) BEGIN_BANNER_RE.lastIndex++; // zero-width safety
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
