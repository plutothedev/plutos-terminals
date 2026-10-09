// (C)
// @vitest-environment happy-dom
// App's half of the API-key storage, run for real: App.jsx mounted over the
// real secretVault and a stand-in keychain, with TerminalsTab replaced by a
// probe that records the user state App hands down (and, when a test asks,
// renders the real Models picker with it, as ModalHost does).
//
// What these pin:
//   * Models open while the keys arrive must not delete them (the picker used
//     to save the copy it took when it opened).
//   * After a launch load that failed (a key too big for the keychain), the
//     keys every new shell gets are the ones App shows and lets the user
//     remove; they used to be invisible while shells were still routed with
//     them. A failed load strips nothing: nothing is confirmed yet.
//   * A key the keychain refuses is the ONLY key kept in plaintext; the
//     fallback used to copy every key, the keychain's healthy ones included,
//     into localStorage. And a refused key survives what used to drop it: an
//     edit made while the load reads, another window's save.
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, act, screen, fireEvent } from "@testing-library/react";
import { StrictMode } from "react";

const { kc, invokeMock, probe } = vi.hoisted(() => {
  // The keychain: a map. `refuse(account, secret)` turns a write down (the
  // Windows Credential Manager cap, say), `failGet(account)` a read, and
  // `dead` every call (no keychain on this machine). `hook` runs first on
  // every call. `inFlight` and `last` let a test wait for the vault to go quiet.
  // `forgetful` is a keychain that says yes to every write and keeps nothing
  // (the keyring crate's in-memory mock when no backend is compiled in).
  // `gen` numbers the app each test launches (see launch).
  const kc = { store: new Map(), refuse: null, failGet: null, dead: false, forgetful: false, hook: null, log: [], inFlight: 0, last: 0, gen: 0 };
  const invokeMock = vi.fn(async (cmd, args = {}) => {
    kc.inFlight += 1;
    kc.last = Date.now();
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (kc.hook) await kc.hook(cmd, args);
      if (cmd.startsWith("secret_") && kc.dead) throw new Error("no keychain on this machine");
      if (cmd.startsWith("secret_") && kc.forgetful) {
        if (cmd === "secret_set") kc.log.push(["set", args.account]);
        return null;
      }
      if (cmd === "secret_set") {
        kc.log.push(["set", args.account]);
        if (kc.refuse && kc.refuse(args.account, args.secret)) throw new Error("credential too large");
        kc.store.set(args.account, args.secret);
        return null;
      }
      if (cmd === "secret_get") {
        if (kc.failGet && kc.failGet(args.account)) throw new Error("keychain read failed");
        return kc.store.has(args.account) ? kc.store.get(args.account) : null;
      }
      if (cmd === "secret_delete") {
        kc.log.push(["delete", args.account]);
        kc.store.delete(args.account);
        return null;
      }
      if (cmd === "read_store") return "null";
      return null; // write_store, sweeps, companion mirrors: nothing to answer
    } finally {
      kc.inFlight -= 1;
      kc.last = Date.now();
    }
  });
  // What App last handed TerminalsTab, and an optional render for the probe.
  const probe = { props: null, render: null };
  return { kc, invokeMock, probe };
});

vi.mock("@backend", () => ({
  invoke: (...args) => invokeMock(...args),
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));
vi.mock("./features/terminals/TerminalsTab.jsx", () => ({
  default: (props) => {
    probe.props = props;
    return probe.render ? probe.render(props) : null;
  },
}));
vi.mock("./components/UpdateBanner.jsx", () => ({ default: () => null }));

const USER_KEY = "plutos-terminals:user:v0";
const LAYOUT_KEY = "plutos-terminals:state:v0";
const INDEX = "llm-provider-keys:v1:index";
const LEGACY = "llm-provider-keys:v1:anthropic";
const P = (id) => `llm-provider-keys:v1:p:${id}`;
const big = (tag) => `sk-${tag}-` + "x".repeat(3000); // past the 2560-byte credential cap
const HUGE = big("huge");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The keychain already holds two keys, in the vault's own layout.
const KEYCHAIN = { anthropic: "A-KEY", moonshot: "M-KEY" };
function seedKeychain(keys = KEYCHAIN) {
  kc.store.set(INDEX, JSON.stringify(Object.keys(keys)));
  for (const [id, key] of Object.entries(keys)) kc.store.set(P(id), key);
}

// What localStorage holds in plaintext under the user blob.
const plaintext = () => {
  const blob = JSON.parse(localStorage.getItem(USER_KEY) || "{}");
  return { providerKeys: blob.providerKeys, anthropicKey: blob.anthropicKey };
};
const KEYCHAIN_TOAST = /Couldn't save your API key to the OS keychain/;

// A fresh app per test: the vault's launch state is once per window.
async function launch(userBlob, { withPicker = false, strict = false } = {}) {
  localStorage.setItem(USER_KEY, JSON.stringify({ welcomeDone: true, ...userBlob }));
  // A layout that parses, so boot recovery has nothing to read.
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ oledDefaultMigrated: true, mobaDefaultForced: true }));
  vi.resetModules();
  // This app's own backend. An earlier test's app can still be running (its
  // launch load backs off and retries for over a second), and through a shared
  // backend it would read and write this test's keychain and, once its calls
  // came back, this test's localStorage. Its calls now never come back.
  const gen = ++kc.gen;
  vi.doMock("@backend", () => ({
    invoke: (...args) => (gen === kc.gen ? invokeMock(...args) : new Promise(() => {})),
    listen: vi.fn(async () => () => {}),
    isTauri: () => true,
  }));
  const { default: App } = await import("./App.jsx");
  const vault = await import("./features/terminals/secretVault.js");
  const storage = await import("./features/terminals/storageKeys.js");
  const providers = await import("./features/terminals/providers.js");
  const spawn = await import("./features/terminals/spawnEnv.js");
  const { default: ModelPicker } = await import("./features/terminals/ModelPicker.jsx");
  // Models open from the first render, fed App's user state as ModalHost feeds it.
  if (withPicker) {
    probe.render = (props) => <ModelPicker open onClose={() => {}} userSt={props.userSt} saveUser={props.saveUser} />;
  }
  // main.jsx mounts App under StrictMode, which runs the mount effects twice.
  render(strict ? <StrictMode><App /></StrictMode> : <App />);
  return { vault, storage, providers, spawn };
}

