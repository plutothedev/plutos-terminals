// (C)
// Push with bounded re-pull on a non-fast-forward. When another machine pushes
// first, our push is rejected (non-ff); we re-pull + re-merge and retry. The
// loop is BOUNDED so a busy fleet can't spin forever, and — critically — if
// every attempt fails the LAST error propagates instead of being swallowed, so
// the caller surfaces an error rather than leaving the user's edits silently
// unpushed (the old code retried exactly once, then threw uncaught on a second
// concurrent push). `tryPush` performs one push; `rePull` resolves the non-ff
// (pull + merge) before the next attempt. Returns tryPush's value on success.
export async function pushWithRePull(tryPush, rePull, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await tryPush();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      await rePull();
    }
  }
  throw lastErr;
}
