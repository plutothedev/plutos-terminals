// (C)
// Shared notebook IO + name helpers for the notebook tab type (Stream C).
//
// Two concerns live here, both closing whole-stream-review findings:
//
//   1. NAME SANITIZATION (silent-content-loss root cause). The Rust dir-scope
//      gate (notebook_path in commands.rs) accepts a "<stem>.md" name only when
//      the stem is BYTE-IDENTICAL to safe_filename(stem) — i.e. the stem is
//      already made of ONLY [A-Za-z0-9_-]. The old UI appended ".md" to whatever
//      the user typed and minted a tab regardless, so "meeting notes", "café",
//      "笔记", "notes.md" (double-append) all produced tabs whose EVERY save was
//      rejected by the gate — and the unmount flush swallowed that error, losing
//      content silently. sanitizeNotebookStem() maps any input to a gate-clean
//      stem so the file a tab is bound to is always savable; toNotebookName()
//      layers the reserved-name + empty-stem rejects on top and returns the
//      friendly "<stem>.md".
//
//   2. WRITE/READ SERIALIZATION (close->reopen race). Closing a dirty notebook
//      fires a final unmount write while a fresh mount of the SAME name (reopen /
//      workspace load) issues its read; with no ordering the reopened view can
//      read the pre-edit file and lose the last edits. noteWrite() records a
//      per-name in-flight write; readNotebook() awaits any in-flight write for
//      that name before reading, so the reopened view always loads the closing
//      view's final content, never a stale snapshot.

import { invoke } from "@backend";

// Every run of chars OUTSIDE the Rust gate's allowlist (ASCII alphanumerics +
// '_' + '-'). Anything else in a stem makes safe_filename(stem) !== stem, which
// the gate rejects.
const DISALLOWED_RUN = /[^A-Za-z0-9_-]+/g;

// Reserved Windows device names (win32-primary app) — mirrors RESERVED_NAMES in
// commands.rs. Compared case-insensitively against the sanitized stem.
const RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

// Reduce arbitrary user text to a gate-valid stem: ONLY [A-Za-z0-9_-]. Every run
// of disallowed characters (spaces, dots, slashes, unicode, …) collapses to a
// single "-"; repeated "-" collapse to one; leading/trailing "-" are trimmed.
// The result is guaranteed allowlist-clean, so safe_filename(result) === result
// and notebook_path accepts "<result>.md". May be "" for all-disallowed input.
export function sanitizeNotebookStem(input) {
  return String(input ?? "")
    .replace(DISALLOWED_RUN, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Turn typed text into a savable notebook filename, or explain why it can't be.
// A single trailing ".md"/".MD" the user typed is stripped FIRST so "notes.md"
// becomes stem "notes" (not "notes-md") — the double-append that made a typed
// ".md" unsavable is gone. Returns { ok: true, name } or { ok: false, reason }.
export function toNotebookName(input) {
  const withoutMd = String(input ?? "").replace(/\.md$/i, ""); // strip one trailing .md
  const stem = sanitizeNotebookStem(withoutMd);
  if (!stem) return { ok: false, reason: "name has no usable characters" };
  if (RESERVED_NAMES.has(stem.toLowerCase())) return { ok: false, reason: "reserved name" };
  return { ok: true, name: `${stem}.md` };
}

// ── In-flight write registry (close->reopen serialization) ────────────────────
const inflightWrites = new Map(); // name -> Promise (the latest write for that name)

// Write a notebook, tracking the in-flight promise per name so a concurrent
// readNotebook(name) can await it. Returns the (tracked) write promise — it
// rejects on a backend error exactly like a bare invoke, so callers keep their
// existing try/catch or .catch handling.
export function noteWrite(name, content) {
  const p = invoke("notebook_write", { name, content });
  // Clear the registry only if THIS write is still the latest for the name — a
  // newer write may have replaced us while in flight, and we must not strand its
  // readers by deleting its entry.
  const tracked = p.finally(() => {
    if (inflightWrites.get(name) === tracked) inflightWrites.delete(name);
  });
  inflightWrites.set(name, tracked);
  return tracked;
}

// Read a notebook AFTER any in-flight write for the same name lands, so a reopen
// that races a closing view's final flush loads post-edit content. A failed
// prior write does not block the read (its rejection is swallowed here; the
// writer already surfaced it) — the read then reflects on-disk truth.
export function readNotebook(name) {
  const pending = inflightWrites.get(name) || Promise.resolve();
  return pending.catch(() => {}).then(() => invoke("notebook_read", { name }));
}
