// (C)
// @vitest-environment happy-dom
// Live model lists (modelCatalog.js). The bug these exist for: the picker only
// knew the models typed into providers.js, so Claude Opus 5.5 never appeared.
import { describe, test, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));

import {
  ERROR_BACKOFF_MS,
  LAUNCH_REFRESH_MS,
  MODEL_CACHE_KEY,
  NEW_WINDOW_MS,
  NOT_LISTED_BACKOFF_MS,
  PICKER_REFRESH_MS,
  agoLabel,
  errorSummary,
  getModelCacheVersion,
  isChatModel,
  isNotListed,
  isRefreshing,
  listTarget,
  needsRefresh,
  normalizeModels,
  phoneModelIds,
  pickerList,
  readModelCache,
  refreshModels,
  refreshStaleLists,
  subscribeModelCache,
} from "./modelCatalog.js";
import { findProvider } from "./providers.js";
import { holdLocalWrites } from "./storageKeys.js";

const anthropic = findProvider("anthropic");
const custom = findProvider("custom");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 3); // 2026-10-03
const secs = (ms) => Math.floor(ms / 1000);

function seed(entries) {
  localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(entries));
}

// A promise the test resolves or rejects by hand.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
});

describe("which models the picker offers", () => {
  test("embeddings, speech, image, video, moderation and rerank models are hidden", () => {
    for (const id of [
      "text-embedding-3-large", "whisper-1", "tts-1-hd", "gpt-4o-mini-tts", "dall-e-3",
      "gpt-image-1", "omni-moderation-latest", "gpt-4o-realtime-preview", "gpt-4o-audio-preview",
      "gpt-4o-transcribe", "sora-2", "mistral-embed", "nomic-embed-text:latest",
      "Qwen/Qwen3-Embedding-8B", "BAAI/bge-reranker-v2-m3",
    ]) {
      expect(isChatModel(id), id).toBe(false);
    }
  });

  test("chat models are kept, across every naming style the providers use", () => {
    for (const id of [
      "claude-opus-5-5", "claude-haiku-4-5-20251001", "gpt-5", "o3", "gpt-4.1-mini",
      "codex-mini-latest", "gemini-2.5-pro", "deepseek-chat", "llama3.1:8b",
      "meta-llama/Llama-3.3-70B-Instruct", "moonshotai/kimi-k2-instruct", "kimi-k2.5",
      "glm-4.6", "grok-4",
    ]) {
      expect(isChatModel(id), id).toBe(true);
    }
  });

  test("a filtered word only counts as a whole token, not inside a longer word", () => {
    for (const id of ["embedded-systems-coder", "imagenetic-7b", "audiophile-chat", "ttsx-1"]) {
      expect(isChatModel(id), id).toBe(true);
    }
  });

  test("newest first, undated after in the provider's order, no duplicates", () => {
    const out = normalizeModels("openai", [
      { id: "a" },
      { id: "b", created: 100 },
      { id: "c" },
      { id: "d", created: 300 },
      { id: "b", created: 999 }, // duplicate id: the first one stands
      { id: "text-embedding-3-small", created: 500 },
      null,
      { id: 42 },
    ]);
    expect(out.map((m) => m.id)).toEqual(["d", "b", "a", "c"]);
    expect(out[1].created).toBe(100);
  });

  test("Gemini's models/ prefix is dropped, and only for Google", () => {
    expect(normalizeModels("google", [{ id: "models/gemini-2.5-pro" }])[0].id).toBe("gemini-2.5-pro");
    expect(normalizeModels("openrouter", [{ id: "models/x" }])[0].id).toBe("models/x");
  });
});

