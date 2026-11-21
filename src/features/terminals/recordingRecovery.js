// (C)
// Launch recovery for recordings orphaned by a crash / force-kill / cancelled
// Save (audit C5): offer each inflight .cast for save or discard. Pulled out of
// TerminalsTab's boot effect so the answer handling is testable on its own.
//
// confirm() (ConfirmModal) answers true from Save, false from the Cancel
// button, which this prompt labels "Discard", and null when the dialog is
// dismissed (Escape, the close button, a backdrop click). Only the Discard
// button deletes: a dismissal leaves the file in recordings-inflight/, where
// recording_list_inflight finds it again on the next launch.
//
// recording: { listInflightRecordings, readInflightRecording, discardInflightRecording }
// saveFile(name, cast) -> saved path, or null when the Save dialog is cancelled
// isCancelled() -> true once the owning effect has been torn down
// isPrimary() -> false in a secondary (detached) window. In-flight files are
// shared by every window, so a window that mounts later would list a recording
// still RUNNING in the main window and offer to Discard it; only the main
// window, which mounts first at launch, runs recovery.
export async function recoverInflightRecordings({ recording, confirm, saveFile, toast, isCancelled, isPrimary = () => true, describeError = (e) => String(e?.message || e) }) {
  if (!isPrimary()) return;
  const names = await recording.listInflightRecordings();
  if (isCancelled() || !Array.isArray(names) || names.length === 0) return;
  for (const name of names) {
    if (isCancelled()) return;
    const ok = await confirm(
      `An interrupted recording ("${name}") was recovered. Save it now? Discard deletes it; closing this keeps it for next launch.`,
      { title: "Recovered recording", confirmLabel: "Save", cancelLabel: "Discard" }
    );
    if (ok === false) { recording.discardInflightRecording(name); continue; }
    if (!ok) continue; // dismissed: keep it for next launch
    const cast = await recording.readInflightRecording(name);
    if (!cast) { recording.discardInflightRecording(name); continue; }
    try {
      const path = await saveFile(name, cast);
      if (path) {
        toast.success(`Saved recovered recording to ${path}`);
        recording.discardInflightRecording(name);
      } // save canceled → keep it for next launch
    } catch (e) {
      toast.error(describeError(e));
    }
  }
}
