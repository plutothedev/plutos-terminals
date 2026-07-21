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
const ptyIds = new Map(); // tabId -> live pty channel id ("pty-…", from pty_spawn)
const dims = new Map(); // tabId -> { cols, rows }
const visible = new Set(); // tabIds whose pane is currently shown
const dimsListeners = new Set(); // () => void
let bridgeVersion = 0; // bumped once per emitDims() call — see subscribeBridge below

// MultiExec broadcast mode (module-level, so per-window). When on, a keystroke
// or snippet goes to every visible terminal rather than just the focused one.
let broadcastMode = false;
// Optional broadcast group: when set to a Set of tabIds, broadcast targets ONLY
// those tabs (regardless of visibility — the user chose them explicitly). When
// null, the default applies: every visible terminal.
let broadcastTargets = null;

function emitDims() {
  bridgeVersion++;
  for (const cb of dimsListeners) {
    try {
      cb();
    } catch {
      /* a bad listener shouldn't break the others */
    }
  }
}

// ── Writer registry (TerminalPane) ─────────────────────────────────────────

export function registerPtyWriter(tabId, fn, isVisible = true) {
  if (!tabId || typeof fn !== "function") return;
  writers.set(tabId, fn);
  // Reflect the pane's ACTUAL visibility at registration (passed from the live
  // visibleRef), routed through the single setTabVisible mutation path. Default
  // true keeps a freshly-spawned ACTIVE tab in the broadcast set with no gap;
  // a background tab passes false so a MultiExec broadcast can't land in it
  // mid-init (e.g. while its welcome-box/clear setup is still running).
  setTabVisible(tabId, isVisible);
}

export function unregisterPty(tabId) {
  if (!tabId) return;
  writers.delete(tabId);
  readers.delete(tabId);
  ptyIds.delete(tabId);
  dims.delete(tabId);
  visible.delete(tabId);
  // Fail an in-flight agent capture fast: without this a runAndCapture on a tab
  // that's being closed sits idle until its 120s timeout (the writer is already
  // gone, so no block-done can ever arrive to resolve it).
  const cap = pendingCapture.get(tabId);
  if (cap) { pendingCapture.delete(tabId); cap.resolve(null); }
  emitDims();
}

// ── Live PTY channel ids (TerminalPane registers; the phone companion reads) ──
// pty_spawn mints a fresh registry id per session ("pty-…") that the renderer
// listens on as `pty://<id>` — it is NOT the tabId. The companion needs this id
// to subscribe to live output and to write/resize, so each pane publishes it
// here keyed by its tabId (= scrollback key). emitDims doubles as the "bridge
// changed" pulse so TerminalsTab re-pushes the session list when panes spawn.

export function setPtyId(tabId, ptyId) {
  if (!tabId) return;
  if (ptyId) ptyIds.set(tabId, ptyId);
  else ptyIds.delete(tabId);
  emitDims();
}

export function getPtyId(tabId) {
  return ptyIds.get(tabId) || null;
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

// ── Command history (captured via OSC 1337 from the shell preexec hook) ──────
// Cross-session, deduped (most-recent-first), capped, and persisted so Ctrl+R
// search survives restarts.
const HISTORY_KEY = "plutos-terminals:cmdhistory:v0";
const HISTORY_CAP = 500;
let cmdHistory = [];
try {
  const raw = localStorage.getItem(HISTORY_KEY);
  const parsed = raw ? JSON.parse(raw) : [];
  if (Array.isArray(parsed)) cmdHistory = parsed;
} catch { /* ignore */ }

export function recordCommand(cmd) {
  const c = String(cmd || "").trim();
  if (!c || c.length > 400) return; // skip empty / huge pastes
  cmdHistory = cmdHistory.filter((x) => x !== c); // move-to-front (dedupe)
  cmdHistory.unshift(c);
  if (cmdHistory.length > HISTORY_CAP) cmdHistory.length = HISTORY_CAP;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(cmdHistory)); } catch { /* ignore */ }
}

export function getCommandHistory() {
  return cmdHistory.slice();
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

// ── Bridge version (useSyncExternalStore surface, #27) ──────────────────────
// getBridgeVersion/subscribeBridge give React's useSyncExternalStore a
// (subscribe, getSnapshot) pair instead of a bespoke bump-state effect.
// Single-channel: every event that already calls emitDims (dims resize,
// ptyId assign/clear, unregister) bumps bridgeVersion and fires every
// subscriber, so a consumer never misses a change. (The old onDimsChange
// callback API was deleted once its last consumer moved here.)

export function getBridgeVersion() {
  return bridgeVersion;
}

export function subscribeBridge(cb) {
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

// Set the broadcast group: an array/Set of tabIds, or null for "all visible".
export function setBroadcastTargets(ids) {
  broadcastTargets = ids && [...ids].length ? new Set(ids) : null;
}

// Current broadcast group as an array, or null when targeting all visible.
export function getBroadcastTargets() {
  return broadcastTargets ? [...broadcastTargets] : null;
}

// tabIds that currently have a live PTY writer (for the group picker).
export function getLiveTabIds() {
  return [...writers.keys()];
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

// ── Agent command capture (Native Agent Mode) ───────────────────────────────
// The agent runs a command in a tab and needs its output back. TerminalPane
// reports each finished command block here (via reportBlockDone); runAndCapture
// writes a command then resolves with the next block-done for that tab. Falls
// back to the recent buffer text on timeout. Sequential by design — the agent
// awaits each step, so at most one capture is pending per tab.
const pendingCapture = new Map(); // tabId -> { resolve, command }

export function reportBlockDone(tabId, block) {
  const p = pendingCapture.get(tabId);
  if (!p) return;
  // Correlate the block to the command we actually wrote. A foreign block-done
  // (a startCommand finishing, a command the user typed, a background prompt)
  // would otherwise resolve the agent's capture with the WRONG output. When the
  // block carries no command (no OSC PlutoCmd), we can't correlate — fall back to
  // resolving so the agent never hangs waiting for a marker that won't come.
  const want = (p.command || "").trim();
  const got = ((block && block.command) || "").trim();
  if (want && got && want !== got) return; // not our command — keep waiting
  pendingCapture.delete(tabId);
  p.resolve(block);
}

export function runAndCapture(tabId, command, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const prev = pendingCapture.get(tabId);
    if (prev) { pendingCapture.delete(tabId); prev.resolve(null); }
    const entry = { resolve, command };
    pendingCapture.set(tabId, entry);
    const ok = writeToTab(tabId, command + "\r");
    if (!ok) { pendingCapture.delete(tabId); resolve(null); return; }
    setTimeout(() => {
      if (pendingCapture.get(tabId) === entry) {
        pendingCapture.delete(tabId);
        resolve({ command, output: getTabText(tabId), exit: null, timedOut: true });
      }
    }, timeoutMs);
  });
}

// MultiExec: fan a write out to every VISIBLE terminal (the active tab of each
// panel), optionally skipping the originating tab so a keystroke isn't doubled
// in the pane that produced it. Returns the number of terminals written to.
export function writeBroadcast(data, { exceptTabId } = {}) {
  let n = 0;
  for (const [tabId, fn] of writers) {
    if (tabId === exceptTabId) continue;
    // A custom group targets exactly its tabs (visible or not); otherwise the
    // default is every currently-visible terminal.
    if (broadcastTargets) {
      if (!broadcastTargets.has(tabId)) continue;
    } else if (!visible.has(tabId)) {
      continue;
    }
    try {
      fn(data);
      n += 1;
    } catch {
      /* skip a dead writer */
    }
  }
  return n;
}