describe("listTarget: who can be asked", () => {
  test("no key, or a blank one, means no request", () => {
    expect(listTarget(anthropic, undefined)).toBeNull();
    expect(listTarget(anthropic, "   ")).toBeNull();
    expect(listTarget(null, "sk")).toBeNull();
  });

  test("Anthropic goes to its default endpoint (empty base, llm.rs fills it in)", () => {
    expect(listTarget(anthropic, "sk-ant")).toEqual({ kind: "anthropic", baseUrl: "", apiKey: "sk-ant" });
  });

  test("a compatible provider without a base URL cannot be routed, same as at spawn", () => {
    expect(listTarget(custom, "k")).toBeNull();
    expect(listTarget(custom, "k", "https://host/v1")).toEqual({ kind: "openai-compat", baseUrl: "https://host/v1", apiKey: "k" });
  });

  test("the key goes as stored, exactly as a spawned shell sends it", () => {
    expect(listTarget(anthropic, " sk ").apiKey).toBe(" sk ");
  });
});

describe("needsRefresh", () => {
  const base = "";
  test("missing, or from another endpoint", () => {
    expect(needsRefresh(undefined, base, PICKER_REFRESH_MS, NOW)).toBe(true);
    expect(needsRefresh({ base: "https://old", fetchedAt: NOW }, base, PICKER_REFRESH_MS, NOW)).toBe(true);
  });

  test("fresh, then stale", () => {
    const entry = { base, fetchedAt: NOW - 10 * 60 * 1000 };
    expect(needsRefresh(entry, base, PICKER_REFRESH_MS, NOW)).toBe(false);
    expect(needsRefresh(entry, base, 5 * 60 * 1000, NOW)).toBe(true);
  });

  test("a fetch that failed a moment ago is not retried automatically", () => {
    const entry = { base, fetchedAt: NOW - 2 * DAY, error: "x", errorAt: NOW - 60 * 1000 };
    expect(needsRefresh(entry, base, PICKER_REFRESH_MS, NOW)).toBe(false);
    expect(needsRefresh(entry, base, PICKER_REFRESH_MS, NOW + ERROR_BACKOFF_MS)).toBe(true);
  });

  test("a changed endpoint beats the error backoff", () => {
    const entry = { base: "https://old", error: "x", errorAt: NOW };
    expect(needsRefresh(entry, "https://new", PICKER_REFRESH_MS, NOW)).toBe(true);
  });
});

