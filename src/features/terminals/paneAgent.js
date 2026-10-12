// (C)
// The agent side of one terminal pane: what it shows, what it answers, and
// when it tells you. TerminalPane wires xterm and the PTY to this; everything
// here is plain logic over the effects it is handed (`fx`), so it is tested
// with fake timers and no terminal (paneAgent.test.js).
//
// - What it shows: a program's own OSC 7501 report (programStatus.js) when
//   the pane holds one, else the heuristics TerminalPane keeps running; and
//   "waiting" whenever those heuristics see Claude's permission dialog, so a
//   program that reports wrongly, or not at all, cannot hide a prompt.
// - What it answers: the fixed OSC 7501 support reply, which must reach the
//   program before xterm's own reply to the `CSI c` that follows the probe.
// - When it tells you: "finished" and "failed" after real work and at most
//   once per gap; "needs you" once the pane has waited NEEDS_YOU_DELAY_MS
//   (long enough for auto-approve to answer), at most once per gap, and again
//   when the gap is over if the pane is still waiting. Only while you are
//   away from the pane. Titles are the app's own words naming the pane; a
//   program's message only ever appears in the body, labelled as its own.
// - The resume hold: a pane that resumed a conversation after a restart is
//   not auto-approved until a person types there.

import {
  parseProgramStatus,
  programStatusReply,
  createStatusStore,
  applyReport,
  endInFlight,
  acknowledge,
  resetStatus,
  paneProgramStatus,
  activityFor,
  statusNotice,
} from "./programStatus.js";

export const PACE = {
  publishMs: 100, // what is shown follows reports at most this often
  finishMinWorkMs: 3000, // a reported finish counts after this much work
  finishGapMs: 10000, // and rings at most once per this, per pane
  needsYouDelayMs: 2000, // "needs you" waits this long (auto-approve may answer)
  needsYouGapMs: 15000, // and is sent at most once per this, per pane
  repliesPerSec: 10, // OSC 7501 support replies a second, per pane
};

// fx: {
//   now(): ms,  setTimer(fn, ms) -> handle,  clearTimer(handle),  microtask(fn),
//   isLive(): the pane still exists,  isAway(): you are not looking at it,
//   paneName(): what notices call it,  heuristic(): the heuristic activity,
//   publish(shown, status): show it (activity string, report or null),
//   write(data): this pane's own ordered PTY queue,
//   notify(title, body, urgent),  push(label, exit, kind),  cue(),
// }
export function createPaneAgent(fx) {
  const store = createStatusStore();
  const s = {
    shown: "idle",
    activeSince: 0,
    lastFinishAt: -Infinity,
    lastNeedsYouAt: -Infinity,
    needsYouTimer: null,
    publishTimer: null,
    replyPending: false,
    replyTimes: [],
    held: false,
  };

  const status = () => paneProgramStatus(store);

  const shownNow = (st) => {
    const heuristic = fx.heuristic() || "idle";
    return st && heuristic !== "waiting" ? activityFor(st) : heuristic;
  };

  const publish = () => {
    const st = status();
    const shown = shownNow(st);
    fx.publish(shown, st);
    const prev = s.shown;
    if (prev === shown) return;
    s.shown = shown;
    changed(prev, shown, st);
  };

  const schedulePublish = () => {
    if (s.publishTimer) return;
    s.publishTimer = fx.setTimer(() => {
      s.publishTimer = null;
      if (fx.isLive()) publish();
    }, PACE.publishMs);
  };

  const changed = (prev, shown, st) => {
    const now = fx.now();
    if (shown === "active") s.activeSince = now;
    if (shown === "waiting") scheduleNeedsYou(PACE.needsYouDelayMs);
    if (shown !== "done" || (prev !== "active" && prev !== "waiting") || !fx.isAway()) return;
    // A program reporting working, then done, in quick turns must not ring,
    // notify and push on every flip.
    if (st && prev === "active" && now - s.activeSince < PACE.finishMinWorkMs) return;
    if (now - s.lastFinishAt < PACE.finishGapMs) return;
    s.lastFinishAt = now;
    const name = fx.paneName();
    const failed = st?.state === "error";
    fx.cue();
    fx.notify(`${failed ? "Agent failed" : "Agent finished"}: ${name}`, statusNotice(st, "finished"), false);
    fx.push(name, failed ? 1 : 0, "finished");
  };

  const scheduleNeedsYou = (delay) => {
    if (s.needsYouTimer) return;
    s.needsYouTimer = fx.setTimer(() => {
      s.needsYouTimer = null;
      if (!fx.isLive() || s.shown !== "waiting" || !fx.isAway()) return;
      const wait = s.lastNeedsYouAt + PACE.needsYouGapMs - fx.now();
      if (wait > 0) {
        // Still waiting, but the last notice was recent: try again once the
        // gap is over rather than not at all.
        scheduleNeedsYou(wait);
        return;
      }
      s.lastNeedsYouAt = fx.now();
      const name = fx.paneName();
      fx.notify(`Needs you: ${name}`, statusNotice(status(), "needs_you"), true);
      fx.push(name, null, "needs_you");
    }, delay);
  };

  const queueReply = () => {
    if (s.replyPending) return;
    const now = fx.now();
    s.replyTimes = s.replyTimes.filter((t) => now - t < 1000);
    if (s.replyTimes.length >= PACE.repliesPerSec) return;
    s.replyTimes.push(now);
    s.replyPending = true;
    fx.microtask(() => {
      if (!s.replyPending) return;
      s.replyPending = false;
      fx.write(programStatusReply());
    });
  };

  return {
    // An OSC 7501 body from the live stream (never replayed scrollback).
    report(body) {
      const parsed = parseProgramStatus(body);
      if (!parsed) return;
      if (parsed.query) {
        queueReply();
        return;
      }
      applyReport(store, parsed.report);
      schedulePublish();
    },
    // xterm answering a program: after any pending support reply, one write.
    reply(data) {
      const support = s.replyPending ? programStatusReply() : "";
      s.replyPending = false;
      fx.write(support + data);
    },
    // A person typed, pasted or dictated here: the resume hold ends, and a
    // finished or failed report has been seen.
    userInput() {
      s.held = false;
      const st = status();
      if (st && (st.state === "done" || st.state === "error")) {
        acknowledge(store);
        publish();
      }
    },
    // The heuristics moved (TerminalPane's setActivity).
    heuristicChanged() {
      publish();
    },
    // Revealing the pane: finished and failed reports have been seen.
    acknowledge() {
      acknowledge(store);
      publish();
    },
    // A new shell prompt (OSC 133 A) or the process exited.
    endInFlight() {
      endInFlight(store);
      publish();
    },
    // RIS: the terminal was reset, and every report with it.
    reset() {
      resetStatus(store);
      publish();
    },
    holdForResume() {
      s.held = true;
    },
    get held() {
      return s.held;
    },
    get shown() {
      return s.shown;
    },
    status,
    // The agent a pane reports is running there now (idle, working or
    // blocked), or null. For the handoff, which also refuses "blocked".
    runningAgent() {
      const st = status();
      return st && ["idle", "working", "blocked"].includes(st.state) ? st : null;
    },
    dispose() {
      if (s.publishTimer) fx.clearTimer(s.publishTimer);
      if (s.needsYouTimer) fx.clearTimer(s.needsYouTimer);
      s.publishTimer = null;
      s.needsYouTimer = null;
    },
  };
}
