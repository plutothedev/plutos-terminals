// (C)
import { describe, it, expect } from "vitest";
import { scanSecrets, maskSecrets } from "./secretScan.js";

const FAKE_PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIBOgIBAAJBAKj34GkxFhD91RaHU1KFwqBSqcHTPYFbUxk2mBjRhkiK5RGbrJmB",
  "UnwqNSJqDPzO0PyEnAWQdHF/eBg7v6/6zpQCAwEAAQ==",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

const FAKE_PEM_EC = [
  "-----BEGIN EC PRIVATE KEY-----",
  "MHcCAQEEIDlowFAYpwIsCzoM3lZDaOOJFrbCuCoxYRitTGWKF7WoAoGCCqGSM49",
  "AwEHoUQDQgAEuNWFwoRzntohK9y1M3y2sYbxLon1MZgpf2Db0jzfLomOQbXqzYZ",
  "-----END EC PRIVATE KEY-----",
].join("\n");

// Fixed-prefix provider/OAuth/bot-token fixtures (audit), built at runtime by
// concatenation/repeat so no key-shaped literal sits in this source file —
// GitHub push protection scans pushed file TEXT for these exact shapes.
const GOOGLE_KEY = "AIza" + "Sy" + "D".repeat(33); // "AIza" + 35 chars
const GOOGLE_OAUTH = "ya29" + "." + "b".repeat(25);
const GROQ_KEY = "gsk_" + "a".repeat(52);
const XAI_KEY = "xai-" + "c".repeat(25);
const HF_TOKEN = "hf_" + "b".repeat(34);
const NVIDIA_KEY = "nvapi" + "-" + "d".repeat(25);
const TAILSCALE_KEY = "tskey" + "-" + "auth" + "-" + "e".repeat(25);
const DISCORD_TOKEN = "M" + "x".repeat(23) + "." + "y".repeat(6) + "." + "z".repeat(27);

