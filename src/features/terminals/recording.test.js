// (C)
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Tauri backend so the disk-checkpoint invokes are observable.
const invoke = vi.fn(() => Promise.resolve());
vi.mock("@backend", () => ({ invoke: (...a) => invoke(...a) }));

import { startRecording, pushOutput, stopRecording, isRecording, pruneRecordings, activeTabIds, inflightName } from "./recording.js";
import { allPaneTargets } from "./activePane.js";
import { allRenderedPaneIds } from "./paneIds.js";
import { splitLeaf, getLayout } from "./splitTree.js";

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("recording disk checkpoint (audit C5)", () => {
  test("start seeds the inflight file with a reset header, output flushes on the 2s timer", () => {
    startRecording("tabX", { width: 80, height: 24, label: "t" });
    // header seed: reset:true
    const seed = invoke.mock.calls.find((c) => c[0] === "recording_checkpoint" && c[1].reset === true);
    expect(seed).toBeTruthy();
    expect(seed[1].name).toMatch(/^rec-tabX-[a-z0-9]+$/);

    invoke.mockClear();
    pushOutput("tabX", "hello");
    pushOutput("tabX", "world");
    // nothing flushed yet (debounced)
    expect(invoke.mock.calls.filter((c) => c[0] === "recording_checkpoint").length).toBe(0);

    vi.advanceTimersByTime(2000);
    const flush = invoke.mock.calls.find((c) => c[0] === "recording_checkpoint" && c[1].reset === false);
    expect(flush).toBeTruthy();
    // both events, header-less, appended in order
    expect(flush[1].chunk).toContain('"o","hello"');
    expect(flush[1].chunk).toContain('"o","world"');
    stopRecording("tabX");
  });

  test("stop flushes the tail, drops the in-memory recording, and no flush fires afterward", () => {
    startRecording("tabY");
    pushOutput("tabY", "tail-data");
    invoke.mockClear();

    const cast = stopRecording("tabY");
    expect(isRecording("tabY")).toBe(false);
    expect(cast).toContain('"o","tail-data"'); // in-memory cast is authoritative
    // stop flushed the pending tail once...
    const flushes = invoke.mock.calls.filter((c) => c[0] === "recording_checkpoint");
    expect(flushes.length).toBe(1);

    // ...and the stale 2s timer must NOT fire another checkpoint after delete.
    invoke.mockClear();
    vi.advanceTimersByTime(5000);
    expect(invoke.mock.calls.filter((c) => c[0] === "recording_checkpoint").length).toBe(0);
  });
});

// Recordings are keyed by PANE id (audit FE-1). pruneRecordings' live set has to
// be built the same way or the sweep deletes live recordings, and the two ways
// of getting it wrong are the ones this file's doc block used to recommend.
// Composed against the REAL allPaneTargets / allRenderedPaneIds rather than
// hand-built id lists: the whole failure mode is a plausible-looking set reaching
// the sweep, so the set has to come from the function TerminalsTab actually calls.
describe("pruneRecordings takes the PANE set (audit FE-1)", () => {
  // useWorkspaceTree's shape after Ctrl+Shift+D: the existing leaf keeps tab.id,
  // the new leaf is added beside it.
  const split = (() => {
    const base = { id: "tab1", label: "shell", cwd: null };
    return { ...base, layout: splitLeaf(getLayout(base), "tab1", "row", { id: "pane2", cwd: null }, "s1") };
  })();
  const panels = [{ id: "p1", tabs: [split, { id: "home1", home: true }] }];

  afterEach(() => { for (const id of activeTabIds()) stopRecording(id); });

  test("keeps a recording on the non-root pane of a split tab", () => {
    // A tab-id live set never contains "pane2", so this recording would be
    // deleted mid-session with its "● rec" indicator still lit.
    startRecording("pane2");
    pushOutput("pane2", "work");
    pruneRecordings(allPaneTargets(panels));
    expect(isRecording("pane2")).toBe(true);
  });

  test("keeps a special tab's recording, which allRenderedPaneIds would drop", () => {
    // home/vnc/rdp/notebook tabs mount no TerminalPane, so allRenderedPaneIds
    // excludes them by design: correct for the pane registry, fatal here.
    startRecording("home1");
    expect(allRenderedPaneIds(panels)).not.toContain("home1");
    expect(allPaneTargets(panels).has("home1")).toBe(true);
    pruneRecordings(allPaneTargets(panels));
    expect(isRecording("home1")).toBe(true);
  });

  test("still drops a recording whose pane left the tree", () => {
    startRecording("pane-gone");
    pruneRecordings(allPaneTargets(panels));
    expect(isRecording("pane-gone")).toBe(false);
  });
});

// A recording kept on disk (Save cancelled, or its recovery prompt dismissed)
// waits for the next launch under its inflight name. A new recording in the
// same pane (pane ids persist across launches) seeds its file with reset:true,
// which truncated that kept recording when the name came from the pane id
// alone. Each recording gets its own name.
describe("inflight names are per recording, not per pane (v0.7.6 audit)", () => {
  const seedName = () => invoke.mock.calls.find((c) => c[0] === "recording_checkpoint" && c[1].reset === true)[1].name;

  test("a second recording in the same pane never truncates the first one's file", () => {
    startRecording("paneR");
    const first = seedName();
    stopRecording("paneR"); // Save cancelled: the file is kept
    invoke.mockClear();
    startRecording("paneR");
    const second = seedName();
    expect(second).not.toBe(first);
    stopRecording("paneR");
  });

  test("inflightName names the live recording's file, and the tail flush goes there", () => {
    expect(inflightName("paneF")).toBeNull();
    startRecording("paneF");
    const name = seedName();
    expect(inflightName("paneF")).toBe(name);
    pushOutput("paneF", "x");
    invoke.mockClear();
    stopRecording("paneF");
    expect(invoke.mock.calls.find((c) => c[0] === "recording_checkpoint")[1].name).toBe(name);
    expect(inflightName("paneF")).toBeNull();
  });

  test("names stay inside the backend's [A-Za-z0-9_-] gate", () => {
    startRecording("pane:weird/id");
    expect(seedName()).toMatch(/^[A-Za-z0-9_-]+$/);
    stopRecording("pane:weird/id");
  });
});

