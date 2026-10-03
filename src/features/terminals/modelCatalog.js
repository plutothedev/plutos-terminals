// (C)
// Live model lists for the Models picker and the phone's copy of it.
//
// providers.js types each provider's models by hand, so a build only knew the
// models that existed when it shipped: v0.7.1 stopped at Claude Opus 4.8 and
// never showed Opus 5.5. Every provider the app routes to publishes the models
// it serves, so the picker asks it (llm_list_models in llm.rs, with the user's
// own key) and caches the answer here. The hand-typed list stays as the
// fallback: no key yet, a provider without a list endpoint, or a failed fetch.
//
// The cache is its own localStorage key, not a userSt field. It is machine
// state that can run to thousands of ids (OpenRouter, Hugging Face), every
// saveUser rewrites the whole userSt blob, and none of it should ride cloud
// sync. It sits under the "plutos-terminals:" prefix so a factory reset wipes
// it, and every write honours the reset's write hold.
//
// API keys never land here. A list is tied to the endpoint it came from
// (`base`), and the picker refetches when the key itself changes.

import { useSyncExternalStore } from "react";
import { invoke } from "@backend";
import { PROVIDERS, findProvider, resolveBaseUrl } from "./providers.js";
import { localWriteHolds, readUserSt } from "./storageKeys.js";

export const MODEL_CACHE_KEY = "plutos-terminals:models:v1";
const DAY_MS = 24 * 60 * 60 * 1000;
// The picker refreshes a list older than this when its row is opened.
export const PICKER_REFRESH_MS = 60 * 60 * 1000;
// The launch pass refreshes a list older than this, quietly.
export const LAUNCH_REFRESH_MS = 12 * 60 * 60 * 1000;
// After a failed fetch, automatic refreshes wait this long. Refresh/Retry in
// the picker always goes straight through.
export const ERROR_BACKOFF_MS = 5 * 60 * 1000;
// An address that answered 404 has no list there (Moonshot's Claude-compatible
// base, checked live 2026-10-03), so it is not asked again for a week.
export const NOT_LISTED_BACKOFF_MS = 7 * DAY_MS;
// A model released within this window gets a "new" label.
export const NEW_WINDOW_MS = 30 * DAY_MS;
// The latest release date believed, 2100-01-01 in unix seconds (llm.rs
// MAX_CREATED_SECS). llm.rs already range-checks; this guards anything else
// that reached the cache, because an out-of-range date throws when formatted.
const MAX_CREATED_SECS = 4_102_444_800;
// Most models the phone's picker is sent per provider.
export const PHONE_MAX_PER_PROVIDER = 60;
// Most models cached per provider (llm.rs keeps up to 5000; nobody scrolls that).
const MAX_CACHED_PER_PROVIDER = 2000;

// ── Which models a chat agent can drive ─────────────────────────────────────
// List endpoints return every model on the account, and OpenAI's is about 40%
// embeddings, speech, image, video and moderation models that Codex or Claude
// Code cannot run. Those are hidden. A hidden model is still one typed id away
// ("...or type any model id").
const NON_CHAT_RE =
  /(?:^|[-/_.:])(?:text-embedding|embeddings?|embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|sora|rerank(?:er)?)(?=$|[-/_.:\d])/i;

export function isChatModel(id) {
  return typeof id === "string" && !NON_CHAT_RE.test(id);
}

// Dated models newest first; undated ones after them, in the provider's own
// order (Array.prototype.sort is stable).
function byNewest(a, b) {
  const ca = Number.isFinite(a.created) ? a.created : null;
  const cb = Number.isFinite(b.created) ? b.created : null;
  if (ca === cb) return 0;
  if (ca === null) return 1;
  if (cb === null) return -1;
  return cb - ca;
}

