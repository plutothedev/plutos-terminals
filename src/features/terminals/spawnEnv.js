// (C)
// Pure environment-resolution transform for spawned shells.
//
// Extracted verbatim from TerminalPane.jsx's spawn effect (behavior-preserving
// refactor). This is the side-effect-free part of env resolution: given the
// already-read user-state object, it returns the env vars derived from the
// user's provider keys + active model. The I/O parts that read state stay in
// the component:
//   - readUserSt() (keychain-overlaid localStorage) — called at the call site
//   - localStorage.getItem(getWindowStorageKey()) per-window envOverrides
//     and legacy anthropicKey — applied at the call site after this transform
//
// Pass `envForModel` in as an argument to avoid a second import path; the
// component already imports it from "./providers.js". activeModelProblem is
// imported here instead, so no caller can leave the fail-closed check out.

import { activeModelProblem, providerKeyFor } from "./providers.js";

// Maps an already-read user-state blob into the provider-key / active-model
// portion of the spawn env. Returns a fresh object (possibly empty). Pure:
// reads only its arguments, performs no I/O, mutates nothing external.
export function resolveEnvFromUserState(userPersisted, envForModel) {
  const env = {};
  if (!userPersisted) return env;
  // A saved model choice that cannot be used (providers.js activeModelProblem)
  // routes nowhere, the default Claude key included: the user picked a
  // provider, and a new shell must not quietly send its work to a different
  // one. Models says what is wrong.
  if (userPersisted.activeModel && activeModelProblem(userPersisted)) return env;
  const baseUrls = (userPersisted && userPersisted.providerBaseUrls) || {};
  // Default Claude key now lives in the Models section as
  // providerKeys.anthropic (legacy userPersisted.anthropicKey is the
  // pre-consolidation fallback for not-yet-migrated state).
  const defaultAnthropic = providerKeyFor(userPersisted, "anthropic");
  if (defaultAnthropic) env.ANTHROPIC_API_KEY = defaultAnthropic;
  // Multi-LLM routing: if the user picked an active provider/model,
  // inject its env vars so `claude` / `codex` route there. Takes
  // precedence over the default ANTHROPIC_API_KEY above.
  const am = userPersisted && userPersisted.activeModel;
  const amKey = am && am.providerId ? providerKeyFor(userPersisted, am.providerId) : "";
  if (am && am.providerId && am.model && amKey) {
    Object.assign(env, envForModel(am.providerId, am.model, amKey, baseUrls[am.providerId]));
  }
  // A Claude-compatible gateway (ANTHROPIC_BASE_URL) gets its own token and
  // never an Anthropic key: Claude Code sends both on every request, so the
  // gateway's operator would receive a working Anthropic key. Blank, not
  // absent: a shell inherits the app's own environment, so an empty value is
  // what hides a key the user set there (one a shell startup file exports
  // still wins, and the CHANGELOG says so).
  if (env.ANTHROPIC_BASE_URL) env.ANTHROPIC_API_KEY = "";
  return env;
}

// The one dim line a new local shell shows when the app's keys did not reach
// it for a reason the user can act on, or "" when there is nothing to say.
// `env` is what the app put in the shell's environment (before the user's own
// envOverrides, which say nothing about the app's keys); `keysSettled` is
// whether the first keychain read has finished (secretVault). Until it has,
// a key not read yet is not a missing one: the line then says the keys were
// still loading, and only when none of the app's keys reached the shell
// (keys still in localStorage, before the keychain holds them, do). The text
// is the app's own; the saved id is never in it.
export function shellNotice(userPersisted, env, keysSettled) {
  const settled = keysSettled === true;
  const reason = userPersisted?.activeModel ? activeModelProblem(userPersisted, { keysKnown: settled }) : null;
  if (reason) return `[models] Your saved model choice cannot be used: ${reason}. This shell got no provider key; open Models to fix it.`;
  const appKey = Boolean(env?.ANTHROPIC_API_KEY || env?.ANTHROPIC_AUTH_TOKEN || env?.OPENAI_API_KEY);
  if (!settled && !appKey) {
    return "[models] This shell started before the keychain had been read, so it has none of your saved API keys. A tab opened after they load will have them.";
  }
  return "";
}
