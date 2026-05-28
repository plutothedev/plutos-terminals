// (C)
// Multi-LLM provider catalog (Hermes-style). The app routes CLI agents to any
// provider by injecting env vars at shell spawn — no per-shell pasting:
//   - kind "anthropic" / "anthropic-compat"  →  Claude Code reads
//       ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) + ANTHROPIC_MODEL
//   - kind "openai" / "openai-compat"  →  Codex & OpenAI-style tools read
//       OPENAI_BASE_URL + OPENAI_API_KEY + OPENAI_MODEL
// Model IDs drift, so every provider also accepts a custom model id in the UI.
// OpenRouter is the long tail (300+ models behind one key).

export const PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    runsWith: "Claude Code",
    keysUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
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
    id: "openrouter",
    label: "OpenRouter (300+ models)",
    kind: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://openrouter.ai/keys",
    models: [
      "anthropic/claude-sonnet-4", "openai/gpt-4o", "openai/o4-mini",
      "google/gemini-2.0-flash-001", "deepseek/deepseek-chat", "x-ai/grok-2",
      "meta-llama/llama-3.3-70b-instruct", "qwen/qwen-2.5-72b-instruct",
      "mistralai/mistral-large", "moonshotai/kimi-k2",
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    runsWith: "Codex / OpenAI tools",
    keysUrl: "https://platform.openai.com/api-keys",
    models: ["gpt-4.1", "gpt-4o", "gpt-4o-mini", "o4-mini", "o3"],
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
];

export function findProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

// Resolve the LLM the AI error explainer should call, from user-state. Prefers
// the active picked model; falls back to the plain Anthropic key (default
// Claude) from the welcome screen. Returns null if nothing is configured.
// Shape: { kind, baseUrl, apiKey, model }.
export function resolveActiveLLM(userSt) {
  const am = userSt?.activeModel;
  const keys = userSt?.providerKeys || {};
  if (am?.providerId && am?.model && typeof keys[am.providerId] === "string" && keys[am.providerId]) {
    const p = findProvider(am.providerId);
    if (p) return { kind: p.kind, baseUrl: p.baseUrl || "", apiKey: keys[am.providerId], model: am.model };
  }
  if (typeof userSt?.anthropicKey === "string" && userSt.anthropicKey) {
    // Cheapest catalog Claude for quick explanations.
    return { kind: "anthropic", baseUrl: "", apiKey: userSt.anthropicKey, model: "claude-haiku-4-5" };
  }
  return null;
}

// Build the env-var overrides for the active provider/model so a freshly
// spawned shell's CLI agent (claude / codex) routes to it automatically.
export function envForModel(providerId, model, apiKey) {
  const p = findProvider(providerId);
  if (!p || !apiKey || !model) return {};
  const e = {};
  if (p.kind === "anthropic") {
    e.ANTHROPIC_API_KEY = apiKey;
    e.ANTHROPIC_MODEL = model;
  } else if (p.kind === "anthropic-compat") {
    e.ANTHROPIC_BASE_URL = p.baseUrl;
    e.ANTHROPIC_AUTH_TOKEN = apiKey;
    e.ANTHROPIC_MODEL = model;
  } else if (p.kind === "openai") {
    e.OPENAI_API_KEY = apiKey;
    e.OPENAI_MODEL = model;
  } else if (p.kind === "openai-compat") {
    e.OPENAI_BASE_URL = p.baseUrl;
    e.OPENAI_API_KEY = apiKey;
    e.OPENAI_MODEL = model;
  }
  return e;
}
