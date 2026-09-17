// (C)
// Boot-time workspace parsing plus the recovery decision that follows from it.
// The per-window layout lives ONLY in localStorage, so a WebView2 profile that
// is reset, quarantined or rebuilt takes the whole workspace with it; store.json
// (write_store) is the durable mirror. These pure functions decide when boot may
// consult that mirror and what to do with what comes back (audit C2, widened by
// re-audit R-C2-1 / RDI-3).
//
// Two flags, because they mean different things to the user:
//   corrupt: a NON-EMPTY string that failed JSON.parse. Real damage.
//   empty:   the parse yielded no usable state at all. Missing key, blank
//            string, the Rust store's "null" sentinel, valid-but-non-object
//            JSON, or a literal {}. `corrupt` always implies `empty`.
//
// Reading `corrupt` alone covered the one failure mode that almost never
// happens. Chromium's LevelDB DISCARDS a damaged localStorage database and
// starts empty rather than handing back a garbled string, so the profile-loss
// case this mechanism exists for arrives as a MISSING key.
import { SECRET_FIELDS } from "./storageKeys.js";

export function parseWorkspace(raw) {
  if (raw == null || raw === "") return { state: {}, corrupt: false, empty: true };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { state: parsed, corrupt: false, empty: Object.keys(parsed).length === 0 };
    }
    return { state: {}, corrupt: false, empty: true };
  } catch {
    return { state: {}, corrupt: true, empty: true };
  }
}

// Should boot read the durable backup before living with what localStorage gave
// it? Any empty parse qualifies, a genuine first run included: recovering
// nothing is the normal case there, and reading the file once is also what holds
// the mirror back long enough that the unconditional boot migrations cannot
// replace a real store.json with their defaults ~200 ms later (R-C2-1).
export function needsBackupRead(boot) {
  if (!boot) return false;
  return boot.empty === true;
}

// A fingerprint of ONE layout blob, so a deliberate discard can name the layout
// it threw away instead of banning recovery outright.
//
// Byte equality is not available: localStorage holds JSON.stringify of the live
// state object while store.json holds JSON.stringify of a copy with
// SECRET_FIELDS deleted (workspaceMirror.js), and a legacy plaintext
// anthropicKey really does survive in the local copy when the OS keychain is
// unavailable. So: drop the secrets, sort every key, hash the result.
//
// Returns null when there is nothing to recognise (missing, blank, corrupt,
// keyless, or secrets-only), which is the same "no specific layout" state an
// ordinary boot is in. Two 32-bit FNV-1a passes with different offset bases, so
// ~64 bits: a collision would only cost one un-restored backup after a crash
// reset, and a MISS costs one extra restore-then-reset cycle, because the
// restored layout is then in both copies and fingerprints identically.
const FNV_PRIME = 0x01000193;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  const primitive = JSON.stringify(value);
  return primitive === undefined ? "null" : primitive;
}

function fnv1a(text, basis) {
  let h = basis >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function layoutFingerprint(value) {
  const state =
    value != null && typeof value === "object" ? value : parseWorkspace(value == null ? null : String(value)).state;
  const safe = { ...state };
  for (const f of SECRET_FIELDS) delete safe[f];
  if (Object.keys(safe).length === 0) return null;
  const canon = stableJson(safe);
  return `fp1:${fnv1a(canon, 0x811c9dc5)}${fnv1a(canon, 0x9dc5811c)}`;
}

// What to do once the backup has been read. `backup` is parseWorkspace() of the
// read_store result, or null when the read itself failed.
//
//   adopt:  restore it. The window came up with NO usable layout while a real
//           one sits in store.json, and there is exactly one way for that to
//           happen: the WebView2 profile was reset, quarantined or rebuilt.
//
//           This case used to be ambiguous, because a Settings factory reset
//           also wiped localStorage and reloaded while deliberately leaving
//           store.json behind, so boot could not tell a profile loss from a
//           reset and asked. Factory reset now clears the durable copy too
//           (SettingsModal.jsx). Removing the ambiguity at its source is what
//           lets this be a decision instead of a question: a boot-time modal
//           has nowhere safe to render (it raced the recording-recovery prompt
//           for ConfirmProvider's single slot, and drew over both the Welcome
//           screen and the master-password LockScreen).
//
//           The other deliberate discard, the ErrorBoundary's "Reset layout &
//           reload", is handled by `skip` below: boot still reads the backup,
//           it just refuses to hand back the one layout that was discarded.
//   skip:   the backup holds the exact layout the user just threw away with the
//           ErrorBoundary's "Reset layout & reload", so handing it back would
//           hand the crash loop back with it. `discarded` is that layout's
//           fingerprint, carried across the reload in sessionStorage
//           (storageKeys.js/markLayoutDiscarded).
//
//           This used to be a bare "do not recover" flag read one level up, so
//           boot skipped the read entirely, and with it the mirror hold, which
//           is what stops the unconditional boot migrations from mirroring their
//           defaults over store.json ~200 ms later. The crash hatch therefore
//           destroyed the durable backup as well as the local copy. Naming the
//           one poisoned layout keeps a DIFFERENT backup (the crash can beat the
//           200 ms debounce, so store.json can still hold the last good one)
//           restorable.
//   notice: tell the user the workspace was unreadable and could not be
//           recovered. Corrupt blobs only; an empty blob with no backup is an
//           ordinary first run and must stay silent and fast.
//   none:   nothing to do.
export function planRecovery(boot, backup, discarded = null) {
  if (!needsBackupRead(boot)) return { action: "none", state: null };
  if (backup && backup.empty === false) {
    if (discarded && layoutFingerprint(backup.state) === discarded) return { action: "skip", state: null };
    return { action: "adopt", state: backup.state };
  }
  return { action: boot.corrupt ? "notice" : "none", state: null };
}
