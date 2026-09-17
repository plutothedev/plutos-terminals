// (C)
// The rule this file exists to lock: a write that arrives while the mirror is
// SUSPENDED must be deferred, never dropped. flushNow consumes pendingRef before
// it reaches the mirror gate, so a dropped write is never retried by anything.
import { describe, test, expect, vi } from "vitest";
import { createWorkspaceMirror } from "./workspaceMirror.js";
import { holdLocalWrites } from "./storageKeys.js";

function harness() {
  const writes = [];
  const mirror = createWorkspaceMirror((data) => writes.push(JSON.parse(data)));
  return { writes, mirror };
}

describe("createWorkspaceMirror", () => {
  test("an unsuspended write reaches the store immediately", () => {
    const { writes, mirror } = harness();
    mirror.write({ uiLayout: "moba" });
    expect(writes).toEqual([{ uiLayout: "moba" }]);
  });

  test("a suspended write is deferred, then lands on resume", () => {
    // The real sequence: boot recovery suspends, the OLED + moba migrations
    // flush ~200 ms later, and read_store answers after that. Under the old
    // gate those two flushes vanished, so a brand-new install that boots once
    // and then sits resident in the tray (closing the window HIDES the app) had
    // NO durable backup at all, which is the exact gap this mirror exists to
    // close.
    const { writes, mirror } = harness();
    mirror.suspend();
    mirror.write({ headerSkin: "oled", oledDefaultMigrated: true });
    mirror.write({ headerSkin: "oled", oledDefaultMigrated: true, uiLayout: "moba" });
    expect(writes).toEqual([]);
    mirror.resume();
    expect(writes).toEqual([{ headerSkin: "oled", oledDefaultMigrated: true, uiLayout: "moba" }]);
  });

  test("resume with nothing deferred writes nothing", () => {
    const { writes, mirror } = harness();
    mirror.suspend();
    mirror.resume();
    expect(writes).toEqual([]);
  });

  test("resume is not a queue: a second resume does not re-send", () => {
    const { writes, mirror } = harness();
    mirror.suspend();
    mirror.write({ a: 1 });
    mirror.resume();
    mirror.resume();
    expect(writes).toHaveLength(1);
  });

  test("replaceNow writes through a suspension and drops what was deferred", () => {
    // Boot recovery adopts the backup while the mirror is still suspended:
    // releasing first would let the deferred pre-restore migration defaults win
    // the race and decide what the backup is.
    const { writes, mirror } = harness();
    mirror.suspend();
    mirror.write({ stale: true });
    mirror.replaceNow({ fresh: true });
    expect(writes).toEqual([{ fresh: true }]);
    mirror.resume();
    expect(writes).toEqual([{ fresh: true }]); // the stale deferred value is gone
  });

  test("secrets are stripped before anything reaches the store", () => {
    // store.json is a NEW, more discoverable at-rest location than localStorage,
    // and the window blob can still carry a legacy plaintext anthropicKey.
    const { writes, mirror } = harness();
    mirror.write({ uiLayout: "moba", anthropicKey: "sk-ant-secret", providerKeys: { openai: "sk-x" } });
    expect(writes).toEqual([{ uiLayout: "moba" }]);
  });

  test("a throwing transport never escapes: the mirror is best-effort", () => {
    const mirror = createWorkspaceMirror(() => { throw new Error("IPC down"); });
    expect(() => mirror.write({ a: 1 })).not.toThrow();
  });

  test("isSuspended reports the hold so boot can leave it up on a deferred offer", () => {
    const { mirror } = harness();
    expect(mirror.isSuspended()).toBe(false);
    mirror.suspend();
    expect(mirror.isSuspended()).toBe(true);
    mirror.resume();
    expect(mirror.isSuspended()).toBe(false);
  });

  test("an unserializable blob is skipped without throwing or half-writing", () => {
    const send = vi.fn();
    const mirror = createWorkspaceMirror(send);
    const cyclic = {};
    cyclic.self = cyclic;
    expect(() => mirror.write(cyclic)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("createWorkspaceMirror under a local write hold", () => {
  // Factory reset writes "{}" to store.json and takes a hold that is never
  // released. Boot recovery's resume()/replaceNow() used to bypass that hold
  // (only flushNow checked it), so a recovery resolving after the reset could
  // repopulate the backup the reset had just emptied.
  test("resume() and replaceNow() write nothing while a hold is up", () => {
    const { writes, mirror } = harness();
    mirror.suspend();
    mirror.write({ uiLayout: "moba" });
    const release = holdLocalWrites();
    try {
      mirror.replaceNow({ uiLayout: "restored" });
      mirror.resume();
      expect(writes).toEqual([]);
    } finally {
      release();
    }
    // The hold is per document and production never releases it (the reset
    // reloads), but the gate must not leave the mirror dead once it is gone.
    mirror.write({ uiLayout: "after" });
    expect(writes).toEqual([{ uiLayout: "after" }]);
  });
});
