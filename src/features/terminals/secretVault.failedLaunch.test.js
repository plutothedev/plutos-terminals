// (C)
// Two vault answers App needs when the keychain refuses a write.
//
// keysNotInKeychain: which keys a plaintext copy is the ONLY copy of. App
// puts exactly those back in localStorage after a refused write; it used to
// put back every key it held, so one key too big for the keychain copied all
// the healthy ones into plaintext as well.
//
// showCachedSecretKeys: after a launch load that failed, the keys every new
// shell gets (readUserSt overlays the cache), for App to show. The guard
// stays up after a failed load, so these keys must count as held, or the
// user could see them and still not remove them.
import { describe, test, expect, vi, beforeEach } from "vitest";

const { kc, invokeMock } = vi.hoisted(() => {
  // `failGet(account)` makes a read throw; `hook` runs first on every call.
  const kc = { store: new Map(), refuse: null, failGet: null, hook: null };
  const invokeMock = vi.fn(async (cmd, args = {}) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (kc.hook) await kc.hook(cmd, args);
    if (cmd === "secret_get" && kc.failGet && kc.failGet(args.account)) throw new Error("keychain read failed");
    if (cmd === "secret_set") {
      if (kc.refuse && kc.refuse(args.account, args.secret)) throw new Error("credential too large");
      kc.store.set(args.account, args.secret);
      return null;
    }
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

const INDEX = "llm-provider-keys:v1:index";
const P = (id) => `llm-provider-keys:v1:p:${id}`;
const LEGACY = "llm-provider-keys:v1:anthropic";
const SEEDED = { anthropic: "A-KEY", moonshot: "M-KEY" };
const seed = () => {
  kc.store.set(INDEX, JSON.stringify(Object.keys(SEEDED)));
  for (const [id, key] of Object.entries(SEEDED)) kc.store.set(P(id), key);
};
const freshVault = async () => {
  vi.resetModules();
  return import("./secretVault.js");
};
// The next save of `account` fails, one of two ways. "refused": the keychain
// turns the write down after the save has read the entry, so the save has
// seen what was there. "locked": the keychain is locked for the whole save,
// which fails at the key index having read nothing, so only a read, or a
// write of this window's that landed, can say what the keychain held.
function failNextSave(how, account) {
  if (how === "refused") {
    const before = kc.refuse;
    kc.refuse = (acc, secret) => acc === account || (before ? before(acc, secret) : false);
    return;
  }
  let left = 1;
  const before = kc.failGet;
  kc.failGet = (acc) => (acc === INDEX && left-- > 0) || (before ? before(acc) : false);
}

beforeEach(() => {
  kc.store.clear();
  kc.refuse = null;
  kc.failGet = null;
  kc.hook = null;
  invokeMock.mockClear();
});

describe("keysNotInKeychain", () => {
  test("names the refused key, never the ones the keychain holds", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.refuse = (account) => account === P("openai");
    const next = { ...SEEDED, openai: "O-BIG", groq: "G-KEY" };
    await expect(vault.saveSecretKeys(next, "")).rejects.toThrow(/openai/);
    expect(vault.keysNotInKeychain(next, "")).toEqual({ ids: ["openai"], legacy: false });
    expect(kc.store.get(P("groq"))).toBe("G-KEY"); // written, so not named
  });

  test("names nothing a later save removed or replaced, so a plaintext copy cannot bring it back", async () => {
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.refuse = (account) => account === P("openai") || account === P("groq");
    const first = { openai: "O-BIG", groq: "G-OLD" };
    const seen = vault.saveSecretKeys(first, "").catch(() => vault.keysNotInKeychain(first, ""));
    vault.saveSecretKeys({ groq: "G-NEW" }, "").catch(() => {}); // openai removed, groq replaced
    expect(await seen).toEqual({ ids: [], legacy: false });
  });

  test("the standalone key: named when refused, not when the keychain holds it or it was cleared since", async () => {
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.refuse = (account) => account === LEGACY;
    await expect(vault.saveSecretKeys({}, "L-KEY")).rejects.toThrow();
    expect(vault.keysNotInKeychain({}, "L-KEY")).toEqual({ ids: [], legacy: true });

    kc.refuse = null;
    await vault.saveSecretKeys({}, "L-KEY");
    expect(kc.store.get(LEGACY)).toBe("L-KEY");
    expect(vault.keysNotInKeychain({}, "L-KEY")).toEqual({ ids: [], legacy: false });

    kc.refuse = (account) => account === LEGACY;
    const seen = vault.saveSecretKeys({}, "L-NEW").catch(() => vault.keysNotInKeychain({}, "L-NEW"));
    vault.saveSecretKeys({}, "").catch(() => {}); // cleared again at once
    expect(await seen).toEqual({ ids: [], legacy: false });
  });

  test("a cleared standalone key is nothing to keep, even while the keychain still has the old one", async () => {
    const vault = await freshVault();
    await vault.loadSecretKeys();
    await vault.saveSecretKeys({}, "L-KEY");
    // The delete is refused, so the keychain keeps "L-KEY" and the baseline
    // still has it; an empty key is no key all the same.
    const realInvoke = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(async (cmd, args = {}) => {
      if (cmd === "secret_delete" && args.account === LEGACY) throw new Error("locked");
      return realInvoke(cmd, args);
    });
    try {
      await expect(vault.saveSecretKeys({}, "")).rejects.toThrow();
      expect(kc.store.get(LEGACY)).toBe("L-KEY");
      expect(vault.keysNotInKeychain({}, "")).toEqual({ ids: [], legacy: false });
    } finally {
      invokeMock.mockImplementation(realInvoke);
    }
  });

  test("a write never attempted (an index it could not read) counts as refused", async () => {
    const vault = await freshVault();
    await vault.loadSecretKeys();
    let reads = 0;
    const realInvoke = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(async (cmd, args = {}) => {
      if (cmd === "secret_get" && args.account === INDEX && reads++ === 0) throw new Error("index unreadable");
      return realInvoke(cmd, args);
    });
    try {
      await expect(vault.saveSecretKeys({ openai: "O-KEY" }, "")).rejects.toThrow(/index unreadable/);
      expect(vault.keysNotInKeychain({ openai: "O-KEY" }, "")).toEqual({ ids: ["openai"], legacy: false });
    } finally {
      invokeMock.mockImplementation(realInvoke);
    }
  });
});

describe("showCachedSecretKeys after a launch load that failed", () => {
  test("returns what shells get, and a key it showed can be removed by the very next save", async () => {
    seed();
    const vault = await freshVault();
    kc.refuse = (account) => account === P("openai");
    await expect(vault.migrateAndLoad({ openai: "O-BIG" }, "")).rejects.toThrow();
    const shown = vault.showCachedSecretKeys();
    expect(shown).toEqual({ providerKeys: { ...SEEDED, openai: "O-BIG" }, anthropicKey: "" });
    expect(shown.providerKeys).not.toBe(vault.getCachedSecretKeys().providerKeys); // a copy
    // The first save after showing them removes moonshot.
    await vault.saveSecretKeys({ anthropic: "A-KEY", openai: "O-BIG" }, "").catch(() => {});
    expect(kc.store.has(P("moonshot"))).toBe(false);
    expect(kc.store.get(P("anthropic"))).toBe("A-KEY");
  });

  test("the keychain's standalone key it showed can be cleared too", async () => {
    seed();
    kc.store.set(LEGACY, "L-CHAIN");
    const vault = await freshVault();
    kc.refuse = (account) => account === P("openai");
    await expect(vault.migrateAndLoad({ openai: "O-BIG" }, "")).rejects.toThrow();
    expect(vault.showCachedSecretKeys().anthropicKey).toBe("L-CHAIN");
    await vault.saveSecretKeys({ ...SEEDED, openai: "O-BIG" }, "").catch(() => {});
    expect(kc.store.has(LEGACY)).toBe(false);
  });
});

// A read that throws for one entry says nothing about that key. A refresh used
// to treat the missing entry as one another window had removed: the key left
// the cache (so App's screen and every new shell) and the record of what the
// keychain holds, until some later read happened to answer.
describe("a refresh that could not read every entry", () => {
  test("keeps what this window knew of the keys it could not read", async () => {
    seed();
    kc.store.set(LEGACY, "L-KEY");
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.failGet = (account) => account === P("moonshot") || account === LEGACY;
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys()).toEqual({ providerKeys: SEEDED, anthropicKey: "L-KEY" });
    expect(vault.keysInKeychain(SEEDED, "L-KEY")).toEqual({ ids: ["anthropic", "moonshot"], legacy: true });
    expect(vault.keysReadFromKeychain(SEEDED, "L-KEY")).toEqual({ ids: ["anthropic", "moonshot"], legacy: true });
    // So a save after it has nothing to write back.
    invokeMock.mockClear();
    await vault.saveSecretKeys(SEEDED, "L-KEY");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "secret_set")).toEqual([]);
  });

  test("still takes what it could read, and what this window had not saved stays as it was", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.refuse = (account) => account === P("openai");
    await expect(vault.saveSecretKeys({ ...SEEDED, openai: "O-BIG" }, "")).rejects.toThrow();
    kc.store.set(P("anthropic"), "A-OTHER"); // another window rotated this one
    kc.failGet = (account) => account === P("moonshot") || account === P("openai");
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys).toEqual({ anthropic: "A-OTHER", moonshot: "M-KEY", openai: "O-BIG" });
    expect(vault.keysNotInKeychain({ openai: "O-BIG" }, "").ids).toEqual(["openai"]);
    expect(vault.keysInKeychain({ anthropic: "A-OTHER", moonshot: "M-KEY" }, "").ids).toEqual(["anthropic", "moonshot"]);
  });
});

