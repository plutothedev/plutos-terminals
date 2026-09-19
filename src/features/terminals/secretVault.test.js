// (C)
// Two defects this file pins down, both of which end with the user's API key
// gone while the UI still shows it:
//
//   A. One blob, no diff. secretVault used to hold EVERY provider key in a
//      single keychain entry and rewrite the whole thing on every user-state
//      save. App.jsx calls saveSecretKeys() on every save, including saves that
//      touch no secret at all. So: window A rotates a key, window B still holds
//      the old one in its module cache, the user saves a workspace in B, and B
//      writes its stale blob straight over A's rotation. Next launch the app
//      authenticates with a revoked key and nothing explains why.
//
//   B. Fire-and-forget writes. The write was not awaited and its rejection was
//      swallowed, while App.jsx had already stripped the plaintext copy out of
//      localStorage on the strength of a startup probe that never re-runs.
//      Windows Credential Manager caps one credential at 2560 bytes (~1280
//      chars) and this app offers sixteen providers, so "the blob got too big"
//      is a reachable state, not a hypothetical. Past the cap every write fails
//      and nothing is said.
//
// The fix is per-provider entries plus a delta write, so the tests below model
// TWO WINDOWS: vi.resetModules() + dynamic import gives two independent module
// instances (two module caches, like two webviews) over ONE fake keychain.
import { describe, test, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Hoisted so the vi.mock factory (lifted above the imports) can see it without
// a TDZ error — same shape as SettingsModal.test.jsx.
const { ctl, invokeMock } = vi.hoisted(() => {
  const ctl = {
    store: new Map(), // account -> secret. Stands in for the OS keychain.
    calls: [], // { cmd, account } in order
    failSet: null, // (account, secret) => truthy to reject that write
    failDelete: null, // (account) => truthy to reject that delete
    failGet: null, // (account) => truthy to reject that read
    delay: 0, // ms per call — a slow keychain, so two windows can interleave
  };
  const invokeMock = vi.fn(async (cmd, args = {}) => {
    ctl.calls.push({ cmd, account: args.account });
    // Recorded first, awaited second: the call ORDER is what the interleaving
    // tests pin down, and it is decided when the call is made, not when it lands.
    if (ctl.delay) await new Promise((r) => setTimeout(r, ctl.delay));
    if (cmd === "secret_set") {
      if (ctl.failSet && ctl.failSet(args.account, args.secret)) throw new Error("keychain write failed");
      ctl.store.set(args.account, args.secret);
      return null;
    }
    if (cmd === "secret_get") {
      if (ctl.failGet && ctl.failGet(args.account)) throw new Error("keychain read failed");
      return ctl.store.has(args.account) ? ctl.store.get(args.account) : null;
    }
    if (cmd === "secret_delete") {
      if (ctl.failDelete && ctl.failDelete(args.account)) throw new Error("keychain delete failed");
      ctl.store.delete(args.account);
      return null;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  return { ctl, invokeMock };
});

vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));

const V0 = "llm-provider-keys:v0";
const INDEX = "llm-provider-keys:v1:index";
const P = (id) => `llm-provider-keys:v1:p:${id}`;
const LEGACY = "llm-provider-keys:v1:anthropic";

// A fresh module instance over the SAME fake keychain = another app window.
async function openWindow() {
  vi.resetModules();
  const mod = await import("./secretVault.js");
  await mod.loadSecretKeys();
  return mod;
}

// Writes that touch the LLM key namespace. The keychain probe writes its own
// per-session sentinel account, which is noise for these assertions.
const keyWrites = () =>
  ctl.calls.filter((c) => c.cmd !== "secret_get" && String(c.account || "").startsWith("llm-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  ctl.store.clear();
  ctl.calls.length = 0;
  ctl.failSet = null;
  ctl.failDelete = null;
  ctl.failGet = null;
  ctl.delay = 0;
  invokeMock.mockClear();
});

describe("secretVault — cross-window delta writes", () => {
  test("an unrelated save in a stale window does not revert another window's rotation", async () => {
    const a = await openWindow();
    await a.saveSecretKeys({ openai: "K0" }, "");

    const b = await openWindow(); // B boots and caches K0
    expect(b.getCachedSecretKeys().providerKeys.openai).toBe("K0");

    await a.saveSecretKeys({ openai: "K1" }, ""); // A rotates

    // B saves a workspace. Its secrets are untouched from ITS point of view, so
    // this must not reach the keychain at all.
    await b.saveSecretKeys({ openai: "K0" }, "");

    const c = await openWindow();
    expect(c.getCachedSecretKeys().providerKeys.openai).toBe("K1");
  });

  test("a stale window adding a different provider keeps the other window's rotation", async () => {
    const a = await openWindow();
    await a.saveSecretKeys({ openai: "K0" }, "");
    const b = await openWindow();
    await a.saveSecretKeys({ openai: "K1" }, "");

    await b.saveSecretKeys({ openai: "K0", groq: "G1" }, "");

    const c = await openWindow();
    expect(c.getCachedSecretKeys().providerKeys).toEqual({ openai: "K1", groq: "G1" });
  });

  test("a save that changes nothing performs no keychain write", async () => {
    const a = await openWindow();
    await a.saveSecretKeys({ openai: "K0", groq: "G0" }, "sk-legacy");
    ctl.calls.length = 0;

    await a.saveSecretKeys({ openai: "K0", groq: "G0" }, "sk-legacy");

    expect(keyWrites()).toEqual([]);
    // Not even a read: an unrelated user-state save must not reach the keychain
    // at all, so a locked or prompting one cannot be provoked by a tab click.
    expect(ctl.calls.filter((c) => String(c.account || "").startsWith("llm-"))).toEqual([]);
  });

  test("clearing a key removes it instead of leaving the old value", async () => {
    const a = await openWindow();
    await a.saveSecretKeys({ openai: "K0", groq: "G0" }, "");
    await a.saveSecretKeys({ groq: "G0" }, "");

    expect(ctl.store.has(P("openai"))).toBe(false);
    const b = await openWindow();
    expect(b.getCachedSecretKeys().providerKeys).toEqual({ groq: "G0" });
  });

  test("refreshSecretKeys pulls another window's rotation into this window's cache", async () => {
    const a = await openWindow();
    await a.saveSecretKeys({ openai: "K0" }, "");
    const b = await openWindow();
    await a.saveSecretKeys({ openai: "K1" }, "");

    expect(b.getCachedSecretKeys().providerKeys.openai).toBe("K0");
    await b.refreshSecretKeys();
    expect(b.getCachedSecretKeys().providerKeys.openai).toBe("K1");
  });

  test("the cache updates synchronously so spawn paths never read a stale key", async () => {
    const a = await openWindow();
    const p = a.saveSecretKeys({ openai: "K9" }, "");
    expect(a.getCachedSecretKeys().providerKeys.openai).toBe("K9");
    await p;
  });
});

describe("secretVault — v0 to v1 migration", () => {
  test("splits the v0 blob into per-provider entries and drops v0 only after readback", async () => {
    ctl.store.set(
      V0,
      JSON.stringify({ providerKeys: { openai: "K0", groq: "G0" }, anthropicKey: "sk-legacy" }),
    );

    const a = await openWindow();

    expect(ctl.store.get(P("openai"))).toBe("K0");
    expect(ctl.store.get(P("groq"))).toBe("G0");
    expect(ctl.store.get(LEGACY)).toBe("sk-legacy");
    expect(JSON.parse(ctl.store.get(INDEX)).sort()).toEqual(["groq", "openai"]);
    expect(ctl.store.has(V0)).toBe(false); // deleted, and only after verification
    expect(a.getCachedSecretKeys()).toEqual({
      providerKeys: { openai: "K0", groq: "G0" },
      anthropicKey: "sk-legacy",
    });

    const b = await openWindow();
    expect(b.getCachedSecretKeys()).toEqual(a.getCachedSecretKeys());
  });

  test("a migration interrupted before the delete leaves a working key set, no duplication", async () => {
    ctl.store.set(
      V0,
      JSON.stringify({ providerKeys: { openai: "K0", groq: "G0" }, anthropicKey: "sk-legacy" }),
    );
    ctl.failDelete = (account) => account === V0; // the crash: v0 survives

    const a = await openWindow();
    expect(a.getCachedSecretKeys().providerKeys).toEqual({ openai: "K0", groq: "G0" });
    expect(ctl.store.has(V0)).toBe(true);

    // Next launch. v0 is still there and v1 is populated: the load must reconcile
    // them rather than double-count or drop one side.
    ctl.failDelete = null;
    const b = await openWindow();
    expect(b.getCachedSecretKeys()).toEqual({
      providerKeys: { openai: "K0", groq: "G0" },
      anthropicKey: "sk-legacy",
    });
    expect(ctl.store.has(V0)).toBe(false);
  });

  test("a migration interrupted mid-write never leaves an empty key set", async () => {
    ctl.store.set(
      V0,
      JSON.stringify({ providerKeys: { openai: "K0", groq: "G0" }, anthropicKey: "sk-legacy" }),
    );
    ctl.failSet = (account) => account === P("groq"); // dies partway through the split

    const a = await openWindow();
    expect(a.getCachedSecretKeys().providerKeys).toEqual({ openai: "K0", groq: "G0" });
    expect(ctl.store.has(V0)).toBe(true); // never deleted on an unverified split

    ctl.failSet = null;
    const b = await openWindow();
    expect(b.getCachedSecretKeys()).toEqual({
      providerKeys: { openai: "K0", groq: "G0" },
      anthropicKey: "sk-legacy",
    });
  });

  test("v1 wins over a lingering v0 blob for a key both hold", async () => {
    const a = await openWindow();
    await a.saveSecretKeys({ openai: "NEW" }, "");
    ctl.store.set(V0, JSON.stringify({ providerKeys: { openai: "ANCIENT" }, anthropicKey: "" }));

    const b = await openWindow();
    expect(b.getCachedSecretKeys().providerKeys.openai).toBe("NEW");
  });
});

describe("secretVault — loud, safe failures", () => {
  test("a rejected write rejects the returned promise without marking the keychain unavailable", async () => {
    const a = await openWindow();
    expect(a.keychainAvailable()).toBe(true);
    ctl.failSet = (account) => account === P("openai");

    await expect(a.saveSecretKeys({ openai: "K0" }, "")).rejects.toThrow();
    expect(a.keychainAvailable()).toBe(true); // one failure is not a dead keychain
  });

  test("one oversized provider failing the Windows size cap does not lose the others", async () => {
    const a = await openWindow();
    await a.saveSecretKeys({ openai: "K0" }, "");
    // Windows Credential Manager: 2560 bytes per credential, ~1280 chars.
    const huge = "x".repeat(1400);
    ctl.failSet = (_account, secret) => secret.length > 1280;

    await expect(a.saveSecretKeys({ openai: "K1", custom: huge, groq: "G1" }, "")).rejects.toThrow();

    const b = await openWindow();
    expect(b.getCachedSecretKeys().providerKeys.openai).toBe("K1");
    expect(b.getCachedSecretKeys().providerKeys.groq).toBe("G1");
    expect(b.getCachedSecretKeys().providerKeys.custom).toBeUndefined();
  });

  test("a failed write is retried by the next save rather than treated as persisted", async () => {
    const a = await openWindow();
    ctl.failSet = (account) => account === P("openai");
    await expect(a.saveSecretKeys({ openai: "K0" }, "")).rejects.toThrow();

    ctl.failSet = null;
    await a.saveSecretKeys({ openai: "K0" }, ""); // same value, still unpersisted
    expect(ctl.store.get(P("openai"))).toBe("K0");
  });
});

// The index is the ONLY enumeration the keychain offers (get/set/delete by
// account, no listing), so every way it can be wrong is a way a key on disk
// becomes a key nobody can find. These are the single-blob failure mode one
// level up: the blob no longer holds the keys, but it still holds the list.
describe("secretVault — the index cannot strand a key", () => {
  test("a transient index read refuses the save instead of narrowing the index", async () => {
    const a = await openWindow();
    await a.saveSecretKeys({ openai: "K0", groq: "G0" }, "");

    const b = await openWindow();
    let n = 0;
    ctl.failGet = (account) => account === INDEX && n++ === 0; // ONE transient failure

    // Treating an unreadable index as an empty one rewrote it down to the single
    // provider this save happens to touch. Refusing costs a retry; proceeding
    // cost the user every other key they own.
    await expect(b.saveSecretKeys({ openai: "K0", groq: "G0", mistral: "M1" }, "")).rejects.toThrow();
    ctl.failGet = null;

    const c = await openWindow();
    expect(c.getCachedSecretKeys().providerKeys.openai).toBe("K0");
    expect(c.getCachedSecretKeys().providerKeys.groq).toBe("G0");
  });

  test("a load recovers entries a narrowed index forgot, and repairs the index", async () => {
    const a = await openWindow();
    await a.saveSecretKeys({ openai: "K0", groq: "G0", mistral: "M0" }, "");
    // Exactly the damage an older build left behind: the entries are all still
    // on disk, and the index names one of them.
    ctl.store.set(INDEX, JSON.stringify(["mistral"]));

    const b = await openWindow();
    expect(b.getCachedSecretKeys().providerKeys).toEqual({ openai: "K0", groq: "G0", mistral: "M0" });
    expect(JSON.parse(ctl.store.get(INDEX)).sort()).toEqual(["groq", "mistral", "openai"]);
  });

  test("a corrupt index neither hides the keys nor gets baked in by the next save", async () => {
    const a = await openWindow();
    await a.saveSecretKeys({ openai: "K0", groq: "G0" }, "");
    ctl.store.set(INDEX, "}{ not json");

    const b = await openWindow();
    expect(b.getCachedSecretKeys().providerKeys).toEqual({ openai: "K0", groq: "G0" });

    await b.saveSecretKeys({ openai: "K0", groq: "G0", mistral: "M1" }, "");
    const c = await openWindow();
    expect(c.getCachedSecretKeys().providerKeys).toEqual({ openai: "K0", groq: "G0", mistral: "M1" });
  });

  test("two windows adding different providers concurrently strand neither key", async () => {
    const a = await openWindow();
    await a.saveSecretKeys({ openai: "K0" }, "");
    const b = await openWindow(); // B's baseline and index read are both {openai}

    ctl.delay = 5; // slow enough that B reads the index before A has written it
    const pa = a.saveSecretKeys({ openai: "K0", groq: "G1" }, "");
    await sleep(1);
    const pb = b.saveSecretKeys({ openai: "K0", mistral: "M1" }, "");
    await Promise.all([pa, pb]);
    ctl.delay = 0;

    expect(ctl.store.get(P("groq"))).toBe("G1"); // both entries land
    expect(ctl.store.get(P("mistral"))).toBe("M1");
    const c = await openWindow(); // and both are still reachable
    expect(c.getCachedSecretKeys().providerKeys).toEqual({ openai: "K0", groq: "G1", mistral: "M1" });
  });
});

describe("secretVault — a refresh must not eat a key being typed", () => {
  test("a key pasted while a cross-window refresh is in flight survives", async () => {
    const a = await openWindow();
    await a.saveSecretKeys({ openai: "K0" }, "");
    const b = await openWindow();
    await a.saveSecretKeys({ openai: "K1" }, ""); // A rotates; B's storage handler fires

    ctl.delay = 5;
    const refresh = b.refreshSecretKeys(); // the handler's detached refresh
    await sleep(1);
    const save = b.saveSecretKeys({ openai: "K0", groq: "G1" }, ""); // user pastes groq

    // The refresh read a keychain that did not have groq yet. If it assigns that
    // read over the cache, the pasted key leaves the UI and the NEXT save diffs
    // it straight back off the disk.
    const seen = await refresh;
    expect(seen.providerKeys.groq).toBe("G1");
    // ...and it still has to CONVERGE: once the save settles, what the refresh
    // hands back is the real stored state, A's rotation included.
    expect(seen.providerKeys.openai).toBe("K1");
    await save;
    ctl.delay = 0;

    // The handler then pushes what the refresh returned into React state, and
    // the next user-state write saves exactly that. It must delete nothing.
    await b.saveSecretKeys(seen.providerKeys, seen.anthropicKey);

    const c = await openWindow();
    expect(c.getCachedSecretKeys().providerKeys.groq).toBe("G1");
    expect(c.getCachedSecretKeys().providerKeys.openai).toBe("K1"); // A's rotation held
  });
});

describe("secretVault — a deleted key stays deleted", () => {
  test("a revoked key does not come back from a v0 blob that outlived the split", async () => {
    ctl.store.set(
      V0,
      JSON.stringify({ providerKeys: { openai: "K0", groq: "REVOKED" }, anthropicKey: "" }),
    );
    ctl.failDelete = (account) => account === V0; // the split can never retire v0

    const a = await openWindow();
    expect(a.getCachedSecretKeys().providerKeys).toEqual({ openai: "K0", groq: "REVOKED" });
    expect(ctl.store.has(V0)).toBe(true);

    await a.saveSecretKeys({ openai: "K0" }, ""); // the user revokes groq
    expect(ctl.store.has(P("groq"))).toBe(false);

    // Next launch. v0 is still there, and merging it back in reinstated a key the
    // user had deliberately revoked — into every shell spawned afterwards.
    const b = await openWindow();
    expect(b.getCachedSecretKeys().providerKeys.groq).toBeUndefined();
    expect(b.getCachedSecretKeys().providerKeys.openai).toBe("K0");
  });

  test("the legacy anthropic key stays deleted too", async () => {
    ctl.store.set(V0, JSON.stringify({ providerKeys: { openai: "K0" }, anthropicKey: "sk-revoked" }));
    ctl.failDelete = (account) => account === V0;

    const a = await openWindow();
    expect(a.getCachedSecretKeys().anthropicKey).toBe("sk-revoked");
    await a.saveSecretKeys({ openai: "K0" }, "");

    const b = await openWindow();
    expect(b.getCachedSecretKeys().anthropicKey).toBe("");
  });
});

// The vault can only do its half. App.jsx owns the two call sites that turned a
// storage-cap failure into silent key loss, so assert them against the shipped
// source (same approach as releaseWorkflow.test.js: read the real file, not a
// copy of it).
describe("App.jsx wiring", () => {
  const SRC = readFileSync(fileURLToPath(new URL("../../App.jsx", import.meta.url)), "utf8");

  // Slice a top-level `function name(...) { ... }` out by brace balance.
  function fnBody(name) {
    const start = SRC.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`App.jsx has no function ${name}`);
    let i = SRC.indexOf("{", start);
    let depth = 0;
    for (let j = i; j < SRC.length; j++) {
      if (SRC[j] === "{") depth++;
      else if (SRC[j] === "}" && --depth === 0) return SRC.slice(start, j + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
  }

  // Slice the balanced (...) or {...} that starts at `from`, contents only.
  function balanced(src, from, open, close) {
    let depth = 0;
    for (let j = from; j < src.length; j++) {
      if (src[j] === open) depth++;
      else if (src[j] === close && --depth === 0) return src.slice(from + 1, j);
    }
    throw new Error("unbalanced source slice");
  }

  // Code only. A commented-out toast must not satisfy "the warning fires", and a
  // comment that merely says "toast" must not fail "nothing outside toasts".
  // (`[^:]` keeps a `https://` in a string from being read as a line comment.)
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  // The REJECTION HANDLER itself, not the function around it: asserting that
  // `.catch`, `restoreLocalSecrets(` and `toast` each appear SOMEWHERE in
  // writeUserState passes just as happily on an empty catch with an unrelated
  // restore beside it, which is the defect this file exists to keep out.
  const catchBody = (() => {
    const body = fnBody("writeUserState");
    const at = body.search(/\.catch\??\.?\(/);
    if (at < 0) throw new Error("writeUserState never keeps the saveSecretKeys rejection");
    return balanced(body, body.indexOf("(", at + 1), "(", ")");
  })();

  // The `if (stripped) { ... }` block inside it, or "" when the branch is not
  // braced (a bare one-statement `if` cannot hold both the restore and the warn).
  const strippedBranch = (() => {
    const m = catchBody.match(/if\s*\(\s*stripped\s*\)\s*\{/);
    if (!m) return "";
    return balanced(catchBody, catchBody.indexOf("{", m.index), "{", "}");
  })();

  const storageHandler = (() => {
    const start = SRC.indexOf("const onStorage = ");
    const end = SRC.indexOf('window.addEventListener("storage", onStorage)');
    if (start < 0 || end < 0) throw new Error("App.jsx storage handler not found");
    return SRC.slice(start, end);
  })();

  test("the storage handler refreshes secrets from the keychain, not from its own stale cache", () => {
    expect(storageHandler).toContain("refreshSecretKeys(");
    // The whole defect was overlaying this window's module cache onto another
    // window's update. It may only appear as the fallback for an unreachable
    // keychain, never as the update's source.
    expect(storageHandler).not.toMatch(/const\s+s\s*=\s*getCachedSecretKeys\(\)\s*;/);
  });

  test("the storage handler does not block on the keychain", () => {
    // No top-level await in a DOM event handler, and no synchronous invoke.
    expect(storageHandler).not.toMatch(/const onStorage = async /);
  });

  test("writeUserState restores the plaintext copy and warns when the keychain write rejects", () => {
    const body = fnBody("writeUserState");
    // The promise must be kept, not dropped on the floor — a bare
    // `saveSecretKeys(a, b);` statement is the defect this replaced.
    expect(body).toMatch(/(?:const|let)\s+\w+\s*=\s*saveSecretKeys\(|saveSecretKeys\([^)]*\)\s*\.catch/);
    // Asserted on the HANDLER BODY: the restore and the warning have to be what
    // the rejection actually runs.
    expect(code(catchBody)).toContain("restoreLocalSecrets(");
    expect(code(catchBody)).toMatch(/toast\w*\s*\??\.\s*error\(/);
  });

  test("the warning fires only when plaintext was actually stripped", () => {
    // With no keychain at all (a Linux box with no secret service) nothing is
    // ever stripped, so nothing is at risk — but every save still rejects. The
    // toast turned a theme change into "Couldn't save your API key", five times
    // over from one settings section. The restore is already guarded this way.
    expect(catchBody).toMatch(/if\s*\(\s*stripped\s*\)\s*\{/);
    expect(code(strippedBranch)).toContain("restoreLocalSecrets(");
    expect(code(strippedBranch)).toMatch(/toast\w*\s*\??\.\s*error\(/);
    // ...and nothing outside the guard toasts.
    expect(code(catchBody.replace(strippedBranch, ""))).not.toMatch(/toast/i);
    // Standing rule: no em dashes in anything the user reads.
    expect(catchBody).not.toContain("—");
  });

  test("a failed keychain write does not flip the global keychain flag", () => {
    // Flipping keychainOk false on one failure would keep every later secret in
    // plaintext for the rest of the session.
    expect(SRC).not.toMatch(/setKeychainUnavailable|keychainOk\s*=\s*false/);
  });

  test("the local restore writes the canonical secret field list back", () => {
    const body = fnBody("restoreLocalSecrets");
    expect(body).toContain("SECRET_FIELDS");
    expect(body).toContain("USER_STORAGE_KEY");
  });
});
