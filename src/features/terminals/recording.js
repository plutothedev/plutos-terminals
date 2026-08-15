// Asciinema-format session recording. v0.1.18.
//
// API: startRecording(tabId, { width, height, label })
//      stopRecording(tabId) → returns the .cast file contents (asciinema v2)
//      isRecording(tabId)   → boolean
//      pushOutput(tabId, data) → record an "o" (output) event
//      activeTabIds()       → list of currently-recording tab ids
//      onChange(callback)   → subscribe to recording-state changes (returns unsubscribe)
//
// Recording streams incrementally to an inflight .cast on disk (audit C5) as
// well as the in-memory events, so a crash / force-kill / cancelled Save loses
// at most the last unflushed tail instead of the whole session. The in-memory
// buffer is still the source for the Save dialog; the disk copy is the crash
// net, discarded once a Save succeeds (finalizeRecording) and surfaced on next
// launch if orphaned (listInflight).
//
// Reference: https://docs.asciinema.org/manual/asciicast/v2/

import { invoke } from "@backend";

const recordings = new Map(); // tabId → { startTs, width, height, label, events: [], capped, pending: [], flushTimer }
const listeners = new Set();

// Disk-safe stem for a tab id (matches the Rust transcript_name_valid gate:
// [A-Za-z0-9_-] only). "rec-" prefix keeps it non-empty and clear of reserved
// device names.
function recName(tabId) {
  return "rec-" + String(tabId).replace(/[^A-Za-z0-9_-]/g, "_");
}

const FLUSH_MS = 2000;

function scheduleFlush(tabId) {
  const rec = recordings.get(tabId);
  if (!rec || rec.flushTimer) return;
  rec.flushTimer = setTimeout(() => flushCheckpoint(tabId), FLUSH_MS);
}

async function flushCheckpoint(tabId) {
  const rec = recordings.get(tabId);
  if (!rec) return;
  if (rec.flushTimer) { clearTimeout(rec.flushTimer); rec.flushTimer = null; }
  if (!rec.pending.length) return;
  const chunk = rec.pending.join("");
  rec.pending = [];
  try {
    await invoke("recording_checkpoint", { name: recName(tabId), chunk, reset: false });
  } catch { /* best-effort crash net — the in-memory buffer is still authoritative */ }
}

// v0.1.22: cap recordings at 100k events (~10-20 MB depending on chunk
// size). A long-running session at 100KB/s of output otherwise grows to
// hundreds of MB in RAM. When the cap is hit, pushOutput stops appending
// and sets `capped = true` so the UI can warn the user to save and stop.
const MAX_EVENTS = 100_000;

function notify() {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function startRecording(tabId, opts = {}) {
  if (!tabId) return false;
  if (recordings.has(tabId)) return false; // already recording
  const rec = {
    startTs: performance.now(),
    width: opts.width || 80,
    height: opts.height || 24,
    label: opts.label || tabId,
    events: [],
    pending: [],
    flushTimer: null,
  };
  recordings.set(tabId, rec);
  // Seed the inflight file with the header (reset:true truncates any stale
  // orphan under the same name).
  invoke("recording_checkpoint", { name: recName(tabId), chunk: castHeaderLine(rec) + "\n", reset: true })
    .catch(() => {});
  notify();
  return true;
}

export function stopRecording(tabId) {
  if (!tabId) return null;
  const rec = recordings.get(tabId);
  if (!rec) return null;
  if (rec.flushTimer) { clearTimeout(rec.flushTimer); rec.flushTimer = null; }
  // Flush any tail to disk before we drop the in-memory copy (fire-and-forget;
  // the returned cast below is the authoritative full recording).
  if (rec.pending.length) {
    const chunk = rec.pending.join("");
    rec.pending = [];
    invoke("recording_checkpoint", { name: recName(tabId), chunk, reset: false }).catch(() => {});
  }
  recordings.delete(tabId);
  notify();
  return formatCast(rec);
}

// Discard the inflight crash-net file after a Save succeeds. Left in place on a
// cancelled/failed Save so the session stays recoverable.
export function finalizeRecording(tabId) {
  return invoke("recording_discard", { name: recName(tabId) }).catch(() => {});
}

// Launch recovery: inflight files left by a crash/kill (audit C5).
export function listInflightRecordings() {
  return invoke("recording_list_inflight").catch(() => []);
}
export function readInflightRecording(name) {
  return invoke("recording_read_inflight", { name }).catch(() => null);
}
export function discardInflightRecording(name) {
  return invoke("recording_discard", { name }).catch(() => {});
}

export function isRecording(tabId) {
  return recordings.has(tabId);
}

export function pushOutput(tabId, data) {
  const rec = recordings.get(tabId);
  if (!rec) return;
  if (rec.capped) return;
  const t = (performance.now() - rec.startTs) / 1000;
  const ev = [t, "o", data];
  rec.events.push(ev);
  // Buffer the same JSONL line for the disk crash-net; flushed on a 2s timer.
  rec.pending.push(JSON.stringify(ev) + "\n");
  scheduleFlush(tabId);
  if (rec.events.length >= MAX_EVENTS) {
    rec.capped = true;
    flushCheckpoint(tabId); // persist the tail immediately at the cap
    notify(); // surfaces in UI so user knows to save and stop
  }
}

// Returns true if any recording has hit the cap. UI uses this to show a
// magenta warning in the status bar telling the user to save.
export function anyCapped() {
  for (const rec of recordings.values()) {
    if (rec.capped) return true;
  }
  return false;
}

// Returns the cap (so UI can mention the limit if it shows).
export const RECORDING_MAX_EVENTS = MAX_EVENTS;

export function activeTabIds() {
  return Array.from(recordings.keys());
}

export function onChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// The asciinema v2 header line for a recording (shared by the in-memory
// formatCast and the disk checkpoint's seed write so both agree byte-for-byte).
function castHeaderLine(rec) {
  return JSON.stringify({
    version: 2,
    width: rec.width,
    height: rec.height,
    timestamp: Math.floor(Date.now() / 1000),
    title: rec.label,
    env: { TERM: "xterm-256color" },
  });
}

function formatCast(rec) {
  const lines = [castHeaderLine(rec)];
  for (const ev of rec.events) {
    // ev = [t, "o", data] — JSON.stringify a 3-element array
    lines.push(JSON.stringify(ev));
  }
  return lines.join("\n") + "\n";
}