// A refresh re-reads the keychain (another window saved, or the launch load
// reads again). It used to replace the cache with what it read, which dropped
// a key the keychain had refused: App showed it, shells lost it, and the next
// save stripped its only plaintext copy. A refresh now keeps what this window
// could not save, unless another window has written that key since.
describe("a refresh keeps what this window could not save", () => {
  test("a refused key stays in the cache, and is still the one plaintext keeps", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.refuse = (account) => account === P("openai");
    await expect(vault.saveSecretKeys({ ...SEEDED, openai: "O-BIG" }, "")).rejects.toThrow();
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys).toEqual({ ...SEEDED, openai: "O-BIG" });
    expect(vault.keysNotInKeychain({ ...SEEDED, openai: "O-BIG" }, "")).toEqual({ ids: ["openai"], legacy: false });
  });

  test("another window's write to that key since then wins", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.refuse = (account) => account === P("openai");
    await expect(vault.saveSecretKeys({ ...SEEDED, openai: "O-BIG" }, "")).rejects.toThrow();
    kc.store.set(P("openai"), "O-OTHER");
    kc.store.set(INDEX, JSON.stringify([...Object.keys(SEEDED), "openai"]));
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.openai).toBe("O-OTHER");
  });

  test("a rotation the keychain refused stays, while the keychain still holds the old value", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.refuse = (account) => account === P("moonshot");
    await expect(vault.saveSecretKeys({ anthropic: "A-KEY", moonshot: "M-BIG" }, "")).rejects.toThrow();
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.moonshot).toBe("M-BIG");
  });

  test("a delete that failed comes back: the keychain still has the key", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    const realInvoke = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(async (cmd, args = {}) => {
      if (cmd === "secret_delete" && args.account === P("moonshot")) throw new Error("locked");
      return realInvoke(cmd, args);
    });
    try {
      await expect(vault.saveSecretKeys({ anthropic: "A-KEY" }, "")).rejects.toThrow();
    } finally {
      invokeMock.mockImplementation(realInvoke);
    }
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys).toEqual(SEEDED);
  });

  test.each(["refused", "locked"])("the first read keeps an edit refused before it, even where the keychain holds an older value (%s)", async (how) => {
    kc.store.set(INDEX, JSON.stringify(["groq"]));
    kc.store.set(P("groq"), "G-CHAIN");
    const vault = await freshVault();
    failNextSave(how, P("groq"));
    // Saved before this window has read the keychain at all: the keychain's
    // value is older than the one the user just typed.
    const saved = vault.saveSecretKeys({ groq: "G-NEW" }, "").catch(() => "refused");
    await vault.loadSecretKeys();
    expect(await saved).toBe("refused");
    expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("G-NEW");
  });

  test("the first read takes another window's write over a value this window had saved", async () => {
    const vault = await freshVault();
    await vault.saveSecretKeys({ groq: "G-MINE" }, ""); // landed, before any read
    kc.store.set(P("groq"), "G-OTHER"); // then another window rotated it
    await vault.loadSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("G-OTHER");
  });

  test("the standalone key: kept when refused, replaced when another window writes it", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.refuse = (account) => account === LEGACY;
    await expect(vault.saveSecretKeys(SEEDED, "L-BIG")).rejects.toThrow();
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-BIG");
    kc.store.set(LEGACY, "L-OTHER");
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-OTHER");
  });
});