describe("scanSecrets", () => {
  const cases = [
    ["aws-access-key", "key=AKIAIOSFODNN7EXAMPLE ok"],
    ["aws-access-key", "ASIAIOSFODNN7EXAMPLE in env"],
    ["github-pat", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["github-fine-grained", "github_pat_11ABCDEFG0_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV"],
    ["provider-key", "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx"],
    ["provider-key", "STRIPE_SECRET_KEY=sk_live_abcdefghijklmnopqrstuvwx"],
    ["slack-token", "xoxb-123456789012-abcdefghijklmnop"],
    ["slack-token", "xapp-1-A0123456789-abcdefghijklm"],
    ["pem-private-key", FAKE_PEM],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    // env-dump / config secrets (audit M5)
    ["env-secret", "DB_PASSWORD=hunter2secret"],
    ["env-secret", "  AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE"],
    ["env-secret", "export API_TOKEN=abcdef123456"],
    ["url-credential", "DATABASE_URL=postgres://admin:s3cr3tpass@db.host:5432/app"],
    // Fixed-prefix provider/OAuth/bot-token formats (audit): bare keys with
    // no env-var name around them, exactly what a terminal prints for these
    // built-in providers.
    ["google-api-key", `key: ${GOOGLE_KEY} end`],
    ["google-oauth", `token=${GOOGLE_OAUTH} end`],
    ["groq-key", `GROQ_API_KEY=${GROQ_KEY}`],
    ["xai-key", `XAI_API_KEY=${XAI_KEY}`],
    ["hf-token", `HF_TOKEN=${HF_TOKEN}`],
    ["nvidia-key", `NVIDIA_API_KEY=${NVIDIA_KEY}`],
    ["tailscale-key", `auth key: ${TAILSCALE_KEY}`],
    ["discord-bot-token", `token: ${DISCORD_TOKEN}`],
    // JSON-quoted env name (audit): env-secret used to require [:=] directly
    // after the NAME, missing `"GEMINI_API_KEY": "..."` dumps.
    ["env-secret", `"GEMINI_API_KEY": "${GOOGLE_KEY}"`],
  ];
  for (const [name, text] of cases) {
    it(`detects ${name}`, () => {
      const hits = scanSecrets(text);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.map((h) => h.name)).toContain(name);
    });
  }

  it("ignores benign lookalikes", () => {
    const benign = [
      "we went skiing, sk-i trip was fun",         // too short for provider-key
      "AKIA is mentioned in the docs",              // no 16-char tail
      "eyJhbGciOiJIUzI1NiJ9.onlytwoparts",          // 2-part, not a JWT
      "ghp_short",                                  // wrong length
      "xoxq-000",                                   // wrong slack letter + short
      "AIzaShort",                                   // way under the 35-char tail
      "gsk_short",                                   // way under the 20-char tail
      "hf_ab",                                        // way under the 20-char tail
      "the ya29 bucket",                              // no dot, no token tail
      // Real strings the UNBOUNDED discord-bot-token rule masked (review): a
      // .NET/Java logger name or stack frame, and a hashed webpack bundle
      // asset. Both start with M, both carry a 6-char middle segment, and the
      // second's tail is a legal 32-char hex hash — only the head bound
      // rejects them, and this scanner now runs over every Agent Mode shell
      // result, so masking these would cost every user their stack traces.
      "MyApplicationServicesModule.Config.RegisterAllTheThingsHandler",
      "Main_vendor_chunk_abcdefghijklmnop.a1b2c3.9f8e7d6c5b4a39281706f5e4d3c2b1a0",
      // Exact off-by-one rejections (review): everything above is far too
      // short, so a loosened quantifier would still be caught by nothing.
      // These sit one character under each floor (or over each ceiling), which
      // is where a future widening actually fails. Concatenated, never
      // literal — GitHub push protection scans this file's text.
      "AIza" + "S".repeat(34),                      // tail floor is 35
      "ya29" + "." + "f".repeat(19),                // tail floor is 20
      "gsk_" + "a".repeat(19),                      // tail floor is 20
      "hf_" + "b".repeat(19),                       // tail floor is 20
      "xai-" + "c".repeat(19),                      // tail floor is 20
      "nvapi" + "-" + "d".repeat(19),               // tail floor is 20
      "tskey" + "-" + "auth" + "-" + "e".repeat(19), // tail floor is 20
      // discord segments: head 23-25 after the M/N sentinel, middle 6, tail 27-45.
      "M" + "x".repeat(22) + "." + "y".repeat(6) + "." + "z".repeat(27), // head 1 short
      "M" + "x".repeat(26) + "." + "y".repeat(6) + "." + "z".repeat(27), // head 1 long
      "M" + "x".repeat(23) + "." + "y".repeat(6) + "." + "z".repeat(26), // tail 1 short
    ].join("\n");
    expect(scanSecrets(benign)).toEqual([]);
  });

  it("does not false-positive the env/url shapes on benign prose (audit M5)", () => {
    const benign = [
      "the key to success = happiness in life",   // KEY but name isn't contiguous with =value
      "press any key to continue",                 // no assignment
      "visit https://user.example.com/path here",  // url, but no user:pass@ credential
      "KEY=1",                                     // value too short (<6)
      "Password: (leave blank for none)",          // parenthetical hint, not a value
      "--passphrase: (optional, prompts if omitted)",
    ].join("\n");
    expect(scanSecrets(benign)).toEqual([]);
  });

  it("credential is always masked even when env-secret and url-credential cross (audit M5)", () => {
    // Neither span contains the other, but they share the user:pass@ core.
    for (const raw of [
      "curl https://TOKEN:abc123xyz@example.com/api",
      "DATABASE_URL=https://TOKEN:pass123@host",
    ]) {
      const masked = maskSecrets(raw, scanSecrets(raw));
      expect(masked).not.toContain("abc123xyz");
      expect(masked).not.toContain("pass123");
      expect(masked).not.toContain("TOKEN:"); // the credential core is gone
    }
  });

  // Regression: unpaired-BEGIN fallback (closes the fail-open gap where a BEGIN
  // banner whose END never pairs used to yield ZERO hits).
  it("well-formed single PEM blob produces exactly one hit (no fallback double-hit)", () => {
    const hits = scanSecrets(FAKE_PEM);
    expect(hits.length).toBe(1);
    expect(hits[0].name).toBe("pem-private-key");
  });

  it("mismatched BEGIN RSA ... END EC yields no paired hit but the fallback spans banner + body", () => {
    const text = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBOgIBAAJBAKj34GkxFhD91RaHU1KFwqBSqcHTPYFbUxk2mBjRhkiK5RGbrJmB",
      "-----END EC PRIVATE KEY-----",
    ].join("\n");
    const hits = scanSecrets(text);
    expect(hits.filter((h) => h.name === "pem-private-key").length).toBe(0);
    const unpaired = hits.filter((h) => h.name === "pem-unpaired-begin");
    expect(unpaired.length).toBe(1);
    // Contract change (release audit): the fallback covers the KEY BODY, not
    // just the banner — flagging a banner while shipping the base64 raw was
    // the actual leak.
    expect(unpaired[0].match).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(unpaired[0].match).toContain("MIIBOgIBAAJBAKj34GkxFhD91RaHU1KFwqBSqcHTPYFbUxk2mBjRhkiK5RGbrJmB");
  });
});

