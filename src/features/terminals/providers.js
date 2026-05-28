// (C)
// Multi-LLM provider catalog (Hermes-style, modeled on the providers Nous
// Research's Hermes Agent supports). The app does NOT proxy API calls — it picks
// WHICH env vars to inject at shell spawn, and the CLI agent the user runs reads
// them:
//   - kind "anthropic" / "anthropic-compat"  →  Claude Code reads
//       ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) + ANTHROPIC_MODEL
//   - kind "openai" / "openai-compat"  →  Codex & OpenAI-style tools read
//       OPENAI_BASE_URL + OPENAI_API_KEY + OPENAI_MODEL
// Model IDs drift fast, so every provider also accepts a custom model id in the
// UI. The "custom" provider (allowBaseUrl) lets the user point at ANY
// OpenAI-compatible endpoint — Hermes' "or any endpoint" escape hatch.
// Base URLs verified against https://hermes-agent.nousresearch.com/docs/integrations/providers

export const PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    runsWith: "Claude Code",
    keysUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
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

export function findProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

// Resolve the base URL for a provider: a user-supplied override (custom
// endpoints, regional mirrors) wins over the catalog default.
function resolveBaseUrl(p, override) {
  const o = typeof override === "string" ? override.trim() : "";
  return o || p.baseUrl || "";
}

// Resolve the LLM the AI error explainer should call, from user-state. Prefers
// the active picked model; falls back to the plain Anthropic key (default
// Claude) from the welcome screen. Returns null if nothing is configured.
// Shape: { kind, baseUrl, apiKey, model }.
export function resolveActiveLLM(userSt) {
  const am = userSt?.activeModel;
  const keys = userSt?.providerKeys || {};
  const baseUrls = userSt?.providerBaseUrls || {};
  if (am?.providerId && am?.model && typeof keys[am.providerId] === "string" && keys[am.providerId]) {
    const p = findProvider(am.providerId);
    if (p) {
      const baseUrl = resolveBaseUrl(p, baseUrls[am.providerId]);
      // Compat kinds can't route without a base URL (e.g. custom with none set).
      if ((p.kind === "anthropic-compat" || p.kind === "openai-compat") && !baseUrl) return null;
      return { kind: p.kind, baseUrl, apiKey: keys[am.providerId], model: am.model };
    }
  }
  // Default Claude key: the Models section's Anthropic key, falling back to the
  // legacy standalone key for not-yet-migrated state.
  const defaultAnthropic = keys.anthropic || userSt?.anthropicKey;
  if (typeof defaultAnthropic === "string" && defaultAnthropic) {
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
  if (!p || !apiKey || !model) return {};
  const url = resolveBaseUrl(p, baseUrl);
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
