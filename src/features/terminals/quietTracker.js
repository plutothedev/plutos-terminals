// (C)
// When a pane's activity starts counting. Activity tracking starts when a
// person types in the pane, so a shell's own prompt never lights it up; it
// also starts at once when the app types a session's system prompt. A
// program that queries the terminal is a full-screen program starting,
// perhaps from start commands nobody types into, so a query ARMS tracking:
// it starts once the pane's output has been quiet for QUIET.quietMs (the
// program's startup is not work), or QUIET.maxWaitMs after the first query
// at the latest (a job the program starts at once still counts). A pane held
// after resuming a conversation is never armed: its repaint of the old
// conversation can take seconds, and nothing it does is work until a person
// types there.
//
// Plain logic over the effects it is handed, so it is tested with a fake
// clock (quietTracker.test.js). TerminalPane keeps one per registry entry.

export const QUIET = {
  quietMs: 3000,
  maxWaitMs: 10000,
};

// fx: {
//   now(): ms,  setTimer(fn, ms) -> handle,  clearTimer(handle),
//   isLive(): the pane still exists,  isHeld(): held after a resume,
//   isOn(): tracking already on,  turnOn(): start tracking,
// }
export function createQuietTracker(fx) {
  let timer = null;
  let since = 0;

  // Re-checks the hold: a query can arm the tracker before the pane is held
  // (a shell's own startup query), and the hold must still win.
  const fire = () => {
    timer = null;
    if (fx.isLive() && !fx.isOn() && !fx.isHeld()) fx.turnOn();
  };

  const schedule = () => {
    const wait = Math.max(0, Math.min(QUIET.quietMs, since + QUIET.maxWaitMs - fx.now()));
    timer = fx.setTimer(fire, wait);
  };

  return {
    // The program queried the terminal.
    arm() {
      if (fx.isOn() || fx.isHeld()) return;
      if (timer === null) since = fx.now();
      else fx.clearTimer(timer);
      schedule();
    },
    // Output arrived: while armed, the quiet wait starts over.
    output() {
      if (timer === null) return;
      fx.clearTimer(timer);
      schedule();
    },
    // The app gave the program work: tracking starts now.
    start() {
      if (timer !== null) fx.clearTimer(timer);
      timer = null;
      if (!fx.isOn()) fx.turnOn();
    },
    get armed() {
      return timer !== null;
    },
    dispose() {
      if (timer !== null) fx.clearTimer(timer);
      timer = null;
    },
  };
}
