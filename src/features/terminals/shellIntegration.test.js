// (C)
import { describe, test, expect } from "vitest";
import { buildPosixShellInit, buildPowerShellInit } from "./shellIntegration.js";

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
