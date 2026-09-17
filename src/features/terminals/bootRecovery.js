// (C)
// The boot restore sequence: read the durable backup, decide with planRecovery,
// and carry out the decision. Lifted out of App.jsx's effect so the branches are
// testable, because the branches are where this keeps going wrong.
//
// BOOT NEVER ASKS. An earlier revision put a confirm() here, because an empty
// localStorage blob over a populated store.json could mean either WebView2
// profile loss or a Settings factory reset. That one modal produced four
// separate defects: it raced the recording-recovery prompt for ConfirmProvider's
// single request slot (the loser's promise was never resolved, so this function
// never returned, the mirror never resumed, and the app ran the rest of the
// session with no durable backup at all), it rendered over the post-reset
// Welcome screen with "Restore" autofocused, it could render over the
// master-password LockScreen before authentication, and its "Start fresh"
// branch wrote nothing. A boot-time modal has nowhere safe to stand.
//
// The ambiguity was removed at its source instead: factory reset now clears
// store.json as well (SettingsModal.jsx), so an empty blob over a real backup
// can only be profile loss. Recovery is silent, and the user is told after the
// fact by a toast rather than asked before the fact by a dialog.
//
// Every collaborator is injected. Nothing here touches localStorage, React or
// Tauri directly.
import { parseWorkspace, planRecovery } from "./workspaceBoot.js";

// read_store is one IPC round-trip to a small file read. Ten seconds is far
// beyond any honest answer, so a read still outstanding at that point is not
// slow, it is never coming back, and everything below the await, the mirror
// release included, is waiting on it.
export const READ_STORE_TIMEOUT_MS = 10_000;

// Reject rather than hang. Tauri's invoke has no timeout of its own, and an
// unsettled read reproduces exactly the end state of the confirm() deadlock this
// file was written to remove: the finally never runs, the mirror stays
// suspended, and the app spends the rest of the session with its durable backup
// silently switched off. A late settle after the timeout lands on an
// already-settled promise, and both handlers are attached, so nothing escapes as
// an unhandled rejection.
function withTimeout(value, ms) {
  const promise = Promise.resolve(value);
  if (!(ms > 0)) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`read_store did not answer within ${ms} ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Returns the outcome: "restored" | "skipped" | "notice" | "none".
//
//   boot        parseWorkspace() of the per-window blob, as read at boot.
//   readStore   async () => the raw backup string ("null" when there is no file).
//   mirror      a workspaceMirror, ALREADY SUSPENDED by the caller.
//   save        the functional-updater save (invariant 3).
//   getState    the latest committed state (stRef.current), read AFTER save.
//   toast       { success, error }.
//   discarded   fingerprint of a layout the user deliberately threw away with
//               "Reset layout & reload", or null (storageKeys/takeDiscardedLayout).
//   timeoutMs   bound on the backup read; see READ_STORE_TIMEOUT_MS.
export async function runBootRecovery({
  boot,
  readStore,
  mirror,
  save,
  getState,
  toast,
  discarded = null,
  timeoutMs = READ_STORE_TIMEOUT_MS,
}) {
  try {
    let backup = null;
    try {
      backup = parseWorkspace(await withTimeout(readStore(), timeoutMs));
    } catch { /* unreadable or unanswered: planRecovery treats that as nothing to restore */ }
    const plan = planRecovery(boot, backup, discarded);

    if (plan.action === "adopt") {
      // Functional form (invariant 3): this lands after an await, so a
      // captured-state spread would revert the boot migrations that committed
      // while read_store was in flight. The backup wins key by key; everything
      // else survives.
      save((prev) => ({ ...prev, ...plan.state }));
      // Put the adopted workspace in store.json now instead of waiting on the
      // 200 ms debounce: resume() below would otherwise send the deferred
      // pre-restore migration defaults over the backup first, so recovering
      // would destroy what it recovered.
      mirror.replaceNow(getState());
      // After the fact, not before it. Nothing is blocked on reading this.
      toast.success("Your saved layout was missing, so it was restored from the on-disk backup.");
      return "restored";
    }

    if (plan.action === "skip") {
      // The backup holds the exact layout the user just discarded on the crash
      // screen. Restoring it would hand the crash loop back, so leave it. Silent
      // deliberately: the user asked for this layout to go, and there is nothing
      // for them to decide. Nothing is written here either: the ordinary
      // debounce mirrors the fresh workspace over store.json in its own time,
      // which is the same thing the discard did before, minus taking a backup
      // the user might still have wanted with it.
      return "skipped";
    }

    if (plan.action === "notice") {
      toast.error("Your saved workspace couldn't be read. Starting fresh.");
      return "notice";
    }

    // A genuine first run, or a boot with nothing recoverable behind it. Silent
    // by design: recovering nothing is the normal case for a new install, and
    // this path must stay fast.
    return "none";
  } finally {
    // Recovery resolved, so let the mirror resume: the recovered or fresh state
    // persists to store.json from here on, including whatever flushed while the
    // hold was up. The mirror defers rather than drops, which is what keeps a
    // first run whose read_store outruns the 200 ms debounce from ending up
    // with no durable backup at all. There is no path that leaves the hold in
    // place, because a permanently suspended mirror is a silently disabled
    // backup, which is the failure this whole file exists to prevent.
    mirror.resume();
  }
}
