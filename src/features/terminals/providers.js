// (C)
// Multi-LLM provider catalog (Hermes-style, modeled on the providers Nous
// Research's Hermes Agent supports). The app does NOT proxy API calls — it picks
// WHICH env vars to inject at shell spawn, and the CLI agent the user runs reads
// them:
//   - kind "anthropic" / "anthropic-compat"  →  Claude Code reads
//       ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) + ANTHROPIC_MODEL
//   - kind "openai" / "openai-compat"  →  Codex & OpenAI-style tools read
//       OPENAI_BASE_URL + OPENAI_API_KEY + OPENAI_MODEL
// Model IDs drift fast. The `models` below are only the BUILT-IN fallback: once
// a provider has a key, the picker shows the list the provider itself publishes
// (modelCatalog.js -> llm_list_models), so a model released after this build
// still appears. These lists show before a key is entered, or when a provider
// has no list endpoint or the fetch fails. Every provider also accepts a typed
// model id. The "custom" provider (allowBaseUrl) lets the user point at ANY
// OpenAI-compatible endpoint — Hermes' "or any endpoint" escape hatch.
// Base URLs verified against https://hermes-agent.nousresearch.com/docs/integrations/providers

export const PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    runsWith: "Claude Code",
    keysUrl: "https://console.anthropic.com/settings/keys",
    // Current generation first. Ids from Anthropic's model catalog (2026-09-25).
    models: [
      "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001",
      "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8",
    ],
  },
  {
    id: "nous",
    label: "Nous Portal · Hermes (Nous Research)",
    kind: "openai-compat",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://portal.nousresearch.com/api-docs",
    models: ["Hermes-4-405B", "Hermes-4-70B", "Hermes-3-Llama-3.1-405B"],
  },
  {
    id: "openrouter",
    label: "OpenRouter (300+ models)",
    kind: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://openrouter.ai/keys",
    models: [
      "nousresearch/hermes-4-405b", "anthropic/claude-sonnet-4", "openai/gpt-4o",
      "openai/o4-mini", "google/gemini-2.5-pro", "google/gemini-2.0-flash-001",
      "deepseek/deepseek-chat", "x-ai/grok-2", "meta-llama/llama-3.3-70b-instruct",
      "qwen/qwen-2.5-72b-instruct", "mistralai/mistral-large", "moonshotai/kimi-k2",
      "z-ai/glm-4.6", "minimax/minimax-m2",
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://platform.openai.com/api-keys",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o4-mini", "o3"],
  },
  {
    id: "google",
    label: "Google · Gemini",
    kind: "openai-compat",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://aistudio.google.com/apikey",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
  },
  {
    id: "moonshot",
    label: "Moonshot · Kimi K2",
    kind: "anthropic-compat",
    baseUrl: "https://api.moonshot.ai/anthropic",
    runsWith: "Claude Code",
    keysUrl: "https://platform.moonshot.ai/console/api-keys",
    models: ["kimi-k2.5", "kimi-k2-turbo-preview", "kimi-k2-0711-preview", "moonshot-v1-128k"],
  },
  {
    id: "zai",
    label: "Z.AI · GLM (Zhipu)",
    kind: "anthropic-compat",
    baseUrl: "https://api.z.ai/api/anthropic",
    runsWith: "Claude Code",
    keysUrl: "https://z.ai/manage-apikey/apikey-list",
    models: ["glm-4.6", "glm-4.5", "glm-4.5-air"],
  },
  {
    id: "minimax",
    label: "MiniMax",
    kind: "anthropic-compat",
    baseUrl: "https://api.minimax.io/anthropic",
    runsWith: "Claude Code",
    keysUrl: "https://platform.minimax.io/",
    models: ["MiniMax-M2", "MiniMax-Text-01"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai-compat",
    baseUrl: "https://api.deepseek.com",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://platform.deepseek.com/api_keys",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "dashscope",
    label: "Alibaba · Qwen (DashScope)",
    kind: "openai-compat",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://bailian.console.alibabacloud.com/",
    models: ["qwen-max", "qwen-plus", "qwen3-coder-plus", "qwen-turbo"],
  },
  {
    id: "groq",
    label: "Groq (fast inference)",
    kind: "openai-compat",
    baseUrl: "https://api.groq.com/openai/v1",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://console.groq.com/keys",
    models: ["llama-3.3-70b-versatile", "moonshotai/kimi-k2-instruct", "qwen-2.5-coder-32b"],
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    kind: "openai-compat",
    baseUrl: "https://api.x.ai/v1",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://console.x.ai/",
    models: ["grok-2-latest", "grok-beta"],
  },
  {
    id: "mistral",
    label: "Mistral",
    kind: "openai-compat",
    baseUrl: "https://api.mistral.ai/v1",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://console.mistral.ai/api-keys",
    models: ["mistral-large-latest", "codestral-latest"],
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    kind: "openai-compat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://build.nvidia.com",
    models: ["deepseek-ai/deepseek-r1", "meta/llama-3.3-70b-instruct", "qwen/qwen2.5-coder-32b-instruct"],
  },
  {
    id: "huggingface",
    label: "Hugging Face (Inference)",
    kind: "openai-compat",
    baseUrl: "https://router.huggingface.co/v1",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://huggingface.co/settings/tokens",
    models: ["meta-llama/Llama-3.3-70B-Instruct", "Qwen/Qwen2.5-Coder-32B-Instruct", "deepseek-ai/DeepSeek-V3"],
  },
  {
    id: "custom",
    label: "Custom (any OpenAI-compatible endpoint)",
    kind: "openai-compat",
    baseUrl: "", // user-supplied — see allowBaseUrl
    allowBaseUrl: true,
    runsWith: "Codex / OpenAI tools",
    keysUrl: "",
    models: [],
  },
];

// The one rule for a model id the app stores and hands to new shells as
// ANTHROPIC_MODEL / OPENAI_MODEL: 1 to 200 characters from the set real model
// ids use (letters, digits and . _ - : / @ + ~ = # [ ]), not starting with
// "-", which a script passing the variable unquoted would read as a flag. The
// set covers OpenRouter's ~vendor/... and @preset/..., Cloudflare's @cf/...,
// the local path vLLM serves as its id (/models/Qwen2.5-7B-Instruct), a
// Fireworks dedicated deployment (model#deployment), and Claude Code's own
// "[1m]" suffix (sonnet[1m] is Sonnet with the 1M context). It is
// the rule llm.rs clean_model_id holds a provider's own list to (a Rust test
// pins this line to it). Every way an id can be set passes through it: typed
// in Models, sent from the phone, and once more at spawn, which also covers an
// id synced from another device. So a NUL byte or an oversized value cannot
// stop shells from starting, and no escape sequence rides along into a tool
// that prints the model name.
const MODEL_ID_RE = /^(?!-)[A-Za-z0-9._:/@+~=#[\]-]{1,200}$/;
export function isModelId(id) {
  return typeof id === "string" && MODEL_ID_RE.test(id);
}

// What the phone's model pick changes, or null to ignore it: a known provider
// that has a key on this machine, and a model id that passes isModelId. Nothing
// else from the payload is kept.
export function phoneModelChoice(payload, userSt) {
  const providerId = payload?.providerId;
  const model = typeof payload?.model === "string" ? payload.model.trim() : "";
  if (typeof providerId !== "string" || !isModelId(model)) return null;
  if (!findProvider(providerId) || !providerKeyFor(userSt, providerId)) return null;
  return { providerId, model };
}

// A base URL a new shell can be handed as an environment variable: at most
// 2048 characters, with no space or control character, which could stop the
// shell starting or split a tool's config line. Where it points stays the
// user's call, as it always was for shells: a homelab gateway on a bare LAN
// name (http://mac-mini:11434), a Tailscale address or host.docker.internal
// is a normal setup. The app's own calls keep the stricter https rule
// (llm.rs resolve_base).
function shellSafeBaseUrl(url) {
  return typeof url === "string" && url.length <= 2048 && !hasControlOrSpace(url);
}

// Whether `s` holds a character that has no place in an address handed to a
// shell as an environment variable: a control character (C0, DEL and C1, NEL
// among them), a format character (zero-width ones, bidi marks, the BOM), a
// space or a line or paragraph separator of any kind, or a lone surrogate,
// which would make the whole spawn request unencodable so that no new shell
// starts. Some tools split a config line at the separators, and the invisible
// ones would hide in a value.
const NOT_IN_A_SHELL_VALUE = /[\p{Cc}\p{Cf}\p{Cs}\p{Z}]/u;
function hasControlOrSpace(s) {
  return NOT_IN_A_SHELL_VALUE.test(s);
}

// The API key this device holds for `providerId`, or "" when it holds none:
// the Models key, or for Anthropic itself the standalone key from before
// Models held keys (falling back to it is no swap of provider). Every check
// of whether a provider has a key asks here, so new shells, the in-app AI,
// Models, the phone and activeModelProblem cannot disagree about it.
export function providerKeyFor(userSt, providerId) {
  if (typeof providerId !== "string") return "";
  const keys = userSt?.providerKeys;
  const k = keys && typeof keys === "object" && Object.prototype.hasOwnProperty.call(keys, providerId) ? keys[providerId] : undefined;
  if (typeof k === "string" && k.trim()) return k;
  const legacy = providerId === "anthropic" ? userSt?.anthropicKey : undefined;
  if (typeof legacy === "string" && legacy.trim()) return legacy;
  return "";
}

// Why the saved model choice cannot be used, or null when it can: an unknown
// provider (synced from a newer build, say), an id that fails isModelId (typed
// or synced before the rule existed), a provider with no API key on this
// device, or one that needs a base URL and has none here (the choice syncs
// between devices; keys and addresses do not), or a base URL that fails
// shellSafeBaseUrl. A choice with a problem routes NOWHERE, not to the default
// Claude key: the user picked a provider, and quietly sending their terminal
// text to a different one would break that choice (an internal gateway picked
// for confidentiality, say). New shells get no provider key, the in-app AI
// says no model is configured, the menu bar and the phone show none, and
// Models says why and offers Use default.
// `keysKnown: false` (before the first keychain read has finished, see
// secretVault keysSettled) skips the key check: a key that has not been read
// yet is not a missing key.
export function activeModelProblem(userSt, { keysKnown = true } = {}) {
  const am = userSt?.activeModel;
  if (!am) return null;
  const p = typeof am.providerId === "string" ? findProvider(am.providerId) : null;
  if (!p) return "its provider is not one this app knows";
  if (!isModelId(am.model)) return "its model id has characters a model id never has";
  if (keysKnown && !providerKeyFor(userSt, am.providerId)) return "its provider has no API key on this device (adding one fixes it)";
  const url = resolveBaseUrl(p, userSt?.providerBaseUrls?.[am.providerId]);
  if (!url && (p.kind === "anthropic-compat" || p.kind === "openai-compat")) {
    return "its provider has no base URL on this device (adding one fixes it)";
  }
  if (url && !shellSafeBaseUrl(url)) return "its base URL has a space or a control character in it, or is too long";
  return null;
}

// The saved model choice when it can be used (activeModelProblem, with the
// same options), else null.
export function validActiveModel(userSt, opts) {
  const am = userSt?.activeModel;
  if (!am || activeModelProblem(userSt, opts)) return null;
  return { providerId: am.providerId, model: am.model };
}

// What the AI panels say when resolveActiveLLM finds no model: the saved
// choice's problem when there is one, else how to set one up.
export function noModelMessage(userSt) {
  const problem = userSt?.activeModel ? activeModelProblem(userSt) : null;
  return problem
    ? `Your saved model choice cannot be used: ${problem}. Open the Models picker (toolbar) to fix it, or choose Use default there.`
    : "No model configured. Open the Models picker (toolbar) first.";
}

export function findProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

// Resolve the base URL for a provider: a user-supplied override (custom
// endpoints, regional mirrors) wins over the catalog default. Exported for
// modelCatalog.js, which must list models from the same endpoint a spawned
// shell will route to.
export function resolveBaseUrl(p, override) {
  const o = typeof override === "string" ? override.trim() : "";
  return o || p.baseUrl || "";
}

// Resolve the LLM the AI panels should call, from user-state. Prefers the
// active picked model; with no model picked, falls back to the plain Anthropic
// key (default Claude). Returns null when nothing is configured, and when the
// saved choice cannot be used (activeModelProblem; noModelMessage says which).
// Shape: { kind, baseUrl, apiKey, model }.
export function resolveActiveLLM(userSt) {
  // A saved choice that cannot be used routes nowhere (activeModelProblem):
  // falling back to the default key would send the text to a provider the user
  // did not pick. The callers then say no model is configured.
  if (userSt?.activeModel && activeModelProblem(userSt)) return null;
  const am = userSt?.activeModel;
  const baseUrls = userSt?.providerBaseUrls || {};
  const amKey = am?.providerId ? providerKeyFor(userSt, am.providerId) : "";
  if (am?.providerId && am?.model && amKey) {
    const p = findProvider(am.providerId);
    if (p) {
      const baseUrl = resolveBaseUrl(p, baseUrls[am.providerId]);
      // Compat kinds can't route without a base URL (e.g. custom with none set).
      if ((p.kind === "anthropic-compat" || p.kind === "openai-compat") && !baseUrl) return null;
      return { kind: p.kind, baseUrl, apiKey: amKey, model: am.model };
    }
  }
  // Default Claude key: the Models section's Anthropic key, falling back to the
  // legacy standalone key for not-yet-migrated state.
  const defaultAnthropic = providerKeyFor(userSt, "anthropic");
  if (defaultAnthropic) {
    // Cheap, fast Claude for quick explanations (exact dated id so it resolves).
    return { kind: "anthropic", baseUrl: "", apiKey: defaultAnthropic, model: "claude-haiku-4-5-20251001" };
  }
  return null;
}

// Build the env-var overrides for the active provider/model so a freshly
// spawned shell's CLI agent (claude / codex) routes to it automatically.
// `baseUrl` overrides the catalog default (custom endpoints / regional mirrors).
export function envForModel(providerId, model, apiKey, baseUrl) {
  const p = findProvider(providerId);
  // An id that fails isModelId or a base URL that fails shellSafeBaseUrl routes
  // nothing (and resolveEnvFromUserState withholds the default key as well).
  if (!p || !apiKey || !isModelId(model)) return {};
  const url = resolveBaseUrl(p, baseUrl);
  if (url && !shellSafeBaseUrl(url)) return {};
  const e = {};
  if (p.kind === "anthropic") {
    e.ANTHROPIC_API_KEY = apiKey;
    e.ANTHROPIC_MODEL = model;
  } else if (p.kind === "anthropic-compat") {
    if (!url) return {}; // can't route a compat provider without a base URL
    e.ANTHROPIC_BASE_URL = url;
    e.ANTHROPIC_AUTH_TOKEN = apiKey;
    e.ANTHROPIC_MODEL = model;
  } else if (p.kind === "openai") {
    e.OPENAI_API_KEY = apiKey;
    e.OPENAI_MODEL = model;
  } else if (p.kind === "openai-compat") {
    if (!url) return {};
    e.OPENAI_BASE_URL = url;
    e.OPENAI_API_KEY = apiKey;
    e.OPENAI_MODEL = model;
  }
  return e;
}