// Waits until the keychain has had no call for a while, so every queued read
// and write has run, without touching the vault (a refresh would change the
// very state under test). It yields first: a save made just before it has
// not reached the keychain yet, and the queue starts it a tick later.
async function drain() {
  await act(async () => {
    const start = Date.now();
    await sleep(5);
    while (kc.inFlight > 0 || Date.now() - kc.last < 40) {
      if (Date.now() - start > 5000) throw new Error("the keychain never went quiet");
      await sleep(5);
    }
  });
}

// Holds the first read of the key index, as an unanswered keychain prompt would.
function holdFirstRead() {
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
  return {
    reached,
    release: () => {
      const r = release;
      release = null;
      r();
    },
  };
}

// Writes the shared blob the way another window would, around any spy on
// this window's localStorage.setItem.
function otherWindowWritesBlob(change) {
  const blob = JSON.parse(localStorage.getItem(USER_KEY) || "{}");
  Storage.prototype.setItem.call(localStorage, USER_KEY, JSON.stringify({ ...blob, ...change }));
}

// Another window saved its user state: it writes the shared blob (stripped,
// as a window with a working keychain writes it) and this window gets the
// storage event for it.
async function anotherWindowSaves(change) {
  const blob = { welcomeDone: true, ...change, _fieldMeta: { themeFollowOS: Date.now() + 1000 } };
  const json = JSON.stringify(blob);
  await act(async () => {
    localStorage.setItem(USER_KEY, json);
    window.dispatchEvent(new StorageEvent("storage", { key: USER_KEY, newValue: json }));
  });
  await drain();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  kc.store.clear();
  kc.refuse = null;
  kc.failGet = null;
  kc.dead = false;
  kc.forgetful = false;
  kc.hook = null;
  kc.log.length = 0;
  invokeMock.mockClear();
  probe.props = null;
  probe.render = null;
});
// Nothing a test started may still be writing when the next one begins: what
// is queued runs out, and what its app asks after that goes unanswered.
afterEach(async () => {
  await drain().catch(() => {});
  cleanup();
  kc.gen += 1;
});

describe("Models open while the keychain's keys arrive", () => {
  test("leaving a field in Models keeps every key, once the launch load is over too", async () => {
    seedKeychain();
    // Models opens with only the key App started with.
    const read = holdFirstRead();
    const app = await launch({ providerKeys: { openrouter: "O-KEY" } }, { withPicker: true });
    await read.reached;
    await waitFor(() => expect(screen.getByLabelText("Anthropic (Claude) API key")).toBeTruthy());
    expect(screen.getByLabelText("Anthropic (Claude) API key").value).toBe("");

    read.release();
    await waitFor(() => expect(probe.props.userSt.providerKeys?.moonshot).toBe("M-KEY"));
    expect(screen.getByLabelText("Anthropic (Claude) API key").value).toBe("A-KEY");

    fireEvent.blur(screen.getByLabelText("Anthropic (Claude) API key"));
    await drain();
    expect(kc.log.filter(([kind, account]) => kind === "delete" && account.startsWith("llm-"))).toEqual([]);
    expect(kc.store.get(P("anthropic"))).toBe("A-KEY");
    expect(kc.store.get(P("moonshot"))).toBe("M-KEY");
    expect(kc.store.get(P("openrouter"))).toBe("O-KEY");
    expect(app.storage.readUserSt().providerKeys).toEqual({ ...KEYCHAIN, openrouter: "O-KEY" });
  });
});

