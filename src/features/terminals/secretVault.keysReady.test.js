// (C)
// The first keychain read's signal (secretVault keysReady / keysSettled). At
// launch the key cache is filled in the background (App.jsx migrateAndLoad),
// and a pane restored at launch used to read it before it was filled, starting
// its shell without the user's keys. These pin the signal the pane now waits
// on: it fires when a read has FINISHED, with the keychain's keys in the cache
// (or with no keychain at all), never when a read has only started or was
// deferred by a save; the launch load reads again when saves deferred it; and
// the panes give up together at one launch deadline.
import { describe, test, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// A stand-in keychain: with `fail` set every call throws (no keychain on this
// machine); otherwise it is a map, and `hook` runs on each call first.
const { kc, invokeMock } = vi.hoisted(() => {
  const kc = { store: new Map(), fail: true, hook: null };
  const invokeMock = vi.fn(async (cmd, args) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (kc.hook) await kc.hook(cmd, args);
    if (kc.fail) throw new Error("no keychain on this machine");
    if (cmd === "secret_set") { kc.store.set(args.account, args.secret); return null; }
    if (cmd === "secret_get") return kc.store.has(args.account) ? kc.store.get(args.account) : null;
    if (cmd === "secret_delete") { kc.store.delete(args.account); return null; }
    return null;
  });
  return { kc, invokeMock };
});
vi.mock("@backend", () => ({
  invoke: (...args) => invokeMock(...args),
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));

// Two saved keys, in the vault's own layout.
const INDEX = "llm-provider-keys:v1:index";
const SEEDED = { anthropic: "A-KEY", moonshot: "M-KEY" };
const seed = () => {
  kc.fail = false;
  kc.store.set(INDEX, JSON.stringify(Object.keys(SEEDED)));
  for (const [id, key] of Object.entries(SEEDED)) kc.store.set(`llm-provider-keys:v1:p:${id}`, key);
};

// A fresh module per test: the signal is per window, set once per launch.
const freshVault = async () => {
  vi.resetModules();
  return import("./secretVault.js");
};
const settlesWithin = (promise, ms) =>
  Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);
const cachedKeys = (vault) => ({ ...vault.getCachedSecretKeys().providerKeys });

// A block body: vitest runs a function RETURNED from beforeEach as cleanup,
// and mockClear() returns the mock itself.
beforeEach(() => {
  invokeMock.mockClear();
  kc.store.clear();
  kc.fail = true;
  kc.hook = null;
});

describe("keysReady", () => {
  test("waits for the first read to finish, which it does even with no keychain", async () => {
    const vault = await freshVault();
    expect(vault.keysSettled()).toBe(false);
    const ready = vault.keysReady(10_000);
    expect(await settlesWithin(ready, 50)).toBe(false); // nothing read yet
    await vault.loadSecretKeys().catch(() => {});
    expect(invokeMock).toHaveBeenCalled(); // it did try the keychain
    expect(vault.keysSettled()).toBe(true);
    expect(await settlesWithin(ready, 50)).toBe(true);
    expect(await settlesWithin(vault.keysReady(10_000), 50)).toBe(true);
  });

  test("a pane that resumes finds the keychain's keys already in the cache", async () => {
    seed();
    const vault = await freshVault();
    const seen = vault.keysReady(10_000).then(() => ({ settled: vault.keysSettled(), keys: cachedKeys(vault) }));
    await vault.migrateAndLoad({}, "");
    expect(await seen).toEqual({ settled: true, keys: SEEDED });
  });

  test("a read that saves deferred does not count, and the launch load reads again", async () => {
    seed();
    const vault = await freshVault();
    // A save lands during each of the first refresh's three passes, so none of
    // them may take what it read (reloadOnce).
    let reads = 0;
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_get" && args.account === INDEX && ++reads <= 3) vault.saveSecretKeys({}, "");
    };
    const seen = vault.keysReady(10_000).then(() => cachedKeys(vault));
    await vault.migrateAndLoad({}, "");
    expect(reads).toBeGreaterThan(3);
    expect(vault.keysSettled()).toBe(true);
    expect(await seen).toEqual(SEEDED);
  });

  test("saves that defer every read: the launch load stops after its retries, unsettled, and holds no pane", async () => {
    seed();
    const vault = await freshVault();
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_get" && args.account === INDEX) vault.saveSecretKeys({}, "");
    };
    const t0 = Date.now();
    await vault.migrateAndLoad({}, "");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400); // four more tries, backing off 150 to 600 ms
    expect(vault.keysSettled()).toBe(false);
    expect(await settlesWithin(vault.keysReady(50), 1000)).toBe(true);
  }, 15_000);

  test("gives up after its bound, once: later panes do not wait again", async () => {
    const vault = await freshVault();
    const t0 = Date.now();
    await vault.keysReady(80);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    expect(vault.keysSettled()).toBe(false);
    expect(await settlesWithin(vault.keysReady(10_000), 50)).toBe(true);
  });

  test("panes share one deadline: a pane that asks later waits only for what is left of it", async () => {
    const vault = await freshVault();
    const first = vault.keysReady(150);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = vault.keysReady(150); // asked 100 ms in: 50 ms left, not 150
    await first;
    expect(await settlesWithin(second, 20)).toBe(true);
    expect(vault.keysSettled()).toBe(false);
  });
});

