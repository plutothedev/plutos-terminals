// (C)
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Tauri backend so the disk-checkpoint invokes are observable.
const invoke = vi.fn(() => Promise.resolve());
vi.mock("@backend", () => ({ invoke: (...a) => invoke(...a) }));

import { startRecording, pushOutput, stopRecording, isRecording } from "./recording.js";

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
    expect(seed[1].name).toBe("rec-tabX");

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