describe("the launch load", () => {
  test("merges the keys onto the live state: a setting saved while it read survives", async () => {
    seedKeychain();
    const read = holdFirstRead();
    await launch({});
    await read.reached;
    act(() => probe.props.saveUser((prev) => ({ ...prev, terminalsOnboarded: true })));
    read.release();
    await waitFor(() => expect(probe.props.userSt.providerKeys).toEqual(KEYCHAIN));
    expect(probe.props.userSt.terminalsOnboarded).toBe(true);
  });
});

describe("another window's save, while one key cannot be read", () => {
  test("leaves that key on screen and in new shells, and nothing is written over it", async () => {
    seedKeychain();
    const app = await launch({});
    await waitFor(() => expect(probe.props?.userSt.providerKeys).toEqual(KEYCHAIN));
    await drain();
    kc.failGet = (account) => account === P("moonshot"); // briefly unreadable
    await anotherWindowSaves({ themeFollowOS: true });
    expect(probe.props.userSt.providerKeys).toEqual(KEYCHAIN);
    expect(app.storage.readUserSt().providerKeys.moonshot).toBe("M-KEY");
    kc.log.length = 0;
    act(() => probe.props.saveUser((prev) => ({ ...prev, terminalsOnboarded: true })));
    await drain();
    expect(kc.log).toEqual([]);
    kc.failGet = null;
    await anotherWindowSaves({ themeFollowOS: false });
    expect(probe.props.userSt.providerKeys).toEqual(KEYCHAIN);
  });
});