// A refresh lets another window's write win only when this window knows what
// the keychain held before: from a read, or from a value it saved itself.
// Until then a value the user typed stays, since the keychain's copy predates
// it. A read that found the keychain empty is knowledge too; a read that could
// not answer is not.
describe("what this window knows the keychain held", () => {
  test.each(["refused", "locked"])("an empty keychain at the first read counts: another window's later write beats a value this window could not save (%s)", async (how) => {
    const vault = await freshVault();
    await vault.loadSecretKeys(); // the index is absent and nothing is stored
    failNextSave(how, P("openai"));
    await expect(vault.saveSecretKeys({ openai: "O-OLD" }, "")).rejects.toThrow();
    kc.refuse = null;
    kc.store.set(P("openai"), "O-OTHER");
    kc.store.set(INDEX, JSON.stringify(["openai"]));
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.openai).toBe("O-OTHER");
    // ...and the next save does not write the old value over it.
    await vault.saveSecretKeys({ openai: "O-OTHER" }, "");
    expect(kc.store.get(P("openai"))).toBe("O-OTHER");
  });

  test.each(["refused", "locked"])("so does an empty first read on a keychain that could not be proven, while no write of this window's has landed (%s)", async (how) => {
    // The self-test failed (its own write was turned down), but reads work.
    kc.refuse = (account) => account.startsWith("keychain-probe");
    const vault = await freshVault();
    await vault.loadSecretKeys(); // the index is absent and nothing is stored
    expect(vault.keychainAvailable()).toBe(false);
    failNextSave(how, P("openai"));
    await expect(vault.saveSecretKeys({ openai: "O-OLD" }, "")).rejects.toThrow();
    kc.store.set(P("openai"), "O-OTHER");
    kc.store.set(INDEX, JSON.stringify(["openai"]));
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.openai).toBe("O-OTHER");
  });

  test.each(["refused", "locked"])("a value this window saved counts before any read: another window's later write beats a refused rotation (%s)", async (how) => {
    const vault = await freshVault();
    await vault.saveSecretKeys({ openai: "O-1" }, ""); // landed
    failNextSave(how, P("openai"));
    await expect(vault.saveSecretKeys({ openai: "O-2" }, "")).rejects.toThrow();
    kc.refuse = null;
    kc.store.set(P("openai"), "O-OTHER"); // another window, after O-1 landed
    await vault.loadSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.openai).toBe("O-OTHER");
  });

  test.each(["refused", "locked"])("a first read that could not answer counts for nothing: a value typed before it stays over an older copy (%s)", async (how) => {
    kc.store.set(INDEX, JSON.stringify(["groq"]));
    kc.store.set(P("groq"), "G-OLD"); // from an earlier session
    const vault = await freshVault();
    let locked = true;
    kc.failGet = (account) => locked && String(account).startsWith("llm-");
    await vault.loadSecretKeys(); // nothing readable
    locked = false;
    failNextSave(how, P("groq"));
    await expect(vault.saveSecretKeys({ groq: "G-NEW" }, "")).rejects.toThrow();
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("G-NEW");
  });

  test.each(["refused", "locked"])("an absent index is no proof of an empty keychain while an entry could not be read (%s)", async (how) => {
    const vault = await freshVault();
    kc.store.set(P("groq"), "G-OLD"); // no index, and this entry will not read
    let locked = true;
    kc.failGet = (account) => locked && account === P("groq");
    await vault.loadSecretKeys();
    locked = false;
    failNextSave(how, P("groq"));
    await expect(vault.saveSecretKeys({ groq: "G-NEW" }, "")).rejects.toThrow();
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("G-NEW");
  });

  test.each(["refused", "locked"])("nor while the standalone entry could not be read (%s)", async (how) => {
    kc.store.set(LEGACY, "L-OLD"); // no index; this entry will not read at first
    const vault = await freshVault();
    let locked = true;
    kc.failGet = (account) => locked && account === LEGACY;
    await vault.loadSecretKeys();
    locked = false;
    failNextSave(how, LEGACY);
    await expect(vault.saveSecretKeys({}, "L-NEW")).rejects.toThrow();
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-NEW");
  });

  test.each(["provider", "standalone"])("a first read that could not answer for one entry (%s) is no baseline for the others either: a key typed before the next read stays", async (which) => {
    // No index, nothing stored but the one entry, which will not read at first.
    let locked = true;
    const stuck = which === "provider" ? P("groq") : LEGACY;
    kc.store.set(stuck, "OLD");
    kc.failGet = (account) => locked && account === stuck;
    const vault = await freshVault();
    await vault.loadSecretKeys(); // nothing readable
    locked = false;
    failNextSave("locked", P("openai"));
    expect(await vault.saveSecretKeys({ openai: "O-NEW" }, "").then(() => "saved", () => "failed")).toBe("failed");
    kc.store.set(P("openai"), "O-OTHER"); // another window's
    kc.store.set(INDEX, JSON.stringify(["openai"]));
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.openai).toBe("O-NEW");
  });

  test("nor while the old single-entry blob could not be read", async () => {
    kc.store.set("llm-provider-keys:v0", JSON.stringify({ providerKeys: { groq: "G-OLD" }, anthropicKey: "" }));
    const vault = await freshVault();
    let locked = true;
    kc.failGet = (account) => locked && account === "llm-provider-keys:v0";
    kc.refuse = (account) => account === P("groq");
    await vault.loadSecretKeys();
    locked = false;
    await expect(vault.saveSecretKeys({ groq: "G-NEW" }, "")).rejects.toThrow();
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("G-NEW");
  });

  test("a cleared standalone key whose delete failed comes back at the refresh", async () => {
    seed();
    kc.store.set(LEGACY, "L-KEY");
    const vault = await freshVault();
    await vault.loadSecretKeys();
    const realInvoke = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(async (cmd, args = {}) => {
      if (cmd === "secret_delete" && args.account === LEGACY) throw new Error("locked");
      return realInvoke(cmd, args);
    });
    try {
      await expect(vault.saveSecretKeys(SEEDED, "")).rejects.toThrow();
    } finally {
      invokeMock.mockImplementation(realInvoke);
    }
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-KEY");
  });

  test.each(["refused", "locked"])("a standalone key this window saved counts before any read: another window's later write beats a refused change (%s)", async (how) => {
    const vault = await freshVault();
    await vault.saveSecretKeys({}, "L-1"); // landed
    failNextSave(how, LEGACY);
    await expect(vault.saveSecretKeys({}, "L-2")).rejects.toThrow();
    kc.refuse = null;
    kc.store.set(LEGACY, "L-OTHER");
    await vault.loadSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-OTHER");
  });

  test("an empty read proves nothing once this window's own writes have landed: the cache keeps them", async () => {
    // A fresh install: the first read finds nothing, and that is the truth.
    const vault = await freshVault();
    await vault.loadSecretKeys();
    expect(vault.keychainAvailable()).toBe(true);
    await vault.saveSecretKeys({ groq: "G-KEY" }, "L-KEY");
    // Then the keychain loses everything it was given, index included. An
    // empty answer now contradicts writes that landed: it is no baseline.
    kc.store.clear();
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys()).toEqual({ providerKeys: { groq: "G-KEY" }, anthropicKey: "L-KEY" });
  });

  test("the standalone key alone counts as a write that landed", async () => {
    const vault = await freshVault();
    await vault.loadSecretKeys();
    await vault.saveSecretKeys({}, "L-KEY");
    kc.store.clear();
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-KEY");
  });

  test("on a keychain that keeps nothing, an empty read proves nothing: the cache keeps what the window saved", async () => {
    // Writes say yes and reads find nothing, the keyring crate's in-memory
    // mock: the probe fails, and an empty read is no proof of an empty keychain.
    const realInvoke = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(async (cmd) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (cmd === "secret_get") return null;
      return null;
    });
    try {
      const vault = await freshVault();
      await vault.loadSecretKeys();
      expect(vault.keychainAvailable()).toBe(false);
      await vault.saveSecretKeys({ groq: "G-KEY" }, "");
      await vault.refreshSecretKeys();
      expect(vault.getCachedSecretKeys().providerKeys).toEqual({ groq: "G-KEY" });
    } finally {
      invokeMock.mockImplementation(realInvoke);
    }
  });

  test("the first read takes another window's write of the standalone key over a value this window had saved", async () => {
    const vault = await freshVault();
    await vault.saveSecretKeys({}, "L-MINE"); // landed, before any read
    kc.store.set(LEGACY, "L-OTHER");
    await vault.loadSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-OTHER");
  });

  test("a standalone key cleared during the load and then written by another window stays", async () => {
    seed();
    const vault = await freshVault();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let held;
    const reached = new Promise((resolve) => { held = resolve; });
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_get" && args.account === INDEX && release) {
        held();
        await gate;
      }
    };
    const load = vault.migrateAndLoad({}, "L-PLAIN");
    await reached;
    vault.saveSecretKeys({}, ""); // this window clears its standalone key
    // Another window writes one; its storage event makes this window refresh.
    kc.store.set(LEGACY, "L-OTHER");
    const refreshed = vault.refreshSecretKeys();
    const r = release;
    release = null;
    r();
    await load;
    await refreshed;
    await vault.refreshSecretKeys();
    expect(kc.store.get(LEGACY)).toBe("L-OTHER");
  });
});

