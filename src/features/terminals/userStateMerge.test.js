// (C)
import { describe, it, expect } from "vitest";
import { stampFieldMeta, mergeUserState } from "./userStateMerge.js";

describe("stampFieldMeta", () => {
  it("stamps only the fields that changed", () => {
    const prev = { welcomeDone: true, terminalsOnboarded: false, _fieldMeta: { welcomeDone: 100 } };
    const next = { welcomeDone: true, terminalsOnboarded: true };
    const out = stampFieldMeta(prev, next, 500);
    expect(out._fieldMeta.welcomeDone).toBe(100); // unchanged → keeps old stamp
    expect(out._fieldMeta.terminalsOnboarded).toBe(500); // changed → new stamp
    expect(out.terminalsOnboarded).toBe(true);
  });

  it("never stamps keychain fields", () => {
    const prev = { anthropicKey: "old", providerKeys: { a: "1" } };
    const next = { anthropicKey: "new", providerKeys: { a: "2" } };
    const out = stampFieldMeta(prev, next, 500);
    expect(out._fieldMeta.anthropicKey).toBeUndefined();
    expect(out._fieldMeta.providerKeys).toBeUndefined();
  });

  it("does not mutate its inputs", () => {
    const prev = { a: 1, _fieldMeta: {} };
    const next = { a: 2 };
    stampFieldMeta(prev, next, 500);
    expect(prev._fieldMeta).toEqual({});
    expect(next._fieldMeta).toBeUndefined();
  });
});

describe("mergeUserState", () => {
  it("keeps each window's independently-edited field (the M10 bug)", () => {
    // Window A changed theme at t=200; window B changed onboarding at t=300.
    // B receives A's blob. B must keep its newer onboarding AND take A's theme.
    const local = { theme: "old", onboarding: true, _fieldMeta: { theme: 100, onboarding: 300 } };
    const remote = { theme: "new", onboarding: false, _fieldMeta: { theme: 200, onboarding: 100 } };
    const out = mergeUserState(local, remote);
    expect(out.theme).toBe("new"); // remote newer (200 > 100)
    expect(out.onboarding).toBe(true); // local newer (300 > 100) — NOT clobbered
    expect(out._fieldMeta.theme).toBe(200);
    expect(out._fieldMeta.onboarding).toBe(300);
  });

  it("newer remote wins a contested field", () => {
    const local = { x: "a", _fieldMeta: { x: 100 } };
    const remote = { x: "b", _fieldMeta: { x: 200 } };
    expect(mergeUserState(local, remote).x).toBe("b");
  });

  it("older remote loses a contested field", () => {
    const local = { x: "a", _fieldMeta: { x: 200 } };
    const remote = { x: "b", _fieldMeta: { x: 100 } };
    expect(mergeUserState(local, remote).x).toBe("a");
  });

  it("converges on an exact-timestamp tie (both windows pick the same value)", () => {
    const A = { x: "aaa", _fieldMeta: { x: 100 } };
    const B = { x: "bbb", _fieldMeta: { x: 100 } };
    // A receives B (remote=B); B receives A (remote=A). Both must land on the same value.
    const aGot = mergeUserState(A, B).x;
    const bGot = mergeUserState(B, A).x;
    expect(aGot).toBe(bGot);
  });

  it("carries keychain fields from local, never from remote", () => {
    const local = { anthropicKey: "local-key", providerKeys: { a: "L" }, _fieldMeta: {} };
    const remote = { anthropicKey: "remote-key", providerKeys: { a: "R" }, _fieldMeta: { anthropicKey: 9999 } };
    const out = mergeUserState(local, remote);
    expect(out.anthropicKey).toBe("local-key"); // never take remote's secret
    expect(out.providerKeys).toEqual({ a: "L" });
    expect(out._fieldMeta.anthropicKey).toBeUndefined(); // secrets excluded from meta
  });

  it("a pre-M10 blob (no _fieldMeta) loses contested fields to a stamped local edit", () => {
    const local = { x: "edited", _fieldMeta: { x: 500 } };
    const remote = { x: "stale" }; // no _fieldMeta → treated as t=0
    expect(mergeUserState(local, remote).x).toBe("edited");
  });

  it("takes a remote-only field the local window never had", () => {
    const local = { a: 1, _fieldMeta: { a: 100 } };
    const remote = { a: 1, b: 2, _fieldMeta: { a: 100, b: 300 } };
    expect(mergeUserState(local, remote).b).toBe(2);
    expect(mergeUserState(local, remote)._fieldMeta.b).toBe(300);
  });
});
