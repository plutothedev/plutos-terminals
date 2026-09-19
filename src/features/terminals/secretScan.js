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
  // Trailing lookahead, not \b: \b does not fire between a `-`/`_`-class char
  // and whitespace (both are non-word), so a key ending in `-` before a space
  // let the quantifier backtrack and drop that last byte unmasked (latent
  // gap, closed by audit). Applied to every fixed-prefix rule below too.
  { name: "provider-key", re: /\bsk[-_][A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g },
  // Built-in provider/OAuth/bot-token keys with a fixed literal prefix
  // (audit, verified by evaluating each regex directly). Google, Groq, xAI,
  // Hugging Face and NVIDIA are built-in providers (providers.js), so a bare
  // key with no surrounding NAME= shape is exactly what a user's terminal
  // prints, and neither env-secret nor provider-key catches a bare key.
  // {35,} not {35}: with an exact count the trailing lookahead has nothing to
  // give back, so one extra class char after the key failed the lookahead and
  // abandoned the WHOLE match rather than shortening it — `AIza` + 35 + `-x`
  // masked nothing. Every other rule here is open-ended for the same reason.
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35,}(?![0-9A-Za-z_-])/g },
  // A real ya29 access token carries dots inside its tail, so the tail class
  // includes `.` and the lookahead matches that class — without either, the
  // match stopped at the first inner dot and left the rest of the token
  // visible (review). Cost: a token ending a sentence eats the period.
  { name: "google-oauth", re: /\bya29\.[0-9A-Za-z._-]{20,}(?![0-9A-Za-z._-])/g },
  { name: "groq-key", re: /\bgsk_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g },
  { name: "xai-key", re: /\bxai-[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g },
  { name: "hf-token", re: /\bhf_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g },
  { name: "nvidia-key", re: /\bnvapi-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g },
  { name: "tailscale-key", re: /\btskey-[a-z]+-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g },
  // Segments BOUNDED, not open-ended (review): an unbounded head and tail made
  // this rule match any dotted identifier starting with M or N — a .NET/Java
  // logger name or stack frame (`MyApplicationServicesModule.Config.Handler`)
  // and a hashed webpack bundle asset (`Main_vendor_chunk_….a1b2c3.<hash>`)
  // both masked. That is not cosmetic here: this scanner now runs over every
  // Agent Mode shell result before the model sees it, so a masked stack frame
  // costs every user their debugging. The bounds are the real token shape:
  // head = base64url of the bot's snowflake (18-19 digits -> 24 or 26 chars
  // including the M/N sentinel), middle = base64url of the 4-byte timestamp
  // (always exactly 6), tail = the HMAC (27 legacy, 38 on newer tokens).
  { name: "discord-bot-token", re: /\b[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,45}(?![A-Za-z0-9_-])/g },
  { name: "slack-token", re: /\bx(?:ox[abprs]|app)-[A-Za-z0-9-]{10,}\b/g },
  { name: "pem-private-key", re: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]+?-----END \1PRIVATE KEY-----/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Env-dump / config secrets (audit M5): a var-like name CONTAINING a secret
  // word, then = or :, then a non-trivial value. Catches `cat .env`,
  // `kubectl get secret -o yaml`, CI variable exports — the shapes this app's
  // actual use case surfaces. Conservative: requires the secret word in the
  // NAME and a 6+ char value, so `KEY=1` or prose "the key to X" don't match.
  // Accepts an optional quote directly after the NAME (audit): a JSON dump
  // quotes the key (`"GEMINI_API_KEY": "..."`), and the closing quote used to
  // sit where this pattern required `[:=]` immediately, missing every
  // JSON-shaped secret.
  { name: "env-secret", re: /\b[A-Z0-9_]{0,40}(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PWD)[A-Z0-9_]{0,40}["']?\s*[:=]\s*["']?[^\s"'`;|&(][^\s"'`;|&]{5,}/gi },
  // Credentials embedded in a connection URL (DATABASE_URL, amqp://, etc.):
  // scheme://user:pass@ — mask through the '@'.
  { name: "url-credential", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/gi },
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
// Deliberately NO gap/length bounds on a run. Every bounded variant of this
// walk stranded the far side of a body: 3+ blank lines mid-key, a body longer
// than the line cap, a corrupted line splitting a block. The gate is instead
// PRESENCE: only a text that actually contains a private-key banner gets its
// key-shaped line runs masked, and within such a text the module's stated
// tradeoff applies — a false positive masks a harmless string, a false
// negative ships a key. Ordinary prose is not base64-dense, so it survives.

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

const isKeyish = (k) => k === "body" || k === "begin" || k === "end";

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
  // Unpaired-banner fallback, one pass over classified lines. Gate: the text
  // must contain a private-key banner at all — a transcript with no banner
  // anywhere keeps its ordinary base64 output untouched. Inside such a text,
  // every maximal RUN of key-shaped lines (banner or body, gap lines allowed
  // through the middle) is one span. Runs subsume both directions, so there
  // is no "does this END belong to that BEGIN" question to get wrong, and no
  // bound whose far side could be stranded.
  const pemHits = hits.filter((h) => h.name === "pem-private-key");
  // Binary search, not a linear .some(): this runs per banner line, and a
  // linear re-scan is O(banners x pairedHits) — 574 ms on 10k well-formed
  // blocks, the same quadratic shape the line-classified rewrite was meant to
  // retire, just moved into the coverage lookup. Paired matches come from one
  // global regex pass, so they are index-ascending and non-overlapping: the
  // last match starting at or before `i` is the only one that can contain it.
  const covered = (i) => {
    let lo = 0;
    let hi = pemHits.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pemHits[mid].index <= i) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best >= 0 && i < pemHits[best].index + pemHits[best].match.length;
  };
  const lines = classifyLines(s);
  if (!lines.some((l) => l.kind === "begin" || l.kind === "end")) {
    return hits.sort((a, b) => a.index - b.index);
  }
  for (let i = 0; i < lines.length; i++) {
    if (!isKeyish(lines[i].kind) || covered(lines[i].start)) continue;
    let last = i;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (covered(lines[j].start)) break; // a well-formed block owns its own text
      if (isKeyish(lines[j].kind)) { last = j; continue; }
      if (lines[j].kind === "gap") continue; // blank / short remnant: keep going
      break; // real content ends the run
    }
    // Name by what the run opens with, so the common shapes read naturally.
    const name = lines[i].kind === "end" ? "pem-unpaired-end"
      : lines[i].kind === "begin" ? "pem-unpaired-begin"
      : "pem-key-material"; // a bare body run next to a banner elsewhere
    hits.push({ name, match: s.slice(lines[i].start, lines[last].end), index: lines[i].start });
    i = last;
  }
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
  // NOTE (audit M5): the env-secret and url-credential patterns have no fixed
  // literal prefix and CAN partially cross — e.g. `https://TOKEN:pass@host`
  // matches url-credential (`https://TOKEN:pass@`) and env-secret
  // (`TOKEN:pass@host`), neither containing the other. This is safe because in
  // every such crossing the two spans share the sensitive `user:pass@` core, so
  // whichever wins the longest-first race still removes the credential bytes;
  // only non-sensitive boilerplate (a scheme or a trailing host char) can be
  // left visible. A regression test pins this. A FUTURE prefix-less pattern
  // whose sensitive region is NOT a shared subset would break the guarantee —
  // revisit maskSecrets (add span-merge) before adding one.
  //
  // The "fixed-prefix rules cannot cross" half of that is narrower than it
  // reads (review): a prefix containing `_` can cross too, because `_` is a
  // WORD character, so it kills the \b that url-credential's scheme needs.
  // `hf_<25 alnum>https://u:p@h` (no delimiter at all) masks as
  // `[masked hf-token]://u:p@h` — the hf token absorbs `https`, url-credential
  // never matches, and the credential stays visible while visibleHits still
  // reports a masked secret. Same shape for `gsk_`. Accepted, not fixed: it
  // needs a key and a credential URL concatenated with zero separator, which
  // no shell, env dump or config file produces, and the fix is the same
  // span-merge rewrite this note already gates on. If a prefix-with-underscore
  // rule ever lands next to a realistic delimiter-free shape, do the rewrite.
  const uniq = [...new Set(hits.map((h) => h.match))].sort((a, b) => b.length - a.length);
  for (const m of uniq) {
    const name = (hits.find((h) => h.match === m) || {}).name || "secret";
    out = out.split(m).join(`[masked ${name}]`);
  }
  return out;
}