// A key the keychain turned down for a moment (locked, a denied prompt) stays
// in this window and goes in at its next save. Not over a write another
// window has made to that key since: a save that changes only keys fires no
// storage event, so this window may never hear of it, and its older value
// used to go in over the newer one at whatever it saved next, a theme toggle
// included. The test is what the keychain held when this window's own write
// failed (or, if it could not read then, what it last knew): any other value
// there now was written after, and stands.
describe("the next save retries what this window could not save, unless another window has written that key since", () => {
  // The next write to `account` is turned down, once; reads still answer.
  const refuseOnce = (account) => {
    let left = 1;
    kc.refuse = (acc) => acc === account && left-- > 0;
  };
  // Another window's save of keys alone: the keychain changes, this one hears nothing.
  const otherWindowWrites = (id, value) => {
    kc.store.set(P(id), value);
    const ids = new Set(JSON.parse(kc.store.get(INDEX) || "[]"));
    ids.add(id);
    kc.store.set(INDEX, JSON.stringify([...ids]));
  };
  const otherWindowRemoves = (id) => {
    kc.store.delete(P(id));
    kc.store.set(INDEX, JSON.stringify(JSON.parse(kc.store.get(INDEX) || "[]").filter((x) => x !== id)));
  };
  const MINE = { ...SEEDED, openai: "O-MINE" };
  // How a save ends: "saved", or the message it was turned down with.
  const ending = (save) => save.then(() => "saved", (err) => err.message);

  test("with nothing written since, the retry goes in", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(P("openai"));
    expect(await ending(vault.saveSecretKeys(MINE, ""))).toMatch(/openai/);
    await vault.saveSecretKeys(MINE, "");
    expect(kc.store.get(P("openai"))).toBe("O-MINE");
    expect(vault.keysNotInKeychain(MINE, "")).toEqual({ ids: [], legacy: false });
  });

  test("another window's write since then stays, and the old value gets no plaintext copy", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(P("openai"));
    expect(await ending(vault.saveSecretKeys(MINE, ""))).toMatch(/openai/);
    otherWindowWrites("openai", "O-OTHER");
    await vault.saveSecretKeys(MINE, ""); // any save: App's state still holds the old value
    expect(kc.store.get(P("openai"))).toBe("O-OTHER");
    expect(vault.keysNotInKeychain(MINE, "")).toEqual({ ids: [], legacy: false });
    // The next refresh brings the newer value in.
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.openai).toBe("O-OTHER");
  });

  test("so does one made after a refresh that kept the refused value", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(P("openai"));
    expect(await ending(vault.saveSecretKeys(MINE, ""))).toMatch(/openai/);
    await vault.refreshSecretKeys(); // another window saved a setting
    expect(vault.getCachedSecretKeys().providerKeys.openai).toBe("O-MINE");
    otherWindowWrites("openai", "O-OTHER");
    await vault.saveSecretKeys(MINE, "");
    expect(kc.store.get(P("openai"))).toBe("O-OTHER");
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.openai).toBe("O-OTHER");
  });

  test("and one made after an outage in which not even a read answered", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.failGet = () => true;
    kc.refuse = () => true;
    expect(await ending(vault.saveSecretKeys(MINE, ""))).not.toBe("saved");
    kc.failGet = null;
    kc.refuse = null;
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.openai).toBe("O-MINE");
    otherWindowWrites("openai", "O-OTHER");
    await vault.saveSecretKeys(MINE, "");
    expect(kc.store.get(P("openai"))).toBe("O-OTHER");
  });

  test("another window's removal of the key since then stays removed", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    const rotated = { ...SEEDED, moonshot: "M-MINE" };
    refuseOnce(P("moonshot"));
    expect(await ending(vault.saveSecretKeys(rotated, ""))).toMatch(/moonshot/);
    otherWindowRemoves("moonshot");
    await vault.saveSecretKeys(rotated, "");
    expect(kc.store.has(P("moonshot"))).toBe(false);
    expect(vault.keysNotInKeychain(rotated, "")).toEqual({ ids: [], legacy: false });
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.moonshot).toBeUndefined();
  });

  test("once overruled, the old value never goes in, even after the newer one is removed", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(P("openai"));
    expect(await ending(vault.saveSecretKeys(MINE, ""))).toMatch(/openai/);
    otherWindowWrites("openai", "O-OTHER");
    await vault.saveSecretKeys(MINE, "");
    expect(kc.store.get(P("openai"))).toBe("O-OTHER");
    await vault.saveSecretKeys(MINE, ""); // and the save after that
    expect(kc.store.get(P("openai"))).toBe("O-OTHER");
    otherWindowRemoves("openai");
    await vault.saveSecretKeys(MINE, "");
    expect(kc.store.has(P("openai"))).toBe(false);
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.openai).toBeUndefined();
  });

  test("a value typed after another window's write still goes in: the failed write saw that write", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    otherWindowWrites("openai", "O-OTHER"); // this window never hears of it
    refuseOnce(P("openai"));
    expect(await ending(vault.saveSecretKeys(MINE, ""))).toMatch(/openai/);
    await vault.saveSecretKeys(MINE, "");
    expect(kc.store.get(P("openai"))).toBe("O-MINE");
  });

  test("a value typed after another window removed the key still goes in: the failed write found it gone", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    const rotated = { ...SEEDED, moonshot: "M-MINE" };
    otherWindowRemoves("moonshot"); // this window never hears of it
    refuseOnce(P("moonshot"));
    expect(await ending(vault.saveSecretKeys(rotated, ""))).toMatch(/moonshot/);
    await vault.saveSecretKeys(rotated, "");
    expect(kc.store.get(P("moonshot"))).toBe("M-MINE");
  });

  test("a key still only in the old single-entry blob: its empty entry is no sign that another window removed it", async () => {
    kc.store.set("llm-provider-keys:v0", JSON.stringify({ providerKeys: { groq: "G-OLD" }, anthropicKey: "" }));
    let stuck = true; // so the move to one entry per key cannot finish
    kc.refuse = (account) => stuck && account === P("groq");
    const vault = await freshVault();
    await vault.loadSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("G-OLD");
    expect(await ending(vault.saveSecretKeys({ groq: "G-NEW" }, ""))).toMatch(/groq/);
    await vault.refreshSecretKeys(); // the old blob still holds G-OLD, as before the save
    expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("G-NEW");
    stuck = false;
    await vault.saveSecretKeys({ groq: "G-NEW" }, "");
    expect(kc.store.get(P("groq"))).toBe("G-NEW");
  });

  test("and a refresh in between keeps it, since the keychain still holds what that write saw", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    otherWindowWrites("openai", "O-OTHER");
    refuseOnce(P("openai"));
    expect(await ending(vault.saveSecretKeys(MINE, ""))).toMatch(/openai/);
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.openai).toBe("O-MINE");
    await vault.saveSecretKeys(MINE, "");
    expect(kc.store.get(P("openai"))).toBe("O-MINE");
  });

  test("a value typed again after being overruled is the user's newest, and keeps its plaintext copy if refused", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(P("openai"));
    expect(await ending(vault.saveSecretKeys(MINE, ""))).toMatch(/openai/);
    otherWindowWrites("openai", "O-OTHER");
    await vault.saveSecretKeys(MINE, ""); // overruled
    await vault.saveSecretKeys(SEEDED, ""); // the user removes it here...
    refuseOnce(P("openai"));
    expect(await ending(vault.saveSecretKeys(MINE, ""))).toMatch(/openai/); // ...and pastes it back
    expect(vault.keysNotInKeychain(MINE, "")).toEqual({ ids: ["openai"], legacy: false });
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.openai).toBe("O-MINE");
    await vault.saveSecretKeys(MINE, "");
    expect(kc.store.get(P("openai"))).toBe("O-MINE");
  });

  test("a retry that cannot read the entry writes, as before: there is nothing to tell it a newer write is there", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    const rotated = { ...SEEDED, moonshot: "M-MINE" };
    refuseOnce(P("moonshot"));
    expect(await ending(vault.saveSecretKeys(rotated, ""))).toMatch(/moonshot/);
    otherWindowWrites("moonshot", "M-OTHER");
    let left = 1;
    kc.failGet = (account) => account === P("moonshot") && left-- > 0;
    await vault.saveSecretKeys(rotated, "");
    expect(kc.store.get(P("moonshot"))).toBe("M-MINE");
  });

  test("after being overruled, removing the key here leaves the newer one: this window never knew it", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(P("openai"));
    expect(await ending(vault.saveSecretKeys(MINE, ""))).toMatch(/openai/);
    otherWindowWrites("openai", "O-OTHER");
    await vault.saveSecretKeys(MINE, ""); // overruled
    await vault.saveSecretKeys(SEEDED, "");
    expect(kc.store.get(P("openai"))).toBe("O-OTHER");
  });

  test("a read replaces what a failed write found: the old value written back since is a change", async () => {
    seed();
    kc.store.set(LEGACY, "L-KEY");
    const vault = await freshVault();
    await vault.loadSecretKeys();
    let left = 2;
    kc.refuse = (account) => (account === P("moonshot") || account === LEGACY) && left-- > 0;
    expect(await ending(vault.saveSecretKeys({ ...SEEDED, moonshot: "M-MINE" }, "L-MINE"))).toMatch(/moonshot, anthropic/); // found M-KEY, L-KEY
    otherWindowWrites("moonshot", "M-OTHER");
    kc.store.set(LEGACY, "L-OTHER");
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.moonshot).toBe("M-OTHER");
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-OTHER");
    otherWindowWrites("moonshot", "M-KEY"); // both put back as they were
    kc.store.set(LEGACY, "L-KEY");
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.moonshot).toBe("M-KEY");
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-KEY");
  });

  test("so does a retry that found its value there already, and one that went in", async () => {
    for (const othersFirst of [true, false]) {
      kc.store.clear();
      seed();
      const vault = await freshVault();
      await vault.loadSecretKeys();
      const rotated = { ...SEEDED, moonshot: "M-MINE" };
      refuseOnce(P("moonshot"));
      expect(await ending(vault.saveSecretKeys(rotated, ""))).toMatch(/moonshot/); // found M-KEY
      if (othersFirst) otherWindowWrites("moonshot", "M-MINE"); // the same value, from another window
      await vault.saveSecretKeys(rotated, "");
      expect(kc.store.get(P("moonshot"))).toBe("M-MINE");
      otherWindowWrites("moonshot", "M-KEY"); // then the old one, put back
      await vault.refreshSecretKeys();
      expect(vault.getCachedSecretKeys().providerKeys.moonshot).toBe("M-KEY");
    }
  });

  test("a refresh that could not read the key keeps what the failed write found", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    otherWindowWrites("moonshot", "M-OTHER"); // this window never hears of it
    refuseOnce(P("moonshot"));
    expect(await ending(vault.saveSecretKeys({ ...SEEDED, moonshot: "M-MINE" }, ""))).toMatch(/moonshot/); // found M-OTHER
    let left = 1;
    kc.failGet = (account) => account === P("moonshot") && left-- > 0;
    await vault.refreshSecretKeys(); // could not read it
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.moonshot).toBe("M-MINE");
  });

  test("the standalone key: another window's write since then stays, and the old value gets no plaintext copy", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(LEGACY);
    expect(await ending(vault.saveSecretKeys(SEEDED, "L-MINE"))).toMatch(/anthropic/);
    kc.store.set(LEGACY, "L-OTHER");
    await vault.saveSecretKeys(SEEDED, "L-MINE");
    expect(kc.store.get(LEGACY)).toBe("L-OTHER");
    expect(vault.keysNotInKeychain(SEEDED, "L-MINE")).toEqual({ ids: [], legacy: false });
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-OTHER");
  });

  test("the standalone key: and one made after an outage in which not even a read answered", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.failGet = () => true;
    kc.refuse = () => true;
    expect(await ending(vault.saveSecretKeys(SEEDED, "L-MINE"))).not.toBe("saved");
    kc.failGet = null;
    kc.refuse = null;
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-MINE");
    kc.store.set(LEGACY, "L-OTHER");
    await vault.saveSecretKeys(SEEDED, "L-MINE");
    expect(kc.store.get(LEGACY)).toBe("L-OTHER");
  });

  test("the standalone key: typed after another window's write, a refresh keeps it and the retry goes in", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.store.set(LEGACY, "L-OTHER");
    refuseOnce(LEGACY);
    expect(await ending(vault.saveSecretKeys(SEEDED, "L-MINE"))).toMatch(/anthropic/);
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-MINE");
    await vault.saveSecretKeys(SEEDED, "L-MINE");
    expect(kc.store.get(LEGACY)).toBe("L-MINE");
  });

  test("the standalone key: once overruled, it never goes in, even after the newer one is removed", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(LEGACY);
    expect(await ending(vault.saveSecretKeys(SEEDED, "L-MINE"))).toMatch(/anthropic/);
    kc.store.set(LEGACY, "L-OTHER");
    await vault.saveSecretKeys(SEEDED, "L-MINE"); // overruled
    await vault.saveSecretKeys(SEEDED, "L-MINE"); // and the save after that
    expect(kc.store.get(LEGACY)).toBe("L-OTHER");
    kc.store.delete(LEGACY);
    await vault.saveSecretKeys(SEEDED, "L-MINE");
    expect(kc.store.has(LEGACY)).toBe(false);
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("");
  });

  test("the standalone key: a refresh that could not read it keeps what the failed write found", async () => {
    seed();
    kc.store.set(LEGACY, "L-KEY");
    const vault = await freshVault();
    await vault.loadSecretKeys();
    kc.store.set(LEGACY, "L-OTHER"); // this window never hears of it
    refuseOnce(LEGACY);
    expect(await ending(vault.saveSecretKeys(SEEDED, "L-MINE"))).toMatch(/anthropic/); // found L-OTHER
    let left = 1;
    kc.failGet = (account) => account === LEGACY && left-- > 0;
    await vault.refreshSecretKeys(); // could not read it
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-MINE");
  });

  test("the standalone key: what a failed write found counts as known before any read has answered", async () => {
    kc.store.set(P("groq"), "G-KEY"); // no index, and this entry will not read at first
    let locked = true;
    kc.failGet = (account) => locked && account === P("groq");
    const vault = await freshVault();
    await vault.loadSecretKeys(); // nothing readable, so no baseline
    locked = false;
    refuseOnce(LEGACY);
    expect(await ending(vault.saveSecretKeys({ groq: "G-KEY" }, "L-MINE"))).toMatch(/anthropic/); // found nothing there
    kc.store.set(LEGACY, "L-OTHER"); // so this was written after
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-OTHER");
  });

  test("a refused change goes in at a later save once a refresh has found the keychain unchanged", async () => {
    seed();
    kc.store.set(LEGACY, "L-KEY");
    const vault = await freshVault();
    await vault.loadSecretKeys();
    const rotated = { ...SEEDED, moonshot: "M-MINE" };
    let left = 2;
    kc.refuse = (account) => (account === P("moonshot") || account === LEGACY) && left-- > 0;
    expect(await ending(vault.saveSecretKeys(rotated, "L-MINE"))).toMatch(/moonshot, anthropic/);
    await vault.refreshSecretKeys();
    await vault.saveSecretKeys(rotated, "L-MINE");
    expect(kc.store.get(P("moonshot"))).toBe("M-MINE");
    expect(kc.store.get(LEGACY)).toBe("L-MINE");
  });

  // Only a window that has seen what the keychain holds for a key can tell a
  // newer write from another window: one that never saw it (no read has
  // answered for that key, and no write of its own landed or looked there)
  // may be looking at an older copy, and the key typed here goes in, as it
  // always did.
  test("a key typed while the keychain could not be read at all goes in over the older copy it never saw", async () => {
    kc.store.set(INDEX, JSON.stringify(["groq"]));
    kc.store.set(P("groq"), "G-OLD"); // from an earlier session
    const vault = await freshVault();
    let locked = true; // nothing reads
    kc.failGet = () => locked;
    await vault.loadSecretKeys(); // no read answers, so no baseline
    expect(await ending(vault.saveSecretKeys({ groq: "G-NEW" }, ""))).not.toBe("saved");
    locked = false;
    await vault.saveSecretKeys({ groq: "G-NEW" }, ""); // any later save
    expect(kc.store.get(P("groq"))).toBe("G-NEW");
  });

  test("the standalone key: typed while the keychain could not be read at all, it goes in over the older copy", async () => {
    kc.store.set(LEGACY, "L-OLD");
    const vault = await freshVault();
    let locked = true;
    kc.failGet = () => locked;
    await vault.loadSecretKeys();
    expect(await ending(vault.saveSecretKeys({}, "L-NEW"))).not.toBe("saved");
    locked = false;
    await vault.saveSecretKeys({}, "L-NEW");
    expect(kc.store.get(LEGACY)).toBe("L-NEW");
  });

  test("so does one whose entry the first read could not answer, though the rest of the keychain answered", async () => {
    kc.store.set(INDEX, JSON.stringify(["groq"]));
    kc.store.set(P("groq"), "G-OLD");
    const vault = await freshVault();
    kc.failGet = (account) => account === P("groq"); // only this entry will not read
    await vault.loadSecretKeys();
    let left = 1;
    kc.failGet = (account) => account === INDEX && left-- > 0; // the save is locked out at the key index
    expect(await ending(vault.saveSecretKeys({ groq: "G-NEW" }, ""))).not.toBe("saved");
    await vault.saveSecretKeys({ groq: "G-NEW" }, "");
    expect(kc.store.get(P("groq"))).toBe("G-NEW");
  });

  test("and a refresh before that save keeps the key typed, then the save puts it in", async () => {
    kc.store.set(INDEX, JSON.stringify(["groq"]));
    kc.store.set(P("groq"), "G-OLD");
    const vault = await freshVault();
    kc.failGet = (account) => account === P("groq");
    await vault.loadSecretKeys();
    let left = 1;
    kc.failGet = (account) => account === INDEX && left-- > 0;
    expect(await ending(vault.saveSecretKeys({ groq: "G-NEW" }, ""))).not.toBe("saved");
    await vault.refreshSecretKeys(); // reads G-OLD, which this window never saw before
    expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("G-NEW");
    await vault.saveSecretKeys({ groq: "G-NEW" }, "");
    expect(kc.store.get(P("groq"))).toBe("G-NEW");
  });

  test("the standalone key: the same when the first read could not answer for it alone", async () => {
    kc.store.set(INDEX, JSON.stringify([]));
    kc.store.set(LEGACY, "L-OLD");
    const vault = await freshVault();
    kc.failGet = (account) => account === LEGACY;
    await vault.loadSecretKeys();
    let left = 1;
    kc.failGet = (account) => account === INDEX && left-- > 0;
    expect(await ending(vault.saveSecretKeys({}, "L-NEW"))).not.toBe("saved");
    await vault.saveSecretKeys({}, "L-NEW");
    expect(kc.store.get(LEGACY)).toBe("L-NEW");
  });

  test("before any read has answered, what a failed write saw still counts: another window's later write stands", async () => {
    kc.store.set(INDEX, JSON.stringify(["groq"]));
    kc.store.set(P("groq"), "G-OLD");
    const vault = await freshVault();
    let locked = true;
    kc.failGet = () => locked;
    await vault.loadSecretKeys(); // no baseline
    locked = false;
    refuseOnce(P("groq"));
    expect(await ending(vault.saveSecretKeys({ groq: "G-NEW" }, ""))).toMatch(/groq/); // saw G-OLD
    otherWindowWrites("groq", "G-OTHER"); // written after that
    await vault.saveSecretKeys({ groq: "G-NEW" }, "");
    expect(kc.store.get(P("groq"))).toBe("G-OTHER");
  });

  test("a retry that could not read the entry keeps what the earlier failed write saw there", async () => {
    const vault = await freshVault();
    await vault.loadSecretKeys(); // an empty keychain
    otherWindowWrites("groq", "G-OTHER"); // before the user types; this window never hears of it
    kc.refuse = (account) => account === P("groq"); // too big for the keychain, every time
    expect(await ending(vault.saveSecretKeys({ groq: "G-BIG" }, ""))).toMatch(/groq/); // saw G-OTHER
    let left = 1;
    kc.failGet = (account) => account === P("groq") && left-- > 0;
    expect(await ending(vault.saveSecretKeys({ groq: "G-BIG" }, ""))).toMatch(/groq/); // could not read the entry
    expect(await ending(vault.saveSecretKeys({ groq: "G-BIG" }, ""))).toMatch(/groq/); // tried again, not overruled
    expect(vault.keysNotInKeychain({ groq: "G-BIG" }, "")).toEqual({ ids: ["groq"], legacy: false });
  });

  test("a removal that lands ends what an earlier failed write saw: a key typed after it, while locked out, goes in", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(P("moonshot"));
    expect(await ending(vault.saveSecretKeys({ ...SEEDED, moonshot: "M-V1" }, ""))).toMatch(/moonshot/); // saw M-KEY
    await vault.saveSecretKeys({ anthropic: "A-KEY" }, ""); // removed here: the delete lands
    expect(kc.store.has(P("moonshot"))).toBe(false);
    let left = 1;
    kc.failGet = (account) => account === INDEX && left-- > 0;
    expect(await ending(vault.saveSecretKeys({ ...SEEDED, moonshot: "M-V2" }, ""))).not.toBe("saved");
    await vault.saveSecretKeys({ ...SEEDED, moonshot: "M-V2" }, "");
    expect(kc.store.get(P("moonshot"))).toBe("M-V2");
  });

  test("so does a removal that finds the key already gone", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(P("moonshot"));
    expect(await ending(vault.saveSecretKeys({ ...SEEDED, moonshot: "M-V1" }, ""))).toMatch(/moonshot/); // saw M-KEY
    otherWindowRemoves("moonshot");
    await vault.saveSecretKeys({ anthropic: "A-KEY" }, ""); // removed here too: nothing left to delete
    let left = 1;
    kc.failGet = (account) => account === INDEX && left-- > 0;
    expect(await ending(vault.saveSecretKeys({ ...SEEDED, moonshot: "M-V2" }, ""))).not.toBe("saved");
    await vault.saveSecretKeys({ ...SEEDED, moonshot: "M-V2" }, "");
    expect(kc.store.get(P("moonshot"))).toBe("M-V2");
  });

  test("the standalone key: a removal that lands ends what an earlier failed write saw", async () => {
    seed();
    kc.store.set(LEGACY, "L-OLD");
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(LEGACY);
    expect(await ending(vault.saveSecretKeys(SEEDED, "L-V1"))).toMatch(/anthropic/); // saw L-OLD
    await vault.saveSecretKeys(SEEDED, ""); // removed here: the delete lands
    expect(kc.store.has(LEGACY)).toBe(false);
    let left = 1;
    kc.failGet = (account) => account === INDEX && left-- > 0;
    expect(await ending(vault.saveSecretKeys(SEEDED, "L-V2"))).not.toBe("saved");
    await vault.saveSecretKeys(SEEDED, "L-V2");
    expect(kc.store.get(LEGACY)).toBe("L-V2");
  });

  // What this window saw when it set a value aside is what it knows of the key,
  // so a value typed after that is compared with it, not with what an earlier
  // failed write found before the other window wrote.
  test("a value typed after this window set its own older one aside for another window's newer key is not set aside in turn", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(P("moonshot"));
    expect(await ending(vault.saveSecretKeys({ ...SEEDED, moonshot: "M-V" }, ""))).toMatch(/moonshot/); // saw M-KEY
    otherWindowWrites("moonshot", "M-R");
    await vault.saveSecretKeys({ ...SEEDED, moonshot: "M-V" }, ""); // M-V is set aside: this window sees M-R here
    expect(kc.store.get(P("moonshot"))).toBe("M-R");
    failNextSave("locked");
    expect(await ending(vault.saveSecretKeys({ ...SEEDED, moonshot: "M-W" }, ""))).not.toBe("saved"); // typed now; the index cannot be read
    await vault.saveSecretKeys({ ...SEEDED, moonshot: "M-W" }, "");
    expect(kc.store.get(P("moonshot"))).toBe("M-W");
  });

  test("the standalone key: a value typed after its older one was set aside is not set aside in turn", async () => {
    seed();
    kc.store.set(LEGACY, "L-OLD");
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(LEGACY);
    expect(await ending(vault.saveSecretKeys(SEEDED, "L-V"))).toMatch(/anthropic/); // saw L-OLD
    kc.store.set(LEGACY, "L-R");
    await vault.saveSecretKeys(SEEDED, "L-V"); // set aside: this window sees L-R here
    expect(kc.store.get(LEGACY)).toBe("L-R");
    failNextSave("locked");
    expect(await ending(vault.saveSecretKeys(SEEDED, "L-W"))).not.toBe("saved");
    await vault.saveSecretKeys(SEEDED, "L-W");
    expect(kc.store.get(LEGACY)).toBe("L-W");
  });

  test("a refresh after that keeps the value typed after it, whose save never got to read the entry", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    refuseOnce(P("moonshot"));
    expect(await ending(vault.saveSecretKeys({ ...SEEDED, moonshot: "M-V" }, ""))).toMatch(/moonshot/);
    otherWindowWrites("moonshot", "M-R");
    await vault.saveSecretKeys({ ...SEEDED, moonshot: "M-V" }, "");
    failNextSave("locked");
    expect(await ending(vault.saveSecretKeys({ ...SEEDED, moonshot: "M-W" }, ""))).not.toBe("saved");
    await vault.refreshSecretKeys();
    expect(vault.getCachedSecretKeys().providerKeys.moonshot).toBe("M-W");
  });

  // The first read of a window that finds the old single-entry blob goes through the split to one entry per key. That path
  // used to drop which entries could not be read, so a key typed for such an entry was judged "written since" by another
  // window and never went in, though the keychain's copy was only an older one this window had never seen.
  describe("a first read that went through the old-blob split still knows which entries it could not read", () => {
    const V0 = "llm-provider-keys:v0";
    const typedWhileLockedOut = async (vault, typed, standalone) => {
      let left = 1;
      kc.failGet = (account) => account === INDEX && left-- > 0; // the typed save is locked out at the key index
      const base = vault.getCachedSecretKeys();
      const keys = standalone ? base.providerKeys : { ...base.providerKeys, custom: typed };
      expect(await ending(vault.saveSecretKeys(keys, standalone ? typed : base.anthropicKey))).not.toBe("saved");
      kc.failGet = null;
      const now = vault.getCachedSecretKeys();
      await vault.saveSecretKeys(now.providerKeys, now.anthropicKey); // any later save
    };
    test("a key typed for an entry the first read could not answer goes in over the older copy", async () => {
      kc.store.set(V0, JSON.stringify({ providerKeys: { groq: "G-V0" }, anthropicKey: "" })); // an unfinished migration
      kc.store.set(INDEX, JSON.stringify(["custom"]));
      kc.store.set(P("custom"), "C-OLD"); // an earlier session's, not in the old blob
      const vault = await freshVault();
      kc.failGet = (account) => account === P("custom");
      await vault.loadSecretKeys();
      await typedWhileLockedOut(vault, "C-MINE", false);
      expect(kc.store.get(P("custom"))).toBe("C-MINE");
    });
    test("the standalone key: a key typed for it goes in over the older copy too", async () => {
      kc.store.set(V0, JSON.stringify({ providerKeys: { groq: "G-V0" }, anthropicKey: "" }));
      kc.store.set(INDEX, JSON.stringify([]));
      kc.store.set(LEGACY, "L-OLD");
      const vault = await freshVault();
      kc.failGet = (account) => account === LEGACY;
      await vault.loadSecretKeys();
      await typedWhileLockedOut(vault, "L-MINE", true);
      expect(kc.store.get(LEGACY)).toBe("L-MINE");
    });
  });

  // A plaintext key another window left (merged at launch) is not a key this window typed. When this window's first read
  // could not answer for its entry, a later refresh that does read the entry takes the keychain's newer key: keeping the
  // merged one showed and routed a superseded key, and put its plaintext copy back, until the next launch.
  describe("a plaintext key merged at launch gives way to the newer key a later refresh reads", () => {
    test("its entry could not be read at the launch read (flaky), the other window then saved a small key", async () => {
      kc.store.set(INDEX, JSON.stringify(["anthropic"]));
      kc.store.set(P("anthropic"), "A-KEY");
      const vault = await freshVault();
      let launching = true;
      kc.failGet = (account) => launching && account === P("groq");
      kc.refuse = (account) => launching && account === P("groq"); // the merged key is too big for the keychain
      await vault.migrateAndLoad({ groq: "B2-BIG" }, "").catch(() => "the launch load saw a refused write");
      launching = false;
      otherWindowWrites("groq", "S3-SMALL");
      await vault.refreshSecretKeys();
      expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("S3-SMALL");
      expect(vault.keysNotInKeychain(vault.getCachedSecretKeys().providerKeys, "")).toEqual({ ids: [], legacy: false });
    });
    test("a key TYPED here before that refresh still stays (the first read could not answer for its entry)", async () => {
      kc.store.set(INDEX, JSON.stringify(["groq"]));
      kc.store.set(P("groq"), "G-OLD");
      const vault = await freshVault();
      kc.failGet = (account) => account === P("groq");
      await vault.loadSecretKeys();
      let left = 1;
      kc.failGet = (account) => account === INDEX && left-- > 0;
      const base = vault.getCachedSecretKeys();
      expect(await ending(vault.saveSecretKeys({ ...base.providerKeys, groq: "G-NEW" }, base.anthropicKey))).not.toBe("saved");
      await vault.refreshSecretKeys(); // reads G-OLD, which this window never saw before
      expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("G-NEW");
    });
    test("a small merged key whose write was refused once does not go on to overwrite the newer key the refresh read", async () => {
      kc.store.set(INDEX, JSON.stringify(["anthropic"]));
      kc.store.set(P("anthropic"), "A-KEY");
      const vault = await freshVault();
      let launching = true;
      kc.failGet = (account) => launching && account === P("groq");
      let left = 1;
      kc.refuse = (account) => account === P("groq") && left-- > 0; // one transient refusal of the merged key's write
      await vault.migrateAndLoad({ groq: "X-OLD-PLAIN" }, "").catch(() => "the launch load saw a refused write");
      launching = false;
      otherWindowWrites("groq", "S3-NEWER");
      await vault.refreshSecretKeys();
      const now = vault.getCachedSecretKeys();
      await vault.saveSecretKeys(now.providerKeys, now.anthropicKey); // any later save
      expect(kc.store.get(P("groq"))).toBe("S3-NEWER");
    });
    test("the standalone key: merged at launch while its entry could not be read, it gives way to the newer key", async () => {
      kc.store.set(INDEX, JSON.stringify(["anthropic"]));
      kc.store.set(P("anthropic"), "A-KEY");
      const vault = await freshVault();
      let launching = true;
      kc.failGet = (account) => launching && account === LEGACY;
      kc.refuse = (account) => launching && account === LEGACY;
      await vault.migrateAndLoad({ anthropic: "A-KEY" }, "L-OLD-PLAIN").catch(() => "the launch load saw a refused write");
      launching = false;
      kc.store.set(LEGACY, "L-NEWER");
      await vault.refreshSecretKeys();
      expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-NEWER");
      await vault.saveSecretKeys({ anthropic: "A-KEY" }, vault.getCachedSecretKeys().anthropicKey);
      expect(kc.store.get(LEGACY)).toBe("L-NEWER");
    });
    test("control: the launch read could read the entry (it was empty), so the newer key wins as before", async () => {
      kc.store.set(INDEX, JSON.stringify(["anthropic"]));
      kc.store.set(P("anthropic"), "A-KEY");
      const vault = await freshVault();
      let launching = true;
      kc.refuse = (account) => launching && account === P("groq");
      await vault.migrateAndLoad({ groq: "B2-BIG" }, "").catch(() => "the launch load saw a refused write");
      launching = false;
      otherWindowWrites("groq", "S3-SMALL");
      await vault.refreshSecretKeys();
      expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("S3-SMALL");
    });
  });

  // A save App makes while the launch load reads carries the plaintext keys
  // App started with: that is App's state, not the user's typing, so such a
  // key gives way to the keychain like the launch merge's own.
  describe("a save made during the launch load that only carries the plaintext keys App started with", () => {
    const launchWithSaveDuring = async () => {
      kc.store.set(INDEX, JSON.stringify(["anthropic"]));
      kc.store.set(P("anthropic"), "A-KEY"); // groq has no entry yet
      const vault = await freshVault();
      let launching = true;
      kc.failGet = (account) => launching && account === P("groq"); // its entry will not read
      kc.refuse = (account) => launching && account === P("groq"); // and the keychain turns it down
      const load = vault.migrateAndLoad({ groq: "B2-BIG" }, "").catch(() => "the launch load saw a refused write");
      vault.saveSecretKeys({ groq: "B2-BIG" }, "").catch(() => {}); // a setting saved meanwhile
      await load;
      launching = false;
      otherWindowWrites("groq", "S3-SMALL");
      await vault.refreshSecretKeys();
      return vault;
    };
    test("gives way to the newer key the refresh reads", async () => {
      const vault = await launchWithSaveDuring();
      expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("S3-SMALL");
    });
    test("and a later save leaves the newer key in the keychain", async () => {
      const vault = await launchWithSaveDuring();
      const now = vault.getCachedSecretKeys();
      await vault.saveSecretKeys(now.providerKeys, now.anthropicKey).catch(() => {});
      expect(kc.store.get(P("groq"))).toBe("S3-SMALL");
    });
    test("the standalone key carried by such a save gives way too", async () => {
      kc.store.set(INDEX, JSON.stringify(["anthropic"]));
      kc.store.set(P("anthropic"), "A-KEY");
      const vault = await freshVault();
      let launching = true;
      kc.failGet = (account) => launching && account === LEGACY;
      kc.refuse = (account) => launching && account === LEGACY;
      const load = vault.migrateAndLoad({ anthropic: "A-KEY" }, "L-OLD-PLAIN").catch(() => "the launch load saw a refused write");
      vault.saveSecretKeys({ anthropic: "A-KEY" }, "L-OLD-PLAIN").catch(() => {});
      await load;
      launching = false;
      kc.store.set(LEGACY, "L-NEWER");
      await vault.refreshSecretKeys();
      expect(vault.getCachedSecretKeys().anthropicKey).toBe("L-NEWER");
    });
    test("App's one-time copy of the standalone key into the anthropic entry counts the same", async () => {
      kc.store.set(INDEX, JSON.stringify(["moonshot"]));
      kc.store.set(P("moonshot"), "M-KEY");
      const vault = await freshVault();
      let launching = true;
      kc.failGet = (account) => launching && account === P("anthropic");
      kc.refuse = (account) => launching && account === P("anthropic");
      const load = vault.migrateAndLoad({}, "L-OLD-PLAIN").catch(() => "the launch load saw a refused write");
      vault.saveSecretKeys({ anthropic: "L-OLD-PLAIN" }, "L-OLD-PLAIN").catch(() => {});
      await load;
      launching = false;
      kc.store.set(P("anthropic"), "A-NEWER");
      kc.store.set(INDEX, JSON.stringify(["moonshot", "anthropic"]));
      await vault.refreshSecretKeys();
      expect(vault.getCachedSecretKeys().providerKeys.anthropic).toBe("A-NEWER");
    });
  });

  // A plaintext key merged at launch defers to the keychain before any refresh
  // too: the save that would retry it finds the newer key and leaves it.
  test("a small merged key whose write was refused once does not go in over the newer key before any refresh either", async () => {
    kc.store.set(INDEX, JSON.stringify(["anthropic"]));
    kc.store.set(P("anthropic"), "A-KEY");
    const vault = await freshVault();
    let launching = true;
    kc.failGet = (account) => launching && account === P("groq");
    let left = 1;
    kc.refuse = (account) => account === P("groq") && left-- > 0;
    await vault.migrateAndLoad({ groq: "X-OLD-PLAIN" }, "").catch(() => "the launch load saw a refused write");
    launching = false;
    otherWindowWrites("groq", "S3-NEWER");
    const now = vault.getCachedSecretKeys();
    await vault.saveSecretKeys(now.providerKeys, now.anthropicKey); // any save, before any refresh
    expect(kc.store.get(P("groq"))).toBe("S3-NEWER");
  });

  // What a read has once answered for a key stays known: a later read that
  // cannot answer for that entry does not make it unknown again, so the
  // outcome does not hang on whether an unrelated refresh happened to fail.
  describe("a read that cannot answer for a key the window has seen leaves it seen", () => {
    const typedWhileLockedOut = async () => {
      kc.store.set(INDEX, JSON.stringify(["anthropic"]));
      kc.store.set(P("anthropic"), "A-KEY"); // groq: nothing in the keychain
      const vault = await freshVault();
      await vault.loadSecretKeys(); // this read answers for groq: nothing there
      let left = 1;
      kc.failGet = (account) => account === INDEX && left-- > 0; // the typed save reads nothing
      expect(await ending(vault.saveSecretKeys({ anthropic: "A-KEY", groq: "G-MINE" }, ""))).not.toBe("saved");
      return vault;
    };
    test("through a save: another window's write stands, as it does with no such read in between", async () => {
      const vault = await typedWhileLockedOut();
      let left = 1;
      kc.failGet = (account) => account === P("groq") && left-- > 0;
      await vault.refreshSecretKeys(); // cannot answer for groq
      otherWindowWrites("groq", "G-OTHER");
      await vault.saveSecretKeys({ anthropic: "A-KEY", groq: "G-MINE" }, "");
      expect(kc.store.get(P("groq"))).toBe("G-OTHER");
    });
    test("the standalone key: another window's write stands though a read in between could not answer for it", async () => {
      kc.store.set(INDEX, JSON.stringify(["anthropic"]));
      kc.store.set(P("anthropic"), "A-KEY"); // no standalone key in the keychain
      const vault = await freshVault();
      await vault.loadSecretKeys(); // answers for the standalone key: nothing there
      let left = 1;
      kc.failGet = (account) => account === INDEX && left-- > 0;
      expect(await ending(vault.saveSecretKeys({ anthropic: "A-KEY" }, "L-MINE"))).not.toBe("saved");
      let once = 1;
      kc.failGet = (account) => account === LEGACY && once-- > 0;
      await vault.refreshSecretKeys(); // cannot answer for the standalone key
      kc.store.set(LEGACY, "L-OTHER");
      await vault.saveSecretKeys({ anthropic: "A-KEY" }, "L-MINE");
      expect(kc.store.get(LEGACY)).toBe("L-OTHER");
    });
    test("through a refresh: the refresh that can read it takes the other window's key", async () => {
      const vault = await typedWhileLockedOut();
      let left = 1;
      kc.failGet = (account) => account === P("groq") && left-- > 0;
      await vault.refreshSecretKeys();
      otherWindowWrites("groq", "G-OTHER");
      await vault.refreshSecretKeys();
      expect(vault.getCachedSecretKeys().providerKeys.groq).toBe("G-OTHER");
    });
  });
});

