import { test, expect } from "vitest";
import { readSurface, writeSurface, deriveLocal, SOURCES } from "./syncState.js";

const stores = () => ({
  userSt: { keybindings: { a: "x" }, activeModel: "m1", customThemes: [{ id: "t1", name: "T" }], providerKeys: { anthropic: "sk-xxx" } },
  st: { headerSkin: "oled", snippets: [{ id: "s1", cmd: "ls" }] },
  macros: [{ id: "mac1", name: "M", data: "abc" }],
});

test("readSurface namespaces across stores and excludes keys", () => {
  const surf = readSurface(stores());
  expect(surf.fields["userSt.activeModel"]).toBe("m1");
  expect(surf.fields["st.headerSkin"]).toBe("oled");
  expect(surf.collections["macros.macros"][0].id).toBe("mac1");
  expect(surf.collections["st.snippets"][0].cmd).toBe("ls");
  expect(JSON.stringify(surf)).not.toContain("sk-xxx");
});

test("writeSurface routes to stores, strips meta, drops tombstones", () => {
  const merged = {
    fields: { "userSt.activeModel": "m2", "st.headerSkin": "light" }, fieldMeta: {},
    collections: {
      "userSt.customThemes": [{ id: "t1", name: "T", _updatedAt: 5 }],
      "st.snippets": [{ id: "s1", cmd: "ls", _updatedAt: 5 }, { id: "s2", _updatedAt: 9, _deletedAt: 9 }],
      "macros.macros": [{ id: "mac1", name: "M", _updatedAt: 5 }],
    },
  };
  const out = writeSurface(merged);
  expect(out.userSt.activeModel).toBe("m2");
  expect(out.st.headerSkin).toBe("light");
  expect(out.st.snippets).toEqual([{ id: "s1", cmd: "ls" }]);
  expect(out.macros).toEqual([{ id: "mac1", name: "M" }]);
});

test("deriveLocal stamps changed field now, keeps unchanged ts", () => {
  const snap = { fields: { "userSt.activeModel": "m1", "st.headerSkin": "oled" }, fieldMeta: { "userSt.activeModel": 100, "st.headerSkin": 100 }, collections: {} };
  const s = stores(); s.userSt.activeModel = "m2";
  const local = deriveLocal(s, snap, 500);
  expect(local.fieldMeta["userSt.activeModel"]).toBe(500);
  expect(local.fieldMeta["st.headerSkin"]).toBe(100);
});

test("deriveLocal emits tombstone for a removed collection item", () => {
  const snap = { fields: {}, fieldMeta: {}, collections: { "st.snippets": [{ id: "s1", cmd: "ls", _updatedAt: 100 }, { id: "sGone", cmd: "old", _updatedAt: 100 }] } };
  const s = stores();
  const local = deriveLocal(s, snap, 500);
  const snips = local.collections["st.snippets"];
  expect(snips.find((x) => x.id === "s1")._updatedAt).toBe(100);
  const tomb = snips.find((x) => x.id === "sGone");
  expect(tomb._deletedAt).toBe(500);
});

test("SOURCES never lists key fields", () => {
  const all = SOURCES.flatMap((s) => [...s.fields, ...s.collections]);
  expect(all).not.toContain("providerKeys");
  expect(all).not.toContain("anthropicKey");
});