describe("a launch load that succeeded", () => {
  test("moves the plaintext keys into the keychain and only then strips them", async () => {
    seedKeychain();
    let plaintextDuringWrite;
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_set" && args.account === P("groq")) plaintextDuringWrite = plaintext().providerKeys?.groq;
    };
    await launch({ providerKeys: { groq: "G-KEY" } });
    await waitFor(() => expect(probe.props?.userSt.providerKeys).toEqual({ ...KEYCHAIN, groq: "G-KEY" }));
    await drain();
    expect(kc.store.get(P("groq"))).toBe("G-KEY");
    expect(plaintextDuringWrite).toBe("G-KEY"); // still on disk while the keychain wrote it
    expect(plaintext().providerKeys).toBeUndefined();
  });

  test("copies a standalone Anthropic key into Models", async () => {
    const app = await launch({ anthropicKey: "L-KEY" });
    await waitFor(() => expect(probe.props?.userSt.providerKeys?.anthropic).toBe("L-KEY"));
    await drain();
    expect(kc.store.get(P("anthropic"))).toBe("L-KEY");
    expect(app.storage.readUserSt().providerKeys.anthropic).toBe("L-KEY");
  });

  test("its copy into the anthropic entry at startup gives way to a newer key another window saved", async () => {
    seedKeychain({ moonshot: "M-KEY" });
    let launching = true;
    kc.failGet = (account) => launching && account === P("anthropic"); // the entry will not read at startup
    kc.refuse = (account) => launching && account === P("anthropic"); // and turns the copy down
    const app = await launch({ anthropicKey: "L-OLD-PLAIN" }); // App copies it into providerKeys.anthropic
    await drain();
    launching = false;
    kc.store.set(P("anthropic"), "A-NEWER");
    kc.store.set(INDEX, JSON.stringify(["moonshot", "anthropic"]));
    await anotherWindowSaves({ themeFollowOS: true });
    expect(probe.props.userSt.providerKeys.anthropic).toBe("A-NEWER");
    expect(app.storage.readUserSt().providerKeys.anthropic).toBe("A-NEWER");
  });

  test("on a keychain that could not be proven, keeps in plaintext only the keys no read has seen there", async () => {
    seedKeychain();
    kc.store.set(LEGACY, "L-CHAIN");
    // The probe's own write is refused, so App cannot strip; reads work.
    kc.refuse = (account) => account.startsWith("keychain-probe");
    const app = await launch({ providerKeys: { groq: "G-KEY" } });
    await waitFor(() => expect(probe.props?.userSt.providerKeys).toEqual({ ...KEYCHAIN, groq: "G-KEY" }));
    await drain();
    expect(app.vault.keychainAvailable()).toBe(false);
    expect(probe.props.userSt.anthropicKey).toBe("L-CHAIN");
    // groq was written, but never read back; the rest a read returned.
    expect(plaintext()).toEqual({ providerKeys: { groq: "G-KEY" }, anthropicKey: undefined });
  });

  test("a plain-object save made from an old render cannot drop a key that arrived since", async () => {
    seedKeychain();
    kc.store.set(LEGACY, "L-CHAIN");
    const read = holdFirstRead();
    await launch({});
    await read.reached;
    const stale = probe.props.userSt; // rendered before the keychain's keys arrived
    read.release();
    await waitFor(() => expect(probe.props.userSt.providerKeys).toEqual(KEYCHAIN));
    await drain();
    act(() => probe.props.saveUser({ ...stale, themeFollowOS: true }));
    await drain();
    expect(probe.props.userSt.themeFollowOS).toBe(true);
    expect(probe.props.userSt.providerKeys).toEqual(KEYCHAIN);
    expect(probe.props.userSt.anthropicKey).toBe("L-CHAIN");
    expect(kc.store.get(P("anthropic"))).toBe("A-KEY");
    expect(kc.store.get(P("moonshot"))).toBe("M-KEY");
    expect(kc.store.get(LEGACY)).toBe("L-CHAIN");
  });

  test("on a keychain that could not be proven, a key removed and pasted back keeps its plaintext copy", async () => {
    seedKeychain();
    kc.refuse = (account) => account.startsWith("keychain-probe");
    const app = await launch({});
    await waitFor(() => expect(probe.props?.userSt.providerKeys).toEqual(KEYCHAIN));
    await drain();
    expect(app.vault.keychainAvailable()).toBe(false);
    expect(plaintext().providerKeys || {}).toEqual({}); // a read returned both
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, moonshot: "" } })));
    await drain();
    expect(kc.store.has(P("moonshot"))).toBe(false);
    // Pasted back, and the keychain turns the write down this time.
    kc.refuse = (account) => account.startsWith("keychain-probe") || account === P("moonshot");
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, moonshot: "M-KEY" } })));
    await drain();
    expect(kc.store.has(P("moonshot"))).toBe(false);
    expect(plaintext().providerKeys).toEqual({ moonshot: "M-KEY" });
    expect(app.storage.readUserSt().providerKeys.moonshot).toBe("M-KEY");
  });

  test("on a keychain that could not be proven, a key removed and pasted back in one go keeps its plaintext copy", async () => {
    seedKeychain();
    kc.refuse = (account) => account.startsWith("keychain-probe");
    await launch({});
    await waitFor(() => expect(probe.props?.userSt.providerKeys).toEqual(KEYCHAIN));
    await drain();
    kc.refuse = (account) => account.startsWith("keychain-probe") || account === P("moonshot");
    // Both saves are made before the first reaches the keychain.
    act(() => {
      probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, moonshot: "" } }));
      probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, moonshot: "M-KEY" } }));
    });
    await drain();
    expect(kc.store.has(P("moonshot"))).toBe(false);
    expect(plaintext().providerKeys).toEqual({ moonshot: "M-KEY" });
  });

  test("a keychain that loses what it was given after it proved itself does not take the key off screen", async () => {
    const app = await launch({});
    await waitFor(() => expect(app.vault.keysSettled()).toBe(true));
    await drain();
    expect(app.vault.keychainAvailable()).toBe(true);
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, groq: "G-KEY" } })));
    await drain();
    expect(kc.store.get(P("groq"))).toBe("G-KEY");
    kc.store.clear(); // it kept nothing after all, index included
    await anotherWindowSaves({ themeFollowOS: true });
    expect(probe.props.userSt.providerKeys.groq).toBe("G-KEY");
    expect(app.storage.readUserSt().providerKeys.groq).toBe("G-KEY");
  });

  test("on a keychain that says yes and keeps nothing, the keys stay in plaintext, save after save", async () => {
    kc.forgetful = true;
    const app = await launch({ providerKeys: { groq: "G-KEY" } });
    await waitFor(() => expect(app.vault.keysSettled()).toBe(true));
    await drain();
    expect(kc.log).toContainEqual(["set", P("groq")]); // the write "succeeded"
    expect(plaintext().providerKeys).toEqual({ groq: "G-KEY" });
    act(() => probe.props.saveUser((prev) => ({ ...prev, terminalsOnboarded: true })));
    await drain();
    expect(plaintext().providerKeys).toEqual({ groq: "G-KEY" });
    // Another window like this one saves, its copy of the key included: this
    // window must not take that copy out on the strength of a write the
    // keychain only said it took.
    await anotherWindowSaves({ themeFollowOS: true, providerKeys: { groq: "G-KEY" } });
    expect(plaintext().providerKeys).toEqual({ groq: "G-KEY" });
  });
});