// One provider's cached list, cleaned for display: chat models only, no
// duplicates, newest first. Gemini's OpenAI-compatible endpoint names models
// "models/<id>" while its chat endpoint takes the bare id, so that prefix is
// dropped for Google.
export function normalizeModels(providerId, models) {
  const seen = new Set();
  const out = [];
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || typeof m.id !== "string") continue;
    const id = providerId === "google" && m.id.startsWith("models/") ? m.id.slice("models/".length) : m.id;
    if (!id || seen.has(id) || !isChatModel(id)) continue;
    seen.add(id);
    const created = Number.isFinite(m.created) && m.created > 0 && m.created <= MAX_CREATED_SECS ? m.created : undefined;
    out.push({ id, name: typeof m.name === "string" && m.name ? m.name : undefined, created });
  }
  return out.sort(byNewest);
}

// ── The cache ───────────────────────────────────────────────────────────────
// Shape: { [providerId]: { base, fetchedAt?, models: [{id, name?, created?}],
//          error?, errorAt? } }

let cacheMemo = { raw: null, parsed: {} };
export function readModelCache() {
  let raw = null;
  try { raw = localStorage.getItem(MODEL_CACHE_KEY); } catch { return {}; }
  if (raw !== cacheMemo.raw) {
    let parsed = {};
    try {
      const v = JSON.parse(raw || "{}");
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v;
    } catch { /* corrupt: start empty, the next fetch rewrites it */ }
    cacheMemo = { raw, parsed };
  }
  return cacheMemo.parsed;
}

let version = 0;
const listeners = new Set();
function bump() {
  version += 1;
  for (const fn of [...listeners]) fn();
}

function writeEntry(providerId, entry) {
  if (localWriteHolds() > 0) return false; // a factory reset is in flight
  try {
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({ ...readModelCache(), [providerId]: entry }));
  } catch {
    return false; // storage full or unavailable: the picker falls back to the built-in list
  }
  bump();
  return true;
}

// Another window refreshed a list: its write arrives here as a storage event.
// One window-level listener, installed while anything is subscribed.
function onStorage(e) {
  if (e.key === MODEL_CACHE_KEY || e.key === null) bump();
}

