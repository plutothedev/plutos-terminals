// (C)
// Keystroke macros: record what you type into a terminal, save it, replay it
// into the active terminal (or broadcast it) later. Recording taps TerminalPane's
// onData (the same byte stream sent to the PTY), so it captures control chars and
// Enter exactly as typed. Macros persist in localStorage.
const KEY = "plutos-terminals:macros:v0";

let recording = false;
let armedTabId = null; // only this tab's keystrokes are captured
let buffer = "";
const listeners = new Set();

function emit() { listeners.forEach((cb) => { try { cb(recording); } catch { /* ignore */ } }); }

export function onMacroStateChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function isMacroRecording() { return recording; }

// Arm recording, scoped to ONE tab. Previously global: every keystroke in EVERY
// terminal — including ssh/sudo/login passwords typed in a tab you weren't even
// looking at — was captured and persisted. Scoping to the armed tab limits the
// blast radius to the terminal the user is intentionally recording.
export function startMacroRecording(tabId = null) { recording = true; armedTabId = tabId; buffer = ""; emit(); }

export function cancelMacroRecording() { recording = false; armedTabId = null; buffer = ""; emit(); }

// Stop and return the captured bytes (may be empty).
export function stopMacroRecording() {
  recording = false;
  armedTabId = null;
  const out = buffer;
  buffer = "";
  emit();
  return out;
}

// Called from every terminal's onData; appends only while recording AND only for
// the armed tab (null = any, for back-compat callers that don't pass a tab).
export function recordInput(tabId, data) {
  if (recording && typeof data === "string" && (armedTabId == null || tabId === armedTabId)) buffer += data;
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
