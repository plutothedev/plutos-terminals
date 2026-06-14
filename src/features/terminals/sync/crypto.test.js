import { test, expect } from "vitest";
import { newSalt, encrypt, decrypt, CorruptBlobError } from "./crypto.js";

test("round-trips plaintext", async () => {
  const salt = newSalt();
  const blob = await encrypt("hello world", "passphrase", salt);
  expect(blob.iv).toBeTruthy();
  expect(blob.ct).toBeTruthy();
  const out = await decrypt(blob, "passphrase", salt);
  expect(out).toBe("hello world");
});

test("rejects wrong passphrase", async () => {
  const salt = newSalt();
  const blob = await encrypt("secret", "right", salt);
  await expect(decrypt(blob, "wrong", salt)).rejects.toThrow();
});

test("uses a fresh IV per encrypt", async () => {
  const salt = newSalt();
  const a = await encrypt("x", "p", salt);
  const b = await encrypt("x", "p", salt);
  expect(a.iv).not.toBe(b.iv);
});

test("rejects a malformed blob with CorruptBlobError", async () => {
  const salt = newSalt();
  await expect(decrypt({}, "p", salt)).rejects.toBeInstanceOf(CorruptBlobError);
  await expect(decrypt({ iv: "x" }, "p", salt)).rejects.toBeInstanceOf(CorruptBlobError);
  await expect(decrypt(null, "p", salt)).rejects.toBeInstanceOf(CorruptBlobError);
});