describe("a launch load that failed", () => {
  // The reviewer's case: the plaintext OpenAI key is too big for the keychain,
  // the keychain holds Anthropic and Moonshot, and the saved choice is Moonshot.
  // A second plaintext key (Groq) moves into the keychain fine.
  async function failedLaunch() {
    seedKeychain();
    kc.refuse = (account) => account === P("openai");
    const app = await launch({
      providerKeys: { openai: HUGE, groq: "G-KEY" },
      activeModel: { providerId: "moonshot", model: "kimi-k2.5" },
    });
    // The load's own write of the OpenAI key is refused, so it rejects.
    await waitFor(() => expect(kc.log).toContainEqual(["set", P("openai")]));
    await drain();
    return app;
  }

  test("App shows the keys new shells get, and both agree on the model", async () => {
    const app = await failedLaunch();
    expect(probe.props.userSt.providerKeys).toEqual({ openai: HUGE, groq: "G-KEY", ...KEYCHAIN });
    const shown = probe.props.userSt;
    const shells = app.storage.readUserSt();
    // The menu bar's answer and the shell's routing come from the same keys.
    expect(app.providers.activeModelProblem(shown, { keysKnown: app.vault.keysSettled() })).toBeNull();
    const routedFromShown = app.spawn.resolveEnvFromUserState(shown, app.providers.envForModel);
    const routedForShells = app.spawn.resolveEnvFromUserState(shells, app.providers.envForModel);
    expect(routedForShells.ANTHROPIC_AUTH_TOKEN).toBe("M-KEY");
    expect(routedFromShown).toEqual(routedForShells);
  });

  test("strips nothing, since nothing is confirmed: the plaintext copies stay as they were", async () => {
    await failedLaunch();
    expect(kc.store.get(P("groq"))).toBe("G-KEY"); // it did make it in
    expect(plaintext().providerKeys).toEqual({ openai: HUGE, groq: "G-KEY" });
    expect(screen.queryByText(KEYCHAIN_TOAST)).toBeNull();
  });

  test("the next save keeps only the refused key in plaintext, and the user is told", async () => {
    await failedLaunch();
    act(() => probe.props.saveUser((prev) => ({ ...prev, terminalsOnboarded: true })));
    await drain();
    expect(kc.log.filter(([kind, account]) => kind === "set" && account === P("openai")).length).toBeGreaterThan(1);
    expect(plaintext()).toEqual({ providerKeys: { openai: HUGE }, anthropicKey: undefined });
    expect((await screen.findAllByText(KEYCHAIN_TOAST)).length).toBeGreaterThan(0);
    // And again on a later save: the keychain's keys never reach plaintext.
    act(() => probe.props.saveUser((prev) => ({ ...prev, themeFollowOS: true })));
    await drain();
    expect(plaintext()).toEqual({ providerKeys: { openai: HUGE }, anthropicKey: undefined });
  });

  test("a key the keychain holds can be removed, and new shells stop getting it", async () => {
    const app = await failedLaunch();
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, moonshot: "" } })));
    await drain();
    expect(kc.store.has(P("moonshot"))).toBe(false);
    expect(kc.store.get(P("anthropic"))).toBe("A-KEY");
    expect(app.storage.readUserSt().providerKeys.moonshot).toBeUndefined();
    expect(plaintext().providerKeys).toEqual({ openai: HUGE });
  });

  test("where the plaintext copy is stale, App shows the keychain's key, as shells get it", async () => {
    seedKeychain();
    kc.refuse = (account) => account === P("openai");
    const app = await launch({ providerKeys: { openai: HUGE, anthropic: "A-STALE" } });
    await waitFor(() => expect(kc.log).toContainEqual(["set", P("openai")]));
    await drain();
    expect(probe.props.userSt.providerKeys.anthropic).toBe("A-KEY");
    expect(app.storage.readUserSt().providerKeys.anthropic).toBe("A-KEY");
  });

  test("an edit made while the load reads, also refused, survives: in App, in shells, in plaintext", async () => {
    seedKeychain();
    kc.refuse = (account) => account === P("groq");
    const OLD = big("old");
    const NEW = big("new");
    const read = holdFirstRead();
    const app = await launch({ providerKeys: { groq: OLD } });
    await read.reached;
    // The user pastes a new Groq key in Models while the keychain is being read.
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, groq: NEW } })));
    read.release();
    await drain();
    expect(probe.props.userSt.providerKeys.groq).toBe(NEW);
    expect(app.storage.readUserSt().providerKeys.groq).toBe(NEW);
    expect(plaintext().providerKeys).toEqual({ groq: NEW });
  });

  test("a key the keychain already holds, changed while the load reads and refused, keeps the user's value", async () => {
    seedKeychain({ ...KEYCHAIN, groq: "G-CHAIN" });
    kc.refuse = (account) => account === P("groq");
    const NEW = big("new");
    const read = holdFirstRead();
    const app = await launch({});
    await read.reached;
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, groq: NEW } })));
    read.release();
    await drain();
    expect(probe.props.userSt.providerKeys.groq).toBe(NEW);
    expect(app.storage.readUserSt().providerKeys.groq).toBe(NEW);
    expect(plaintext().providerKeys).toEqual({ groq: NEW });
  });

  test("another window's save keeps the refused key on screen and in shells, and this window's next save puts its local copy back", async () => {
    const app = await failedLaunch();
    await anotherWindowSaves({ themeFollowOS: true });
    // The other window's write replaced the shared blob, plaintext copy included.
    expect(probe.props.userSt.themeFollowOS).toBe(true);
    expect(probe.props.userSt.providerKeys.openai).toBe(HUGE);
    expect(app.storage.readUserSt().providerKeys.openai).toBe(HUGE);
    act(() => probe.props.saveUser((prev) => ({ ...prev, terminalsOnboarded: true })));
    await drain();
    expect(plaintext().providerKeys).toEqual({ openai: HUGE });
  });

  test("another window's newer write to the same key wins over the one this window could not save", async () => {
    const app = await failedLaunch();
    kc.store.set(P("openai"), "O-OTHER");
    kc.store.set(INDEX, JSON.stringify([...Object.keys(KEYCHAIN), "groq", "openai"]));
    await anotherWindowSaves({ themeFollowOS: true });
    expect(probe.props.userSt.providerKeys.openai).toBe("O-OTHER");
    expect(app.storage.readUserSt().providerKeys.openai).toBe("O-OTHER");
  });

  test("on a keychain that could not be proven, the next save keeps the keychain's keys out of plaintext", async () => {
    seedKeychain();
    kc.refuse = (account) => account.startsWith("keychain-probe") || account === P("openai");
    await launch({ providerKeys: { openai: HUGE } });
    await waitFor(() => expect(kc.log).toContainEqual(["set", P("openai")]));
    await drain();
    expect(probe.props.userSt.providerKeys).toEqual({ openai: HUGE, ...KEYCHAIN });
    act(() => probe.props.saveUser((prev) => ({ ...prev, terminalsOnboarded: true })));
    await drain();
    expect(plaintext().providerKeys).toEqual({ openai: HUGE });
  });

  test("under StrictMode too: the keys shells get are shown, nothing is stripped, and a shown key can be removed", async () => {
    seedKeychain();
    kc.refuse = (account) => account === P("openai");
    const app = await launch({ providerKeys: { openai: HUGE, groq: "G-KEY" } }, { strict: true });
    await waitFor(() => expect(probe.props?.userSt.providerKeys).toEqual({ openai: HUGE, groq: "G-KEY", ...KEYCHAIN }));
    await drain();
    expect(plaintext().providerKeys).toEqual({ openai: HUGE, groq: "G-KEY" });
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, moonshot: "" } })));
    await drain();
    expect(kc.store.has(P("moonshot"))).toBe(false);
    expect(app.storage.readUserSt().providerKeys.moonshot).toBeUndefined();
    expect(plaintext().providerKeys).toEqual({ openai: HUGE });
  });

  test("first-run migration with an unreadable index: nothing is stripped, and the next save moves the keys", async () => {
    kc.failGet = (account) => account === INDEX;
    const app = await launch({ providerKeys: { anthropic: "A-PLAIN", groq: "G-KEY" } });
    await waitFor(() => expect(app.vault.keysSettled()).toBe(true));
    await drain();
    expect(probe.props.userSt.providerKeys).toEqual({ anthropic: "A-PLAIN", groq: "G-KEY" });
    expect(plaintext().providerKeys).toEqual({ anthropic: "A-PLAIN", groq: "G-KEY" });
    kc.failGet = null; // the index reads again
    act(() => probe.props.saveUser((prev) => ({ ...prev, terminalsOnboarded: true })));
    await drain();
    expect(kc.store.get(P("anthropic"))).toBe("A-PLAIN");
    expect(kc.store.get(P("groq"))).toBe("G-KEY");
    expect(plaintext().providerKeys).toBeUndefined();
  });

  test("with no keychain at all, the keys stay in plaintext and nobody is warned", async () => {
    kc.dead = true;
    const app = await launch({ providerKeys: { anthropic: "A-PLAIN" } });
    await waitFor(() => expect(app.vault.keysSettled()).toBe(true));
    await drain();
    expect(probe.props.userSt.providerKeys).toEqual({ anthropic: "A-PLAIN" });
    act(() => probe.props.saveUser((prev) => ({ ...prev, terminalsOnboarded: true })));
    await drain();
    expect(plaintext().providerKeys).toEqual({ anthropic: "A-PLAIN" });
    expect(screen.queryByText(KEYCHAIN_TOAST)).toBeNull();
  });
});

