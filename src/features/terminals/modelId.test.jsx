// (C)
// @vitest-environment happy-dom
// A model id becomes ANTHROPIC_MODEL / OPENAI_MODEL in every shell the app
// starts afterwards, and it can be set three ways: typed in Models, sent from
// the phone, or synced from another device. These pin the one rule all of them
// pass through (isModelId, the same rule llm.rs clean_model_id holds a
// provider's list to; a Rust test pins the two together), the shell-safety
// check on a provider's base URL, and what happens to a saved choice that
// cannot be used here: it routes nowhere (not to a provider the user did not
// pick), everything shows no model and says why, and Models keeps the choice.
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("@backend", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));

import {
  activeModelProblem, envForModel, isModelId, noModelMessage, phoneModelChoice, providerKeyFor, resolveActiveLLM, validActiveModel,
} from "./providers.js";
import { resolveEnvFromUserState, shellNotice } from "./spawnEnv.js";
import { buildNoticeSuffix } from "./shellIntegration.js";
import ModelPicker from "./ModelPicker.jsx";
import { ToastProvider } from "../../components/Toast.jsx";

const chr = (code) => String.fromCharCode(code);
const NUL = chr(0);
const LF = chr(10);
const ESC = chr(27);
const BEL = chr(7);
// Normalised to LF, so the source pins hold on a Windows (CRLF) checkout too.
const source = (file) => readFileSync(path.join(process.cwd(), "src/features/terminals", file), "utf8").replace(/\r\n/g, "\n");

// Real ids from the providers the app routes to: Anthropic (aliases, dated, and
// Claude Code's own "[1m]" 1M-context suffix), OpenRouter (vendor/model:variant,
// ~vendor, @preset), Cloudflare (@cf/...), Bedrock, Ollama (name:tag), Hugging
// Face via Ollama, Fireworks (including a dedicated deployment), Google,
// Moonshot, and the local path vLLM serves as its id.
const REAL_IDS = [
  "claude-opus-5-5",
  "claude-haiku-4-5-20251001",
  "sonnet[1m]",
  "claude-opus-4-1[1m]",
  "anthropic.claude-sonnet-4-5-20250929-v1:0[1m]",
  "kimi-k2.5[1m]",
  "gpt-5",
  "anthropic/claude-3.5-sonnet:beta",
  "~anthropic/claude-sonnet-4.5",
  "@preset/my-coding-preset",
  "meta-llama/llama-3.1-405b-instruct",
  "@cf/meta/llama-3-8b-instruct",
  "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
  "qwen2.5-coder:7b",
  "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M",
  "accounts/fireworks/models/llama-v3p1-405b-instruct",
  "accounts/fireworks/models/llama-v3p1-8b-instruct#accounts/acme/deployments/abcd1234",
  "models/gemini-2.5-pro",
  "/models/Qwen2.5-7B-Instruct",
  "./models/foo.gguf",
];

const BAD_IDS = [
  "",
  " ",
  "two words",
  "x" + NUL + "y",
  "x" + LF + "y",
  "claude-opus-5-5" + LF,
  ESC + "]52;c;aGk=" + BEL, // an OSC 52 clipboard write
  "claude;rm -rf ~",
  "$(curl evil)",
  "-rf",
  "--version",
  "é",
  "a".repeat(201),
];

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("isModelId", () => {
  test("accepts the ids real providers use", () => {
    for (const id of REAL_IDS) expect(isModelId(id), id).toBe(true);
    expect(isModelId("a".repeat(200))).toBe(true);
  });
  test("rejects anything else, including an id that would read as a flag", () => {
    for (const id of BAD_IDS) expect(isModelId(id), JSON.stringify(id)).toBe(false);
    for (const v of [null, undefined, 42, {}, ["claude-opus-5-5"]]) expect(isModelId(v)).toBe(false);
  });
});

