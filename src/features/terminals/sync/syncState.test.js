import { test, expect } from "vitest";
import { extractSynced, applySynced, SYNCED_FIELDS } from "./syncState.js";

test("extract excludes provider keys", () => {
  const userSt = {
    headerSkin: "oled",
    providerKeys: { anthropic: "sk-xxx" },
    anthropicKey: "sk-yyy",
    _syncMeta: { headerSkin: 123 },
  };
  const surface = extractSynced(userSt);
  expect(JSON.stringify(surface)).not.toContain("sk-xxx");
  expect(JSON.stringify(surface)).not.toContain("sk-yyy");
  expect(surface.fields.headerSkin).toBe("oled");
  expect(surface.fieldMeta.headerSkin).toBe(123);
});

test("apply preserves non-synced fields", () => {
  const userSt = { headerSkin: "oled", providerKeys: { anthropic: "k" }, _syncMeta: {} };
  const merged = { fields: { headerSkin: "light" }, fieldMeta: { headerSkin: 9 }, collections: {} };
  const next = applySynced(userSt, merged);
  expect(next.headerSkin).toBe("light");
  expect(next.providerKeys.anthropic).toBe("k"); // untouched
  expect(next._syncMeta.headerSkin).toBe(9);
});

test("SYNCED_FIELDS never includes key fields", () => {
  expect(SYNCED_FIELDS).not.toContain("providerKeys");
  expect(SYNCED_FIELDS).not.toContain("anthropicKey");
});