describe("a key the keychain refuses after a good launch", () => {
  async function goodLaunch(keys = KEYCHAIN) {
    seedKeychain(keys);
    const app = await launch({});
    await waitFor(() => expect(probe.props?.userSt.providerKeys?.moonshot).toBe("M-KEY"));
    await drain();
    expect(plaintext().providerKeys).toBeUndefined(); // stripped once the keychain proved itself
    return app;
  }

  test("is the only key put back in plaintext", async () => {
    await goodLaunch();
    kc.refuse = (_account, secret) => secret.length > 1280;
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, custom: HUGE } })));
    await drain();
    expect(kc.store.has(P("custom"))).toBe(false);
    expect(plaintext().providerKeys).toEqual({ custom: HUGE });
  });

  test("this window writes the shared blob only when it saves, never in answer to another window's save", async () => {
    await goodLaunch();
    kc.refuse = (_account, secret) => secret.length > 1280;
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, custom: HUGE } })));
    await drain();
    expect(plaintext().providerKeys).toEqual({ custom: HUGE });
    const spy = vi.spyOn(localStorage, "setItem"); // calls through; the other window's writes go around it
    try {
      // Whatever the other window's save leaves there: no copy of this
      // window's refused key, its own different copy of it, a cleared entry,
      // empty fields, a copy of a key the keychain holds.
      const shapes = [{}, { providerKeys: { custom: big("other-window") } }, { providerKeys: { custom: "" } }, { providerKeys: {}, anthropicKey: "" }, { providerKeys: { moonshot: "M-KEY" } }];
      for (const [n, keys] of shapes.entries()) {
        const json = JSON.stringify({ welcomeDone: true, themeFollowOS: n % 2 === 0, ...keys, _fieldMeta: { themeFollowOS: Date.now() + 1000 + n } });
        await act(async () => {
          Storage.prototype.setItem.call(localStorage, USER_KEY, json);
          window.dispatchEvent(new StorageEvent("storage", { key: USER_KEY, newValue: json }));
        });
        await drain();
      }
      expect(spy.mock.calls.filter(([key]) => key === USER_KEY)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
    // This window's own next save puts its copy back and tidies the rest.
    act(() => probe.props.saveUser((prev) => ({ ...prev, terminalsOnboarded: true })));
    await drain();
    expect(plaintext().providerKeys).toEqual({ custom: HUGE });
  });

  test("changed again and refused again, its new value goes in over any older copy", async () => {
    await goodLaunch();
    kc.refuse = (_account, secret) => secret.length > 1280;
    const NEWER = big("newer");
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, custom: HUGE } })));
    await drain();
    // Another window that still holds the old value puts its copy back while
    // this save's write is out: the value the user just entered here wins.
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_set" && args.account === P("custom")) otherWindowWritesBlob({ providerKeys: { custom: HUGE } });
    };
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, custom: NEWER } })));
    await drain();
    expect(plaintext().providerKeys).toEqual({ custom: NEWER });
  });

  test("and removed again at once, it does not come back from plaintext", async () => {
    await goodLaunch();
    kc.refuse = (_account, secret) => secret.length > 1280;
    act(() => {
      probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, custom: HUGE } }));
      probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, custom: "" } }));
    });
    await drain();
    expect(plaintext().providerKeys).toBeUndefined();
  });

  test("turned down for a moment, it does not go in over a newer key another window saved since", async () => {
    const app = await goodLaunch();
    let left = 1;
    kc.refuse = (account) => account === P("openai") && left-- > 0; // a keychain locked for a moment
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, openai: "O-MINE" } })));
    await drain();
    expect(plaintext().providerKeys).toEqual({ openai: "O-MINE" });
    // Another window saves a setting (its blob write takes this window's copy
    // with it), then a key of its own for openai: a save of keys alone changes
    // no byte of the blob, so this window hears nothing of that one.
    await anotherWindowSaves({ themeFollowOS: true });
    expect(probe.props.userSt.providerKeys.openai).toBe("O-MINE");
    kc.store.set(P("openai"), "O-OTHER");
    kc.store.set(INDEX, JSON.stringify([...Object.keys(KEYCHAIN), "openai"]));
    // Any save of this window's, of a setting with no key in it.
    act(() => probe.props.saveUser((prev) => ({ ...prev, terminalsOnboarded: true })));
    await drain();
    expect(kc.store.get(P("openai"))).toBe("O-OTHER");
    expect(plaintext().providerKeys).toBeUndefined();
    // The next refresh shows the newer key, and new shells get it.
    await anotherWindowSaves({ themeFollowOS: false });
    expect(probe.props.userSt.providerKeys.openai).toBe("O-OTHER");
    expect(app.storage.readUserSt().providerKeys.openai).toBe("O-OTHER");
  });

  test("the restore adds this window's refused key and keeps a copy another window put there", async () => {
    await goodLaunch();
    kc.refuse = (account) => account === P("custom");
    // Another window's own refused key lands in the shared blob while this
    // window's write is in flight: its plaintext copy is the only one.
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_set" && args.account === P("custom")) {
        otherWindowWritesBlob({ providerKeys: { openrouter: "OR-ONLY-COPY" }, anthropicKey: "L-ONLY-COPY" });
      }
    };
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, custom: HUGE } })));
    await drain();
    expect(plaintext()).toEqual({ providerKeys: { openrouter: "OR-ONLY-COPY", custom: HUGE }, anthropicKey: "L-ONLY-COPY" });
  });

  test("the restore drops a plaintext copy of a key the keychain holds, whoever put it there", async () => {
    await goodLaunch();
    kc.refuse = (account) => account === P("custom");
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_set" && args.account === P("custom")) {
        otherWindowWritesBlob({ providerKeys: { anthropic: "A-KEY" } });
      }
    };
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, custom: HUGE } })));
    await drain();
    expect(plaintext()).toEqual({ providerKeys: { custom: HUGE }, anthropicKey: undefined });
  });

  test("the restore drops a plaintext copy of the standalone key the keychain holds", async () => {
    kc.store.set(LEGACY, "L-CHAIN");
    await goodLaunch();
    kc.refuse = (account) => account === P("custom");
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_set" && args.account === P("custom")) otherWindowWritesBlob({ anthropicKey: "L-CHAIN" });
    };
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, custom: HUGE } })));
    await drain();
    expect(plaintext()).toEqual({ providerKeys: { custom: HUGE }, anthropicKey: undefined });
  });

  test("a save the keychain takes keeps another window's only copy, and writes the blob once", async () => {
    await goodLaunch();
    kc.hook = async (cmd, args) => {
      if (cmd === "secret_set" && args.account === P("groq")) otherWindowWritesBlob({ providerKeys: { openrouter: "OR-ONLY-COPY" } });
    };
    const spy = vi.spyOn(localStorage, "setItem"); // calls through; the other window's write goes around it
    try {
      act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, groq: "G-KEY" } })));
      await drain();
      expect(spy.mock.calls.filter(([key]) => key === USER_KEY)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    expect(kc.store.get(P("groq"))).toBe("G-KEY");
    expect(plaintext().providerKeys).toEqual({ openrouter: "OR-ONLY-COPY" });
  });

  test("a refused standalone Anthropic key is kept in plaintext, by itself", async () => {
    await goodLaunch();
    kc.refuse = (account) => account === LEGACY;
    act(() => probe.props.saveUser((prev) => ({ ...prev, anthropicKey: "L-KEY" })));
    await drain();
    expect(plaintext()).toEqual({ providerKeys: undefined, anthropicKey: "L-KEY" });
  });

  test("the standalone key the keychain holds is not copied when another key is refused", async () => {
    kc.store.set(LEGACY, "L-CHAIN");
    await goodLaunch();
    expect(probe.props.userSt.anthropicKey).toBe("L-CHAIN");
    kc.refuse = (account) => account === P("custom");
    act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, custom: HUGE } })));
    await drain();
    expect(plaintext()).toEqual({ providerKeys: { custom: HUGE }, anthropicKey: undefined });
  });

  test("a save with nothing to tidy writes the user blob once, so other windows get one event", async () => {
    await goodLaunch();
    const spy = vi.spyOn(localStorage, "setItem"); // calls through
    try {
      act(() => probe.props.saveUser((prev) => ({ ...prev, terminalsOnboarded: true })));
      await drain();
      expect(spy.mock.calls.filter(([key]) => key === USER_KEY)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("a later save the keychain takes clears the copy an earlier refusal left", async () => {
    await goodLaunch();
    let refusals = 0;
    kc.refuse = (account) => account === P("custom") && refusals++ === 0; // refused once, then fine
    act(() => {
      probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, custom: "C-KEY" } }));
      probe.props.saveUser((prev) => ({ ...prev, terminalsOnboarded: true }));
    });
    await drain();
    expect(kc.store.get(P("custom"))).toBe("C-KEY");
    expect(plaintext().providerKeys).toBeUndefined();
  });
});