// Release-audit CRITICAL: a PEM bisected by an UPSTREAM truncation (the Rust
// transcript read cap severs whole days before the text ever reaches this
// scanner) must not ship its key body raw — in EITHER direction. The
// unpaired-BEGIN fallback existed but masked only the banner; there was no
// unpaired-END fallback at all, so an END-kept fragment scored zero hits and
// uploaded with no warning and no masking.
describe("scanSecrets — bisected PEM blocks (upstream truncation)", () => {
  const BODY_A = "MIIEowIBAAKCAQEAx7Zk9fQ2vLmN8pQrStUvWxYz0123456789abcdefGHIJKLMN";
  const BODY_B = "OPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/AAAAAAAAAAAAAA";

  it("END kept but BEGIN severed: flags a hit and masks the surviving body", () => {
    const text = `${BODY_A}\n${BODY_B}\n-----END RSA PRIVATE KEY-----\n`;
    const hits = scanSecrets(text);
    expect(hits.length).toBeGreaterThan(0); // was ZERO — silent leak
    const masked = maskSecrets(text, hits);
    expect(masked).not.toContain(BODY_A);
    expect(masked).not.toContain(BODY_B);
  });

  it("BEGIN kept but END severed: masks the body, not just the banner", () => {
    const text = `-----BEGIN RSA PRIVATE KEY-----\n${BODY_A}\n${BODY_B}\n`;
    const masked = maskSecrets(text, scanSecrets(text));
    expect(masked).not.toContain(BODY_A);
    expect(masked).not.toContain(BODY_B);
  });

  it("does not swallow ordinary prose adjacent to a bisected block", () => {
    const text = `before\n-----BEGIN RSA PRIVATE KEY-----\n${BODY_A}\nafter\n`;
    const masked = maskSecrets(text, scanSecrets(text));
    expect(masked).not.toContain(BODY_A);
    expect(masked).toContain("before");
    expect(masked).toContain("after");
  });

  it("a whole PEM still produces exactly one paired hit (no fallback double-hit)", () => {
    const text = `-----BEGIN RSA PRIVATE KEY-----\n${BODY_A}\n${BODY_B}\n-----END RSA PRIVATE KEY-----\n`;
    const hits = scanSecrets(text);
    expect(hits.length).toBe(1);
    expect(hits[0].name).toBe("pem-private-key");
  });

  it("body lines carrying terminal padding (trailing spaces) are still spanned", () => {
    // Real-world shape: raw PTY output pads lines to the pane width, so a
    // captured key's body lines can carry trailing spaces/tabs. Requiring a
    // body line to end exactly at the newline let the whole body through.
    const withPad = `${BODY_A}   \n${BODY_B}\t\n-----END RSA PRIVATE KEY-----\n`;
    const maskedPad = maskSecrets(withPad, scanSecrets(withPad));
    expect(maskedPad).not.toContain(BODY_A);
    expect(maskedPad).not.toContain(BODY_B);

    const dangling = `-----BEGIN RSA PRIVATE KEY-----\n${BODY_A}  \n${BODY_B}   \n`;
    const maskedDangling = maskSecrets(dangling, scanSecrets(dangling));
    expect(maskedDangling).not.toContain(BODY_A);
    expect(maskedDangling).not.toContain(BODY_B);
  });

  // Round-3 adversarial findings. Each of these shipped a raw key body through
  // the real buildShare path; they are the reason the fallback moved from
  // regex line-adjacency to a line-classified scan.
  describe("adjacency edge cases that previously leaked", () => {
    const A = "A".repeat(40);
    const Bb = "B".repeat(40);
    const maskOf = (t) => maskSecrets(t, scanSecrets(t));

    it("a second key separated from an earlier banner by blank lines is still flagged", () => {
      const t = `-----BEGIN RSA PRIVATE KEY-----\n${A}\n\n\n${Bb}\n-----END EC PRIVATE KEY-----\n`;
      const m = maskOf(t);
      expect(m).not.toContain(A);
      expect(m).not.toContain(Bb);
    });

    it("a blank line inside a body does not strand the far side (forward)", () => {
      const m = maskOf(`-----BEGIN RSA PRIVATE KEY-----\n${A}\n\n${Bb}`);
      expect(m).not.toContain(A);
      expect(m).not.toContain(Bb);
    });

    it("a short line inside a body does not strand the far side (backward)", () => {
      const m = maskOf(`${A}\nABCDEFGHIJKLMNO\n${Bb}\n-----END RSA PRIVATE KEY-----`);
      expect(m).not.toContain(A);
      expect(m).not.toContain(Bb);
    });

    it("padding on the BEGIN banner's own line does not defeat the span", () => {
      const m = maskOf(`-----BEGIN RSA PRIVATE KEY----- \n${A}\n${Bb}`);
      expect(m).not.toContain(A);
      expect(m).not.toContain(Bb);
    });

    it("padding on the END banner's own line does not defeat the span", () => {
      const m = maskOf(`${A}\n${Bb}\n -----END RSA PRIVATE KEY-----`);
      expect(m).not.toContain(A);
      expect(m).not.toContain(Bb);
    });

    it("stays fast with many WELL-FORMED blocks (paired-hit lookup is not quadratic)", () => {
      // The unpaired-banner perf test below leaves pemHits empty, so it never
      // exercised the paired-hit coverage lookup. With thousands of paired
      // blocks a re-scan-from-zero per banner is O(P^2): measured 574 ms at
      // 10k blocks before the lookup became a binary search.
      const text = `-----BEGIN A PRIVATE KEY-----\n${"M".repeat(40)}\n-----END A PRIVATE KEY-----\n`.repeat(10000);
      const t0 = Date.now();
      const hits = scanSecrets(text);
      expect(hits.length).toBe(10000);
      expect(Date.now() - t0).toBeLessThan(150);
    });

    it("stays fast with many unpaired END banners (no quadratic backward scan)", () => {
      const text = Array(300).fill(`${A}\n-----END RSA PRIVATE KEY-----\n$ cmd\n`).join("");
      const t0 = Date.now();
      scanSecrets(text);
      expect(Date.now() - t0).toBeLessThan(500); // was ~545 ms at this size, ~77 s at 256 KB
    });

    it("a long run of gap lines mid-body does not strand the far side", () => {
      const m = maskOf(`-----BEGIN RSA PRIVATE KEY-----\n${A}\n\n\n\n${Bb}`);
      expect(m).not.toContain(A);
      expect(m).not.toContain(Bb);
    });

    it("a body far longer than any line bound is fully masked", () => {
      const body = Array(450).fill(A);
      const m = maskOf(`-----BEGIN RSA PRIVATE KEY-----\n${body.join("\n")}`);
      expect(m).not.toContain(A);
    });

    it("two banners sharing one line still cover the body below", () => {
      const m = maskOf(`-----BEGIN RSA PRIVATE KEY----- -----END RSA PRIVATE KEY-----\n${A}`);
      expect(m).not.toContain(A);
    });

    it("a corrupted line inside a body does not strand what follows", () => {
      const m = maskOf(`-----BEGIN RSA PRIVATE KEY-----\n${A}\tXX\n${Bb}`);
      expect(m).not.toContain(Bb);
    });

    // The gate that keeps the run-based span from over-masking: no banner in
    // the text means ordinary base64/hash output is left completely alone.
    it("a transcript with no private-key banner is returned untouched", () => {
      const t = [
        "$ sha256sum f.bin",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "ZGVwbG95bWVudC1hcnRpZmFjdC1jaGVja3N1bS1wYXlsb2FkLXYx",
      ].join("\n");
      expect(maskOf(t)).toBe(t);
    });

    it("ordinary command output survives even in a transcript that DOES carry a key", () => {
      const t = [
        "$ git log --oneline",
        "4a17675 fix(security): line-classified PEM fallback",
        "$ sha256sum f.bin",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  f.bin",
        "-----BEGIN RSA PRIVATE KEY-----",
        A,
        "-----END RSA PRIVATE KEY-----",
        "$ echo done",
      ].join("\n");
      const m = maskOf(t);
      expect(m).not.toContain(A);
      expect(m).toContain("4a17675 fix(security): line-classified PEM fallback");
      expect(m).toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  f.bin");
      expect(m).toContain("$ echo done");
    });

    // Property test. Four review rounds each found a leak a targeted test had
    // missed, so this asserts the INVARIANT over randomized shapes rather than
    // another hand-picked case: in a text that carries a private-key banner,
    // no standalone key-shaped line survives into the output. Deterministic
    // seed — a failure is reproducible, not a flake.
    it("no key-shaped line survives in any banner-bearing text (fuzz)", () => {
      let seed = 12345;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const pick = (a) => a[Math.floor(rnd() * a.length)];
      const b64 = (n) =>
        Array.from({ length: n }, () =>
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[Math.floor(rnd() * 64)]
        ).join("");
      const KINDS = [
        () => `-----BEGIN ${pick(["RSA", "EC", "DSA", "OPENSSH", ""])} PRIVATE KEY-----`,
        () => `-----END ${pick(["RSA", "EC", "DSA", "OPENSSH", ""])} PRIVATE KEY-----`,
        () => b64(16 + Math.floor(rnd() * 50)),
        () => b64(16 + Math.floor(rnd() * 50)) + pick(["", "  ", "\t"]),
        () => "",
        () => b64(Math.floor(rnd() * 15)),
        () => `$ ${pick(["ls -la", "git status", "echo hi", "cat f"])}`,
        () => `--- 2026-08-0${Math.floor(rnd() * 9)} ---`,
        () => b64(30) + "\tXX",
      ];
      const KEYISH = /^[A-Za-z0-9+/]{16,}={0,2}$/;
      const BANNER = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/;
      let checked = 0;
      for (let iter = 0; iter < 1500; iter++) {
        const lines = Array.from({ length: 3 + Math.floor(rnd() * 25) }, () => pick(KINDS)());
        if (!lines.some((l) => BANNER.test(l))) continue;
        const text = lines.join(pick(["\n", "\r\n"]));
        const masked = maskSecrets(text, scanSecrets(text));
        for (const l of lines) {
          const t = l.trim();
          if (!KEYISH.test(t)) continue;
          checked++;
          expect(masked, `key-shaped line survived:\n${text}`).not.toContain(t);
        }
      }
      expect(checked).toBeGreaterThan(1000); // the corpus actually exercised the invariant
    });

    it("ordinary output between two keys is never swallowed", () => {
      const t = `${A}\n-----END RSA PRIVATE KEY-----\n$ real command output\n-----BEGIN EC PRIVATE KEY-----\n${Bb}\n`;
      const m = maskOf(t);
      expect(m).not.toContain(A);
      expect(m).not.toContain(Bb);
      expect(m).toContain("$ real command output");
    });
  });

  it("TWO separately-bisected keys in one text: both bodies masked", () => {
    // Re-review catch: suppressing an unpaired END whenever ANY earlier BEGIN
    // exists is distance-blind. Mismatched key types mean the paired pattern
    // never bridges them, so key 2's headless body must still be flagged on
    // its own. (Key 1 tail-severed, key 2 head-severed, unrelated output
    // between them — exactly what a capped multi-day transcript looks like.)
    const text = [
      "-----BEGIN EC PRIVATE KEY-----",
      BODY_A,
      "$ unrelated command output",
      "--- 2026-08-03 ---",
      BODY_B,
      "-----END RSA PRIVATE KEY-----",
      "",
    ].join("\n");
    const masked = maskSecrets(text, scanSecrets(text));
    expect(masked).not.toContain(BODY_A);
    expect(masked).not.toContain(BODY_B);
    expect(masked).toContain("$ unrelated command output"); // no over-masking between them
  });
});