// What App needs to keep plaintext honest: which keys the keychain holds
// (keysInKeychain, from this window's reads and the writes it saw land), and
// which of those a read has actually seen (keysReadFromKeychain). The second
// is the only proof there is when the keychain could not be proven to keep
// writes: a keychain that says yes and keeps nothing never reads a key back.
describe("what the keychain is known to hold", () => {
  test("keysInKeychain names keys whose exact value was read or saved", async () => {
    seed();
    const vault = await freshVault();
    await vault.loadSecretKeys();
    await vault.saveSecretKeys({ ...SEEDED, groq: "G-KEY" }, "");
    expect(vault.keysInKeychain({ anthropic: "A-KEY", groq: "G-KEY", moonshot: "M-OLD", openai: "O" }, "")).toEqual({
      ids: ["anthropic", "groq"],
      legacy: false,
    });
  });

  test("keysReadFromKeychain names only what a read saw, and only while reads still see it", async () => {
    seed();
    kc.store.set(LEGACY, "L-KEY");
    const vault = await freshVault();
    await vault.loadSecretKeys();
    await vault.saveSecretKeys({ ...SEEDED, groq: "G-KEY" }, "L-KEY"); // groq written, never read back
    expect(vault.keysReadFromKeychain({ ...SEEDED, groq: "G-KEY", openai: "O" }, "L-KEY")).toEqual({
      ids: ["anthropic", "moonshot"],
      legacy: true,
    });
    expect(vault.keysReadFromKeychain({ anthropic: "A-OTHER" }, "L-OTHER")).toEqual({ ids: [], legacy: false });
    kc.store.delete(P("moonshot")); // another window removed it
    kc.store.set(INDEX, JSON.stringify(["anthropic", "groq"]));
    await vault.refreshSecretKeys();
    expect(vault.keysReadFromKeychain(SEEDED, "").ids).toEqual(["anthropic"]);
  });

  test("a key this window removes or changes stops counting as read, even pasted back with the same value", async () => {
    seed();
    kc.store.set(LEGACY, "L-KEY");
    const vault = await freshVault();
    await vault.loadSecretKeys();
    await vault.saveSecretKeys(SEEDED, "L-KEY"); // a save that changes nothing changes nothing here
    expect(vault.keysReadFromKeychain(SEEDED, "L-KEY")).toEqual({ ids: ["anthropic", "moonshot"], legacy: true });
    // Removed and pasted straight back, in one tick: the read before them no
    // longer says anything about what the keychain holds for these two.
    const removed = vault.saveSecretKeys({ anthropic: "A-KEY" }, "");
    const pasted = vault.saveSecretKeys(SEEDED, "L-KEY");
    expect(vault.keysReadFromKeychain(SEEDED, "L-KEY")).toEqual({ ids: ["anthropic"], legacy: false });
    await removed;
    await pasted;
    expect(vault.keysReadFromKeychain(SEEDED, "L-KEY")).toEqual({ ids: ["anthropic"], legacy: false });
    await vault.saveSecretKeys({ ...SEEDED, anthropic: "A-NEW" }, "L-KEY");
    await vault.saveSecretKeys(SEEDED, "L-KEY"); // and back again
    expect(vault.keysReadFromKeychain(SEEDED, "L-KEY")).toEqual({ ids: [], legacy: false });
    // A read that returns them vouches for them again.
    await vault.refreshSecretKeys();
    expect(vault.keysReadFromKeychain(SEEDED, "L-KEY")).toEqual({ ids: ["anthropic", "moonshot"], legacy: true });
  });
});
