// (C)
// Keystroke macros: record what you type into a terminal, save it, replay it
// into the active terminal (or broadcast it) later. Recording taps TerminalPane's
// onData (the same byte stream sent to the PTY), so it captures control chars and
// Enter exactly as typed. Macros persist in localStorage.
const KEY = "plutos-terminals:macros:v0";

let recording = false;
let buffer = "";
const listeners = new Set();

function emit() { listeners.forEach((cb) => { try { cb(recording); } catch { /* ignore */ } }); }

export function onMacroStateChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function isMacroRecording() { return recording; }

export function startMacroRecording() { recording = true; buffer = ""; emit(); }

export function cancelMacroRecording() { recording = false; buffer = ""; emit(); }

// Stop and return the captured bytes (may be empty).
export function stopMacroRecording() {
  recording = false;
  const out = buffer;
  buffer = "";
  emit();
  return out;
}

// Called from every terminal's onData; appends only while recording.
export function recordInput(data) {
  if (recording && typeof data === "string") buffer += data;
}

export function loadMacros() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveMacros(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

// Human-readable preview of a macro's raw bytes (show control chars as symbols).
export function previewMacro(data, max = 48) {
  const s = (data || "")
    .replace(/\r/g, "⏎")
    .replace(/\t/g, "⇥")
    .replace(/\x1b/g, "␛")
    .replace(/[\x00-\x1f]/g, "·");
  return s.length > max ? s.slice(0, max) + "…" : s;
}
