// (C)
// The durable store.json mirror of the per-window layout blob (audit C2), split
// out of App.jsx's flushNow because it owns two rules that are not obvious from
// the call site and were both getting broken there.
//
// 1. SECRETS ARE STRIPPED. The window blob can still carry a legacy plaintext
//    anthropicKey, and store.json is a NEW, more discoverable at-rest location
//    than localStorage, so mirroring it unfiltered would turn a durability fix
//    into a key leak. Same SECRET_FIELDS allowlist the keychain and cloud-sync
//    paths use.
// 2. A SUSPENDED WRITE IS DEFERRED, NOT DROPPED. Boot recovery holds the mirror
//    off until it has read store.json once, so the boot migrations cannot
//    replace a real backup with their defaults. flushNow consumes pendingRef
//    before it reaches the mirror, and nothing re-queues it, so a write skipped
//    during that hold used to be lost outright: a first run whose read_store
//    outran the 200 ms debounce (plausible on Windows with AV scanning a fresh
//    install) mirrored NOTHING, and an app left resident in the tray never got
//    a second chance. Deferring the last value and sending it on resume closes
//    that.

import { SECRET_FIELDS, localWriteHolds } from "./storageKeys.js";

export function createWorkspaceMirror(transport) {
  let suspended = false;
  // Only the LAST value matters: every write is a whole-blob snapshot, so an
  // older one is strictly superseded rather than lost.
  let deferred = null;

  const send = (state) => {
    // A factory reset takes a write hold and never releases it (the document
    // is on its way out). flushNow checks that hold, but resume() and
    // replaceNow() reach this transport directly, so a boot recovery that
    // resolved AFTER the reset had written "{}" would repopulate store.json
    // and the reload would adopt it: the reset undoing itself. One gate, here,
    // covers all three paths.
    if (localWriteHolds()) return;
    try {
      const safe = { ...state };
      for (const f of SECRET_FIELDS) delete safe[f];
      transport(JSON.stringify(safe));
    } catch { /* mirror is best-effort: never break a save over the backup copy */ }
  };

  return {
    isSuspended() {
      return suspended;
    },
    suspend() {
      suspended = true;
    },
    // Release the hold and send whatever was skipped while it was up.
    resume() {
      suspended = false;
      const pending = deferred;
      deferred = null;
      if (pending != null) send(pending);
    },
    write(state) {
      if (suspended) {
        deferred = state;
        return false;
      }
      send(state);
      return true;
    },
    // Replace the backup with `state` right now, hold or no hold, and drop the
    // deferred value it supersedes. This is boot recovery adopting the backup:
    // the restored workspace has to be in store.json before the hold lifts, or
    // resume() sends the deferred PRE-restore migration defaults over it and
    // the act of recovering destroys what it recovered.
    replaceNow(state) {
      deferred = null;
      send(state);
    },
  };
}
