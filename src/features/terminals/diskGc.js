// (C)
// The boot/daily scrollback GC, lifted out of App.jsx so its ORDER is testable
// without a browser. The sweep itself is one IPC call; everything that matters
// here is what has to be true before that call is allowed to happen.
//
// THE BUG THIS FILE EXISTS FOR. The sweep used to be scheduled straight onto an
// idle callback at boot. Boot recovery (bootRecovery.js) is meanwhile awaiting
// read_store to pull the durable backup, and nothing ordered the two. The
// keep-list is built from localStorage ONLY and skips a blob it cannot parse,
// so a missing or corrupt profile — the exact condition that makes recovery run
// at all — yields an EMPTY keep-list. The Rust sweep deletes every file past the
// age floor that is not in the keep-list, so an empty list is not "keep
// everything", it is "keep nothing". The idle callback fired first, the files
// went, and recovery then restored those panes with their original ids and no
// history.
//
// AND THE HALF THE FIRST FIX MISSED (review F2). Refusing on an empty list uses
// emptiness as a proxy for "the layout was unreadable", which holds only while
// exactly one window is open. With two, a lost primary blob and an intact
// secondary produce a NON-EMPTY list built from the wrong window: nothing
// refuses, and the primary's recovering panes lose their history anyway. So the
// harvest now reports whether it read everything (storageKeys.harvestKeepList),
// and an incomplete read is refused on its own terms.
//
// The 30-day floor is a much weaker bound than it reads. A rotated `.old.txt`
// segment keeps the mtime it had at rotation, and merely loading a tab's
// scrollback never writes the file, so after a month away every restored tab is
// eligible on the first boot back.
//
// Every collaborator is injected. Nothing here touches localStorage, React or
// Tauri directly.

// Upper bound on the wait for boot recovery. bootRecovery already bounds its
// own read_store at READ_STORE_TIMEOUT_MS (10 s) and App catches, so in
// practice the promise always settles; this sits ABOVE that so the normal
// timeout path settles first and this never races it. It exists because
// everything below the await is the only GC this app gets and the window hides
// to the tray rather than quitting (lib.rs), so a wedged wait is not a slow
// boot, it is unbounded scrollback growth for the life of a weeks-long session.
export const BOOT_SETTLE_TIMEOUT_MS = 15_000;

// Resolve once `value` has settled EITHER WAY, or once `ms` elapses. A failed
// recovery must not disable cleanup forever: the reason the restore failed has
// nothing to do with whether abandoned files should be reclaimed. Both handlers
// are attached, so a rejection never escapes as an unhandled rejection.
function settled(value, ms) {
  const done = Promise.resolve(value).then(() => {}, () => {});
  if (!(ms > 0)) return done;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    done.then(() => { clearTimeout(timer); resolve(); });
  });
}

// Why a sweep was refused. The result stays a bare boolean (callers only care
// whether files were reclaimed), so the reason travels through `onRefuse` — and
// the three are kept apart because they are three different events and only one
// of them is normal:
//
//   EMPTY       the store read fine and nothing is open. Routine; a workspace
//               with no tabs simply never GCs.
//   INCOMPLETE  at least one window's layout could not be read, so the ids that
//               DID come back are a partial exclusion list and everything
//               missing from it is unprotected. This is the two-window boot bug
//               (review F2) and it is worth noticing in a log.
//   UNREADABLE  the harvest threw, or returned something that is not
//               { ids, complete } at all — including a bare array, i.e. someone
//               wired the old allOpenTabIds back in. Fails closed on purpose.
export const REFUSED_EMPTY = "empty-keep-list";
export const REFUSED_INCOMPLETE = "incomplete-keep-list";
export const REFUSED_UNREADABLE = "unreadable-keep-list";

function warnRefused(reason) {
  console.warn(`Pluto's Terminal: scrollback sweep refused (${reason})`);
}

/**
 * Run one scrollback sweep, in the only order that is safe.
 *
 *   bootSettled  the boot-recovery promise, or null when recovery never ran
 *                (the common case: the layout parsed, so there was nothing to
 *                restore). Awaited settled-either-way, never for its value.
 *   flush        App's flushNow. Recovery restores by calling save(), which
 *                only ARMS the 200 ms debounce; without this the harvest reads
 *                a localStorage that still holds the unusable boot blob and the
 *                restored panes are invisible to it.
 *   harvest      storageKeys.harvestKeepList. Called AFTER the flush, never
 *                before, and it must return { ids, complete } — NOT the plain
 *                array allOpenTabIds gives back, which cannot say whether a
 *                window's blob was skipped.
 *   invoke       the Tauri invoke.
 *   timeoutMs    bound on the recovery wait (tests shorten it).
 *   onRefuse     called with one of the REFUSED_* reasons when the sweep is
 *                refused. Defaults to a console.warn so a refusal always leaves
 *                a trace.
 *
 * Returns true when the sweep was invoked, false when it was refused.
 */
export async function runBootSweep({ bootSettled = null, flush, harvest, invoke, timeoutMs = BOOT_SETTLE_TIMEOUT_MS, onRefuse = warnRefused } = {}) {
  if (bootSettled) await settled(bootSettled, timeoutMs);

  // Best-effort: a full-quota localStorage throws in here, and that is a reason
  // to distrust the keep-list, not a reason to skip straight past the harvest.
  try { flush?.(); } catch { /* flushNow already surfaces its own failures */ }

  let keep;
  try {
    keep = harvest?.();
  } catch {
    keep = null; // an unreadable store is the refusal case below, precisely
  }

  // A bare array lands here too, and refuses: the old harvest could not report
  // completeness, so accepting its shape would silently restore the gap below.
  const keepTabIds = Array.isArray(keep?.ids) ? keep.ids : null;
  if (!keepTabIds) { onRefuse?.(REFUSED_UNREADABLE); return false; }

  // REFUSE on an INCOMPLETE keep-list, checked BEFORE the length (review F2).
  // The keep-list is an EXCLUSION list, so a harvest that skipped a window did
  // not return "fewer ids", it returned a list that leaves every pane of that
  // window unprotected. With one window open that shows up as empty and the
  // guard below catches it; with two it does not — a corrupt PRIMARY blob plus
  // an intact secondary reads as a perfectly healthy non-empty list, and the
  // sweep deletes the aged scrollback of the panes boot recovery is at that
  // moment restoring. Emptiness was only ever a proxy for this; ask directly.
  //
  // `!== true`, not `=== false`: a harvest that never says it read everything
  // has not said it did. On a path that unlinks a user's history, silence is not
  // consent, and the one production harvest always answers explicitly.
  if (keep.complete !== true) { onRefuse?.(REFUSED_INCOMPLETE); return false; }

  // REFUSE on an empty keep-list. This is the guard, not a nicety: an empty list
  // protects nothing, so sweeping on one is indistinguishable from "delete every
  // scrollback file older than the floor". A workspace with genuinely zero open
  // tabs therefore never GCs, which is the trade taken on purpose — deferring
  // cleanup costs disk, sweeping unprotected costs a user's history.
  if (keepTabIds.length === 0) { onRefuse?.(REFUSED_EMPTY); return false; }

  await invoke("scrollback_sweep", { keepTabIds });
  return true;
}
