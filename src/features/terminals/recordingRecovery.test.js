// (C)
// The recovered-recording prompt (audit C5, v0.7.6 audit). Its Cancel button
// is labelled "Discard", so dismissing the dialog (Escape, the close button, a
// backdrop click, which ConfirmModal answers with null) must not take the
// Discard path: the recording stays on disk and is offered again next launch.
import { test, expect, vi } from "vitest";
import { recoverInflightRecordings } from "./recordingRecovery.js";

function harness(answers, { cast = "CAST", savedPath = "C:/out.cast" } = {}) {
  const queue = [...answers];
  const recording = {
    listInflightRecordings: vi.fn(async () => ["rec-a", "rec-b"].slice(0, answers.length)),
    readInflightRecording: vi.fn(async () => cast),
    discardInflightRecording: vi.fn(async () => {}),
  };
  const confirm = vi.fn(async () => queue.shift());
  const saveFile = vi.fn(async () => savedPath);
  const toast = { success: vi.fn(), error: vi.fn() };
  const run = () => recoverInflightRecordings({ recording, confirm, saveFile, toast, isCancelled: () => false });
  return { recording, confirm, saveFile, toast, run };
}

test("dismissing the prompt (null) keeps the recording for next launch", async () => {
  const h = harness([null]);
  await h.run();
  expect(h.confirm).toHaveBeenCalledTimes(1);
  expect(h.recording.discardInflightRecording).not.toHaveBeenCalled();
  expect(h.recording.readInflightRecording).not.toHaveBeenCalled();
  expect(h.saveFile).not.toHaveBeenCalled();
});

test("the Discard button (false) discards it", async () => {
  const h = harness([false]);
  await h.run();
  expect(h.recording.discardInflightRecording).toHaveBeenCalledWith("rec-a");
  expect(h.saveFile).not.toHaveBeenCalled();
});

test("a dismissal moves on to the next recording without touching the first", async () => {
  const h = harness([null, false]);
  await h.run();
  expect(h.confirm).toHaveBeenCalledTimes(2);
  expect(h.recording.discardInflightRecording.mock.calls).toEqual([["rec-b"]]);
});

test("Save writes the file, then drops the crash-net copy", async () => {
  const h = harness([true]);
  await h.run();
  expect(h.saveFile).toHaveBeenCalledWith("rec-a", "CAST");
  expect(h.recording.discardInflightRecording).toHaveBeenCalledWith("rec-a");
  expect(h.toast.success).toHaveBeenCalled();
});

test("a cancelled Save keeps it", async () => {
  const h = harness([true], { savedPath: null });
  await h.run();
  expect(h.recording.discardInflightRecording).not.toHaveBeenCalled();
});

test("an unreadable recording is discarded after Save", async () => {
  const h = harness([true], { cast: null });
  await h.run();
  expect(h.saveFile).not.toHaveBeenCalled();
  expect(h.recording.discardInflightRecording).toHaveBeenCalledWith("rec-a");
});

test("a failed Save keeps it and says why", async () => {
  const h = harness([true]);
  h.saveFile.mockRejectedValueOnce(new Error("disk full"));
  await h.run();
  expect(h.recording.discardInflightRecording).not.toHaveBeenCalled();
  expect(h.toast.error).toHaveBeenCalled();
});

test("the prompt tells the user that closing it keeps the recording", async () => {
  const h = harness([null]);
  await h.run();
  const [message, opts] = h.confirm.mock.calls[0];
  expect(message).toMatch(/rec-a/);
  expect(message).toMatch(/Discard deletes it/);
  expect(message).toMatch(/[Cc]los(e|ing) this keeps it/);
  expect(opts).toMatchObject({ confirmLabel: "Save", cancelLabel: "Discard" });
});
