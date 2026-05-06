// Asciinema-format session recording. v0.1.18.
//
// API: startRecording(tabId, { width, height, label })
//      stopRecording(tabId) → returns the .cast file contents (asciinema v2)
//      isRecording(tabId)   → boolean
//      pushOutput(tabId, data) → record an "o" (output) event
//      activeTabIds()       → list of currently-recording tab ids
//      onChange(callback)   → subscribe to recording-state changes (returns unsubscribe)
//
// Recording is in-memory only until stopped. The asciinema v2 format is
// JSONL: header object on line 1, then one [timestamp, "o", data] event
// per subsequent line.
//
// Reference: https://docs.asciinema.org/manual/asciicast/v2/

const recordings = new Map(); // tabId → { startTs, width, height, label, events: [], capped }
const listeners = new Set();

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
  recordings.set(tabId, {
    startTs: performance.now(),
    width: opts.width || 80,
    height: opts.height || 24,
    label: opts.label || tabId,
    events: [],
  });
  notify();
  return true;
}

export function stopRecording(tabId) {
  if (!tabId) return null;
  const rec = recordings.get(tabId);
  if (!rec) return null;
  recordings.delete(tabId);
  notify();
  return formatCast(rec);
}

export function isRecording(tabId) {
  return recordings.has(tabId);
}

export function pushOutput(tabId, data) {
  const rec = recordings.get(tabId);
  if (!rec) return;
  if (rec.capped) return;
  const t = (performance.now() - rec.startTs) / 1000;
  rec.events.push([t, "o", data]);
  if (rec.events.length >= MAX_EVENTS) {
    rec.capped = true;
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

function formatCast(rec) {
  const header = {
    version: 2,
    width: rec.width,
    height: rec.height,
    timestamp: Math.floor(Date.now() / 1000),
    title: rec.label,
    env: { TERM: "xterm-256color" },
  };
  const lines = [JSON.stringify(header)];
  for (const ev of rec.events) {
    // ev = [t, "o", data] — JSON.stringify a 3-element array
    lines.push(JSON.stringify(ev));
  }
  return lines.join("\n") + "\n";
}
