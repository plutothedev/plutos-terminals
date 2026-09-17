// (C)
import { describe, test, expect } from "vitest";
import { parseWorkspace, needsBackupRead, planRecovery, layoutFingerprint } from "./workspaceBoot.js";

describe("parseWorkspace", () => {
  test("absent / empty is empty state, not corruption", () => {
    expect(parseWorkspace(null)).toEqual({ state: {}, corrupt: false, empty: true });
    expect(parseWorkspace("")).toEqual({ state: {}, corrupt: false, empty: true });
  });

  test("valid object parses through", () => {
    const r = parseWorkspace('{"panels":[1,2],"skin":"oled"}');
    expect(r.corrupt).toBe(false);
    expect(r.empty).toBe(false);
    expect(r.state).toEqual({ panels: [1, 2], skin: "oled" });
  });

  test("the Rust store 'null' sentinel is empty, not corrupt", () => {
    expect(parseWorkspace("null")).toEqual({ state: {}, corrupt: false, empty: true });
  });

  test("valid-but-non-object JSON is empty, not corrupt", () => {
    expect(parseWorkspace("42")).toEqual({ state: {}, corrupt: false, empty: true });
    expect(parseWorkspace('"a string"')).toEqual({ state: {}, corrupt: false, empty: true });
  });

  test("a non-empty string that fails to parse IS corruption", () => {
    const r = parseWorkspace('{"panels":[1,2],"skin":'); // truncated
    expect(r.corrupt).toBe(true);
    expect(r.empty).toBe(true); // corruption always leaves nothing usable behind
    expect(r.state).toEqual({});
  });

  test("a parsed-but-keyless object is empty", () => {
    expect(parseWorkspace("{}")).toEqual({ state: {}, corrupt: false, empty: true });
  });
});

describe("needsBackupRead", () => {
  // The regression this whole pair of functions exists for (R-C2-1 / RDI-3):
  // Chromium discards a damaged localStorage database and starts EMPTY, so the
  // WebView2 profile-loss case arrives as a MISSING key, never as a garbled
  // string. Gating the backup read on `corrupt` alone missed it entirely.
  test("a missing blob must consult the backup, not default straight to empty", () => {
    expect(needsBackupRead(parseWorkspace(null))).toBe(true);
    expect(needsBackupRead(parseWorkspace(""))).toBe(true);
    expect(needsBackupRead(parseWorkspace("{}"))).toBe(true);
  });

  test("a corrupt blob still consults the backup", () => {
    expect(needsBackupRead(parseWorkspace('{"panels":['))).toBe(true);
  });

  test("a healthy blob never touches the backup", () => {
    expect(needsBackupRead(parseWorkspace('{"panels":[1]}'))).toBe(false);
  });
});

describe("planRecovery", () => {
  const backup = parseWorkspace('{"terminalsState":{"panels":[{"id":"p1"}]}}');

  test("missing blob + a real backup is adopted, with nothing to ask about", () => {
    // This used to be ambiguous: a Settings factory reset wiped localStorage and
    // reloaded but left store.json alone, so it looked exactly like WebView2
    // profile loss and boot had to ask which one it was. Factory reset now
    // clears the durable copy too (SettingsModal.jsx), which removes the
    // ambiguity at the source rather than pushing it onto the user at boot.
    const plan = planRecovery(parseWorkspace(null), backup);
    expect(plan.action).toBe("adopt");
    expect(plan.state).toEqual(backup.state);
  });

  test("corrupt blob + a real backup is adopted (the original C2 path)", () => {
    const plan = planRecovery(parseWorkspace('{"panels":['), backup);
    expect(plan.action).toBe("adopt");
    expect(plan.state).toEqual(backup.state);
  });

  test("missing blob + no backup is a genuine first run: silent", () => {
    expect(planRecovery(parseWorkspace(null), parseWorkspace("null")).action).toBe("none");
    expect(planRecovery(parseWorkspace(null), null).action).toBe("none");
  });

  test("corrupt blob + no backup tells the user their workspace was lost", () => {
    expect(planRecovery(parseWorkspace('{"panels":['), parseWorkspace("null")).action).toBe("notice");
    expect(planRecovery(parseWorkspace('{"panels":['), null).action).toBe("notice");
  });

  test("a backup that is itself unusable counts as no backup", () => {
    expect(planRecovery(parseWorkspace(null), parseWorkspace('{"panels":[')).action).toBe("none");
    expect(planRecovery(parseWorkspace(null), parseWorkspace("{}")).action).toBe("none");
  });

  test("a healthy boot never restores over itself", () => {
    expect(planRecovery(parseWorkspace('{"panels":[1]}'), backup).action).toBe("none");
  });
});

