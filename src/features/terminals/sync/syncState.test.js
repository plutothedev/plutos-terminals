import { test, expect } from "vitest";
import { readSurface, writeSurface, deriveLocal, surfaceValueKey, SOURCES } from "./syncState.js";
import { merge } from "./merge.js";

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

test("deriveLocal does NOT mass-tombstone when a store reads empty (corrupt/unloaded store)", () => {
  // The snapshot recorded 2 live snippets. The live `st` store then reads empty
  // (e.g. a corrupt localStorage blob whose JSON.parse failed and returned {}).
  // deriveLocal must NOT manufacture fresh delete-tombstones for the snapshot
  // items — that would merge-win and propagate a fleet-wide wipe.
  const snap = { fields: {}, fieldMeta: {}, collections: { "st.snippets": [
    { id: "s1", cmd: "ls", _updatedAt: 100 },
    { id: "s2", cmd: "pwd", _updatedAt: 100 },
  ] } };
  const s = stores();
  s.st = {}; // simulate the store that failed to load / corrupt-parse returned {}
  const local = deriveLocal(s, snap, 500);
  const snips = local.collections["st.snippets"];
  expect(snips.filter((x) => x._deletedAt).length).toBe(0); // no fresh deletes
  expect(snips.find((x) => x.id === "s1")).toBeTruthy();
  expect(snips.find((x) => x.id === "s2")).toBeTruthy();
});

test("first sync (null snapshot): remote wins scalar conflicts, collections union", () => {
  // No snapshot => no basis to claim local scalars are newer. A fresh machine
  // joining the fleet must adopt the established remote settings (not clobber
  // them with local defaults), while still contributing its unique collection
  // items. Bug was: deriveLocal stamped local fields `now`, so local always won.
  const s = stores();
  const local = deriveLocal(s, null, 1000);
  const remote = {
    fields: { "userSt.activeModel": "REMOTE", "st.headerSkin": "light" },
    fieldMeta: { "userSt.activeModel": 50, "st.headerSkin": 50 },
    collections: { "st.snippets": [{ id: "sR", cmd: "remote", _updatedAt: 50 }] },
  };
  const { merged } = merge(local, remote, 2000);
  expect(merged.fields["userSt.activeModel"]).toBe("REMOTE"); // remote wins despite older stamp
  expect(merged.fields["st.headerSkin"]).toBe("light");
  const snipIds = merged.collections["st.snippets"].map((x) => x.id).sort();
  expect(snipIds).toEqual(["s1", "sR"]); // union: local-unique item survives
});

test("surfaceValueKey ignores timestamps so identical data does not ping-pong", () => {
  const a = { fields: { "st.headerSkin": "oled" }, fieldMeta: { "st.headerSkin": 100 },
    collections: { "st.snippets": [{ id: "s1", cmd: "ls", _updatedAt: 100 }] } };
  const b = { fields: { "st.headerSkin": "oled" }, fieldMeta: { "st.headerSkin": 999 },
    collections: { "st.snippets": [{ id: "s1", cmd: "ls", _updatedAt: 999 }] } };
  expect(surfaceValueKey(a)).toBe(surfaceValueKey(b));
});

test("surfaceValueKey is order-insensitive but value-sensitive", () => {
  const a = { fields: {}, fieldMeta: {}, collections: { "st.snippets": [{ id: "s1" }, { id: "s2" }] } };
  const b = { fields: {}, fieldMeta: {}, collections: { "st.snippets": [{ id: "s2" }, { id: "s1" }] } };
  const c = { fields: {}, fieldMeta: {}, collections: { "st.snippets": [{ id: "s1", cmd: "X" }, { id: "s2" }] } };
  expect(surfaceValueKey(a)).toBe(surfaceValueKey(b)); // order doesn't matter
  expect(surfaceValueKey(a)).not.toBe(surfaceValueKey(c)); // a value change does
});

test("surfaceValueKey distinguishes a tombstone from a live item", () => {
  const live = { fields: {}, fieldMeta: {}, collections: { "st.snippets": [{ id: "s1", cmd: "ls", _updatedAt: 5 }] } };
  const dead = { fields: {}, fieldMeta: {}, collections: { "st.snippets": [{ id: "s1", cmd: "ls", _updatedAt: 9, _deletedAt: 9 }] } };
  expect(surfaceValueKey(live)).not.toBe(surfaceValueKey(dead));
});

test("deriveLocal DOES tombstone a full-collection clear when the store is still loaded", () => {
  // The st store loaded fine (still has headerSkin) and the user deleted their
  // only snippet. That is a legitimate clear and must sync — the mass-delete
  // guard only protects against an unloaded/corrupt store (whole object empty),
  // not a collection the user legitimately emptied.
  const snap = { fields: {}, fieldMeta: {}, collections: { "st.snippets": [
    { id: "s1", cmd: "ls", _updatedAt: 100 },
  ] } };
  const s = stores();
  s.st = { headerSkin: "oled" }; // store loaded, snippets legitimately cleared
  const local = deriveLocal(s, snap, 500);
  const tomb = local.collections["st.snippets"].find((x) => x.id === "s1");
  expect(tomb._deletedAt).toBe(500); // the clear syncs (not masked)
});

test("SOURCES never lists key fields", () => {
  const all = SOURCES.flatMap((s) => [...s.fields, ...s.collections]);
  expect(all).not.toContain("providerKeys");
  expect(all).not.toContain("anthropicKey");
});