describe("refreshModels", () => {
  test("asks llm_list_models with the routing target and caches the answer", async () => {
    invokeMock.mockResolvedValue([{ id: "claude-opus-5-5", name: "Claude Opus 5.5", created: 1790000000 }]);
    const entry = await refreshModels("anthropic", "sk-ant");
    expect(invokeMock).toHaveBeenCalledWith("llm_list_models", { kind: "anthropic", baseUrl: "", apiKey: "sk-ant" });
    expect(entry.models[0].id).toBe("claude-opus-5-5");
    expect(readModelCache().anthropic).toEqual(entry);
    expect(entry.base).toBe("");
    expect(typeof entry.fetchedAt).toBe("number");
  });

  test("API keys never land in the cache", async () => {
    invokeMock.mockResolvedValue([{ id: "m" }]);
    await refreshModels("anthropic", "sk-ant-SECRET-123");
    expect(localStorage.getItem(MODEL_CACHE_KEY)).not.toContain("SECRET");
  });

  test("a failure keeps the previous list for the same endpoint and says why", async () => {
    seed({ anthropic: { base: "", fetchedAt: Date.now() - 60 * 1000, models: [{ id: "claude-opus-5-5" }] } });
    invokeMock.mockRejectedValue("HTTP 401: invalid x-api-key");
    const entry = await refreshModels("anthropic", "sk-bad");
    expect(entry.models.map((m) => m.id)).toEqual(["claude-opus-5-5"]);
    expect(entry.error).toBe("HTTP 401"); // the cached summary
    const view = pickerList(anthropic, readModelCache().anthropic, "", entry.errorAt);
    expect(view.source).toBe("live");
    expect(view.error).toBe("HTTP 401: invalid x-api-key"); // this session's full text
  });

  test("provider wording never reaches the cache, only a fixed summary", async () => {
    invokeMock.mockRejectedValue("HTTP 401: Received API Key = sk-1234, Key Hash (Token) =9f2c");
    const entry = await refreshModels("anthropic", "sk-1234");
    const stored = localStorage.getItem(MODEL_CACHE_KEY);
    expect(stored).not.toContain("sk-1234");
    expect(stored).not.toContain("Received");
    expect(entry.error).toBe("HTTP 401");
  });

  test("after a restart, the cached summary is what shows", async () => {
    invokeMock.mockRejectedValue("HTTP 401: invalid x-api-key");
    const entry = await refreshModels("anthropic", "sk-bad");
    vi.resetModules(); // a fresh module is a fresh session: its in-memory text is gone
    const fresh = await import("./modelCatalog.js");
    expect(fresh.pickerList(anthropic, fresh.readModelCache().anthropic, "", entry.errorAt).error).toBe("HTTP 401");
  });

  test("errorSummary never passes provider wording through", () => {
    expect(errorSummary("HTTP 404: url.not_found")).toBe("HTTP 404");
    expect(errorSummary("The provider answered without a model list: token sk-123 expired")).toBe(
      "The provider answered without a model list.",
    );
    expect(errorSummary("The provider's model list is larger than 4 MB, so it was not read.")).toBe(
      "The provider's model list is too large.",
    );
    expect(errorSummary("Refusing to send the API key to a non-HTTPS endpoint: http://x")).toBe(
      "Refused to send the key: the address is not https.",
    );
    expect(errorSummary("error sending request for url (https://api.example/v1/models)")).toBe(
      "Could not reach the provider.",
    );
    expect(errorSummary(undefined)).toBe("Could not reach the provider.");
  });

  test("a failure does not keep a list fetched from a different endpoint", async () => {
    seed({ custom: { base: "https://old/v1", fetchedAt: NOW, models: [{ id: "old-model" }] } });
    invokeMock.mockRejectedValue("404 Not Found");
    const entry = await refreshModels("custom", "k", "https://new/v1");
    expect(entry.base).toBe("https://new/v1");
    expect(entry.models).toEqual([]);
  });

  test("never rejects, even when invoke throws synchronously", async () => {
    invokeMock.mockImplementation(() => { throw new Error("boom"); });
    const entry = await refreshModels("anthropic", "sk");
    expect(entry.error).toBe("Could not reach the provider.");
    expect(pickerList(anthropic, entry, "").error).toBe("boom");
    expect(isRefreshing("anthropic")).toBe(false);
  });

  test("two requests for the same key share one fetch", async () => {
    const d = deferred();
    invokeMock.mockReturnValue(d.promise);
    const a = refreshModels("anthropic", "sk");
    const b = refreshModels("anthropic", "sk");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    d.resolve([{ id: "m" }]);
    expect(await a).toEqual(await b);
  });

  test("an older answer landing late does not overwrite a newer key's list", async () => {
    const slow = deferred();
    invokeMock.mockReturnValueOnce(slow.promise).mockResolvedValueOnce([{ id: "from-key-b" }]);
    const first = refreshModels("anthropic", "key-a");
    await refreshModels("anthropic", "key-b");
    slow.resolve([{ id: "from-key-a" }]);
    await first;
    expect(readModelCache().anthropic.models.map((m) => m.id)).toEqual(["from-key-b"]);
    expect(isRefreshing("anthropic")).toBe(false);
  });

  test("a factory reset's write hold keeps the answer out of storage", async () => {
    const release = holdLocalWrites();
    try {
      invokeMock.mockResolvedValue([{ id: "m" }]);
      await refreshModels("anthropic", "sk");
      expect(localStorage.getItem(MODEL_CACHE_KEY)).toBeNull();
      expect(isRefreshing("anthropic")).toBe(false);
    } finally {
      release();
    }
  });

  test("a provider that cannot be asked resolves null without a request", async () => {
    expect(await refreshModels("custom", "k")).toBeNull();
    expect(await refreshModels("anthropic", "")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("loading on and off both notify subscribers", async () => {
    const d = deferred();
    invokeMock.mockReturnValue(d.promise);
    const seen = [];
    const unsub = subscribeModelCache(() => seen.push(isRefreshing("anthropic")));
    const p = refreshModels("anthropic", "sk");
    expect(isRefreshing("anthropic")).toBe(true);
    d.resolve([{ id: "m" }]);
    await p;
    unsub();
    expect(seen[0]).toBe(true);
    expect(seen.at(-1)).toBe(false);
  });
});

describe("pickerList: what a row shows", () => {
  test("no list yet: the built-in one", () => {
    const view = pickerList(anthropic, undefined, "");
    expect(view.source).toBe("builtin");
    expect(view.models.map((m) => m.id)).toEqual(anthropic.models);
    expect(view.models.map((m) => m.id)).toContain("claude-opus-5-5");
  });

  test("the provider's list, newest first, recent releases flagged new", () => {
    const entry = {
      base: "",
      fetchedAt: NOW,
      models: [
        { id: "claude-opus-4-8", created: secs(NOW - 200 * DAY) },
        { id: "claude-opus-5-5", created: secs(NOW - 5 * DAY) },
      ],
    };
    const view = pickerList(anthropic, entry, "", NOW);
    expect(view.source).toBe("live");
    expect(view.models.map((m) => [m.id, m.isNew])).toEqual([["claude-opus-5-5", true], ["claude-opus-4-8", false]]);
    expect(NEW_WINDOW_MS).toBe(30 * DAY);
  });

  test("a list from another endpoint is not shown", () => {
    const entry = { base: "https://old", fetchedAt: NOW, models: [{ id: "old" }] };
    expect(pickerList(custom, entry, "https://new").source).toBe("builtin");
  });

  test("a list with no chat models falls back and says so", () => {
    const entry = { base: "", fetchedAt: NOW, models: [{ id: "text-embedding-3-large" }] };
    const view = pickerList(anthropic, entry, "");
    expect(view.source).toBe("builtin");
    expect(view.emptyLive).toBe(true);
  });

  test("an error older than the list on show is not repeated", () => {
    const entry = { base: "", fetchedAt: NOW, errorAt: NOW - 1000, error: "old", models: [{ id: "m" }] };
    expect(pickerList(anthropic, entry, "").error).toBeNull();
  });
});

describe("phoneModelIds", () => {
  const big = { base: "", fetchedAt: NOW, models: Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, created: 1000 - i })) };

  test("capped, and the active model rides along when the cap leaves it out", () => {
    const ids = phoneModelIds(anthropic, big, "", { providerId: "anthropic", model: "m99" }, 10);
    expect(ids).toHaveLength(11);
    expect(ids.at(-1)).toBe("m99");
  });

  test("the active model is not duplicated", () => {
    const ids = phoneModelIds(anthropic, big, "", { providerId: "anthropic", model: "m0" }, 10);
    expect(ids.filter((id) => id === "m0")).toHaveLength(1);
  });

  test("another provider's active model is not added", () => {
    const ids = phoneModelIds(anthropic, big, "", { providerId: "openai", model: "gpt-5" }, 10);
    expect(ids).not.toContain("gpt-5");
  });
});

