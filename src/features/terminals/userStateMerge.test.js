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

  it("a stale-closure save cannot roll an unchanged field's stamp BACKWARD (review M10 #4)", () => {
    // prev = fresh ref (x last written at 500); next = a stale capture whose
    // _fieldMeta still says x=100, and which adds y. x is unchanged, so its
    // stamp must stay 500 (fresh), not regress to 100.
    const prev = { x: 1, _fieldMeta: { x: 500 } };
    const next = { x: 1, y: 2, _fieldMeta: { x: 100 } };
    const out = stampFieldMeta(prev, next, 900);
    expect(out._fieldMeta.x).toBe(500); // NOT rolled back to 100
    expect(out._fieldMeta.y).toBe(900); // new field stamped now
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

  it("local wins CONFLICTING keychain fields, never taking remote's value", () => {
    const local = { anthropicKey: "local-key", providerKeys: { a: "L" }, _fieldMeta: {} };
    const remote = { anthropicKey: "remote-key", providerKeys: { a: "R" }, _fieldMeta: { anthropicKey: 9999 } };
    const out = mergeUserState(local, remote);
    expect(out.anthropicKey).toBe("local-key"); // never take remote's secret on conflict
    expect(out.providerKeys).toEqual({ a: "L" }); // local wins the shared key
    expect(out._fieldMeta.anthropicKey).toBeUndefined(); // secrets excluded from meta
  });

  it("UNIONS provider keys — a key added in another window (keychain unavailable) is not dropped (review M10 #1)", () => {
    // Keychain unavailable → blob keeps plaintext secrets; window B added `anthropic`.
    const local = { providerKeys: { openai: "L" }, _fieldMeta: {} };
    const remote = { providerKeys: { openai: "R", anthropic: "new-from-B" }, _fieldMeta: {} };
    const out = mergeUserState(local, remote);
    expect(out.providerKeys.openai).toBe("L"); // local wins the conflict
    expect(out.providerKeys.anthropic).toBe("new-from-B"); // remote fills the gap — NOT lost
  });

  it("takes a keychain field local never had at all", () => {
    const local = { _fieldMeta: {} };
    const remote = { providerKeys: { x: "only-remote" }, anthropicKey: "rk", _fieldMeta: {} };
    const out = mergeUserState(local, remote);
    expect(out.providerKeys).toEqual({ x: "only-remote" });
    expect(out.anthropicKey).toBe("rk");
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
