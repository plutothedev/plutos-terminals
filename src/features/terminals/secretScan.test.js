// (C)
import { describe, it, expect } from "vitest";
import { scanSecrets, maskSecrets } from "./secretScan.js";

const FAKE_PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIBOgIBAAJBAKj34GkxFhD91RaHU1KFwqBSqcHTPYFbUxk2mBjRhkiK5RGbrJmB",
  "UnwqNSJqDPzO0PyEnAWQdHF/eBg7v6/6zpQCAwEAAQ==",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

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
    ].join("\n");
    expect(scanSecrets(benign)).toEqual([]);
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

  it("no hits -> unchanged reference", () => {
    const t = "nothing secret here";
    expect(maskSecrets(t, [])).toBe(t);
  });
});