describe("refreshStaleLists (launch pass)", () => {
  test("refreshes only keyed providers with stale lists, one at a time", async () => {
    seed({ openai: { base: "", fetchedAt: Date.now(), models: [{ id: "gpt-5" }] } }); // fresh: skipped
    let running = 0;
    let most = 0;
    invokeMock.mockImplementation(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return [{ id: "m" }];
    });
    await refreshStaleLists(() => ({
      providerKeys: { anthropic: "sk-ant", openai: "sk-oa", groq: "gsk" },
      providerBaseUrls: {},
    }));
    const asked = invokeMock.mock.calls.map(([, target]) => target.kind + ":" + target.apiKey);
    expect(asked).toEqual(["anthropic:sk-ant", "openai-compat:gsk"]);
    expect(most).toBe(1);
  });

  test("a list younger than 12 h is left alone", async () => {
    seed({ anthropic: { base: "", fetchedAt: Date.now() - (LAUNCH_REFRESH_MS - 60 * 1000), models: [{ id: "m" }] } });
    await refreshStaleLists(() => ({ providerKeys: { anthropic: "sk" } }));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("never sends a key to a plain-http endpoint unattended", async () => {
    invokeMock.mockResolvedValue([{ id: "m" }]);
    await refreshStaleLists(() => ({
      providerKeys: { custom: "k" },
      providerBaseUrls: { custom: "http://gpu-box.local:8000/v1" },
    }));
    expect(invokeMock).not.toHaveBeenCalled();
    // The same row over https is fine.
    await refreshStaleLists(() => ({
      providerKeys: { custom: "k" },
      providerBaseUrls: { custom: "https://gpu-box.example/v1" },
    }));
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  test("an address that has never answered waits for the user", async () => {
    seed({ anthropic: { base: "", models: [], error: "HTTP 401", errorAt: Date.now() - 2 * DAY } });
    await refreshStaleLists(() => ({ providerKeys: { anthropic: "sk" } }));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("one that answered before is retried after a failure, so one offline launch does not stop it", async () => {
    seed({
      anthropic: {
        base: "", fetchedAt: Date.now() - 3 * DAY, models: [{ id: "m" }],
        error: "Could not reach the provider.", errorAt: Date.now() - 2 * DAY,
      },
    });
    invokeMock.mockResolvedValue([{ id: "claude-opus-5-5" }]);
    await refreshStaleLists(() => ({ providerKeys: { anthropic: "sk" } }));
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  test("a pass that read an old key never overwrites the list a new key asked for", async () => {
    const anthropicCall = deferred();
    const newKeyCall = deferred();
    invokeMock.mockImplementation((cmd, t) => {
      if (t.apiKey === "ant") return anthropicCall.promise;
      if (t.apiKey === "new") return newKeyCall.promise;
      return Promise.resolve([{ id: `from-${t.apiKey}` }]);
    });
    // The stored key is still the old one when the pass reaches OpenAI (the
    // user's save has not landed yet), so only the in-flight check stands
    // between the pass and a request that would supersede the user's.
    const current = { providerKeys: { anthropic: "ant", openai: "old" } };
    const pass = refreshStaleLists(() => current);
    // While the pass waits on Anthropic, the user's new OpenAI key starts its fetch.
    const user = refreshModels("openai", "new");
    anthropicCall.resolve([{ id: "claude-opus-5-5" }]);
    await new Promise((r) => setTimeout(r, 0));
    newKeyCall.resolve([{ id: "from-new" }]);
    await Promise.all([pass, user]);
    expect(invokeMock.mock.calls.map(([, t]) => t.apiKey)).toEqual(["ant", "new"]);
    expect(readModelCache().openai.models.map((m) => m.id)).toEqual(["from-new"]);
  });

  test("keys are read at the moment of asking, per provider", async () => {
    invokeMock.mockResolvedValue([{ id: "m" }]);
    let reads = 0;
    let key = "first";
    await refreshStaleLists(() => {
      reads += 1;
      if (reads > 1) key = "second"; // saved after the pass started
      return { providerKeys: { openai: key } };
    });
    expect(invokeMock.mock.calls.map(([, t]) => t.apiKey)).toEqual(["second"]);
  });
});

describe("dates from a provider", () => {
  test("an out-of-range date is dropped, not kept to crash a formatter later", () => {
    const out = normalizeModels("custom", [
      { id: "ns", created: 1_727_000_000_000_000_000 },
      { id: "us", created: 1_727_000_000_000_000 },
      { id: "neg", created: -5 },
      { id: "ok", created: 1_727_000_000 },
    ]);
    expect(Object.fromEntries(out.map((m) => [m.id, m.created]))).toEqual({
      ok: 1_727_000_000, ns: undefined, us: undefined, neg: undefined,
    });
  });

  test("a date in the future is not 'new'", () => {
    const entry = { base: "", fetchedAt: NOW, models: [{ id: "future", created: secs(NOW + 400 * DAY) }] };
    expect(pickerList(anthropic, entry, "", NOW).models[0].isNew).toBe(false);
  });
});

describe("an address with no list (404)", () => {
  test("is recognised from the status llm.rs puts first", () => {
    expect(isNotListed({ base: "", models: [], error: "HTTP 404: url.not_found", errorAt: NOW })).toBe(true);
    expect(isNotListed({ base: "", models: [], error: "HTTP 401: nope", errorAt: NOW })).toBe(false);
    // A provider that has listed before is having a bad day, not missing a list.
    expect(isNotListed({ base: "", fetchedAt: NOW - DAY, models: [{ id: "m" }], error: "HTTP 404: x", errorAt: NOW })).toBe(false);
  });

  test("is not asked again for a week, unless the endpoint changes", () => {
    const entry = { base: "https://api.moonshot.ai/anthropic", models: [], error: "HTTP 404: url.not_found", errorAt: NOW };
    const base = entry.base;
    expect(needsRefresh(entry, base, PICKER_REFRESH_MS, NOW + 2 * DAY)).toBe(false);
    expect(needsRefresh(entry, base, PICKER_REFRESH_MS, NOW + NOT_LISTED_BACKOFF_MS + 1)).toBe(true);
    expect(needsRefresh(entry, "https://elsewhere", PICKER_REFRESH_MS, NOW + 60 * 1000)).toBe(true);
  });

  test("shows the built-in list and says why", () => {
    const moonshot = findProvider("moonshot");
    const entry = { base: moonshot.baseUrl, models: [], error: "HTTP 404: url.not_found", errorAt: NOW };
    const view = pickerList(moonshot, entry, moonshot.baseUrl, NOW);
    expect(view.source).toBe("builtin");
    expect(view.notListed).toBe(true);
    expect(view.models.map((m) => m.id)).toEqual(moonshot.models);
  });
});

describe("the cache itself", () => {
  test("another window's refresh re-renders this one", () => {
    const before = getModelCacheVersion();
    const unsub = subscribeModelCache(() => {});
    window.dispatchEvent(new StorageEvent("storage", { key: MODEL_CACHE_KEY }));
    unsub();
    expect(getModelCacheVersion()).toBeGreaterThan(before);
  });

  test("an unrelated storage event does not", () => {
    const unsub = subscribeModelCache(() => {});
    const before = getModelCacheVersion();
    window.dispatchEvent(new StorageEvent("storage", { key: "plutos-terminals:user:v0" }));
    unsub();
    expect(getModelCacheVersion()).toBe(before);
  });

  test("corrupt JSON reads as empty instead of throwing", () => {
    localStorage.setItem(MODEL_CACHE_KEY, "{not json");
    expect(readModelCache()).toEqual({});
    localStorage.setItem(MODEL_CACHE_KEY, "[1,2]");
    expect(readModelCache()).toEqual({});
  });

  test("lives under the prefix a factory reset wipes", () => {
    expect(MODEL_CACHE_KEY.startsWith("plutos-terminals:")).toBe(true);
  });
});

test("agoLabel", () => {
  expect(agoLabel(NOW - 5 * 1000, NOW)).toBe("just now");
  expect(agoLabel(NOW - 5 * 60 * 1000, NOW)).toBe("5 min ago");
  expect(agoLabel(NOW - 3 * 60 * 60 * 1000, NOW)).toBe("3 h ago");
  expect(agoLabel(NOW - 2 * DAY, NOW)).toBe("2 d ago");
});