describe("layoutFingerprint", () => {
  // The escape hatch's problem in one line: "Reset layout & reload" throws away
  // ONE layout, and boot has to recognise that one layout in store.json without
  // being told to ignore the backup entirely. The two copies are stringified
  // independently and the durable one has its secrets stripped, so byte equality
  // is not available; this is what stands in for it.
  const RAW = '{"uiLayout":"moba","terminalsState":{"panels":[{"id":"p1"}]}}';

  test("the same layout fingerprints the same as a raw string and as parsed state", () => {
    expect(layoutFingerprint(RAW)).toBe(layoutFingerprint(parseWorkspace(RAW).state));
  });

  test("key order does not change the fingerprint", () => {
    // localStorage holds JSON.stringify of the live object; store.json holds
    // JSON.stringify of a shallow copy of it. Same content, and nothing promises
    // the same key order forever.
    const reordered = '{"terminalsState":{"panels":[{"id":"p1"}]},"uiLayout":"moba"}';
    expect(layoutFingerprint(reordered)).toBe(layoutFingerprint(RAW));
  });

  test("the secret fields the mirror strips do not change it either", () => {
    // A legacy plaintext anthropicKey survives in localStorage when the OS
    // keychain is unavailable (secretVault keeps the local copy rather than lose
    // the keys), while workspaceMirror deletes SECRET_FIELDS on the way to
    // store.json. Fingerprinting them would make ONE layout look like two, and
    // the crash-loop guard would hand the poison straight back for exactly the
    // population the keychain fail-safe protects.
    const withKey = '{"uiLayout":"moba","anthropicKey":"sk-live","terminalsState":{"panels":[{"id":"p1"}]}}';
    expect(layoutFingerprint(withKey)).toBe(layoutFingerprint(RAW));
  });

  test("a different layout fingerprints differently", () => {
    const other = '{"uiLayout":"moba","terminalsState":{"panels":[{"id":"p2"}]}}';
    expect(layoutFingerprint(other)).not.toBe(layoutFingerprint(RAW));
  });

  test("nothing usable has no fingerprint", () => {
    // Null means "no specific layout to recognise", which is the state the
    // ordinary (non-discard) boot is already in.
    expect(layoutFingerprint(null)).toBe(null);
    expect(layoutFingerprint("")).toBe(null);
    expect(layoutFingerprint("{}")).toBe(null);
    expect(layoutFingerprint('{"panels":[')).toBe(null);
    expect(layoutFingerprint('{"anthropicKey":"sk-live"}')).toBe(null); // secrets only
  });
});

describe("planRecovery after a deliberate discard", () => {
  // "Reset layout & reload" used to set a blanket do-not-recover mark, so boot
  // skipped the backup read entirely and the migrations' first flush mirrored
  // their defaults over store.json ~200 ms later: the crash hatch quietly took
  // the durable backup with it. The mark now names ONE layout instead.
  const RAW = '{"uiLayout":"moba","terminalsState":{"panels":[{"id":"p1"}]}}';

  test("the discarded layout is not handed back out of the backup", () => {
    const plan = planRecovery(parseWorkspace(null), parseWorkspace(RAW), layoutFingerprint(RAW));
    expect(plan.action).toBe("skip");
    expect(plan.state).toBe(null);
  });

  test("a DIFFERENT backup is still restored: the hatch drops one layout, not the backup", () => {
    // The case that makes this worth doing. The crash can beat the 200 ms
    // debounce, so store.json can still hold the last GOOD layout while the
    // poison only ever reached localStorage.
    const older = '{"uiLayout":"moba","terminalsState":{"panels":[{"id":"older"}]}}';
    const plan = planRecovery(parseWorkspace(null), parseWorkspace(older), layoutFingerprint(RAW));
    expect(plan.action).toBe("adopt");
    expect(plan.state).toEqual(parseWorkspace(older).state);
  });

  test("no discard mark leaves the ordinary restore exactly as it was", () => {
    expect(planRecovery(parseWorkspace(null), parseWorkspace(RAW), null).action).toBe("adopt");
    expect(planRecovery(parseWorkspace(null), parseWorkspace(RAW)).action).toBe("adopt");
  });

  test("a corrupt blob with no backup still tells the user, mark or no mark", () => {
    const plan = planRecovery(parseWorkspace('{"panels":['), parseWorkspace("null"), layoutFingerprint(RAW));
    expect(plan.action).toBe("notice");
  });
});