describe("phoneModelChoice", () => {
  const userSt = { providerKeys: { anthropic: "sk-ant-test", openrouter: "" } };
  test("keeps a known provider with a key and a valid id, trimmed", () => {
    expect(phoneModelChoice({ providerId: "anthropic", model: " claude-opus-5-5 " }, userSt))
      .toEqual({ providerId: "anthropic", model: "claude-opus-5-5" });
    expect(phoneModelChoice({ providerId: "anthropic", model: "sonnet[1m]" }, userSt))
      .toEqual({ providerId: "anthropic", model: "sonnet[1m]" });
  });
  test("ignores a bad id, an unknown provider, a provider with no key, or a malformed payload", () => {
    // The pick is trimmed first (as llm.rs active_model_payload does), so an id
    // that is only bad for its surrounding whitespace is fine here.
    for (const model of BAD_IDS.filter((id) => !isModelId(id.trim()))) {
      expect(phoneModelChoice({ providerId: "anthropic", model }, userSt), JSON.stringify(model)).toBe(null);
    }
    expect(phoneModelChoice({ providerId: "anthropic", model: "claude-opus-5-5" + LF }, userSt))
      .toEqual({ providerId: "anthropic", model: "claude-opus-5-5" });
    expect(phoneModelChoice({ providerId: "nope", model: "claude-opus-5-5" }, userSt)).toBe(null);
    expect(phoneModelChoice({ providerId: "openrouter", model: "gpt-5" }, userSt)).toBe(null);
    expect(phoneModelChoice({ providerId: ["anthropic"], model: "claude-opus-5-5" }, userSt)).toBe(null);
    expect(phoneModelChoice(null, userSt)).toBe(null);
  });
  test("counts Anthropic's standalone key for Anthropic, and for no one else", () => {
    const legacy = { anthropicKey: "sk-legacy" };
    expect(phoneModelChoice({ providerId: "anthropic", model: "claude-opus-5-5" }, legacy))
      .toEqual({ providerId: "anthropic", model: "claude-opus-5-5" });
    expect(phoneModelChoice({ providerId: "openrouter", model: "gpt-5" }, legacy)).toBe(null);
    expect(phoneModelChoice({ providerId: "anthropic", model: "claude-opus-5-5" }, { providerKeys: { anthropic: "   " } })).toBe(null);
  });
  test("TerminalsTab applies the phone's pick only through phoneModelChoice, and lists only a usable choice", () => {
    // The listener and the catalog live inside TerminalsTab's render closure
    // and cannot be mounted alone, so they are read from source, as
    // keybindings.tabs.test.js does for the shortcut wiring.
    const src = source("TerminalsTab.jsx");
    const body = src.slice(src.indexOf("setActiveModelRef.current = (payload) => {"), src.indexOf('listen("companion://set-active-model"'));
    expect(body).toMatch(/const next = phoneModelChoice\(payload, userSt\);\s*if \(next\) saveUser\(\{ \.\.\.userSt, activeModel: next \}\);/);
    expect(body).not.toMatch(/payload\?\.model/);
    expect(src).toMatch(/const choice = validActiveModel\(userSt, \{ keysKnown: keysSettled\(\) \}\);/);
    expect(src).toMatch(/phoneModelIds\(pp, hasKey \? cache\[pp\.id\] : null, resolveBaseUrl\(pp, bases\[pp\.id\]\), choice\)/);
  });
});

