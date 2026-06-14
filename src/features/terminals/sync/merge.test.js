import { test, expect } from "vitest";
import { merge, TOMBSTONE_TTL_MS } from "./merge.js";

const base = () => ({ fields: {}, fieldMeta: {}, collections: {} });

test("scalar: newer timestamp wins", () => {
  const local = { ...base(), fields: { skin: "oled" }, fieldMeta: { skin: 200 } };
  const remote = { ...base(), fields: { skin: "light" }, fieldMeta: { skin: 100 } };
  const { merged } = merge(local, remote);
  expect(merged.fields.skin).toBe("oled");
});

test("scalar: remote newer wins and flags changedLocally", () => {
  const local = { ...base(), fields: { skin: "oled" }, fieldMeta: { skin: 100 } };
  const remote = { ...base(), fields: { skin: "light" }, fieldMeta: { skin: 200 } };
  const { merged, changedLocally } = merge(local, remote);
  expect(merged.fields.skin).toBe("light");
  expect(changedLocally).toBe(true);
});

test("collection: union by id, newer item wins on collision", () => {
  const local = { ...base(), collections: { workflows: [{ id: "a", _updatedAt: 50, name: "L" }] } };
  const remote = { ...base(), collections: { workflows: [
    { id: "a", _updatedAt: 99, name: "R" },
    { id: "b", _updatedAt: 10, name: "B" },
  ] } };
  const { merged } = merge(local, remote);
  const wf = merged.collections.workflows;
  expect(wf.find((x) => x.id === "a").name).toBe("R");
  expect(wf.find((x) => x.id === "b")).toBeTruthy();
});

test("collection: tombstone is not resurrected by a stale copy", () => {
  const local = { ...base(), collections: { workflows: [{ id: "a", _updatedAt: 200, _deletedAt: 200 }] } };
  const remote = { ...base(), collections: { workflows: [{ id: "a", _updatedAt: 50, name: "stale" }] } };
  const { merged } = merge(local, remote, 300);
  expect(merged.collections.workflows.find((x) => x.id === "a")._deletedAt).toBe(200);
});

test("collection: tombstone past TTL is garbage-collected", () => {
  const now = 1_000_000_000_000;
  const old = now - TOMBSTONE_TTL_MS - 1;
  const local = { ...base(), collections: { workflows: [{ id: "a", _updatedAt: old, _deletedAt: old }] } };
  const remote = base();
  const { merged } = merge(local, remote, now);
  expect(merged.collections.workflows.find((x) => x.id === "a")).toBeUndefined();
});