describe("where key material can surface", () => {
  test("no key value reaches the console, the page, or any command but the keychain's own write", async () => {
    const MARK = "LEAKMARK";
    const OPENAI = `sk-${MARK}-openai-` + "x".repeat(3000);
    const CUSTOM = `sk-${MARK}-custom-` + "y".repeat(3000);
    seedKeychain({ anthropic: `A-${MARK}`, moonshot: `M-${MARK}` });
    kc.refuse = (_account, secret) => secret.length > 1280;
    const logged = [];
    const spies = ["log", "info", "warn", "error", "debug"].map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => { logged.push(args); }));
    try {
      // A failed launch, another window's save, then a refused key and a removal.
      await launch({ providerKeys: { openai: OPENAI } });
      await waitFor(() => expect(kc.log).toContainEqual(["set", P("openai")]));
      await drain();
      await anotherWindowSaves({ themeFollowOS: true });
      act(() => probe.props.saveUser((prev) => ({ ...prev, providerKeys: { ...prev.providerKeys, custom: CUSTOM, moonshot: "" } })));
      await drain();
      expect((await screen.findAllByText(KEYCHAIN_TOAST)).length).toBeGreaterThan(0);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const text = (v) => {
      if (v instanceof Error) return `${v.message}\n${v.stack}`;
      try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); }
    };
    const consoleText = logged.map((args) => args.map(text).join(" ")).join("\n");
    expect(consoleText).toMatch(/keychain write failed for: /); // the refusals were logged...
    expect(consoleText).not.toContain(MARK); // ...by provider id only
    expect(document.body.innerHTML).not.toContain(MARK);
    const otherCommands = invokeMock.mock.calls
      .filter(([cmd]) => cmd !== "secret_set")
      .map(([cmd, args]) => `${cmd} ${JSON.stringify(args)}`);
    expect(otherCommands.length).toBeGreaterThan(0);
    expect(otherCommands.join("\n")).not.toContain(MARK);
  });
});