describe("providerKeyFor: one answer to whether a provider has a key", () => {
  test("the Models key, else for Anthropic alone its standalone key; a blank counts as none", () => {
    expect(providerKeyFor({ providerKeys: { openrouter: "sk-or" } }, "openrouter")).toBe("sk-or");
    expect(providerKeyFor({ providerKeys: { anthropic: "sk-ant" }, anthropicKey: "sk-legacy" }, "anthropic")).toBe("sk-ant");
    expect(providerKeyFor({ anthropicKey: "sk-legacy" }, "anthropic")).toBe("sk-legacy");
    expect(providerKeyFor({ anthropicKey: "sk-legacy" }, "openrouter")).toBe("");
    expect(providerKeyFor({ providerKeys: { openrouter: "  " } }, "openrouter")).toBe("");
    expect(providerKeyFor({ providerKeys: { openrouter: 42 } }, "openrouter")).toBe("");
    expect(providerKeyFor({ providerKeys: {} }, "__proto__")).toBe("");
    expect(providerKeyFor(null, "anthropic")).toBe("");
    // A blank standalone key counts as none too.
    expect(providerKeyFor({ anthropicKey: "   " }, "anthropic")).toBe("");
    // Only a string id, and only the object's own keys.
    expect(providerKeyFor({ providerKeys: { anthropic: "sk-ant" } }, ["anthropic"])).toBe("");
    expect(providerKeyFor({ providerKeys: { anthropic: "sk-ant" } }, { toString: () => "anthropic" })).toBe("");
    expect(providerKeyFor({ anthropicKey: "sk-legacy" }, { toString: () => "anthropic" })).toBe("");
    expect(providerKeyFor({ providerKeys: Object.create({ openrouter: "sk-inherited" }) }, "openrouter")).toBe("");
  });
  test("Anthropic's standalone key never stands in for another provider: that choice fails closed", () => {
    // OpenRouter picked, and only the old standalone Anthropic key on this device.
    const st = { anthropicKey: "sk-legacy", activeModel: { providerId: "openrouter", model: "gpt-5" } };
    expect(activeModelProblem(st)).toMatch(/no API key on this device/);
    expect(resolveEnvFromUserState(st, envForModel)).toEqual({});
    expect(resolveActiveLLM(st)).toBe(null);
  });
  test("for an Anthropic choice it is used the whole way, the chosen model included", () => {
    const st = { anthropicKey: "sk-legacy", activeModel: { providerId: "anthropic", model: "claude-opus-5-5" } };
    expect(activeModelProblem(st)).toBe(null);
    expect(resolveEnvFromUserState(st, envForModel)).toMatchObject({ ANTHROPIC_API_KEY: "sk-legacy", ANTHROPIC_MODEL: "claude-opus-5-5" });
    expect(resolveActiveLLM(st)).toMatchObject({ kind: "anthropic", apiKey: "sk-legacy", model: "claude-opus-5-5" });
  });
  test("every key check goes through it (from source)", () => {
    const outside = source("providers.js").replace(/export function providerKeyFor\([\s\S]*?\n}\n/, "");
    expect(outside).not.toMatch(/providerKeys(\?\.)?\[|keys\[(am\.)?providerId\]/);
    expect(source("providers.js")).toMatch(/if \(keysKnown && !providerKeyFor\(userSt, am\.providerId\)\) return/);
    expect(source("providers.js")).toMatch(/const amKey = am\?\.providerId \? providerKeyFor\(userSt, am\.providerId\) : "";/);
    expect(source("providers.js")).toMatch(/if \(!findProvider\(providerId\) \|\| !providerKeyFor\(userSt, providerId\)\) return null;/);
    expect(source("spawnEnv.js")).toMatch(/const amKey = am && am\.providerId \? providerKeyFor\(userPersisted, am\.providerId\) : "";/);
    expect(source("spawnEnv.js")).not.toMatch(/keys\[am\.providerId\]/);
    expect(source("TerminalsTab.jsx")).toMatch(/const hasKey = Boolean\(providerKeyFor\(userSt, pp\.id\)\);/);
    expect(source("TerminalsTab.jsx")).not.toMatch(/keys\[pp\.id\]/);
    expect(source("ModelPicker.jsx")).toMatch(/if \(!providerKeyFor\(\{ providerKeys: keys, anthropicKey: userSt\?\.anthropicKey \}, providerId\)\) \{\s*toast\.error\("Enter the provider's API key first\."\);/);
  });
});

describe("a Claude-compatible gateway never gets the Anthropic key", () => {
  // Claude Code sends ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN together, so
  // with both in a shell's env a gateway's operator would receive a working
  // Anthropic key beside the gateway's own token.
  for (const providerId of ["moonshot", "zai", "minimax"]) {
    test(`${providerId}: its own token, address and model, and no default key`, () => {
      for (const st of [
        { providerKeys: { anthropic: "sk-ant-default", [providerId]: "sk-gateway" }, activeModel: { providerId, model: "kimi-k2.5" } },
        { anthropicKey: "sk-legacy", providerKeys: { [providerId]: "sk-gateway" }, activeModel: { providerId, model: "kimi-k2.5" } },
      ]) {
        const env = resolveEnvFromUserState(st, envForModel);
        // Blank rather than absent: the shell inherits the app's environment,
        // and an empty value is what hides a key the user set there.
        expect(env.ANTHROPIC_API_KEY).toBe("");
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-gateway");
        expect(env.ANTHROPIC_BASE_URL).toMatch(/^https:\/\//);
        expect(env.ANTHROPIC_MODEL).toBe("kimi-k2.5");
      }
    });
  }
  test("every other choice is as before: Anthropic gets its key, an OpenAI-style provider keeps it beside its own", () => {
    expect(resolveEnvFromUserState({ providerKeys: { anthropic: "sk-ant" }, activeModel: { providerId: "anthropic", model: "claude-opus-5-5" } }, envForModel))
      .toMatchObject({ ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_MODEL: "claude-opus-5-5" });
    const env = resolveEnvFromUserState({ providerKeys: { anthropic: "sk-ant", openrouter: "sk-or" }, activeModel: { providerId: "openrouter", model: "gpt-5" } }, envForModel);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant"); // claude in that shell still talks to Anthropic itself
    expect(env.OPENAI_API_KEY).toBe("sk-or");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
  test("the standalone key TerminalPane adds stays out of a gateway's env too (from source)", () => {
    expect(source("TerminalPane.jsx")).toMatch(/if \(!routingBlocked && !env\.ANTHROPIC_API_KEY && !env\.ANTHROPIC_BASE_URL && persisted/);
  });
});

describe("the one line a local shell shows (shellNotice)", () => {
  const keys = { anthropic: "sk-ant-test" };
  const choice = (activeModel, providerKeys = keys) => ({ providerKeys, activeModel });
  const LOADING = "[models] This shell started before the keychain had been read, so it has none of your saved API keys. A tab opened after they load will have them.";
  test("a saved choice that cannot be used: the reason, once the keychain has been read", () => {
    expect(shellNotice(choice({ providerId: "openrouter", model: "gpt-5" }), {}, true))
      .toBe("[models] Your saved model choice cannot be used: its provider has no API key on this device (adding one fixes it). This shell got no provider key; open Models to fix it.");
    // A bad id is bad whether or not the keys have loaded.
    expect(shellNotice(choice({ providerId: "anthropic", model: "two words" }), {}, false)).toMatch(/its model id has characters/);
  });
  test("before the read has finished, a missing key reads as still loading, and only when no app key got through", () => {
    expect(shellNotice(choice({ providerId: "openrouter", model: "gpt-5" }, {}), {}, false)).toBe(LOADING);
    expect(shellNotice({}, {}, false)).toBe(LOADING);
    expect(shellNotice({}, {}, undefined)).toBe(LOADING); // only `true` means the read finished
    // Keys still in localStorage (before the keychain holds them) did get through.
    expect(shellNotice({ providerKeys: keys }, { ANTHROPIC_API_KEY: "sk-ant-test" }, false)).toBe("");
    expect(shellNotice({}, { OPENAI_API_KEY: "sk" }, false)).toBe("");
    expect(shellNotice({}, { ANTHROPIC_AUTH_TOKEN: "t" }, false)).toBe("");
  });
  test("nothing to say: a usable choice, or no choice once the read is done", () => {
    expect(shellNotice(choice({ providerId: "anthropic", model: "claude-opus-5-5" }), { ANTHROPIC_API_KEY: "sk-ant-test" }, true)).toBe("");
    expect(shellNotice({}, {}, true)).toBe("");
    expect(shellNotice({ providerKeys: keys }, {}, true)).toBe("");
  });
  test("never carries the saved id, and every line it can print survives the shell (buildNoticeSuffix)", () => {
    const hostile = "x" + ESC + "]0;pwned" + BEL + "'; rm -rf ~ #";
    const states = [
      choice({ providerId: "anthropic", model: hostile }),
      choice({ providerId: "nope", model: "m" }),
      choice({ providerId: "openrouter", model: "gpt-5" }),
      { providerKeys: { custom: "sk" }, activeModel: { providerId: "custom", model: "m" } },
      { providerKeys: { custom: "sk" }, providerBaseUrls: { custom: "http://my host/v1" }, activeModel: { providerId: "custom", model: "m" } },
      {},
    ];
    const lines = new Set();
    for (const st of states) {
      for (const settled of [true, false]) {
        const line = shellNotice(st, {}, settled);
        if (!line) continue;
        lines.add(line);
        expect(line).not.toContain(hostile);
        expect(buildNoticeSuffix(line, false), line).not.toBe("");
        expect(buildNoticeSuffix(line, true), line).not.toBe("");
      }
    }
    expect(lines.size).toBe(6); // five reasons and the still-loading line
  });
});

describe("new shells get only a valid id and a shell-safe base URL", () => {
  test("envForModel routes a valid id and nothing for a bad one", () => {
    expect(envForModel("anthropic", "claude-opus-5-5", "sk-ant-test")).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_MODEL: "claude-opus-5-5",
    });
    expect(envForModel("anthropic", "sonnet[1m]", "sk-ant-test").ANTHROPIC_MODEL).toBe("sonnet[1m]");
    for (const model of BAD_IDS) expect(envForModel("anthropic", model, "sk-ant-test"), JSON.stringify(model)).toEqual({});
  });
  test("a well-formed non-ASCII address passes", () => {
    expect(envForModel("custom", "m", "sk-secret", "http://gate" + chr(0xd83d) + chr(0xde00) + "way/v1").OPENAI_MODEL).toBe("m");
  });
  test("where a base URL points is the user's call; a control character, a space or a huge value is not", () => {
    // A homelab gateway on a bare LAN name is a normal setup for a shell.
    expect(envForModel("custom", "m", "sk-secret", "http://mac-mini:11434/v1")).toEqual({
      OPENAI_BASE_URL: "http://mac-mini:11434/v1",
      OPENAI_API_KEY: "sk-secret",
      OPENAI_MODEL: "m",
    });
    // resolveBaseUrl trims the saved address, so the rule sees what is inside it.
    expect(envForModel("custom", "m", "sk-secret", "http://local" + LF + "host:1234")).toEqual({});
    expect(envForModel("custom", "m", "sk-secret", "http://gate way/v1")).toEqual({});
    expect(envForModel("custom", "m", "sk-secret", "http://h/" + "a".repeat(2048))).toEqual({});
  });
  test("Unicode line separators, spaces, invisible characters and lone surrogates count too", () => {
    // NEL, the line separator, a no-break space, a zero-width space, a BOM, an
    // ideographic space, a soft hyphen, the Arabic letter mark, and a lone high
    // surrogate (which would make the whole spawn request unencodable). A real
    // emoji, a surrogate pair, is a character like any other.
    for (const code of [0x85, 0x2028, 0xa0, 0x200b, 0xfeff, 0x3000, 0xad, 0x061c, 0xd83d]) {
      expect(envForModel("custom", "m", "sk-secret", "http://gate" + chr(code) + "way/v1"), code.toString(16)).toEqual({});
    }
  });
});

describe("a saved choice that cannot be used here routes nowhere, everywhere", () => {
  const keys = { anthropic: "sk-ant-test", moonshot: "sk-moon", custom: "sk-custom" };
  const saved = (activeModel, providerBaseUrls, providerKeys = keys) => ({ providerKeys, activeModel, providerBaseUrls });
  test("activeModelProblem names the problem, validActiveModel drops the choice", () => {
    expect(activeModelProblem(saved({ providerId: "anthropic", model: "sonnet[1m]" }))).toBe(null);
    expect(validActiveModel(saved({ providerId: "anthropic", model: "sonnet[1m]" }))).toEqual({ providerId: "anthropic", model: "sonnet[1m]" });
    expect(activeModelProblem(saved({ providerId: "anthropic", model: "two words" }))).toMatch(/model id/);
    expect(activeModelProblem(saved({ providerId: "nope", model: "m" }))).toMatch(/provider is not one/);
    expect(activeModelProblem(saved({ providerId: "custom", model: "m" }, { custom: "http://gate way/v1" }))).toMatch(/base URL has a space/);
    expect(activeModelProblem(saved({ providerId: "custom", model: "m" }, { custom: "http://mac-mini:11434/v1" }))).toBe(null);
    expect(validActiveModel(saved({ providerId: "anthropic", model: "two words" }))).toBe(null);
    expect(activeModelProblem({})).toBe(null);
    expect(validActiveModel({})).toBe(null);
  });
  test("a choice synced from another device fails here when this device lacks its key or address", () => {
    // activeModel syncs between devices; keys and base URLs do not.
    expect(activeModelProblem(saved({ providerId: "openrouter", model: "gpt-5" }))).toMatch(/no API key on this device/);
    expect(activeModelProblem(saved({ providerId: "custom", model: "m" }))).toMatch(/no base URL on this device/);
    // Before the first keychain read finishes, a key not read yet is not missing.
    expect(activeModelProblem(saved({ providerId: "openrouter", model: "gpt-5" }), { keysKnown: false })).toBe(null);
    expect(validActiveModel(saved({ providerId: "openrouter", model: "gpt-5" }), { keysKnown: false })).toEqual({ providerId: "openrouter", model: "gpt-5" });
    // Anthropic's own standalone key (from before Models held keys) still counts.
    expect(activeModelProblem({ anthropicKey: "sk-legacy", activeModel: { providerId: "anthropic", model: "claude-opus-5-5" } })).toBe(null);
  });
  test("the in-app AI gets no model, rather than the default Claude key", () => {
    expect(resolveActiveLLM(saved({ providerId: "moonshot", model: "two words" }))).toBe(null);
    expect(resolveActiveLLM(saved({ providerId: "openrouter", model: "gpt-5" }))).toBe(null);
    expect(resolveActiveLLM(saved({ providerId: "anthropic", model: "sonnet[1m]" })).model).toBe("sonnet[1m]");
    expect(resolveActiveLLM({ providerKeys: keys }).model).toBe("claude-haiku-4-5-20251001");
  });
  test("a new shell gets no key at all, and no caller can leave that check out", () => {
    // Two arguments, as TerminalPane calls it: the check is built in.
    expect(resolveEnvFromUserState(saved({ providerId: "anthropic", model: "x" + NUL + "y" }), envForModel)).toEqual({});
    expect(resolveEnvFromUserState(saved({ providerId: "openrouter", model: "gpt-5" }), envForModel)).toEqual({});
    expect(resolveEnvFromUserState({ providerKeys: keys }, envForModel)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test" });
  });
  test("the AI panels say why, and the five of them all ask noModelMessage", () => {
    expect(noModelMessage(saved({ providerId: "openrouter", model: "gpt-5" })))
      .toMatch(/^Your saved model choice cannot be used: its provider has no API key on this device \(adding one fixes it\)\./);
    expect(noModelMessage({})).toBe("No model configured. Open the Models picker (toolbar) first.");
    for (const f of ["AskBar.jsx", "DockAssistant.jsx", "AgentMode.jsx", "ErrorExplainer.jsx", "SessionSummary.jsx"]) {
      const src = source(f);
      expect(src, f).toMatch(/const llm = resolveActiveLLM\(llmState\);/);
      expect(src, f).toMatch(/noModelMessage\(llmState\)/);
      expect(src, f).not.toMatch(/No model configured/);
    }
  });
  test("TerminalPane withholds the legacy key too, and the shell says why after its clear (from source)", () => {
    const src = source("TerminalPane.jsx");
    expect(src).toMatch(/resolveEnvFromUserState\(userPersisted, envForModel\)/);
    expect(src).toMatch(/const modelProblem = userPersisted\?\.activeModel \? activeModelProblem\(userPersisted\) : null;/);
    expect(src).toMatch(/if \(!routingBlocked && !env\.ANTHROPIC_API_KEY && !env\.ANTHROPIC_BASE_URL && persisted/);
    // The line is worked out once the app's own keys are in (the standalone
    // one included) and before the user's envOverrides, for local shells only.
    const legacy = src.indexOf("env.ANTHROPIC_API_KEY = persisted.anthropicKey;");
    const notice = src.indexOf("if (!serial && !connection) modelNotice = shellNotice(userPersisted, env, keysSettled());");
    const overrides = src.indexOf("persisted.envOverrides && typeof persisted.envOverrides");
    expect(legacy).toBeGreaterThan(0);
    expect(notice).toBeGreaterThan(legacy);
    expect(overrides).toBeGreaterThan(notice);
    // The shell prints it after the setup's clear, which wipes anything
    // written to the pane before it; it goes straight to the pane only when
    // nothing clears it (a tab with start commands).
    expect(src).toMatch(/display \+= buildNoticeSuffix\(modelNotice, false\);\s*if \(entryLive\(\) && ptyId\) \{/);
    expect(src).toMatch(/winDisplay \+= buildNoticeSuffix\(modelNotice, true\);\s*try \{ await invoke\("pty_write", \{ id: ptyId, data: winDisplay/);
    expect(src).toMatch(/\) \+ buildNoticeSuffix\(modelNotice, isWindowsUA\);\s*entry\.ui\.bannerCols\.set\(cols\);/);
    expect(src).toMatch(/if \(modelNotice && cmdsAtSpawn\.length > 0\) term\.writeln\(/);
    expect(src.match(/term\.writeln\([^)]*modelNotice/g)).toHaveLength(1);
  });
  test("TerminalPane waits for the keychain before it reads the pane's size, for local shells only (from source)", () => {
    const src = source("TerminalPane.jsx");
    const wait = src.indexOf("if (!serial && !connection) await keysReady(2000);");
    expect(wait).toBeGreaterThan(src.indexOf("const restored = await replayScrollback();"));
    expect(wait).toBeLessThan(src.indexOf("const cols = Math.max(term.cols, MIN_COLS);"));
    expect(src.match(/keysReady\(/g)).toHaveLength(1);
    // A fit during PTY creation reaches the PTY once the resize listener exists.
    const listener = src.indexOf("term.onResize(({ cols, rows }) => {");
    const sync = src.indexOf("if (entryLive() && ptyId && (Math.max(term.cols, MIN_COLS) !== cols || Math.max(term.rows, MIN_ROWS) !== rows)) {");
    expect(listener).toBeGreaterThan(0);
    expect(sync).toBeGreaterThan(listener);
    expect(src.slice(sync, sync + 400)).toMatch(/invoke\("pty_resize", \{ id: ptyId, cols: Math\.max\(term\.cols, MIN_COLS\), rows: Math\.max\(term\.rows, MIN_ROWS\) \}\)/);
  });
  test("the menu bar and the phone show the same state (TerminalsTab, from source)", () => {
    const src = source("TerminalsTab.jsx");
    expect(src).toMatch(/const activeModelName = validActiveModel\(userSt, \{ keysKnown: keysSettled\(\) \}\)\?\.model;/);
    expect(src).toMatch(/JSON\.stringify\(\{ active: choice, providers \}\)/);
  });
});

describe("Models", () => {
  function renderPicker(userSt, saveUser = vi.fn()) {
    render(
      <ToastProvider>
        <ModelPicker open onClose={() => {}} userSt={userSt} saveUser={saveUser} />
      </ToastProvider>,
    );
    return saveUser;
  }
  test("a bad typed id is refused with the rule spelled out", async () => {
    const saveUser = renderPicker({ providerKeys: { anthropic: "sk-ant-test" } });
    fireEvent.change(screen.getByPlaceholderText("…or type any model id"), { target: { value: "-rf" } });
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(await screen.findByText(/A model id uses letters, digits and .* does not start with a dash/)).toBeTruthy();
    expect(saveUser).not.toHaveBeenCalled();
  });
  test("a good typed id is saved, the 1M-context suffix included", () => {
    const saveUser = renderPicker({ providerKeys: { anthropic: "sk-ant-test" } });
    fireEvent.change(screen.getByPlaceholderText("…or type any model id"), { target: { value: " sonnet[1m] " } });
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(saveUser).toHaveBeenCalledTimes(1);
    expect(saveUser.mock.calls[0][0].activeModel).toEqual({ providerId: "anthropic", model: "sonnet[1m]" });
  });
  test("a choice that could not be used is refused when it is picked, with the reason", async () => {
    // The custom row opens because the saved choice is there; its base URL has a space.
    const saveUser = renderPicker({
      providerKeys: { custom: "sk-custom" },
      providerBaseUrls: { custom: "http://my host:11434/v1" },
      activeModel: { providerId: "custom", model: "m" },
    });
    fireEvent.change(screen.getByPlaceholderText("…or type any model id"), { target: { value: "qwen2.5-coder:7b" } });
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(await screen.findByText(/That choice cannot be used: its base URL has a space/)).toBeTruthy();
    expect(saveUser).not.toHaveBeenCalled();
  });
  test("a saved choice that cannot be used shows as none, with the reason and a way back", () => {
    renderPicker({ providerKeys: { anthropic: "sk-ant-test" }, activeModel: { providerId: "anthropic", model: "two words" } });
    expect(screen.getByText("Active: none")).toBeTruthy();
    expect(screen.getByText(/Your saved choice \(two\?words\) cannot be used: its model id has characters/)).toBeTruthy();
    expect(screen.getByText(/which clears it on your synced devices too/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use default" })).toBeTruthy();
  });
  test("the reason line never prints a control or bidi character from a synced id", () => {
    renderPicker({ providerKeys: { anthropic: "sk-ant-test" }, activeModel: { providerId: "anthropic", model: "a" + ESC + "[31mb" + chr(0x202e) + "c" } });
    const line = screen.getByText(/Your saved choice/).textContent;
    expect(line).toContain("(a?[31mb?c)");
    expect(line).not.toContain(ESC);
    expect(line).not.toContain(chr(0x202e));
  });
  test("the reason line cuts a long id at 60 characters", () => {
    renderPicker({ providerKeys: { anthropic: "sk-ant-test" }, activeModel: { providerId: "anthropic", model: "two words" + "y".repeat(80) } });
    expect(screen.getByText(/Your saved choice/).textContent).toContain("(two?words" + "y".repeat(51) + ")");
  });
  test("Anthropic's own standalone key counts for an Anthropic choice in Models too", () => {
    renderPicker({ anthropicKey: "sk-legacy", activeModel: { providerId: "anthropic", model: "claude-opus-5-5" } });
    expect(screen.queryByText(/cannot be used/)).toBeNull();
  });
  test("Anthropic's own standalone key is enough to pick an Anthropic model, as everywhere else", () => {
    const saveUser = renderPicker({ anthropicKey: "sk-legacy" });
    fireEvent.change(screen.getByPlaceholderText("…or type any model id"), { target: { value: "claude-opus-5-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(saveUser).toHaveBeenCalledTimes(1);
    expect(saveUser.mock.calls[0][0].activeModel).toEqual({ providerId: "anthropic", model: "claude-opus-5-5" });
  });
  test("leaving a field does not erase a saved choice that cannot be used", () => {
    // Every save writes the picker's choice back, and activeModel syncs to the
    // user's other devices, so a stand-in null here would erase it there too.
    const savedChoice = { providerId: "anthropic", model: "two words" };
    const saveUser = renderPicker({ providerKeys: { anthropic: "sk-ant-test" }, activeModel: savedChoice });
    fireEvent.blur(screen.getByPlaceholderText(/API key/));
    expect(saveUser).toHaveBeenCalled();
    expect(saveUser.mock.calls.at(-1)[0].activeModel).toEqual(savedChoice);
  });
  test("a valid saved choice shows as active, with no warning", () => {
    renderPicker({ providerKeys: { anthropic: "sk-ant-test" }, activeModel: { providerId: "anthropic", model: "claude-opus-5-5" } });
    expect(screen.queryByText(/Active: none|Active: default/)).toBeNull();
    expect(screen.queryByText(/cannot be used/)).toBeNull();
  });
});
