// (C)
// Locks allOpenTabIds() — the keep-set builder the scrollback GC hinges on. If a
// future state-shape refactor breaks it, the sweep would regress to deleting a
// live tab's scrollback (the CRITICAL this exists to prevent), so these assert
// the prefix match, the exclusions, and fail-safe resilience to bad blobs.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { allOpenTabIds, STATE_KEY_PREFIX, USER_STORAGE_KEY } from "./storageKeys.js";

beforeEach(() => {
  const store = new Map();
  global.window = {}; // make `typeof window !== "undefined"`
  global.localStorage = {
    get length() { return store.size; },
    key(i) { return [...store.keys()][i] ?? null; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
});
afterEach(() => { delete global.window; delete global.localStorage; });

describe("allOpenTabIds", () => {
  it("gathers tab ids across the primary + secondary windows", () => {
    localStorage.setItem(STATE_KEY_PREFIX, JSON.stringify({ panels: [{ tabs: [{ id: "t1" }, { id: "t2" }] }] }));
    localStorage.setItem(`${STATE_KEY_PREFIX}:w2`, JSON.stringify({ panels: [{ tabs: [{ id: "t3" }] }] }));
    expect(allOpenTabIds().sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("excludes the user blob and other plutos-terminals keys", () => {
    localStorage.setItem(STATE_KEY_PREFIX, JSON.stringify({ panels: [{ tabs: [{ id: "t1" }] }] }));
    // A panels-shaped user blob must NOT contribute ids (it isn't window state).
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ panels: [{ tabs: [{ id: "NOPE" }] }] }));
    localStorage.setItem("plutos-terminals:cmdhistory:v0", JSON.stringify(["ls"]));
    localStorage.setItem("plutos-terminals:macros:v0", JSON.stringify([]));
    expect(allOpenTabIds()).toEqual(["t1"]);
  });

  it("a malformed blob in one window doesn't stop the others", () => {
    localStorage.setItem(STATE_KEY_PREFIX, "{bad json");
    localStorage.setItem(`${STATE_KEY_PREFIX}:w2`, JSON.stringify({ panels: [{ tabs: [{ id: "ok" }] }] }));
    expect(allOpenTabIds()).toEqual(["ok"]);
  });

  it("missing / empty panels or tabs yields no ids and never throws", () => {
    localStorage.setItem(STATE_KEY_PREFIX, JSON.stringify({}));
    localStorage.setItem(`${STATE_KEY_PREFIX}:w2`, JSON.stringify({ panels: [] }));
    localStorage.setItem(`${STATE_KEY_PREFIX}:w3`, JSON.stringify({ panels: [{}] }));
    expect(allOpenTabIds()).toEqual([]);
  });
});