// Audit: fixed-prefix provider/OAuth/bot-token key shapes (Google, Groq, xAI,
// Hugging Face, NVIDIA, Tailscale, Discord) had no rule at all, and the
// provider-key pattern's trailing \b shared the same gap once fixed here: \b
// does not fire between a `-`/`_`-class char and whitespace, so a key ending
// in `-` before a space used to lose its last byte to masking. Runtime-built
// fixtures throughout — a key-shaped literal in this file trips GitHub push
// protection on push.
describe("scanSecrets — fixed-prefix key formats (audit)", () => {
  it("provider-key: a key ending in - before whitespace is fully masked (was truncated by trailing \\b)", () => {
    // A weak `not.toContain(SK)` check would pass vacuously here: once the
    // "sk-" PREFIX is masked, the full original string can never be found as
    // a substring again, regardless of whether the trailing '-' leaked. Only
    // an exact-output assertion catches a one-byte tail leak.
    const SK = "sk-" + "g".repeat(21) + "-"; // ends in '-', built at runtime
    const text = `${SK} end`;
    const masked = maskSecrets(text, scanSecrets(text));
    expect(masked).toBe("[masked provider-key] end");
  });

  it("google-oauth: a DOTTED access token is masked through its last segment", () => {
    // A real ya29 token carries dots inside it. The tail class used to exclude
    // `.`, so the match stopped at the first inner dot and shipped the rest in
    // the clear (review). Exact-output assertion, for the same reason as the
    // provider-key test above: once any prefix is replaced, a
    // `not.toContain(whole)` check can never fail. No `=`/`:` in the wrapper,
    // so env-secret cannot win the longest-first race and mask it for us.
    const TOKEN = "ya29" + "." + "a".repeat(25) + "." + "b".repeat(30);
    const text = `Bearer ${TOKEN} end`;
    const masked = maskSecrets(text, scanSecrets(text));
    expect(masked).toBe("Bearer [masked google-oauth] end");
  });

  it("google-api-key: a class char glued to the tail shortens the match, it does not abandon it", () => {
    // `{35}` exact meant the trailing lookahead had nothing to give back, so
    // one extra char after the key failed the lookahead and killed the whole
    // match — the key shipped raw (review). Both trailing shapes, plus the
    // front-glue case that must STILL be rejected (\b never fires mid-word).
    for (const suffix of ["-x", "Z"]) {
      const KEY = "AIza" + "S".repeat(35);
      const text = `${KEY}${suffix} end`;
      const masked = maskSecrets(text, scanSecrets(text));
      expect(masked).not.toContain("S".repeat(35));
      expect(masked).toContain("[masked google-api-key]");
    }
    const glued = "x" + "AIza" + "S".repeat(35);
    expect(scanSecrets(`${glued} end`)).toEqual([]);
  });

  // Property test, same seeded-LCG style as the PEM fuzz above: random
  // 35-char [0-9A-Za-z_-] tails after AIza, wrapped in varied real-world
  // contexts, asserting the raw key never survives masking.
  it("no AIza-prefixed google key survives in any wrapped context (fuzz)", () => {
    let seed = 987654321;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    const randKey = () =>
      "AIza" + Array.from({ length: 35 }, () => ALPHABET[Math.floor(rnd() * ALPHABET.length)]).join("");
    const CONTEXTS = [
      (k) => `${k}`, // own line
      (k) => `| ${k} | ok |`, // table cell
      (k) => `{"key": "${k}"}`, // JSON value
      (k) => `$ echo ${k}`, // echo output line
      (k) => `${k}\r\n`, // CRLF line ending
      (k) => `(${k})`, // inside parentheses
    ];
    let checked = 0;
    for (let iter = 0; iter < 2500; iter++) {
      const key = randKey();
      const wrap = CONTEXTS[Math.floor(rnd() * CONTEXTS.length)];
      const text = wrap(key);
      const hits = scanSecrets(text);
      expect(maskSecrets(text, hits), `key survived:\n${text}`).not.toContain(key);
      // Count an iteration only when the rule under test is what saved it
      // (review). An unconditional `checked++` inside a fixed loop proves the
      // loop ran, nothing more — and the JSON-value context is masked by
      // env-secret even with google-api-key deleted, so those iterations say
      // nothing about this rule. Both halves are checked directly: the rule
      // fired, AND the key would still be visible without it.
      const others = hits.filter((h) => h.name !== "google-api-key");
      if (others.length < hits.length && maskSecrets(text, others).includes(key)) checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2000); // measured 2057 of 2500 (seed is fixed)
  });
});

