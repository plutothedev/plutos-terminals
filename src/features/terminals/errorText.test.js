// (C)
import { describe, it, expect } from "vitest";
import { humanizeError } from "./errorText";

describe("humanizeError mappings", () => {
  it("maps os error 2 / NotFound to file-not-found", () => {
    expect(humanizeError("The system cannot find the file specified. (os error 2)").message)
      .toBe("File not found");
    expect(humanizeError("Custom { kind: NotFound, error: \"missing\" }").message)
      .toBe("File not found");
  });

  it("maps os error 5 / access denied to permission-denied", () => {
    expect(humanizeError("Access is denied. (os error 5)").message).toBe("Permission denied");
    expect(humanizeError("open failed: permission denied").message).toBe("Permission denied");
  });

  it("maps SSH publickey rejection to auth, not filesystem permission", () => {
    // The classic libssh2/sshd wording contains "Permission denied" — the auth
    // rule must win over the ACL rule.
    expect(humanizeError("Permission denied (publickey).").message)
      .toBe("Authentication failed — check your credentials");
  });

  it("maps auth/password failures to the credentials sentence", () => {
    expect(humanizeError("[Session(-18)] Username/PublicKey combination invalid: authentication failed").message)
      .toBe("Authentication failed — check your credentials");
    expect(humanizeError("wrong password for key").message)
      .toBe("Authentication failed — check your credentials");
  });

  it("does not read a file error mentioning password.txt as an auth failure", () => {
    expect(humanizeError("no such file: password.txt").message).toBe("File not found");
  });

  it("maps connection refused / timed out / unreachable to plain network sentences", () => {
    expect(humanizeError("Connection refused (os error 111)").message)
      .toBe("Connection refused — nothing is listening at that address");
    expect(humanizeError("A connection attempt failed... timed out (os error 10060)").message)
      .toBe("The connection timed out");
    expect(humanizeError("connect: network is unreachable").message)
      .toBe("The host could not be reached");
    expect(humanizeError("failed to resolve address for example.invalid").message)
      .toBe("The host could not be reached");
  });

  it("maps a poisoned lock to the internal-error sentence", () => {
    expect(humanizeError("PoisonError { poisoned lock: another task failed inside }").message)
      .toBe("Internal error — please retry (the app recovered a background lock)");
  });

  it("maps git2 non-fast-forward to pull-first", () => {
    expect(humanizeError("cannot push non-fast-forward reference; class=Reference").message)
      .toBe("Remote has newer changes — pull first");
  });

  it("maps ssh2 handshake failures, winning over the timeout rule", () => {
    expect(humanizeError("[Session(-8)] Unable to exchange encryption keys during handshake").message)
      .toBe("Could not establish the SSH connection");
    expect(humanizeError("SSH handshake timed out").message)
      .toBe("Could not establish the SSH connection");
  });
});

describe("humanizeError fallback + composition", () => {
  it("keeps an unmatched raw string as the message", () => {
    const { message, detail } = humanizeError("weird bespoke failure 42");
    expect(message).toBe("weird bespoke failure 42");
    expect(detail).toBe("weird bespoke failure 42");
  });

  it("caps an unmatched message at 160 chars but keeps full detail", () => {
    const raw = "x".repeat(400);
    const { message, detail } = humanizeError(raw);
    expect(message.length).toBe(160);
    expect(message.endsWith("…")).toBe(true);
    expect(detail).toBe(raw);
  });

  it("collapses newlines in the unmatched message, not in detail", () => {
    const raw = "line one\nline two\n\tline three";
    const { message, detail } = humanizeError(raw);
    expect(message).toBe("line one line two line three");
    expect(detail).toBe(raw);
  });

  it("prefixes ctx onto mapped and unmatched messages", () => {
    expect(humanizeError("os error 2", "Download failed").message)
      .toBe("Download failed: File not found");
    expect(humanizeError("bespoke", "Upload failed").message)
      .toBe("Upload failed: bespoke");
  });

  it("stringifies Error objects and keeps the raw form as detail", () => {
    const e = new Error("boom");
    const { message, detail } = humanizeError(e, "Save failed");
    expect(message).toBe("Save failed: Error: boom");
    expect(detail).toBe("Error: boom");
  });

  it("uses .message for objects that stringify to [object Object]", () => {
    expect(humanizeError({ message: "plain object failure" }).message)
      .toBe("plain object failure");
  });

  it("falls back to Unknown error for null/undefined/empty", () => {
    expect(humanizeError(null).message).toBe("Unknown error");
    expect(humanizeError(undefined).message).toBe("Unknown error");
    expect(humanizeError("   ").message).toBe("Unknown error");
    expect(humanizeError(null, "Delete failed").message).toBe("Delete failed: Unknown error");
  });
});
