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
// component already imports it from "./providers.js".

// Maps an already-read user-state blob into the provider-key / active-model
// portion of the spawn env. Returns a fresh object (possibly empty). Pure:
// reads only its arguments, performs no I/O, mutates nothing external.
export function resolveEnvFromUserState(userPersisted, envForModel) {
  const env = {};
  if (!userPersisted) return env;
  const keys = (userPersisted && userPersisted.providerKeys) || {};
  const baseUrls = (userPersisted && userPersisted.providerBaseUrls) || {};
  // Default Claude key now lives in the Models section as
  // providerKeys.anthropic (legacy userPersisted.anthropicKey is the
  // pre-consolidation fallback for not-yet-migrated state).
  const defaultAnthropic =
    (typeof keys.anthropic === "string" && keys.anthropic.length > 0)
      ? keys.anthropic
      : (typeof userPersisted?.anthropicKey === "string" ? userPersisted.anthropicKey : "");
  if (defaultAnthropic) env.ANTHROPIC_API_KEY = defaultAnthropic;
  // Multi-LLM routing: if the user picked an active provider/model,
  // inject its env vars so `claude` / `codex` route there. Takes
  // precedence over the default ANTHROPIC_API_KEY above.
  const am = userPersisted && userPersisted.activeModel;
  if (am && am.providerId && am.model && typeof keys[am.providerId] === "string" && keys[am.providerId].length > 0) {
    Object.assign(env, envForModel(am.providerId, am.model, keys[am.providerId], baseUrls[am.providerId]));
  }
  return env;
}