describe("maskSecrets", () => {
  it("masks every hit, keeps surrounding text, is idempotent", () => {
    const text = "a AKIAIOSFODNN7EXAMPLE b ghp_abcdefghijklmnopqrstuvwxyz0123456789 c";
    const once = maskSecrets(text, scanSecrets(text));
    expect(once).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(once).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(once).toContain("a ");
    expect(once).toContain(" b ");
    expect(once).toContain(" c");
    expect(once).toContain("[masked aws-access-key]");
    const twice = maskSecrets(once, scanSecrets(once));
    expect(twice).toBe(once);
  });

  it("masks a full PEM blob including the body, not just the banner", () => {
    const text = `before\n${FAKE_PEM}\nafter`;
    const masked = maskSecrets(text, scanSecrets(text));
    expect(masked).not.toContain("MIIBOgIBAAJBAKj34GkxFhD91RaHU1KFwqBSqcHTPYFbUxk2mBjRhkiK5RGbrJmB");
    expect(masked).not.toContain("UnwqNSJqDPzO0PyEnAWQdHF/eBg7v6/6zpQCAwEAAQ==");
    expect(masked).toContain("[masked pem-private-key]");
    expect(masked).toContain("before");
    expect(masked).toContain("after");
  });

  it("two well-formed PEM blobs (RSA + EC) in one text -> exactly 2 hits, both bodies masked, middle preserved", () => {
    const text = `${FAKE_PEM}\nMIDDLE-MARKER\n${FAKE_PEM_EC}`;
    const hits = scanSecrets(text);
    expect(hits.filter((h) => h.name === "pem-private-key").length).toBe(2);
    expect(hits.filter((h) => h.name === "pem-unpaired-begin").length).toBe(0);
    const masked = maskSecrets(text, hits);
    expect(masked).not.toContain("MIIBOgIBAAJBAKj34GkxFhD91RaHU1KFwqBSqcHTPYFbUxk2mBjRhkiK5RGbrJmB");
    expect(masked).not.toContain("MHcCAQEEIDlowFAYpwIsCzoM3lZDaOOJFrbCuCoxYRitTGWKF7WoAoGCCqGSM49");
    expect(masked).toContain("MIDDLE-MARKER");
  });

  it("dangling BEGIN with no END anywhere -> one pem-unpaired-begin hit; maskSecrets masks banner AND body", () => {
    const text = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD91RaHU1KFwqBSqcHTPYFbUxk2mBjRhkiK5RGbrJmB\nafter";
    const hits = scanSecrets(text);
    expect(hits.length).toBe(1);
    expect(hits[0].name).toBe("pem-unpaired-begin");
    const masked = maskSecrets(text, hits);
    expect(masked).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(masked).not.toContain("MIIBOgIBAAJBAKj34GkxFhD91RaHU1KFwqBSqcHTPYFbUxk2mBjRhkiK5RGbrJmB");
    expect(masked).toContain("[masked pem-unpaired-begin]");
  });

  it("no hits -> unchanged reference", () => {
    const t = "nothing secret here";
    expect(maskSecrets(t, [])).toBe(t);
  });
});
