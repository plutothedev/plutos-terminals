// (C)
// Lightweight bridge between TerminalPane (each owns one PTY) and the rest of
// the app — snippet insertion, the status-bar size readout, and MultiExec
// broadcast. Module-level singletons keyed by tabId so PTY ids don't have to
// thread down through TerminalPanel → TerminalPane as props.
//
// Each TerminalPane registers a writer when its PTY spawns and unregisters on
// unmount. Consumers (TerminalsTab) look a tab up by id and write to it, read
// its live dimensions, or fan a write out to every visible terminal at once.

const writers = new Map(); // tabId -> (data: string) => void
const readers = new Map(); // tabId -> () => string (recent terminal text)
const dims = new Map(); // tabId -> { cols, rows }
const visible = new Set(); // tabIds whose pane is currently shown
const dimsListeners = new Set(); // () => void

// MultiExec broadcast mode (module-level, so per-window). When on, a keystroke
// or snippet goes to every visible terminal rather than just the focused one.
let broadcastMode = false;

function emitDims() {
  for (const cb of dimsListeners) {
    try {
      cb();
    } catch {
      /* a bad listener shouldn't break the others */
    }
  }
}

// ── Writer registry (TerminalPane) ─────────────────────────────────────────

export function registerPtyWriter(tabId, fn) {
  if (!tabId || typeof fn !== "function") return;
  writers.set(tabId, fn);
  // Assume visible until the pane's visibility effect says otherwise — avoids a
  // window where a freshly-spawned active tab is missing from the broadcast set.
  visible.add(tabId);
}

export function unregisterPty(tabId) {
  if (!tabId) return;
  writers.delete(tabId);
  readers.delete(tabId);
  dims.delete(tabId);
  visible.delete(tabId);
  emitDims();
}

// ── Terminal text reader (TerminalPane exposes recent buffer; AI features read) ─

export function registerTabReader(tabId, fn) {
  if (tabId && typeof fn === "function") readers.set(tabId, fn);
}

// Returns recent terminal text for a tab (for AI summaries), "" if unavailable.
export function getTabText(tabId) {
  const fn = readers.get(tabId);
  if (!fn) return "";
  try { return fn() || ""; } catch { return ""; }
}

// ── Dimensions (TerminalPane writes, status bar reads) ──────────────────────

export function setTabDims(tabId, cols, rows) {
  if (!tabId) return;
  const prev = dims.get(tabId);
  if (prev && prev.cols === cols && prev.rows === rows) return;
  dims.set(tabId, { cols, rows });
  emitDims();
}

export function getTabDims(tabId) {
  return dims.get(tabId) || null;
}

export function onDimsChange(cb) {
  dimsListeners.add(cb);
  return () => dimsListeners.delete(cb);
}

// ── Visibility (drives MultiExec broadcast targeting) ───────────────────────

export function setTabVisible(tabId, isVisible) {
  if (!tabId) return;
  if (isVisible) visible.add(tabId);
  else visible.delete(tabId);
}

// ── MultiExec broadcast mode ────────────────────────────────────────────────

export function setBroadcast(enabled) {
  broadcastMode = !!enabled;
}

export function isBroadcast() {
  return broadcastMode;
}

// ── Transient SSH passwords ─────────────────────────────────────────────────
// Held in memory only (never localStorage), keyed by tabId. Set when the user
// enters a password in the connect modal; read by TerminalPane at ssh_spawn.
// The encrypted credential vault is a later phase; for now a password lives
// only for the app session and is gone on restart (re-prompt to reconnect).
const passwords = new Map(); // tabId -> string

export function setTabPassword(tabId, pw) {
  if (tabId) passwords.set(tabId, pw);
}

export function getTabPassword(tabId) {
  return passwords.get(tabId) ?? null;
}

export function clearTabPassword(tabId) {
  passwords.delete(tabId);
}

// ── Writes ──────────────────────────────────────────────────────────────────

// Write to one tab's PTY. Returns false if that tab has no live writer yet.
export function writeToTab(tabId, data) {
  const fn = writers.get(tabId);
  if (!fn) return false;
  try {
    fn(data);
    return true;
  } catch {
    return false;
  }
}

// MultiExec: fan a write out to every VISIBLE terminal (the active tab of each
// panel), optionally skipping the originating tab so a keystroke isn't doubled
// in the pane that produced it. Returns the number of terminals written to.
export function writeBroadcast(data, { exceptTabId } = {}) {
  let n = 0;
  for (const [tabId, fn] of writers) {
    if (tabId === exceptTabId) continue;
    if (!visible.has(tabId)) continue;
    try {
      fn(data);
      n += 1;
    } catch {
      /* skip a dead writer */
    }
  }
  return n;
}