// App merges the cache into its state once the first load resolves, and that
// load can take a while when saves set its reads aside: the merge has to build
// on the live state, or a setting saved meanwhile is reverted.
test("App merges the keys the first load returns onto its live state, not the state it had at mount (from source)", () => {
  const src = readFileSync(path.join(process.cwd(), "src/App.jsx"), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("migrateAndLoad(userSt.providerKeys, userSt.anthropicKey)");
  expect(start).toBeGreaterThan(0);
  const body = src.slice(start, src.indexOf("writeUserState(merged);", start));
  expect(body).toMatch(/\.then\(\(loaded\) =>/);
  expect(body).toMatch(/const cur = userStRef\.current;/);
  expect(body).toMatch(/\.\.\.cur,/);
  expect(body).toMatch(/loaded\?\.providerKeys/);
  expect(body).not.toMatch(/\.\.\.userSt,|getCachedSecretKeys\(/);
});

// App merges the keychain's keys into its state only once the launch load
// succeeds, so a save made before then carries state that may not hold them:
// it may delete only keys the state has held (shown at mount, carried by one
// of its saves, or put on screen by a refresh), even when its turn in the
// queue comes after the load has finished, and the cache keeps the rest.
describe("saves made while the launch load runs", () => {
  // The keys this window's state has never held (the keychain's, before App
  // merges them) cannot be deleted by such a save; the keys it has held can.
  test("delete no key the state never held, even when their turn comes after the load", async () => {
    seed();
    const vault = await freshVault();
    let fired = false;
    kc.hook = async (cmd, args) => {
      if (!fired && cmd === "secret_set" && args.account === "llm-provider-keys:v1:p:openrouter") {
        fired = true;
        // App's state: its plaintext key plus one the user just added, never
        // the keychain's. The first save waits on the keychain, so the second's
        // turn comes after the load has finished.
        vault.saveSecretKeys({ openrouter: "O-KEY", zai: "Z-KEY" }, "");
        vault.saveSecretKeys({ openrouter: "O-KEY", zai: "Z-KEY" }, "");
      }
    };
    const loaded = await vault.migrateAndLoad({ openrouter: "O-KEY" }, "");
    expect(fired).toBe(true);
    const all = { ...SEEDED, openrouter: "O-KEY", zai: "Z-KEY" };
    expect(loaded.providerKeys).toEqual(all);
    expect(cachedKeys(vault)).toEqual(all);
    await vault.refreshSecretKeys(); // queued behind both saves, so they have run
    const stored = [...kc.store.keys()].filter((k) => k.startsWith("llm-provider-keys:v1:p:")).sort();
    expect(stored).toEqual(["anthropic", "moonshot", "openrouter", "zai"].map((id) => `llm-provider-keys:v1:p:${id}`));
  });

  test("a key the user added and removed while the load waited stays removed", async () => {
    seed();
    const vault = await freshVault();
    // Hold the first read, as a keychain prompt nobody has answered would.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let blocked;
    const isBlocked = new Promise((resolve) => { blocked = resolve; });
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_get" && args.account === INDEX && release) {
        blocked();
        await gate;
      }
    };
    const load = vault.migrateAndLoad({}, "");
    await isBlocked;
    vault.saveSecretKeys({ openai: "OA-KEY" }, "");
    vault.saveSecretKeys({}, "");
    const r = release;
    release = null;
    r();
    const loaded = await load;
    expect(loaded.providerKeys).toEqual(SEEDED);
    expect(kc.store.has("llm-provider-keys:v1:p:openai")).toBe(false);
    expect(kc.store.get("llm-provider-keys:v1:p:anthropic")).toBe("A-KEY");
    expect(kc.store.get("llm-provider-keys:v1:p:moonshot")).toBe("M-KEY");
  });

  test("the keys on screen at launch count as held: removing them during the load's last write sticks", async () => {
    seed();
    const vault = await freshVault();
    let fired = false;
    kc.hook = async (cmd, args) => {
      if (!fired && cmd === "secret_set" && args.account === "llm-provider-keys:v1:p:openrouter") {
        fired = true;
        // The user clears both plaintext keys App started with.
        vault.saveSecretKeys({}, "");
      }
    };
    const loaded = await vault.migrateAndLoad({ openrouter: "O-KEY" }, "L-KEY");
    expect(fired).toBe(true);
    expect(loaded.providerKeys).toEqual(SEEDED);
    expect(loaded.anthropicKey).toBe("");
    await vault.refreshSecretKeys();
    expect(kc.store.has("llm-provider-keys:v1:p:openrouter")).toBe(false);
    expect(kc.store.has("llm-provider-keys:v1:anthropic")).toBe(false);
    expect(kc.store.get("llm-provider-keys:v1:p:anthropic")).toBe("A-KEY");
  });

  test("a plaintext key removed while the load reads the keychain stays removed, even when the keychain had it too", async () => {
    seed();
    kc.store.set(INDEX, JSON.stringify(["anthropic", "moonshot", "groq"]));
    kc.store.set("llm-provider-keys:v1:p:groq", "G-KEY");
    const vault = await freshVault();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let blocked;
    const isBlocked = new Promise((resolve) => { blocked = resolve; });
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_get" && args.account === INDEX && release) {
        blocked();
        await gate;
      }
    };
    // App started with two plaintext keys; the user removes groq while the
    // load waits on the keychain.
    const load = vault.migrateAndLoad({ groq: "G-KEY", openai: "OA-KEY" }, "");
    await isBlocked;
    vault.saveSecretKeys({ openai: "OA-KEY" }, "");
    const r = release;
    release = null;
    r();
    const loaded = await load;
    expect(loaded.providerKeys).toEqual({ ...SEEDED, openai: "OA-KEY" });
    await vault.refreshSecretKeys();
    expect(kc.store.has("llm-provider-keys:v1:p:groq")).toBe(false);
    expect(kc.store.get("llm-provider-keys:v1:p:openai")).toBe("OA-KEY");
  });

  test("after a failed load, a key that a refresh put on screen can be removed", async () => {
    seed();
    const vault = await freshVault();
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_set" && args.account === "llm-provider-keys:v1:p:openrouter") throw new Error("too big for the keychain");
    };
    await expect(vault.migrateAndLoad({ openrouter: "O-KEY" }, "")).rejects.toThrow();
    // Another window changed something: App's storage handler refreshes and
    // shows the keychain's keys; the user then removes moonshot.
    await vault.refreshSecretKeys();
    await vault.saveSecretKeys({ anthropic: "A-KEY", openrouter: "O-KEY" }, "").catch(() => {});
    expect(kc.store.has("llm-provider-keys:v1:p:moonshot")).toBe(false);
    expect(kc.store.get("llm-provider-keys:v1:p:anthropic")).toBe("A-KEY");
  });

  test("a plaintext key removed and then re-added while the load reads stays, with its new value", async () => {
    seed();
    const vault = await freshVault();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let blocked;
    const isBlocked = new Promise((resolve) => { blocked = resolve; });
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_get" && args.account === INDEX && release) {
        blocked();
        await gate;
      }
    };
    const load = vault.migrateAndLoad({ groq: "G-KEY" }, "");
    await isBlocked;
    vault.saveSecretKeys({}, "");
    vault.saveSecretKeys({ groq: "G-NEW" }, "");
    const r = release;
    release = null;
    r();
    const loaded = await load;
    expect(loaded.providerKeys.groq).toBe("G-NEW");
    await vault.refreshSecretKeys();
    expect(kc.store.get("llm-provider-keys:v1:p:groq")).toBe("G-NEW");
  });

  test("the keychain's standalone key survives a save during the load that never showed it", async () => {
    seed();
    kc.store.set("llm-provider-keys:v1:anthropic", "L-CHAIN");
    const vault = await freshVault();
    let fired = false;
    kc.hook = async (cmd, args) => {
      if (!fired && cmd === "secret_set" && args.account === "llm-provider-keys:v1:p:openrouter") {
        fired = true;
        vault.saveSecretKeys({ openrouter: "O-KEY" }, "");
      }
    };
    const loaded = await vault.migrateAndLoad({ openrouter: "O-KEY" }, "");
    expect(fired).toBe(true);
    expect(loaded.anthropicKey).toBe("L-CHAIN");
    await vault.refreshSecretKeys();
    expect(kc.store.get("llm-provider-keys:v1:anthropic")).toBe("L-CHAIN");
  });

  test("a standalone key a save carried during the load counts as held: clearing it sticks", async () => {
    seed();
    const vault = await freshVault();
    let fired = false;
    kc.hook = async (cmd, args) => {
      if (!fired && cmd === "secret_set" && args.account === "llm-provider-keys:v1:p:openrouter") {
        fired = true;
        vault.saveSecretKeys({ openrouter: "O-KEY" }, "U-KEY"); // typed
        vault.saveSecretKeys({ openrouter: "O-KEY" }, ""); // and cleared again
      }
    };
    const loaded = await vault.migrateAndLoad({ openrouter: "O-KEY" }, "");
    expect(fired).toBe(true);
    expect(loaded.anthropicKey).toBe("");
    await vault.refreshSecretKeys();
    expect(kc.store.has("llm-provider-keys:v1:anthropic")).toBe(false);
  });

  test("a second launch in the same window starts with nothing held from the first", async () => {
    seed();
    const vault = await freshVault();
    await vault.migrateAndLoad({ zai: "Z-KEY" }, ""); // the first launch's state held zai
    let fired = false;
    kc.hook = async (cmd, args) => {
      if (!fired && cmd === "secret_set" && args.account === "llm-provider-keys:v1:p:openrouter") {
        fired = true;
        vault.saveSecretKeys({ openrouter: "O-KEY" }, ""); // the second's never showed it
      }
    };
    await vault.migrateAndLoad({ openrouter: "O-KEY" }, "");
    expect(fired).toBe(true);
    await vault.refreshSecretKeys();
    expect(kc.store.get("llm-provider-keys:v1:p:zai")).toBe("Z-KEY");
  });

  test("a standalone key on screen at launch and cleared while the load reads stays cleared, keychain copy included", async () => {
    seed();
    kc.store.set("llm-provider-keys:v1:anthropic", "L-CHAIN");
    const vault = await freshVault();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let blocked;
    const isBlocked = new Promise((resolve) => { blocked = resolve; });
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_get" && args.account === INDEX && release) {
        blocked();
        await gate;
      }
    };
    const load = vault.migrateAndLoad({}, "L-PLAIN");
    await isBlocked;
    vault.saveSecretKeys({}, "");
    const r = release;
    release = null;
    r();
    const loaded = await load;
    expect(loaded.anthropicKey).toBe("");
    await vault.refreshSecretKeys();
    expect(kc.store.has("llm-provider-keys:v1:anthropic")).toBe(false);
  });

  test("a standalone key cleared and typed again while the load reads keeps its new value", async () => {
    seed();
    const vault = await freshVault();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let blocked;
    const isBlocked = new Promise((resolve) => { blocked = resolve; });
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_get" && args.account === INDEX && release) {
        blocked();
        await gate;
      }
    };
    const load = vault.migrateAndLoad({}, "L-PLAIN");
    await isBlocked;
    vault.saveSecretKeys({}, "");
    vault.saveSecretKeys({}, "L-NEW");
    const r = release;
    release = null;
    r();
    const loaded = await load;
    expect(loaded.anthropicKey).toBe("L-NEW");
    await vault.refreshSecretKeys();
    expect(kc.store.get("llm-provider-keys:v1:anthropic")).toBe("L-NEW");
  });

  test("a key removed during the load and then added back by another window stays", async () => {
    seed();
    const vault = await freshVault();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let blocked;
    const isBlocked = new Promise((resolve) => { blocked = resolve; });
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_get" && args.account === INDEX && release) {
        blocked();
        await gate;
      }
    };
    const load = vault.migrateAndLoad({ groq: "G-KEY" }, "");
    await isBlocked;
    vault.saveSecretKeys({}, ""); // this window removes groq
    // Another window writes groq back; its storage event makes this window refresh.
    kc.store.set("llm-provider-keys:v1:p:groq", "G-OTHER");
    kc.store.set(INDEX, JSON.stringify([...Object.keys(SEEDED), "groq"]));
    const refreshed = vault.refreshSecretKeys();
    const r = release;
    release = null;
    r();
    const loaded = await load;
    await refreshed;
    expect(loaded.providerKeys.groq).toBe("G-OTHER");
    await vault.refreshSecretKeys();
    expect(kc.store.get("llm-provider-keys:v1:p:groq")).toBe("G-OTHER");
  });

  test("after a failed load, a standalone key a refresh put on screen can be cleared", async () => {
    seed();
    kc.store.set("llm-provider-keys:v1:anthropic", "L-CHAIN");
    const vault = await freshVault();
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_set" && args.account === "llm-provider-keys:v1:p:openrouter") throw new Error("too big for the keychain");
    };
    await expect(vault.migrateAndLoad({ openrouter: "O-KEY" }, "")).rejects.toThrow();
    await vault.refreshSecretKeys(); // shows the keychain's keys, the standalone one included
    await vault.saveSecretKeys({ ...SEEDED, openrouter: "O-KEY" }, "").catch(() => {});
    expect(kc.store.has("llm-provider-keys:v1:anthropic")).toBe(false);
    expect(kc.store.get("llm-provider-keys:v1:p:moonshot")).toBe("M-KEY");
  });

  test("a second launch in the same window starts with nothing dropped by the first", async () => {
    seed();
    const vault = await freshVault();
    let fired = false;
    kc.hook = async (cmd, args) => {
      if (!fired && cmd === "secret_set" && args.account === "llm-provider-keys:v1:p:openrouter") {
        fired = true;
        vault.saveSecretKeys({}, ""); // the first launch's user removes openrouter
      }
    };
    await vault.migrateAndLoad({ openrouter: "O-KEY" }, "");
    expect(fired).toBe(true);
    await vault.refreshSecretKeys();
    expect(kc.store.has("llm-provider-keys:v1:p:openrouter")).toBe(false);
    // Another window adds openrouter again before this window's next launch load.
    kc.store.set("llm-provider-keys:v1:p:openrouter", "O-OTHER");
    kc.store.set(INDEX, JSON.stringify([...Object.keys(SEEDED), "openrouter"]));
    const loaded = await vault.migrateAndLoad({}, "");
    expect(loaded.providerKeys.openrouter).toBe("O-OTHER");
    await vault.refreshSecretKeys();
    expect(kc.store.get("llm-provider-keys:v1:p:openrouter")).toBe("O-OTHER");
  });

  test("a key rotated during the load's last write comes back rotated", async () => {
    seed();
    const vault = await freshVault();
    let fired = false;
    kc.hook = async (cmd, args) => {
      if (!fired && cmd === "secret_set" && args.account === "llm-provider-keys:v1:p:openrouter") {
        fired = true;
        vault.saveSecretKeys({ openrouter: "O-KEY", anthropic: "A-NEW" }, "");
      }
    };
    const loaded = await vault.migrateAndLoad({ openrouter: "O-KEY" }, "");
    expect(fired).toBe(true);
    expect(loaded.providerKeys.anthropic).toBe("A-NEW");
    await vault.refreshSecretKeys();
    expect(kc.store.get("llm-provider-keys:v1:p:anthropic")).toBe("A-NEW");
  });

  test("a load that fails keeps the guard up, so a later save still cannot delete the keychain's keys", async () => {
    seed();
    const vault = await freshVault();
    // The plaintext key will not fit in the keychain, so the load's own write fails.
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_set" && args.account === "llm-provider-keys:v1:p:openrouter") throw new Error("too big for the keychain");
    };
    await expect(vault.migrateAndLoad({ openrouter: "O-KEY" }, "")).rejects.toThrow();
    // App never merged, so its next save carries only its own state.
    await vault.saveSecretKeys({ openrouter: "O-KEY" }, "").catch(() => {});
    expect(kc.store.get("llm-provider-keys:v1:p:anthropic")).toBe("A-KEY");
    expect(kc.store.get("llm-provider-keys:v1:p:moonshot")).toBe("M-KEY");
  });

  test("once the load has finished, a save can delete again", async () => {
    seed();
    const vault = await freshVault();
    await vault.migrateAndLoad({}, "");
    await vault.saveSecretKeys({ anthropic: "A-KEY" }, "");
    expect(kc.store.has("llm-provider-keys:v1:p:moonshot")).toBe(false);
    expect(kc.store.get("llm-provider-keys:v1:p:anthropic")).toBe("A-KEY");
  });

  test("the guard is a count that only a load that finished takes down (from source)", () => {
    const src = readFileSync(path.join(process.cwd(), "src/features/terminals/secretVault.js"), "utf8");
    expect(src).toMatch(/launching \+= 1;[^]*?const result = await launchLoad\(legacyProviderKeys, legacyAnthropicKey\);\s*launching -= 1;/);
    expect(src).not.toMatch(/finally \{\s*launching -= 1;/);
  });
});