export function subscribeModelCache(fn) {
  listeners.add(fn);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function getModelCacheVersion() {
  return version;
}

// Re-render when any provider's list changes, in this window or another.
export function useModelCacheVersion() {
  return useSyncExternalStore(subscribeModelCache, getModelCacheVersion);
}

// ── Fetching ────────────────────────────────────────────────────────────────

// Where to ask for a provider's list, or null when it cannot be asked: no key,
// or a compatible provider with no base URL to route to (the same rule
// envForModel and resolveActiveLLM apply). The key goes as stored, exactly as
// a spawned shell will send it, so the list reflects what that shell can reach.
export function listTarget(provider, apiKey, baseUrlOverride) {
  if (!provider || typeof apiKey !== "string" || !apiKey.trim()) return null;
  const baseUrl = resolveBaseUrl(provider, baseUrlOverride);
  if ((provider.kind === "anthropic-compat" || provider.kind === "openai-compat") && !baseUrl) return null;
  return { kind: provider.kind, baseUrl, apiKey };
}

// The address answered 404 and has never given a list: it has none there.
// llm.rs leads every HTTP failure with "HTTP <code>:" for exactly this test.
export function isNotListed(entry) {
  return !!entry && !entry.fetchedAt && typeof entry.error === "string" && /^HTTP 404\b/.test(entry.error);
}

// Whether the last attempt failed (no list since the failure).
function lastAttemptFailed(entry) {
  return !!entry?.errorAt && (!entry.fetchedAt || entry.errorAt > entry.fetchedAt);
}

// Whether an automatic refresh is due. A list from a different endpoint is
// always due; an address with no list waits a week, a fetch that failed a
// moment ago waits five minutes (Refresh/Retry bypasses both); otherwise it is
// due once older than `maxAgeMs`.
export function needsRefresh(entry, base, maxAgeMs, now = Date.now()) {
  if (!entry || entry.base !== base) return true;
  if (isNotListed(entry) && now - entry.errorAt < NOT_LISTED_BACKOFF_MS) return false;
  if (entry.errorAt && now - entry.errorAt < ERROR_BACKOFF_MS) return false;
  return !entry.fetchedAt || now - entry.fetchedAt > maxAgeMs;
}

const inflight = new Map(); // providerId -> { key, promise }
const latest = new Map(); // providerId -> sequence of the newest request

// Provider wording can quote the key back. OpenAI's refusal quotes part of it,
// and a debug gateway may echo all of it in forms no redaction can promise to
// catch (a short key, an upper-cased or percent-encoded one). The cache is
// plaintext localStorage that outlives the session, so it keeps only a fixed
// summary of a failure; the full text (already redacted by llm.rs) is held in
// memory for this session and is what the picker shows while it lasts
// (review 2026-10-03).
const sessionErrors = new Map(); // providerId -> { at: errorAt, text }

// The fixed summary of an llm_list_models failure. Never contains provider
// wording: the HTTP status when there was one, else one of llm.rs's own fixed
// sentences, else a generic line. isNotListed reads the "HTTP 404" form.
export function errorSummary(text) {
  const t = String(text ?? "");
  const http = /^HTTP (\d{3})\b/.exec(t);
  if (http) return `HTTP ${http[1]}`;
  if (t.startsWith("No API key is set")) return "No API key is set for this provider.";
  if (t.startsWith("The provider answered without a model list")) return "The provider answered without a model list.";
  if (t.startsWith("The provider's model list is larger than")) return "The provider's model list is too large.";
  if (t.startsWith("The provider's model list was not valid JSON")) return "The provider's model list was not valid JSON.";
  if (t.startsWith("Refusing to send the API key")) return "Refused to send the key: the address is not https.";
  return "Could not reach the provider.";
}

// The error text to show for an entry: this session's full text when it
// belongs to the failure on record, else the cached summary.
function shownError(providerId, entry) {
  const s = sessionErrors.get(providerId);
  return s && s.at === entry.errorAt ? s.text : entry.error || "unknown error";
}

// Whether this window is fetching a provider's list right now. A fetch
// starting or ending bumps the cache version, so a component reading this
// under useModelCacheVersion re-renders on both edges without local state.
export function isRefreshing(providerId) {
  return inflight.has(providerId);
}

// Fetch a provider's list and cache it. Resolves to the cache entry, or null
// when the provider cannot be asked (see listTarget). Never rejects: a failure
// is recorded on the entry, which keeps the previous list for the same
// endpoint so one bad fetch does not empty a good picker.
export function refreshModels(providerId, apiKey, baseUrlOverride) {
  const target = listTarget(findProvider(providerId), apiKey, baseUrlOverride);
  if (!target) return Promise.resolve(null);
  // A second request for the same key and endpoint shares the first one.
  const key = `${target.baseUrl}\n${target.apiKey}`;
  const running = inflight.get(providerId);
  if (running && running.key === key) return running.promise;

  const seq = (latest.get(providerId) || 0) + 1;
  latest.set(providerId, seq);
  // The record exists before the fetch starts, so cleanup can name it even
  // when invoke throws synchronously and the whole body runs before the
  // promise below is assigned.
  const record = { key, promise: null };
  inflight.set(providerId, record);
  bump(); // "loading" is on
  record.promise = (async () => {
    let entry;
    let failure = null; // { at, text }: this session's full error text
    try {
      const models = await invoke("llm_list_models", target);
      entry = {
        base: target.baseUrl,
        fetchedAt: Date.now(),
        models: Array.isArray(models) ? models.slice(0, MAX_CACHED_PER_PROVIDER) : [],
      };
    } catch (e) {
      const prev = readModelCache()[providerId];
      const kept = prev && prev.base === target.baseUrl ? prev : { base: target.baseUrl, models: [] };
      failure = { at: Date.now(), text: String(e?.message ?? e ?? "unknown error").slice(0, 300) };
      entry = { ...kept, error: errorSummary(failure.text), errorAt: failure.at };
    } finally {
      if (inflight.get(providerId) === record) inflight.delete(providerId);
    }
    // A newer request (a different key or endpoint) owns the entry now; an
    // older answer landing late must not overwrite it.
    if (latest.get(providerId) !== seq) {
      bump(); // "loading" is off; the newer request writes the entry
      return readModelCache()[providerId] || null;
    }
    if (failure) sessionErrors.set(providerId, failure);
    else sessionErrors.delete(providerId);
    // writeEntry bumps on success. A held or failed write still has to turn
    // "loading" off.
    if (!writeEntry(providerId, entry)) bump();
    return entry;
  })();
  return record.promise;
}

// Launch pass: refresh any list older than LAUNCH_REFRESH_MS for the providers
// that have a key, one at a time. Failures are recorded on the entry (the
// picker shows them) and never interrupt anything.
//
// This sends keys with no click, so it is narrower than the picker
// (review 2026-10-03):
//  - https only. A plain-http LAN gateway (the custom row allows one) gets its
//    key when the user opens its row, never because the app was launched on
//    whatever network the laptop is on.
//  - an address that has never answered with a list (including a 404, which
//    has none) is asked at most once unattended: after that first failure it
//    is left for the user, so a key is not resent at every launch to
//    something that never answered. An address never asked before (no cache
//    entry) is asked once. One that answered before is retried after a
//    failure: a single launch with no network must not stop its refreshes
//    for good (review round 2).
//  - keys are read per provider, at the moment of asking (`getUserSt` must be
//    keychain-overlaid, as readUserSt is), and a provider the user is already
//    fetching is skipped: a pass that started with the old key must never
//    overwrite the list a new key just asked for.
export async function refreshStaleLists(getUserSt = readUserSt, now = Date.now()) {
  for (const p of PROVIDERS) {
    const u = getUserSt() || {};
    const key = u.providerKeys?.[p.id];
    const baseOverride = u.providerBaseUrls?.[p.id];
    const target = listTarget(p, key, baseOverride);
    if (!target || isRefreshing(p.id)) continue;
    if (target.baseUrl && !/^https:\/\//i.test(target.baseUrl)) continue;
    const entry = readModelCache()[p.id];
    if (entry && entry.base === target.baseUrl && !entry.fetchedAt && lastAttemptFailed(entry)) continue;
    if (!needsRefresh(entry, target.baseUrl, LAUNCH_REFRESH_MS, now)) continue;
    await refreshModels(p.id, key, baseOverride);
  }
}

// ── What the picker and the phone show ──────────────────────────────────────

// One provider's list as the picker shows it. `source` is "live" when the
// provider's own list is cached for this endpoint and holds at least one chat
// model, else "builtin" (providers.js). `error` is the last failure, when it is
// newer than the list on show.
export function pickerList(provider, entry, base, now = Date.now()) {
  const usable = entry && entry.base === base ? entry : null;
  const live = usable?.fetchedAt ? normalizeModels(provider.id, usable.models) : [];
  const failedSince = lastAttemptFailed(usable);
  const error = failedSince ? shownError(provider.id, usable) : null;
  if (live.length) {
    return {
      source: "live",
      fetchedAt: usable.fetchedAt,
      error,
      // "New" means released recently, so a date in the future is not new.
      models: live.map((m) => {
        const age = m.created ? now - m.created * 1000 : null;
        return { ...m, isNew: age !== null && age >= -DAY_MS && age < NEW_WINDOW_MS };
      }),
    };
  }
  return {
    source: "builtin",
    fetchedAt: null,
    error,
    // This address has no list (404), as opposed to a failed fetch.
    notListed: isNotListed(usable),
    // Fetched fine, but nothing in it was a chat model.
    emptyLive: !!usable?.fetchedAt && !failedSince,
    models: (provider.models || []).map((id) => ({ id })),
  };
}

// The phone's picker gets ids only, newest first, capped so a 300-model
// OpenRouter list stays a list. The active model rides along even when the cap
// (or the list) would leave it out, so the phone always shows which one is on.
export function phoneModelIds(provider, entry, base, active, cap = PHONE_MAX_PER_PROVIDER) {
  const ids = pickerList(provider, entry, base).models.slice(0, cap).map((m) => m.id);
  if (active?.providerId === provider.id && typeof active.model === "string" && active.model && !ids.includes(active.model)) {
    ids.push(active.model);
  }
  return ids;
}

// "just now" / "5 min ago" / "3 h ago" / "2 d ago", for the picker's status line.
export function agoLabel(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
