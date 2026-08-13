import { useEffect, useRef, useState } from "react";
import { invoke } from "@backend";
import { listen } from "@backend";
import { setPaneActivity } from "./activityStore.js";
import { stripAnsi, detectPendingPrompt } from "./promptDetect.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { ImageAddon } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";
import { pushOutput as pushRecordingOutput } from "./recording.js";
import { envForModel } from "./providers.js";
import { readUserSt, getWindowStorageKey, isPrimaryWindow } from "./storageKeys.js";
import ErrorExplainer from "./ErrorExplainer.jsx";
import { recordInput } from "./macros.js";
import { actionForEvent } from "./keybindings.js";
import { buildWelcomeBanner } from "./welcomeBanner.js";
import { buildPosixShellInit, buildPowerShellInit } from "./shellIntegration.js";
import { resolveEnvFromUserState } from "./spawnEnv.js";
import PromptEditor from "./PromptEditor.jsx";
import ShareModal from "./ShareModal.jsx";
import { MONO_STACK } from "./fonts.js";
import { blockOutputText } from "./blockText";
import {
  registerPtyWriter,
  unregisterPty,
  setPtyId,
  setTabDims,
  setTabVisible,
  isBroadcast,
  writeBroadcast,
  getTabPassword,
  writeToTab,
  registerTabReader,
  recordCommand,
  reportBlockDone,
} from "./ptyBridge.js";
import {
  ensureEntry,
  getEntry,
  attachHost,
  detachHost,
  registerDestroyHook,
  destroyEntry,
} from "./paneRegistry.js";

// v0.1.25: soft "ding" when a backgrounded agent finishes. Uses Web Audio
// rather than an mp3 asset so there's nothing to bundle. Two-note ascending
// pluck — short enough to not annoy, distinct enough to register. Lazy-init
// the AudioContext on first call (browsers require user gesture before).
let _audioCtx = null;
function playDoneCue() {
  if (typeof window === "undefined") return;
  try {
    if (!_audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      _audioCtx = new Ctx();
    }
    if (_audioCtx.state === "suspended") {
      _audioCtx.resume().catch(() => {});
    }
    const now = _audioCtx.currentTime;
    [
      { freq: 660, start: 0, dur: 0.08 },
      { freq: 880, start: 0.08, dur: 0.16 },
    ].forEach(({ freq, start, dur }) => {
      const osc = _audioCtx.createOscillator();
      const gain = _audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.value = 0;
      gain.gain.linearRampToValueAtTime(0.06, now + start + 0.01);
      gain.gain.linearRampToValueAtTime(0, now + start + dur);
      osc.connect(gain).connect(_audioCtx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.01);
    });
  } catch (_) {
    // Audio is non-critical — silent fail.
  }
}

const MIN_COLS = 40;
const MIN_ROWS = 10;

// Activity state machine constants (per Moon Dev): only fire dots when the
// user isn't already watching, and only after they've actually typed at least
// once. Without `userHasTyped` we'd light up on the shell prompt itself.
const ACTIVITY_BYTE_THRESHOLD = 500;
const DONE_TIMEOUT_MS = 5000;

// Scrollback persistence: keep the last ~100KB of PTY output in memory for
// agent capture / cost scans. Disk persistence is owned by the Rust reader
// thread (two ~5MB rotation segments); restore replays the last ~256KB tail
// via scrollback_load (P1-T6) — enough to fill xterm's buffer, not megabytes
// parsed at boot.
const SCROLLBACK_MAX_BYTES = 100_000;

// Session transcripts: ANSI-stripped output appended to a daily markdown
// file every 5s (or sooner if 8KB has accumulated). Lets the user grep
// "what did claude work on Monday?" later.
const TRANSCRIPT_FLUSH_MS = 5000;
const TRANSCRIPT_FLUSH_BYTES = 8000;

// Shared transcript flush ticker (P2-T5): ONE 5s interval driving every
// pane's flusher instead of one interval per pane (20 panes = 4 timer
// wakeups/s for the same work). Registration is CREATE-ONCE at first mount —
// the transcript buffers are first-fiber-bound, so a per-mount registration
// would flush a moved pane's empty new-fiber buffer forever (plan-audit H4) —
// and unregistered via the registry destroy hook (registry-lifetime, like the
// bridge writer). Each registered fn owns its own midnight date-roll.
const transcriptFlushers = new Map(); // tabId -> () => void
let transcriptTicker = null;
function registerTranscriptFlusher(tabId, fn) {
  transcriptFlushers.set(tabId, fn);
  if (!transcriptTicker) {
    transcriptTicker = setInterval(() => {
      for (const f of transcriptFlushers.values()) {
        try { f(); } catch { /* one pane's failure must not starve the rest */ }
      }
    }, TRANSCRIPT_FLUSH_MS);
  }
}
function unregisterTranscriptFlusher(tabId) {
  transcriptFlushers.delete(tabId);
  if (transcriptFlushers.size === 0 && transcriptTicker) {
    clearInterval(transcriptTicker);
    transcriptTicker = null;
  }
}

// Auto-approve: scan the recent output buffer for Claude's permission
// prompt pattern. Throttled so a stuck prompt can't loop us.
const AUTO_APPROVE_BUFFER_BYTES = 2000;
const AUTO_APPROVE_DEBOUNCE_MS = 3000;

// Cost / token regexes — match what Claude Code prints in `/cost` output and
// the session status banner. Patterns tried in order; we take the MAX of all
// matches found anywhere in the cost-scan buffer (10KB window into scrollback,
// since the 2KB recent buffer rotates the banner out fast).
const COST_RE = /total\s+cost\s*[:=]?\s*\$(\d+(?:\.\d+)?)/i;
const TOKENS_PATTERNS = [
  // "(38,143 total tokens)" — Claude /cost summary parens form
  /\(\s*([\d,.]+)\s*([kmKM])?\s*total\s+tokens?\s*\)/i,
  // "Total tokens: 38,143" or "Total tokens used: 38,143"
  /total\s+tokens?(?:\s*used)?\s*[:=]?\s*([\d,.]+)\s*([kmKM])?/i,
  // "38.1k tokens" / "1.2M tokens" — status banner abbreviated form
  // (requires k/M suffix so a stray "5 tokens" mention can't false-positive)
  /([\d,.]+)\s*([kmKM])\s+tokens?/i,
];
// Claude /cost model line: "claude-opus-4-5: 12,345 input, 6,789 output, 0 cache read, 0 cache write"
// Sums all four categories. Matches multiple lines (one per model) and adds them.
const MODEL_LINE_RE = /([\d,]+)\s*input,\s*([\d,]+)\s*output(?:,\s*([\d,]+)\s*cache\s*read)?(?:,\s*([\d,]+)\s*cache\s*write)?/gi;
const COST_SCAN_BYTES = 10_000;

// Per-family blended cost per 1M tokens (USD). Used to derive a live cost
// estimate from observed token counts when Claude Code hasn't printed an
// explicit "Total cost: $X.XX" line yet (the inline status banner shows
// tokens like "1.6k tokens · thought for 2s" but never the dollar figure).
//
// Blended rate assumes a typical Claude Code mix: cache-heavy input + moderate
// output. Real cost depends on the input/output/cache-read/cache-write split,
// but this estimate is within 2x of the real number for normal sessions, and
// the explicit COST_RE match takes priority whenever pluto runs /cost.
//
// Source: Anthropic Claude API pricing for the Claude 4.x family with prompt
// caching enabled. Estimate is per million total tokens charged through the
// API, weighting cache-read at ~75%, fresh-input at ~12%, output at ~13%.
const FAMILY_BLENDED_RATE_PER_M = {
  opus: 12.0,
  sonnet: 2.5,
  haiku: 0.7,
};
const DEFAULT_FAMILY = "opus"; // Worst-case fallback when banner not yet parsed.

// Detect which Claude family is in play by scanning the welcome banner /
// status line. Claude Code prints e.g. "Opus 4.7 (1M context) with high
// effort · Claude Max" near session start, and "claude-opus-4-7" in /cost
// output. Both surface forms (friendly + API) covered.
const FAMILY_DETECT_RE = /\bclaude-(opus|sonnet|haiku)\b|\b(opus|sonnet|haiku)\s*[0-9]/i;
function detectFamily(text) {
  const m = text.match(FAMILY_DETECT_RE);
  if (!m) return DEFAULT_FAMILY;
  return (m[1] || m[2] || DEFAULT_FAMILY).toLowerCase();
}

function tokensFromMatch(m) {
  if (!m) return 0;
  let v = parseFloat((m[1] || "0").replace(/,/g, ""));
  const suffix = (m[2] || "").toLowerCase();
  if (suffix === "k") v *= 1000;
  else if (suffix === "m") v *= 1_000_000;
  return Number.isFinite(v) ? v : 0;
}

function sumModelLines(text) {
  let total = 0;
  let m;
  // Reset lastIndex since regex is /g
  MODEL_LINE_RE.lastIndex = 0;
  while ((m = MODEL_LINE_RE.exec(text)) !== null) {
    let lineSum = 0;
    for (const cap of [m[1], m[2], m[3], m[4]]) {
      if (cap) lineSum += parseInt(cap.replace(/,/g, ""), 10) || 0;
    }
    if (lineSum > total) total = lineSum;
  }
  return total;
}

// stripAnsi + the permission-prompt detector live in promptDetect.js (P2-T5
// review: the detector needed to be pure + tested; sharing one import keeps
// the transcript strip and the detector's strip from drifting).

// Exported so the block/transcript share handlers (Stream D) can stamp the
// share filename's date at click time — the modal and buildShare stay pure and
// never call `new Date()` themselves (deterministic filename contract).
export function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Exported so TerminalPanel (the read side of Share transcript) shares this exact
// stem instead of duplicating it. Format: "<project-or-tab>-<last6ofTabId>".
export function transcriptName(projectName, tabId) {
  const base = projectName ? `${projectName}` : "tab";
  const short = (tabId || "").slice(-6);
  return `${base}-${short}`;
}

// One terminal pane. B1: the xterm instance, its host DOM element, and the PTY
// session are owned by the pane REGISTRY (paneRegistry.js), keyed by this
// pane's leaf id — the first mount creates them, and unmount PARKS by default
// (detach the host, keep the session) so a move between panels re-attaches the
// live terminal instead of kill+respawn. Real closes are the reconcile sweep's
// job (TerminalsTab destroys entries whose pane id left the tree); only a
// mid-spawn unmount destroys inline (decision 6).
// `visible` toggles display so a hidden tab keeps its PTY + scrollback alive.
// `startCommands` is captured at mount and auto-typed after the shell init.
// `xtermTheme` is the xterm.js theme object (background / foreground / cursor /
//   ANSI palette). Driven by the active app skin via headerSkins.js
//   getSkinXtermTheme(). Passed down from TerminalsTab → TerminalPanel → here.
// `tabId` keys the on-disk scrollback file.
// `projectName` shapes the transcript filename.
// `autoApprove` enables Claude permission auto-confirmation.
// `onCostUpdate({tokens, cost})` reports up; activity goes straight to the
// module activity store (P2-T1).
export default function TerminalPane({
  visible,
  active = true,
  cwd,
  connection,
  serial,
  startCommands,
  systemPrompt,
  xtermTheme,
  tabId,
  projectName,
  autoApprove,
  onCostUpdate,
  promptEditor = false, // opt-in app-owned prompt editor (Milestone 2, slice 1)
  promptEditorVim = false, // vim keybindings inside the prompt editor
  saveUser = () => {},  // functional user-store writer, threaded from TerminalsTab for ShareModal
}) {
  const containerRef = useRef(null);
  const wrapperRef = useRef(null);
  const fitRef = useRef(null);
  const termRef = useRef(null);
  const searchAddonRef = useRef(null);
  // App-owned prompt editor state (gated by OSC-133 prompt state).
  const [atPrompt, setAtPrompt] = useState(false);
  const [altScreen, setAltScreen] = useState(false);
  const [shellCwd, setShellCwd] = useState(cwd || null); // live cwd from OSC 1337 PlutoCwd
  const [peRect, setPeRect] = useState({ top: 0, left: 0, width: 0, height: 0 });
  const peEnabledRef = useRef(promptEditor);
  peEnabledRef.current = promptEditor;
  const captureRef = useRef(null);   // latest prompt-capture fn for the OSC handler
  const settleTimerRef = useRef(null);
  // Find-in-terminal (Cmd/Ctrl+F) overlay state.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Command blocks (OSC 133): track the block boundaries the shell marks so we
  // can flag a failed command + feed it to the AI explainer.
  // The open block between A and D lives at entry.blocks.current (registry —
  // survives pane moves). These two refs are POINTED at the registry entry's
  // arrays (entry.blocks.list / entry.blocks.decorations) by the main effect on
  // every mount — the arrays are only ever mutated in place (push/shift/splice)
  // so every fiber's ref aliases the same shared containers.
  const blocksRef = useRef([]);         // finished blocks (capped) for right-click actions
  const blockDecorationsRef = useRef([]); // xterm decorations tinting each command block
  const [failedBlock, setFailedBlock] = useState(null);  // banner: most recent failure
  const [blockMenu, setBlockMenu] = useState(null); // right-click block actions { block, x, y }
  const [stickyBlock, setStickyBlock] = useState(null); // command pinned at top while scrolled into its output
  const [explainBlock, setExplainBlock] = useState(null); // explainer popover target
  const [shareTarget, setShareTarget] = useState(null); // { kind, title, rawText, dateStamp } | null — open share preview (Stream D)
  const startCommandsRef = useRef(startCommands);
  startCommandsRef.current = startCommands;
  const systemPromptRef = useRef(systemPrompt);
  systemPromptRef.current = systemPrompt;
  const xtermThemeRef = useRef(xtermTheme);
  xtermThemeRef.current = xtermTheme;

  // Activity tracking refs. (The user-has-typed gate lives at
  // entry.counters.userHasTyped — it must survive pane moves.)
  const activityRef = useRef("idle");
  const bytesSinceSeenRef = useRef(0);
  // Welcome-banner re-render on resize: a fresh local shell's banner is baked
  // into scrollback at boot width and can't reflow, so splitting the pane garbles
  // it. While the pane is still untouched we reprint it at the new width.
  const bannerRedrawRef = useRef(null);    // (cols) => Promise, or null when not armed
  const bannerColsRef = useRef(0);         // width the banner was last drawn at
  const bannerRedrawTimerRef = useRef(null);
  const doneTimerRef = useRef(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Whether this pane is the focused one within its tab (relevant when the tab
  // is split into multiple panes). Gates autofocus-on-show so siblings don't
  // fight over focus. Read via ref so the visibility effect needn't re-run.
  const activeRef = useRef(active);
  activeRef.current = active;

  // Live-prop refs so we don't have to re-run the spawn effect on prop change.
  const onCostRef = useRef(onCostUpdate);
  onCostRef.current = onCostUpdate;
  const autoApproveRef = useRef(autoApprove);
  autoApproveRef.current = autoApprove;
  const lastNotifyAtRef = useRef(0);

  // "Away" = this tab isn't the one you're looking at, or the app window isn't
  // focused. Used to gate OS notifications + the done audio cue. Visibility is
  // read through entry.ui (repointed every mount) because this helper is
  // captured by create-once handlers — a dead fiber's visibleRef would freeze
  // at its park-time value (decision 4).
  const isAway = () => {
    const ui = entryRef.current?.ui;
    const vis = ui ? ui.isVisible() : visibleRef.current;
    return (
      !vis ||
      (typeof document !== "undefined" && document.hasFocus && !document.hasFocus())
    );
  };
  const notifyOS = (title, body) => {
    invoke("notify", { title, body }).catch(() => {});
  };
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;

  // Registry entry for this pane id (paneRegistry.js). Set by the main effect
  // on every mount and left pointing at the entry afterwards, so the
  // component-body helpers captured by create-once handlers (handleChunk →
  // appendScrollback / checkAutoApprove / checkCost, setActivity, isAway)
  // resolve the DURABLE entry — not per-fiber state — no matter which mount's
  // closure is running.
  const entryRef = useRef(null);

  // Project name resolved through entry.ui (the CURRENT fiber's ref) — same
  // dead-closure class as the setters: the readers below live in create-once
  // closures (setActivity's notifications, flushTranscript's filename,
  // checkAutoApprove's ping), where a dead fiber's projectNameRef would
  // freeze at its park-time value after a move + rename.
  const liveProjectName = () => {
    const ui = entryRef.current?.ui;
    return ui?.projectName ? ui.projectName() : projectNameRef.current;
  };

  // Scrollback / transcript buffers — populated from the PTY stream.
  // (The scrollback chunk list + byte count live at entry.counters.* so a
  // moved pane keeps its analysis buffers; transcript machinery stays
  // per-mount — see the flush destroy hook for the tail.)
  const transcriptBufRef = useRef("");
  const transcriptDateRef = useRef(todayDate());
  // Serializes this pane's transcript_append invokes (P1-T3 append-order).
  const transcriptChainRef = useRef(null);

  // Auto-approve state. (The recent-output match buffer lives at
  // entry.counters.recentOut so it survives pane moves.)
  const lastApproveAtRef = useRef(0);

  // Boot-conceal gate: while set ({ buf, timer }), incoming PTY chunks are
  // buffered instead of rendered, hiding the echoed shell-integration setup
  // (prompt function, OSC-133 hooks, PSReadLine config) that otherwise flashes
  // as a wall of code before Clear-Host paints the welcome box. Released when
  // the boot marker (emitted right before the clear) arrives — or by a 4s
  // timeout / 64KB cap that flushes everything, so an unexpected shell can
  // never leave the pane blank.
  const concealRef = useRef(null);

  // Cost tracker state — only emit when the latest seen value changes. The
  // last-seen {tokens, cost} and the sticky model family (held across
  // checkCost calls so the family signal survives the banner scrolling out of
  // the 10KB cost-scan window) both live at entry.counters.* — cost telemetry
  // must not jump backward after a pane move (B1 bug fix 2).
  // Coalesces the expensive cost scan (10KB tail + several regexes) to at most
  // one run per animation frame. A high-throughput burst fires the pty:// listener
  // hundreds of times/sec; checkCost reads the accumulated scrollback buffer (not
  // the chunk), so running it once per frame is lossless. checkAutoApprove stays
  // synchronous — it's cheap and must keep firing even while this window is hidden
  // (rAF is paused when hidden), which is exactly when auto-approve does its job.
  const costRafRef = useRef(0);
  const stickyRafRef = useRef(0);

  const setActivity = (next) => {
    if (activityRef.current === next) return;
    const prev = activityRef.current;
    activityRef.current = next;
    // Straight into the module-level activity store (P2-T1). The store is
    // fiber-agnostic, which retires the entry.ui.onActivity indirection this
    // line used to need for moved panes — and only THIS pane's subscribers
    // re-render instead of the whole app.
    try { setPaneActivity(tabIdRef.current, next); } catch {}
    // v0.1.25: audio cue when an agent transitions from working to done.
    // Soft Web-Audio-generated tone — no asset to bundle. Only fires when
    // the tab is NOT currently visible (you don't need a ding for the tab
    // you're staring at). Respects user gesture requirements: AudioContext
    // is created on demand and resumed if needed.
    // "waiting" counts as working-in-progress here: a session that was blocked
    // on a prompt and then reached done still earns the finished cue.
    if ((prev === "active" || prev === "waiting") && next === "done" && isAway()) {
      const pn = liveProjectName();
      try { playDoneCue(); } catch {}
      notifyOS("Agent finished ✓", pn ? `${pn} is done` : "A session finished");
      // Phone companion (Phase 5): push a "finished" alert when no phone is actively
      // connected (the companion no-ops if its server is off / a phone is viewing /
      // no push subscription). Primary window only, to avoid duplicate pushes.
      if (isPrimaryWindow()) {
        invoke("companion_notify_finish", { label: pn || "session", exit: 0 }).catch(() => {});
      }
    }
  };
  const clearDoneTimer = () => {
    if (doneTimerRef.current) {
      clearTimeout(doneTimerRef.current);
      doneTimerRef.current = null;
    }
  };

  const appendScrollback = (chunk) => {
    const e = entryRef.current;
    if (!chunk || !e) return;
    e.counters.scrollbackChunks.push(chunk);
    e.counters.scrollbackBytes += chunk.length;
    while (e.counters.scrollbackBytes > SCROLLBACK_MAX_BYTES && e.counters.scrollbackChunks.length > 1) {
      const dropped = e.counters.scrollbackChunks.shift();
      e.counters.scrollbackBytes -= dropped.length;
    }
  };

  const appendTranscript = (chunk) => {
    if (!chunk) return;
    transcriptBufRef.current += stripAnsi(chunk);
    if (transcriptBufRef.current.length >= TRANSCRIPT_FLUSH_BYTES) {
      flushTranscript();
    }
  };

  const flushTranscript = () => {
    const buf = transcriptBufRef.current;
    if (!buf) return;
    transcriptBufRef.current = "";
    const id = tabIdRef.current;
    if (!id) return;
    const name = transcriptName(liveProjectName(), id);
    // Chain appends per pane (P1-T3): transcript_append is async on the Rust
    // side now, so two in-flight invokes (a threshold flush + an unmount
    // flush) are independent tokio tasks that could land swapped and
    // interleave the file mid-line. The chain serializes them; errors break
    // the chain's PAYLOAD but never the chain itself.
    const prev = transcriptChainRef.current || Promise.resolve();
    transcriptChainRef.current = prev
      .then(() =>
        invoke("transcript_append", {
          date: transcriptDateRef.current,
          name,
          content: buf,
        })
      )
      .catch((e) => {
        // The buffer was cleared above, so a swallowed failure loses this
        // chunk of history permanently and silently (disk full, permissions).
        // Same rule the notebook save path already follows: a genuine disk
        // error must be visible somewhere. Log rather than toast — this fires
        // every few seconds per pane, and a toast storm would be worse.
        console.error("Pluto's Terminals: transcript flush failed", e);
      });
  };

  // The prompt heuristic, extracted so BOTH the auto-approve pass and the
  // visibility reset can ask the same question. A Claude permission prompt has
  // the arrow on option 1, a "Yes" option, an "(esc)" hint, AND the
  // "Do you want …?" question. Requiring the question anchors the match to
  // Claude's real permission framing so arbitrary attacker-influenced output
  // that merely echoes "❯ 1." / "Yes" / "(esc)" can't forge an
  // auto-confirmation (defense-in-depth atop the away-gate). All four markers
  // are still required together — this is a pure move, not a loosening.
  const hasPendingPrompt = () => {
    const e = entryRef.current;
    if (!e) return false;
    // Pure + tested detector (promptDetect.js): prefilter + four-marker scan.
    // A miss — prefilter or full — returns false through the same path, so
    // the caller's waiting→active un-block branch always runs.
    return detectPendingPrompt(e.counters.recentOut);
  };

  const checkAutoApprove = (ptyId) => {
    const e = entryRef.current;
    if (!ptyId || !e) return;
    const now = Date.now();
    // Trim recent buffer to last 2KB for cheap pattern matching.
    if (e.counters.recentOut.length > AUTO_APPROVE_BUFFER_BYTES) {
      e.counters.recentOut = e.counters.recentOut.slice(-AUTO_APPROVE_BUFFER_BYTES);
    }
    if (!hasPendingPrompt()) {
      // No prompt in the recent buffer any more: whatever we were blocked on is
      // resolved (answered here, answered elsewhere, or scrolled out as the
      // agent resumed), so stop reporting "waiting". This runs on every output
      // chunk, which is what makes it the natural un-block signal.
      if (activityRef.current === "waiting") setActivity("active");
      return;
    }
    // A detected prompt means this session is blocked on a human. Record that as
    // first-class activity BEFORE the away-gate below: an agent is waiting
    // whether or not you happen to be looking at its tab, and the fleet view in
    // the Monitor dock is exactly for the ones you are NOT looking at. This is
    // state only — it authorizes nothing.
    setActivity("waiting");
    // A blocked session must not age into "done" on the idle timer — it hasn't
    // finished, it is stuck on you.
    clearDoneTimer();
    // Invariant #7 (CLAUDE.md): only act on a permission prompt when the tab is
    // backgrounded/unfocused. A foregrounded tab is being supervised — never
    // auto-confirm there, so the watching user can intervene before a
    // destructive tool-use runs. The gate stays exactly here, guarding the
    // ACTION; the state above is deliberately outside it.
    if (!isAway()) return;
    if (e.ui ? e.ui.isAutoApprove() : autoApproveRef.current) {
      if (now - lastApproveAtRef.current < AUTO_APPROVE_DEBOUNCE_MS) return;
      lastApproveAtRef.current = now;
      invoke("pty_write", { id: ptyId, data: "1\r" }).catch(() => {});
      e.counters.recentOut = ""; // don't re-match the same prompt
      setActivity("active"); // answered on your behalf — no longer blocked
    } else if (now - lastNotifyAtRef.current > 15000) {
      // Auto-approve off + you're elsewhere → ping that a session needs you.
      lastNotifyAtRef.current = now;
      const pn = liveProjectName();
      notifyOS("Needs your input", pn ? `${pn} is waiting for approval` : "A session is waiting for approval");
    }
  };

  const checkCost = () => {
    const e = entryRef.current;
    if (!e) return;
    // Scan the LAST ~10KB of scrollback rather than the 2KB recent buffer —
    // the welcome banner with "38.1k tokens" and /cost summaries scroll out
    // of the recent buffer fast on a busy session.
    let bytes = 0;
    const parts = [];
    for (let i = e.counters.scrollbackChunks.length - 1; i >= 0; i--) {
      const chunk = e.counters.scrollbackChunks[i];
      parts.unshift(chunk);
      bytes += chunk.length;
      if (bytes >= COST_SCAN_BYTES) break;
    }
    const text = stripAnsi(parts.join(""));

    let next = { ...e.counters.lastCost };
    let changed = false;

    // Cost: only update if higher (cumulative session figure).
    const cm = text.match(COST_RE);
    if (cm) {
      const v = parseFloat(cm[1]);
      if (!Number.isNaN(v) && v > next.cost) { next.cost = v; changed = true; }
    }

    // Tokens: take the max value found across all patterns + model lines.
    let bestTokens = 0;
    for (const re of TOKENS_PATTERNS) {
      const v = tokensFromMatch(text.match(re));
      if (v > bestTokens) bestTokens = v;
    }
    const modelSum = sumModelLines(text);
    if (modelSum > bestTokens) bestTokens = modelSum;
    if (bestTokens > next.tokens) {
      next.tokens = bestTokens;
      changed = true;
    }

    // Derive a live cost estimate from total tokens × per-family blended
    // rate. Claude Code's inline status banner shows tokens climbing in real
    // time but never the dollar figure, so without this estimate the cost
    // stays at $0 until pluto runs /cost — which most sessions never trigger.
    // Authoritative COST_RE matches above already take priority via the
    // monotonic "only update if higher" rule. Estimate uses the cumulative
    // `next.tokens` (which never decreases) rather than `bestTokens` (the
    // snapshot in the current 10KB window, which can drop as banners scroll
    // out).
    if (!e.counters.family) {
      const detected = detectFamily(text);
      if (detected) e.counters.family = detected;
    }
    if (next.tokens > 0) {
      const family = e.counters.family || DEFAULT_FAMILY;
      const rate = FAMILY_BLENDED_RATE_PER_M[family] || FAMILY_BLENDED_RATE_PER_M[DEFAULT_FAMILY];
      const estimated = (next.tokens * rate) / 1_000_000;
      if (estimated > next.cost) {
        next.cost = estimated;
        changed = true;
      }
    }

    if (changed) {
      e.counters.lastCost = next;
      try { (e.ui?.onCost ?? onCostRef.current)?.(next); } catch {}
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── Registry attach (B1): the entry owns the xterm + PTY; this mount is a
    // slot. First mount creates everything; a re-attach (pane moved between
    // panels, or a cwd-prop change re-running this effect) re-parents the live
    // host and skips creation, handler registration, and the spawn IIFE — the
    // isFirstMount gate is what keeps start-commands from being retyped into a
    // live shell (B1 bug fix 3).
    const entry = ensureEntry(tabId);
    const isFirstMount = !entry.term;
    attachHost(tabId, container);
    entryRef.current = entry;
    // Liveness for create-once closures: "this pane's entry still exists AND
    // is still the one we were built for". Identity (not truthiness) so a
    // stray late callback from a closed pane can never touch a reopened pane's
    // fresh entry under the same id.
    const entryLive = () => getEntry(tabId) === entry;

    // Per-MOUNT liveness — only this mount's observers + fonts.ready refit use
    // it. Create-once code (listeners, handlers, the spawn IIFE) uses
    // entryLive() instead: it must keep working while the pane is parked.
    let alive = true;

    // Shared-container refs alias the entry's arrays (mutated in place only —
    // push/shift/splice — so every fiber's ref can point at the same object).
    blocksRef.current = entry.blocks.list;
    blockDecorationsRef.current = entry.blocks.decorations;

    // (3b') Per-mount UI pointer table — decision 4. Create-once handlers (OSC
    // parsers, onData/onResize/onScroll, handleChunk) outlive this fiber; any
    // per-fiber setter/ref they closed over would go permanently dead after
    // the first move. They call entry.ui.* at event time instead, and EVERY
    // mount overwrites this table with the current fiber's functions. While
    // the pane is parked, calls land on the previous fiber's setters — React
    // 18 silently no-ops setState on unmounted fibers — and resume against the
    // live fiber after the next repoint. Known cosmetic gap: UI-derived state
    // (shellCwd/atPrompt/altScreen/stickyBlock/failedBlock) changed during a
    // parked window is lost until the next event after re-attach.
    const prevUi = entry.ui;
    if (prevUi) {
      // Banner-redraw state is armed once, by the first mount's spawn IIFE,
      // but stored per-fiber; hand it forward so the "reprint banner at new
      // width" arm still works after a move.
      bannerRedrawRef.current = prevUi.bannerRedraw.get();
      bannerColsRef.current = prevUi.bannerCols.get();
    }
    entry.ui = {
      setFailedBlock,
      setShellCwd,
      setAtPrompt,
      setStickyBlock,
      setAltScreen,
      setSearchOpen,
      // The OSC-133 "A" prompt-editor arm (settle timer + capture): per-fiber
      // timer + capture fn, so the whole arm routes through the table.
      capturePrompt: () => {
        if (!peEnabledRef.current) return;
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = setTimeout(() => captureRef.current?.(), 70);
      },
      cancelPromptSettle: () => clearTimeout(settleTimerRef.current),
      isAutoApprove: () => autoApproveRef.current,
      isVisible: () => visibleRef.current,
      isActive: () => activeRef.current,
      projectName: () => projectNameRef.current,
      onCost: (next) => onCostRef.current?.(next),
      resizeReprint: (cols) => { bannerRedrawRef.current?.(cols); },
      bannerRedraw: { get: () => bannerRedrawRef.current, set: (fn) => { bannerRedrawRef.current = fn; } },
      bannerCols: { get: () => bannerColsRef.current, set: (v) => { bannerColsRef.current = v; } },
      // The activity state machine (activityRef / bytesSinceSeen / doneTimer)
      // is create-once — it lives in the FIRST mount's closures alongside
      // handleChunk. Carry its reset forward on every repoint so the current
      // fiber's visibility effect resets the machine that actually runs (a
      // fresh per-fiber reset would no-op and leave the activity dot stuck
      // after a move).
      resetActivity: prevUi?.resetActivity ?? (() => {
        bytesSinceSeenRef.current = 0;
        clearDoneTimer();
        // Looking at a tab clears its "you haven't seen this" states — but NOT
        // "waiting". A blocked session is still blocked after you glance at it,
        // and since the check only re-runs on new PTY output (of which a parked
        // process produces none), forcing idle here would drop the flag
        // permanently without anything having been answered.
        setActivity(hasPendingPrompt() ? "waiting" : "idle");
      }),
    };

    // Cleanup is park-by-default: detach the host and leave the entry (xterm,
    // PTY, counters) alive for the next mount. Only a mid-spawn unmount
    // destroys (decision 6) — there is nothing live to hand off, and the
    // in-flight spawn's orphan guard kills the PTY on arrival. Real closes are
    // the reconcile sweep's job (TerminalsTab); lock/crash is destroyAll's.
    // Every step tolerates the entry being ALREADY gone — ErrorBoundary's
    // componentDidCatch destroyAll typically runs BEFORE a crashed pane's own
    // cleanup flushes.
    const paneCleanup = (vis, ro) => () => {
      alive = false;
      vis.disconnect();
      ro.disconnect();
      clearDoneTimer();
      clearTimeout(bannerRedrawTimerRef.current); // pending banner reprint must not fire post-unmount
      // Accepted gap: if a fresh local pane parks inside its ~4s boot-conceal
      // window, the buffered boot output is dropped (the pane may look blank
      // until the next output) — pre-existing park-time conceal semantics.
      if (concealRef.current) {
        clearTimeout(concealRef.current.timer);
        concealRef.current = null;
      }
      if (costRafRef.current) {
        cancelAnimationFrame(costRafRef.current);
        costRafRef.current = 0;
      }
      if (stickyRafRef.current) {
        cancelAnimationFrame(stickyRafRef.current);
        stickyRafRef.current = 0;
      }
      // (The 5s flush now rides the shared module ticker, registered
      // create-once and unregistered by the destroy hook — a park no longer
      // kills periodic flushing for moved panes. P2-T5.)
      flushTranscript();
      detachHost(tabId);
      const e = getEntry(tabId);
      if (e && e === entry && e.spawnState === "starting") destroyEntry(tabId); // mid-spawn: no live handoff (decision 6)
      // otherwise: park. The PTY, xterm, event listeners, and bridge
      // registrations stay live on the entry; the destroy hooks own their
      // teardown (the old six-statement close block dissolved into them).
      termRef.current = null;
      fitRef.current = null;
    };

    if (!isFirstMount) {
      // ── Re-attach: restore this fiber's component refs from the entry. ──
      termRef.current = entry.term;
      fitRef.current = entry.fit;
      searchAddonRef.current = entry.search;
      // Observers get a refit-ONLY callback — NEVER the first mount's
      // openIfVisible: its body does term.open + loadAddon(new ImageAddon())
      // unconditionally, and reusing it would stack a duplicate ImageAddon per
      // move (audit HIGH). One exception lives inside: a pane that parked
      // BEFORE ever becoming visible (a background tab moved before its first
      // view) was never open()ed — the first mount's deferred open died with
      // its observers, so it happens here instead, and ImageAddon still loads
      // exactly once per terminal lifetime (only on this never-opened path).
      const refitOnly = () => {
        if (!alive || !container.clientWidth || !container.clientHeight) return;
        const t = entry.term;
        if (!t) return;
        if (!t.element) {
          try {
            t.open(entry.host);
            t.loadAddon(new ImageAddon());
          } catch { /* ignore */ }
        }
        try { entry.fit?.fit(); } catch {}
      };
      const vis = new IntersectionObserver((entries) => {
        if (entries.some((en) => en.isIntersecting)) refitOnly();
      });
      vis.observe(container);
      const ro = new ResizeObserver(refitOnly);
      ro.observe(container);
      // One-shot restore: refit to the new slot, repaint, refocus-if-active
      // (mirrors the visibility effect's show path).
      if (container.clientWidth && container.clientHeight) {
        try { entry.fit?.fit(); } catch {}
      }
      try {
        if (entry.term?.element) entry.term.refresh(0, entry.term.rows - 1);
      } catch {}
      if (activeRef.current && visibleRef.current) {
        try { entry.term?.focus(); } catch {}
      }
      return paneCleanup(vis, ro);
    }

    // ── First mount: create the terminal, handlers, and PTY. ──
    let ptyId = null;
    let unlistenData = null;
    // (jump-host tunnel id lives at entry.jumpFwdId — single-ownership
    // teardown via its dedicated destroy hook + the spawn-catch fast path)
    let restoringScrollback = false; // suppress OSC 133 while replaying old output
    let unlistenExit = null;
    const cmdsAtSpawn = Array.isArray(startCommandsRef.current) ? [...startCommandsRef.current] : [];

    const term = new Terminal({
      theme: xtermThemeRef.current,
      fontSize: 13,
      // Shared mono stack (Cascadia Code → MesloLGS NF for powerline glyphs) so
      // the terminal matches the app-owned prompt editor exactly — no font swap
      // when a typed command is echoed by the shell.
      fontFamily: MONO_STACK,
      cursorBlink: true,
      cursorStyle: "bar",
      // v0.1.32 bumped this to 10000 lines for large disk restores; P1-T6
      // capped the restore payload to a 256KB tail (~2.5k typical lines), so
      // 10000 now comfortably holds a full replay plus live output. Memory
      // cost is modest — xterm cells are compact; ~16MB per pane at full
      // fill, ~150MB across 8 packed panes.
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    // The registry owns these create-once objects from here on; a later mount
    // restores its component refs from the entry instead of re-creating.
    entry.term = term;
    entry.fit = fit;
    entry.search = searchAddon;
    // Destroy hooks run LIFO — dispose is registered FIRST so it runs LAST
    // (after the listener-detach and pty-kill hooks registered further down).
    registerDestroyHook(tabId, () => {
      try { term.dispose(); } catch {}
    });
    // Transcript tail: the transcript buffer + flush belong to THIS mount's
    // fiber (deliberately not migrated to the entry), but after a move the
    // later fibers' cleanups flush their own — empty — buffers. This hook
    // flushes the owning fiber's tail on real destroy (close/lock/crash).
    registerDestroyHook(tabId, () => {
      try { flushTranscript(); } catch {}
    });
    // The "find" shortcut opens the find overlay (intercepted before the PTY).
    // Combo is user-remappable; read it live from the shared keybinding cache.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === "keydown" && actionForEvent(ev) === "find") {
        entry.ui.setSearchOpen(true); // via the table — this handler outlives the fiber
        return false;
      }
      // Jump between command blocks (Blocks slice 4): Alt+Up / Alt+Down scrolls the
      // viewport to the previous / next command's prompt line.
      if (ev.type === "keydown" && ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
        const buf = term.buffer.active;
        const top = buf.viewportY;
        const starts = blocksRef.current.map((b) => b.startLine).filter((n) => typeof n === "number");
        if (starts.length) {
          let target;
          if (ev.key === "ArrowUp") {
            const above = starts.filter((n) => n < top);
            target = above.length ? Math.max(...above) : starts[0];
          } else {
            const below = starts.filter((n) => n > top);
            target = below.length ? Math.min(...below) : buf.baseY;
          }
          if (typeof term.scrollToLine === "function") term.scrollToLine(target);
          else term.scrollLines(target - top);
          return false;
        }
      }
      return true;
    });
    // Clickable absolute file paths (/… or ~/…), with optional :line:col → open
    // with the OS default handler. Relative paths aren't linkified — the shell's
    // live cwd isn't known here, so they can't be resolved reliably.
    term.registerLinkProvider({
      provideLinks(y, cb) {
        const lineObj = term.buffer.active.getLine(y - 1);
        if (!lineObj) { cb(undefined); return; }
        const text = lineObj.translateToString(true);
        // Exclude shell metacharacters (& | ^ % ; $ ` \) from linkified paths so an
        // attacker-influenced terminal line (malicious MOTD, crafted file, git log)
        // can't surface a clickable `/tmp/x&calc`-style token. The backend open_path
        // also refuses metacharacter reparsing — this is the matching front-line guard.
        const re = /(?:~|\/)[^\s'"()<>:&|^%;$`\\]{2,}(?::\d+(?::\d+)?)?/g;
        const links = [];
        let m;
        while ((m = re.exec(text)) !== null) {
          const raw = m[0];
          const startX = m.index + 1;
          links.push({
            text: raw,
            range: { start: { x: startX, y }, end: { x: startX + raw.length - 1, y } },
            decorations: { underline: true },
            activate: () => {
              const filePath = raw.replace(/:\d+(?::\d+)?$/, "");
              invoke("open_path", { path: filePath }).catch(() => {});
            },
          });
        }
        cb(links.length ? links : undefined);
      },
    });
    // NOTE: `term.open()` is intentionally deferred to `openIfVisible()` below.
    // Opening into a hidden / 0×0 / off-Space container leaves xterm's renderer
    // uncreated (its IntersectionObserver pauses it) and a later async write-flush
    // then throws on the missing renderer. The WebGL renderer (@xterm/addon-webgl)
    // was tried but renders blank glyphs in Tauri's WKWebView, so we stay on the
    // default DOM renderer; ImageAddon (Sixel + iTerm2 inline images) loads in
    // openIfVisible since it needs the renderer.
    // Command blocks via OSC 133 shell integration. The shell (see promptSetup)
    // emits ESC]133;A BEL at each prompt and ESC]133;D;<exit> BEL when a command
    // finishes. We pair them: A opens a block (record the prompt line), the next
    // D closes the PREVIOUS block with its exit code. A non-zero exit captures
    // the block's text (prompt+command+output) and surfaces the AI explainer.
    term.parser.registerOscHandler(133, (data) => {
      // Ignore marks replayed from restored scrollback — those are last
      // session's command boundaries, not live ones (would pop a phantom
      // "command failed" banner / blocks on tab restore).
      if (restoringScrollback) return true;
      const buf = term.buffer.active;
      const here = buf.baseY + buf.cursorY;
      if (data === "A" || data.startsWith("A;")) {
        const b = { startLine: here, command: null, endLine: null, exit: 0, el: null, deco: null };
        entry.blocks.current = b;
        blocksRef.current.push(b);
        if (blocksRef.current.length > 200) {
          // Evict the oldest block AND its xterm decoration — without the
          // dispose, blockDecorationsRef grew unbounded over a long session
          // (each decoration holds a marker + a DOM overlay element).
          const evicted = blocksRef.current.shift();
          if (evicted?.deco) {
            try { evicted.deco.dispose(); } catch { /* already disposed */ }
            const di = blockDecorationsRef.current.indexOf(evicted.deco);
            if (di !== -1) blockDecorationsRef.current.splice(di, 1);
          }
        }
        // App-owned prompt editor: the prompt is (re)opening. Once the prompt
        // string finishes printing and the cursor settles, capture the input
        // origin and show the editor. Re-armed on every prompt. Routed through
        // entry.ui — the settle timer + capture fn belong to the CURRENT fiber.
        entry.ui.capturePrompt();
      } else if (data === "D" || data.startsWith("D;")) {
        const blk = entry.blocks.current;
        entry.blocks.current = null;
        if (!blk) return true; // first D (after our init) — no block open
        const exit = data.includes(";") ? parseInt(data.split(";")[1], 10) : 0;
        const ok = Number.isNaN(exit) || exit === 0;
        blk.endLine = here;
        blk.exit = Number.isNaN(exit) ? 0 : exit;
        // Warp-style command block (Blocks UI, slice 1): tint the just-finished
        // command's region (prompt → here) with a left accent bar — green ok / red
        // fail — plus a faint red wash on failure. xterm decorations track their
        // own scroll position (bottom layer = behind the text). exit comes from
        // OSC 133 D;<code>, which fires on bash/zsh AND PowerShell.
        try {
          const rows = Math.max(1, here - blk.startLine + 1);
          const marker = term.registerMarker(blk.startLine - here);
          if (marker) {
            const deco = term.registerDecoration({ marker, x: 0, width: term.cols, height: rows, layer: "bottom" });
            if (deco) {
              deco.onRender((el) => {
                blk.el = el; // for right-click block hit-testing
                el.style.pointerEvents = "none";
                el.style.boxSizing = "border-box";
                el.style.borderLeft = `2px solid ${ok ? "rgba(111,184,92,0.45)" : "rgba(224,91,91,0.85)"}`;
                el.style.backgroundColor = ok ? "transparent" : "rgba(224,91,91,0.08)";
              });
              blk.deco = deco; // pairs the decoration with its block for eviction
              blockDecorationsRef.current.push(deco);
            }
          }
        } catch { /* decorations are best-effort */ }
        // Native Agent Mode: hand the finished command + its output to any waiting
        // agent step (ptyBridge.runAndCapture).
        try {
          let out = "";
          for (let i = blk.startLine + 1; i <= here && i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line) out += line.translateToString(true) + "\n";
          }
          reportBlockDone(tabId, { command: blk.command || "", output: out.replace(/\s+$/, ""), exit: Number.isNaN(exit) ? 0 : exit });
        } catch { /* best-effort */ }
        if (!ok) {
          let text = "";
          for (let i = blk.startLine; i <= here && i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line) text += line.translateToString(true) + "\n";
          }
          text = text.replace(/\n{3,}/g, "\n\n").trim();
          if (text) entry.ui.setFailedBlock({ exitCode: exit, text, key: `${here}:${Date.now()}` });
        }
      }
      return true; // handled (don't pass the OSC through to the screen)
    });
    // Command history: the shell's preexec hook emits ESC]1337;PlutoCmd=<base64>
    // with each command it's about to run (1337 is iTerm2's namespace — we only
    // claim the PlutoCmd payload and pass anything else through).
    term.parser.registerOscHandler(1337, (data) => {
      // Live cwd report (for the prompt editor's path completion).
      if (data.startsWith("PlutoCwd=")) {
        if (restoringScrollback) return true; // stale replayed dir
        try {
          const bin = atob(data.slice("PlutoCwd=".length));
          const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
          const dir = new TextDecoder().decode(bytes);
          if (dir) entry.ui.setShellCwd((prev) => (prev === dir ? prev : dir));
        } catch { /* ignore */ }
        return true;
      }
      if (!data.startsWith("PlutoCmd=")) return false;
      if (restoringScrollback) return true; // don't re-record replayed scrollback
      try {
        const bin = atob(data.slice("PlutoCmd=".length));
        const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
        const cmd = new TextDecoder().decode(bytes);
        recordCommand(cmd);
        // A command was submitted → leave prompt state (hide the editor) until
        // the next prompt re-arms it.
        entry.ui.cancelPromptSettle();
        entry.ui.setAtPrompt(false);
        // Tag the open block with the command it's running (for block copy/re-run).
        if (entry.blocks.current) entry.blocks.current.command = cmd;
      } catch { /* malformed payload — ignore */ }
      return true;
    });
    // Sticky command header (Blocks slice 3): while scrolled up into a block's
    // output, pin that block's command at the top so you know what produced it.
    // rAF-coalesced (P2-T5, same pattern as checkCost): xterm fires onScroll
    // once PER SCROLLED LINE, and this walks up to 200 blocks — a flood
    // scrolling hundreds of lines per frame ran it hundreds of times for one
    // paint. Final-state-wins; the header is an absolutely-positioned overlay,
    // so end-of-frame placement is lossless.
    const updateSticky = () => {
      const buf = term.buffer.active;
      if (buf.viewportY >= buf.baseY) { entry.ui.setStickyBlock(null); return; } // at the live bottom
      const top = buf.viewportY;
      let found = null;
      for (const b of blocksRef.current) {
        const end = b.endLine != null ? b.endLine : b.startLine;
        if (b.command && b.startLine < top && top <= end) found = b;
      }
      entry.ui.setStickyBlock(found);
    };
    term.onScroll(() => {
      if (stickyRafRef.current) return;
      stickyRafRef.current = requestAnimationFrame(() => {
        stickyRafRef.current = 0;
        updateSticky();
      });
    });
    termRef.current = term;
    fitRef.current = fit;
    // xterm creates its renderer (and measures char-cell size) inside open() —
    // but ONLY when the element is visible: its internal IntersectionObserver
    // pauses an element that's display:none / 0×0 / on an inactive macOS Space,
    // and opening while paused never creates the renderer, so `_renderer.value`
    // stays undefined. A later (async) write-flush then runs syncScrollArea →
    // reads the missing renderer's `dimensions` → throws an unhandled error.
    // This bit every relaunch as restored background tabs (display:none) replayed
    // scrollback into a hidden container. So defer open() until the container is
    // genuinely visible; writes before then buffer safely in xterm's core (no
    // renderer touched) and render once we open.
    let opened = false;
    // Only fit when the terminal is opened AND on-screen with a real size. A
    // hidden tab is display:none (0×0); fitting then clamps the PTY to a tiny
    // width and makes zsh redraw a WRAPPED prompt in the background — the
    // "wonky prompt on tab switch" bug. Skipping 0-size keeps hidden tabs intact.
    const safeFit = () => {
      if (!alive || !opened || !container.clientWidth || !container.clientHeight) return;
      try { fit.fit(); } catch {}
    };
    const openIfVisible = () => {
      if (opened || !alive || !container.clientWidth || !container.clientHeight) return;
      opened = true;
      term.open(entry.host); // registry-owned host — the xterm DOM moves with it across slots
      try { term.loadAddon(new ImageAddon()); } catch { /* ignore */ }
      safeFit();
    };
    // Open as soon as the container actually intersects the viewport — the same
    // signal xterm gates its renderer on. An initially-visible active tab opens
    // on the observer's first callback (~a frame); a restored background tab
    // opens when the user first switches to it.
    const vis = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) openIfVisible();
    });
    vis.observe(container);

    // Once the bundled powerline font is ready, RE-ASSIGN fontFamily so xterm
    // rebuilds its glyph atlas with MesloLGS NF (a plain refresh() keeps the
    // fallback atlas, so the  powerline glyphs wouldn't render otherwise),
    // then re-fit for the corrected glyph widths.
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (!alive) return;
        try {
          term.options.fontFamily = MONO_STACK;
          safeFit();
          if (opened) term.refresh(0, term.rows - 1);
        } catch {}
      }).catch(() => {});
    }

    // Replay saved scrollback if we have one for this tab id.
    const replayScrollback = async () => {
      const id = tabIdRef.current;
      if (!id) return false;
      try {
        const saved = await invoke("scrollback_load", { tabId: id });
        if (saved && entryLive()) {
          // Suppress OSC 133 while the old bytes replay; clear once parsed.
          restoringScrollback = true;
          term.write(saved, () => { restoringScrollback = false; });
          if (!saved.endsWith("\n")) term.writeln("");
          term.writeln("\x1b[90m─── scrollback restored ───\x1b[0m");
          return true;
        }
      } catch {}
      return false;
    };

    // Periodic transcript flush — rides the shared module ticker (P2-T5),
    // registered here in the create-once path so the closure captures THIS
    // (first) fiber's buffer/date refs — the ones handleChunk actually fills.
    // Moved panes keep flushing (the old per-pane interval died on park).
    // Date-roll: flush under the OLD date, then roll (the midnight flush is
    // the documented stale-date write-through P1's transcript pool supports).
    registerTranscriptFlusher(tabId, () => {
      const today = todayDate();
      if (today !== transcriptDateRef.current) {
        flushTranscript();
        transcriptDateRef.current = today;
      } else {
        flushTranscript();
      }
    });
    registerDestroyHook(tabId, () => unregisterTranscriptFlusher(tabId));

    (async () => {
      const restored = await replayScrollback();
      try {
        const cols = Math.max(term.cols, MIN_COLS);
        const rows = Math.max(term.rows, MIN_ROWS);
        // Read persisted settings from app state and inject into the spawned
        // shell so `claude` + custom env overrides just work without per-shell
        // pastes. Failsafe: if state is unreadable, spawn without env overrides
        // — user can paste manually.
        let extraEnv = null;
        try {
          // v0.1.21: anthropicKey now lives in the shared user-state key
          // so multi-window users don't re-enter it per window. Fall back
          // to legacy window-state location for migration safety.
          const env = {};
          // readUserSt() overlays the in-memory keychain cache on the
          // localStorage blob — App.jsx strips providerKeys/anthropicKey from
          // localStorage once keychain migration completes, so a raw
          // localStorage read here would spawn shells with NO keys.
          let userPersisted = null;
          try { userPersisted = readUserSt(); } catch (_) { /* ignore */ }
          // Pure transform: provider keys + active-model routing → env vars.
          // The keychain-overlaid read (readUserSt) stays above; this only
          // maps the already-read blob.
          Object.assign(env, resolveEnvFromUserState(userPersisted, envForModel));
          // envOverrides (and the legacy anthropicKey for not-yet-migrated
          // users) still live in the per-window state. Use the per-window key
          // (matches App's write key) so a detached ?w= window reads ITS OWN
          // state, not the default window's — previously this read the bare key
          // and silently missed a secondary window's overrides.
          const winRaw = localStorage.getItem(getWindowStorageKey());
          if (winRaw) {
            const persisted = JSON.parse(winRaw);
            if (!env.ANTHROPIC_API_KEY && persisted && typeof persisted.anthropicKey === "string" && persisted.anthropicKey.length > 0) {
              env.ANTHROPIC_API_KEY = persisted.anthropicKey;
            }
            if (persisted && persisted.envOverrides && typeof persisted.envOverrides === "object") {
              for (const [k, v] of Object.entries(persisted.envOverrides)) {
                if (typeof v === "string" && v.length > 0) env[k] = v;
              }
            }
          }
          if (Object.keys(env).length > 0) extraEnv = env;
        } catch (_) { /* ignore */ }
        // v0.1.29: pass tabId so the PTY reader thread can own the on-disk
        // scrollback file. Replaces the previous unmount-time renderer-side
        // scrollback_save, which raced process death on tray→Quit (async
        // invoke didn't reach Rust before the process exited).
        // Local PTY vs SSH transport — both register in the same backend
        // SessionRegistry and stream through the identical pty://{id} event, so
        // everything below (listen, write, resize, scrollback, cost) is shared.
        let id;
        if (serial) {
          term.writeln(`\x1b[2m[serial] ${serial.path} @ ${serial.baud} baud…\x1b[0m`);
          id = await invoke("serial_spawn", { path: serial.path, baud: serial.baud, tabId });
        } else if (connection) {
          const method = connection.auth?.method || "password";
          let password = null;
          if (method === "password") {
            password = getTabPassword(tabId);
            if (!password) {
              term.writeln("\r\n\x1b[31m[SSH]\x1b[0m no password for this session — reopen it from the sidebar to reconnect.");
              return;
            }
          }
          // Jump host: tunnel an ephemeral local port to the target through the
          // bastion, then connect the real session to 127.0.0.1:<port>.
          // (libssh2 needs a real socket fd, so a bastion channel can't be the
          // transport directly — this local-forward hop is the viable path.)
          let connectHost = connection.host;
          let connectPort = connection.port || 22;
          if (connection.jump) {
            const j = connection.jump;
            term.writeln(`\x1b[2m[SSH] opening jump host ${j.user}@${j.host}…\x1b[0m`);
            const jf = await invoke("jump_forward_start", {
              bastionHost: j.host, bastionPort: j.port || 22, bastionUser: j.user,
              bastionAuth: j.auth || { method: "agent" },
              targetHost: connection.host, targetPort: connection.port || 22,
            });
            entry.jumpFwdId = jf.id;
            // SINGLE owner of tunnel teardown, registered the moment the
            // tunnel exists — covers destroy in every later window (ssh_spawn
            // in flight, ssh_spawn THROWING, setup, parked). The null-out
            // keeps it idempotent with the fast-stop in the spawn catch.
            registerDestroyHook(tabId, () => {
              if (entry.jumpFwdId) {
                invoke("port_forward_stop", { id: entry.jumpFwdId }).catch(() => {});
                entry.jumpFwdId = null;
              }
            });
            connectHost = "127.0.0.1";
            connectPort = jf.local_port;
          }
          term.writeln(`\x1b[2m[SSH] connecting to ${connection.user}@${connection.host}:${connection.port || 22}${connection.jump ? ` via ${connection.jump.host}` : ""}…\x1b[0m`);
          id = await invoke("ssh_spawn", {
            host: connectHost,
            port: connectPort,
            user: connection.user,
            auth: { ...connection.auth, password },
            cols,
            rows,
            tabId,
            // Jump host: pin the target's key under its real identity, not the
            // ephemeral 127.0.0.1 tunnel port.
            hostKeyAlias: connection.jump ? connection.host : null,
            hostKeyPort: connection.jump ? (connection.port || 22) : null,
          });
        } else {
          id = await invoke("pty_spawn", { cwd: cwd || null, cols, rows, extraEnv, tabId });
        }
        // Orphan guard (decision 6): if the entry was destroyed while the
        // spawn was in flight (mid-spawn unmount, StrictMode's synthetic first
        // mount, instant close), nothing owns this PTY — kill it on arrival.
        // Tunnel ownership split: the dedicated destroy hook covers destroys
        // AFTER its registration; if the destroy landed while
        // jump_forward_start was still awaited, registerDestroyHook no-oped on
        // the already-missing entry — so THIS guard owns that pre-registration
        // window. check→stop→null runs to completion (no await in between),
        // and the null-out keeps every other stop site a no-op.
        // Identity check, not truthiness: a close-then-reopen may already have
        // minted a FRESH entry (with its own spawn) under the same id, and
        // this stale spawn must never adopt it.
        if (getEntry(tabId) !== entry) {
          if (entry.jumpFwdId) {
            invoke("port_forward_stop", { id: entry.jumpFwdId }).catch(() => {});
            entry.jumpFwdId = null;
          }
          await invoke("pty_kill", { id }).catch(() => {});
          return;
        }
        ptyId = id;
        entry.ptyId = id;
        entry.spawnState = "live"; // from here on, unmount parks instead of destroying
        // Registered the moment the PTY exists — BEFORE any later await — so a
        // destroy landing in the listen()/setup windows below still kills the
        // process and force-resolves any waiting agent capture (unregisterPty).
        // (The jump tunnel has its own dedicated hook — single ownership.)
        // LIFO: runs after the listener-detach hook, before dispose.
        registerDestroyHook(tabId, () => {
          unregisterPty(tabId);
          invoke("pty_kill", { id }).catch(() => {});
        });

        // Expose this tab's PTY to the snippets drawer / status bar via the
        // bridge. Writer closes over the local ptyId; dims reported below.
        // Bridge registrations are REGISTRY-lifetime (decision 7): they
        // survive parks and are torn down only by the destroy hook above — so
        // runAndCapture survives a mid-run move (B1 bug fix 1).
        registerPtyWriter(tabId, (data) => {
          if (!ptyId) return;
          // Anything written to this PTY is a potential answer to a pending
          // prompt, so un-block here rather than only in term.onData — that
          // covered local typing alone, leaving MultiExec broadcast, snippet
          // insertion, macro replay, the prompt editor and agent steps to
          // strand the session as "needs you" after they had already answered
          // it. Every one of those routes through this writer.
          if (entryLive()) {
            entryRef.current.counters.recentOut = "";
            if (activityRef.current === "waiting") setActivity("active");
          }
          invoke("pty_write", { id: ptyId, data }).catch(() => {});
        }, visibleRef.current);
        // Publish the live channel id so the phone companion can subscribe to
        // `pty://<id>` and write/resize this session. Cleared by unregisterPty.
        setPtyId(tabId, id);
        // Expose recent buffer text (ANSI already resolved by xterm) for AI
        // features like the session summary. Last ~400 lines, capped at 8 KB.
        registerTabReader(tabId, () => {
          try {
            const buf = term.buffer.active;
            const total = buf.length;
            const lines = [];
            for (let i = Math.max(0, total - 400); i < total; i++) {
              const ln = buf.getLine(i);
              if (ln) lines.push(ln.translateToString(true));
            }
            return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd().slice(-8000);
          } catch { return ""; }
        });
        try { setTabDims(tabId, term.cols, term.rows); } catch {}

        // Everything a live PTY chunk feeds: xterm, the recorder, the analysis
        // buffers, and activity tracking. Factored out of the listener so the
        // boot-conceal gate below can replay buffered bytes through the same
        // path once the marker (or the flush fallback) releases them.
        const handleChunk = (payload) => {
          term.write(payload);

          // v0.1.18: feed the asciinema recorder if this tab is being recorded.
          // Helper is a no-op when there's no active recording for tabId.
          pushRecordingOutput(tabId, payload);

          // Feed the various analysis buffers.
          appendScrollback(payload);
          appendTranscript(payload);
          entry.counters.recentOut += payload;
          // Cheap (2KB + 3 regexes) and safety-relevant — keep synchronous so it
          // fires on every chunk even while the window is hidden.
          checkAutoApprove(ptyId);
          // Expensive (10KB tail + several regexes) and display-only — coalesce
          // to at most one scan per frame. Reads accumulated scrollback, so a
          // burst of N chunks collapses to one scan with no data loss.
          if (!costRafRef.current) {
            costRafRef.current = requestAnimationFrame(() => {
              costRafRef.current = 0;
              if (entryLive()) checkCost();
            });
          }

          // Activity tracking: only count when user isn't watching this tab.
          // Visibility reads go through entry.ui (the current fiber's ref).
          if (entry.ui.isVisible()) return;
          bytesSinceSeenRef.current += payload.length;
          // "waiting" outranks "active": the chunk that DRAWS a permission
          // prompt also trips this byte threshold, and checkAutoApprove above
          // already ran on it — so without this guard the prompt's own output
          // would immediately mask the blocked state. checkAutoApprove owns the
          // way out of waiting (see its no-match branch).
          if (
            bytesSinceSeenRef.current >= ACTIVITY_BYTE_THRESHOLD &&
            entry.counters.userHasTyped &&
            activityRef.current !== "waiting"
          ) {
            setActivity("active");
            clearDoneTimer();
            doneTimerRef.current = setTimeout(() => {
              if (entryLive() && !entry.ui.isVisible()) setActivity("done");
            }, DONE_TIMEOUT_MS);
          }
        };
        // Raw byte sequence the display command emits right before its clear.
        // Only ever present in OUTPUT (the typed setup source builds it from
        // [char]27 / \033 pieces, so the echo never contains the real ESC byte
        // and can't false-trigger the scan).
        const BOOT_MARKER = "\x1b]1337;PlutoBoot=1\x07";
        const flushConceal = () => {
          const c = concealRef.current;
          if (!c) return;
          clearTimeout(c.timer);
          concealRef.current = null;
          if (c.buf && entryLive()) handleChunk(c.buf);
        };

        unlistenData = await listen(`pty://${id}`, (e) => {
          if (!entryLive()) return; // registry-lifetime: keeps streaming while parked
          const payload = e.payload || "";
          const c = concealRef.current;
          if (c) {
            c.buf += payload;
            const idx = c.buf.indexOf(BOOT_MARKER);
            if (idx >= 0) {
              // Marker found: drop the setup noise (everything up to and
              // including the marker), render from the clear onward.
              clearTimeout(c.timer);
              concealRef.current = null;
              const rest = c.buf.slice(idx + BOOT_MARKER.length);
              if (rest) handleChunk(rest);
            } else if (c.buf.length > 131072) {
              // Something is flooding output before setup finished (not the
              // scenario this gate is for) — stop hiding it. 128KB, not 64KB:
              // backend coalescing (P1-T1) can legally deliver one ~64KB
              // chunk, which must not single-handedly trip the escape hatch.
              flushConceal();
            }
            return;
          }
          handleChunk(payload);
        });
        // If the entry was destroyed while listen() was in flight, the destroy
        // hooks already ran (and saw unlistenData undefined) — detach
        // immediately or it leaks. (The PTY itself was killed by the destroy
        // hook registered at spawn.)
        if (!entryLive()) { try { unlistenData(); } catch {} return; }

        unlistenExit = await listen(`pty-exit://${id}`, () => {
          if (!entryLive()) return;
          const msg = serial ? "[serial port closed]" : connection ? "[ssh disconnected]" : "[process exited]";
          term.writeln(`\r\n\x1b[90m${msg}\x1b[0m`);
          // A dead process is not waiting on anyone. Without this, a session
          // killed (OOM, kill -9, dropped SSH) while blocked on a prompt stays
          // "needs you" forever: the way out of waiting only runs on new PTY
          // output, and a dead PTY produces none. It also permanently inflates
          // the fleet counts for a session that no longer exists.
          entry.counters.recentOut = ""; // the prompt died with the process
          setActivity("done");
        });
        // Same late-resolution guard as unlistenData above.
        if (!entryLive()) { try { unlistenExit(); } catch {} return; }

        // Both listeners live — detach only on real destroy. LIFO runs this
        // hook FIRST: stop consuming events, then the spawn hook kills the
        // PTY, then dispose.
        registerDestroyHook(tabId, () => {
          try { unlistenData(); } catch {}
          try { unlistenExit(); } catch {}
        });

        // Both listeners are live — tell the backend it may begin streaming.
        // EVERY transport (local, SSH, serial) now gates its first emit on this
        // so the initial prompt/MOTD burst can't race ahead of the pty://{id}
        // subscription above (the old fixed 150ms warm-up lost that race under
        // load). If this invoke is lost, the backend falls back to a short
        // timeout, so surface (don't swallow) the failure.
        invoke("pty_ready", { id }).catch((e) => console.warn("pty_ready failed", e));

        term.onData((data) => {
          if (!entryLive() || !ptyId) return;
          entry.counters.userHasTyped = true;
          recordInput(tabId, data); // macro recording (no-op unless armed for this tab)
          // Clear the auto-approve match buffer when the user types — they
          // intend to answer the prompt themselves. That also ends the
          // "waiting" state: answering IS the thing it was waiting for.
          entry.counters.recentOut = "";
          if (activityRef.current === "waiting") setActivity("active");
          // MultiExec: when broadcast is on, fan the keystroke out to every
          // visible terminal (this pane included, since it's visible) rather
          // than writing only to our own PTY — so it lands exactly once here.
          if (isBroadcast()) {
            writeBroadcast(data);
          } else {
            invoke("pty_write", { id: ptyId, data }).catch(() => {});
          }
        });

        term.onResize(({ cols, rows }) => {
          if (entryLive() && ptyId) {
            setTabDims(tabId, cols, rows);
            invoke("pty_resize", {
              id: ptyId,
              cols: Math.max(cols, MIN_COLS),
              rows: Math.max(rows, MIN_ROWS),
            }).catch(() => {});
          }
          // Reprint the welcome banner at the new width while the pane is
          // still untouched (e.g. just split). Debounced so a flurry of resize
          // events collapses to one reprint; the last-drawn width guards
          // against redundant runs. The armed fn + width live behind entry.ui
          // (per-fiber refs handed forward on re-attach), and the deferred
          // body reads entry.term — the registry-owned instance — never this
          // mount's termRef, which is nulled at park.
          if (entry.ui.bannerRedraw.get() && !entry.counters.userHasTyped && cols !== entry.ui.bannerCols.get()) {
            clearTimeout(bannerRedrawTimerRef.current);
            bannerRedrawTimerRef.current = setTimeout(() => {
              const t = entry.term;
              if (t && !entry.counters.userHasTyped && entry.ui.bannerRedraw.get()) entry.ui.resizeReprint(t.cols);
            }, 200);
          }
        });

        // App-owned prompt editor: drop to raw passthrough whenever a full-screen
        // app takes the alternate screen buffer (vim, less, a TUI); restore after.
        try {
          term.buffer.onBufferChange(() => {
            const alt = term.buffer.active.type === "alternate";
            entry.ui.setAltScreen(alt);
            if (alt) { entry.ui.cancelPromptSettle(); entry.ui.setAtPrompt(false); }
          });
        } catch { /* older xterm — feature degrades to prompt-state only */ }

        // Defensive latch (decision 9): the whole spawn IIFE is first-mount-
        // only, so this setup region can never run twice for one entry — the
        // isFirstMount gate is the real start-command suppressor. Kept as
        // belt-and-suspenders + self-documentation. Set BEFORE the region so a
        // mid-setup throw can never allow a second pass at typing commands.
        if (entry.setupDone) return;
        entry.setupDone = true;

        // Pre-flight check (v0.1.14): if any startCommand invokes `claude` and
        // the CLI isn't on PATH, the shell would respond "claude is not
        // recognized" and the systemPrompt write 2s later would dump prose
        // into a confused shell. Catch it cleanly and surface a fix path.
        // Local-only pre-flight: a remote SSH host has its own PATH, so don't
        // gate SSH start-commands on whether `claude` is installed locally.
        let skipPackCommands = false;
        if (!connection && !serial && cmdsAtSpawn.length > 0) {
          const willInvokeClaude = cmdsAtSpawn.some((cmd) => {
            const t = (cmd || "").trim();
            return t === "claude" || t.startsWith("claude ") || t.startsWith("claude\t");
          });
          if (willInvokeClaude) {
            let claudeAvailable = false;
            try {
              const v = await invoke("check_command_version", { name: "claude" });
              claudeAvailable = !!v;
            } catch {}
            if (!claudeAvailable && entryLive()) {
              term.writeln("");
              term.writeln("\x1b[33m[pluto's terminals]\x1b[0m \x1b[31mClaude CLI not found on PATH.\x1b[0m");
              term.writeln("\x1b[2m  Install:  \x1b[0m\x1b[36mnpm install -g @anthropic-ai/claude-code\x1b[0m");
              term.writeln("\x1b[2m  Or click \x1b[0m\x1b[36m🚀 setup\x1b[0m\x1b[2m in the header for guided steps + live API test.\x1b[0m");
              term.writeln("\x1b[2m  Skipping pack startCommands and systemPrompt; shell is yours.\x1b[0m");
              term.writeln("");
              skipPackCommands = true;
            }
          }
        }

        if (!skipPackCommands && cmdsAtSpawn.length > 0) {
          await new Promise(r => setTimeout(r, 600));
          for (let i = 0; i < cmdsAtSpawn.length; i++) {
            if (!entryLive() || !ptyId) break;
            try {
              await invoke("pty_write", { id: ptyId, data: cmdsAtSpawn[i] + "\r" });
            } catch {}
            if (i < cmdsAtSpawn.length - 1) {
              await new Promise(r => setTimeout(r, 300));
            }
          }
        }

        // MobaXterm-style colorful prompt + welcome banner for a local shell.
        // The prompt (+ colours / aliases) is set on BOTH fresh and restored
        // tabs so the MobaXterm look is consistent after a restart; the clear +
        // welcome banner + rainbow line run only on a FRESH tab (a restored tab
        // keeps its replayed scrollback visible — no clear). Skipped for SSH /
        // serial tabs and for tabs that launch their own app via startCommands.
        // Detects zsh/bash at runtime. Windows shells keep their default.
        const isWindowsUA = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
        if (!connection && !serial && cmdsAtSpawn.length === 0 && entryLive() && ptyId) {
          // Arm the boot-conceal gate BEFORE the shell's first output: the pane
          // stays clean (restored tabs: just the replayed scrollback) instead of
          // flashing the startup banner + the echoed wall of setup code. The
          // display command below emits BOOT_MARKER right before its clear,
          // which releases the gate; the 4s timer is the can't-go-blank fallback.
          concealRef.current = { buf: "", timer: setTimeout(flushConceal, 4000) };
          // Let the shell render its first prompt before we send the (now short)
          // welcome line so the colours/box land cleanly.
          await new Promise(r => setTimeout(r, 450));
          // Colorful output like MobaXterm: BSD/GNU ls colors + colored grep/less
          // + a few quality-of-life aliases. (Kept short so the welcome init fits
          // comfortably in one shell line alongside the big welcome box.)
          // MobaXterm-style welcome box + POSIX prompt / OSC-133 / command-capture
          // setup strings. Both are pure builders extracted to welcomeBanner.js +
          // shellIntegration.js — output bytes identical to the old inline code.
          // The box is written to a file (real ESC bytes) and the shell `cat`s it
          // before the first prompt to dodge the tty canonical line-length limit.
          const boxRaw = buildWelcomeBanner({ paneCols: term.cols || 80 });
          // Reprint the welcome banner at a given width (used by the resize hook
          // when a split narrows an untouched pane). Rebuilds the box file and
          // runs a plain clear+cat (no boot marker / conceal gate — just a tidy
          // refresh). Leading space on POSIX so a shell with ignorespace skips it
          // in history.
          const sendBannerDisplay = async (cols) => {
            if (!entryLive() || !ptyId) return;
            try {
              const raw = buildWelcomeBanner({ paneCols: cols });
              const p = await invoke("write_welcome_file", { content: raw });
              if (!p) return;
              const lit = String(p);
              const cmd = isWindowsUA
                ? `Clear-Host; Get-Content -Raw -Encoding utf8 -LiteralPath '${lit.replace(/'/g, "''")}'`
                : ` clear; cat '${lit.replace(/'/g, "'\\''")}'`;
              entry.ui.bannerCols.set(cols); // via the table — this closure outlives its fiber
              await invoke("pty_write", { id: ptyId, data: cmd + "\r" });
            } catch { /* best-effort refresh */ }
          };
          const { promptSetup, cmdCapture } = buildPosixShellInit();
          // Fresh tabs: write the box to a file, then `${promptSetup}; clear; cat
          // '<file>'` — a short command whose output (the box) lands before the
          // first prompt (clean ordering, box sits above the prompt where ZLE
          // never touches it). Restored tabs: set prompt then a scrollback-
          // PRESERVING clear (ESC[2J, not ESC[3J) hides the echoed setup and
          // keeps history scrollable.
          // Send the setup (colors + prompt + OSC 133 hooks) and the visual
          // (clear + welcome box) as TWO separate lines. Combined they'd be
          // ~930 bytes — close enough to the tty canonical-mode limit
          // (MAX_CANON ≈ 1024) that the multi-byte prompt emoji could tip it
          // over and hang the line (the old 2.4 KB-printf bug). The trailing
          // `clear` wipes the echoed setup line either way.
          if (isWindowsUA) {
            // PowerShell prompt / OSC-133 / command-capture / autosuggest setup.
            // Pure builders extracted to shellIntegration.js — output bytes
            // identical to the old inline PowerShell equivalents.
            const { psEnc, psPrompt, psHist, psComplete } = buildPowerShellInit();
            if (entryLive() && ptyId) {
              try { await invoke("pty_write", { id: ptyId, data: `${psEnc}; ${psPrompt}` + "\r" }); } catch {}
              try { await invoke("pty_write", { id: ptyId, data: psHist + "\r" }); } catch {}
              try { await invoke("pty_write", { id: ptyId, data: psComplete + "\r" }); } catch {}
              // Fresh tab: clear + welcome box. Restored tab: scrollback was replayed,
              // so a scrollback-PRESERVING clear (ESC[2J, not Clear-Host) hides the
              // echoed setup without wiping the history.
              // Each variant emits BOOT_MARKER first (assembled from [char]27
              // so the echoed source can't contain the real escape sequence),
              // releasing the conceal gate exactly at the clear.
              const psMarker = `[Console]::Write([char]27 + ']1337;PlutoBoot=1' + [char]7)`;
              let winDisplay;
              if (restored) {
                winDisplay = `${psMarker}; [Console]::Write([char]27 + '[2J' + [char]27 + '[H')`;
              } else {
                winDisplay = `${psMarker}; Clear-Host`;
                try {
                  const p = await invoke("write_welcome_file", { content: boxRaw });
                  if (p) winDisplay = `${psMarker}; Clear-Host; Get-Content -Raw -Encoding utf8 -LiteralPath '${String(p).replace(/'/g, "''")}'`;
                } catch { /* no file → just clear */ }
              }
              try { await invoke("pty_write", { id: ptyId, data: winDisplay + "\r" }); } catch {}
            }
          } else {
            // Same marker idea as the PowerShell path: the echoed source only
            // contains the literal text "\033]1337;…" (no real ESC byte), so
            // the gate releases on the OUTPUT of this printf, not its echo.
            const shMarker = `printf '\\033]1337;PlutoBoot=1\\007'`;
            let display;
            if (restored) {
              display = `${shMarker}; printf '\\033[2J\\033[H'`;
            } else {
              display = `${shMarker}; clear`;
              try {
                const p = await invoke("write_welcome_file", { content: boxRaw });
                if (p) display = `${shMarker}; clear; cat '${String(p).replace(/'/g, "'\\''")}'`;
              } catch { /* no file → just clear */ }
            }
            if (entryLive() && ptyId) {
              try { await invoke("pty_write", { id: ptyId, data: promptSetup + "\r" }); } catch {}
              try { await invoke("pty_write", { id: ptyId, data: cmdCapture + "\r" }); } catch {}
              try { await invoke("pty_write", { id: ptyId, data: display + "\r" }); } catch {}
            }
          }
          // Arm banner re-render on resize, but only for a plain local shell with
          // no pack commands / system prompt (those make the pane "busy" — never
          // a clean banner to refresh). The userHasTyped counter gates it live:
          // once the user touches the pane we stop reprinting. Armed THROUGH the
          // table — a move may already have repointed entry.ui to a newer fiber
          // by the time this IIFE reaches here.
          if (!restored && !connection && !serial && cmdsAtSpawn.length === 0
              && !(systemPromptRef.current && systemPromptRef.current.trim())) {
            entry.ui.bannerRedraw.set(sendBannerDisplay);
            entry.ui.bannerCols.set(term.cols);
          }
        }

        // System prompt injection (v0.1.8 Tier 1 #1) — after start commands
        // run (typically `claude`), wait for Claude Code to finish booting,
        // then type the system prompt as the first user message. Turns
        // packs from "tab labels" into actual specialized agents.
        const sysPrompt = systemPromptRef.current;
        if (!skipPackCommands && sysPrompt && typeof sysPrompt === "string" && sysPrompt.trim().length > 0 && entryLive() && ptyId) {
          // 2s lets `claude` finish initializing + render its prompt before
          // we paste. If Claude isn't ready yet, the input buffers and gets
          // consumed once the REPL is alive.
          await new Promise(r => setTimeout(r, 2000));
          if (entryLive() && ptyId) {
            try {
              await invoke("pty_write", { id: ptyId, data: sysPrompt.trim() + "\r" });
            } catch {}
          }
        }
      } catch (err) {
        if (entryLive()) term.writeln(`\r\n\x1b[31m[spawn failed: ${err}]\x1b[0m`);
        // Fast path: a dead spawn must not hold the jump tunnel open until the
        // tab closes (ssh_spawn threw AFTER jump_forward_start succeeded).
        // Null-out keeps the dedicated destroy hook a no-op later — and if the
        // entry was already destroyed, that hook already ran and nulled this,
        // so there is no double-stop.
        if (entry.jumpFwdId) {
          invoke("port_forward_stop", { id: entry.jumpFwdId }).catch(() => {});
          entry.jumpFwdId = null;
        }
      }
    })();

    const ro = new ResizeObserver(safeFit);
    ro.observe(container);

    // v0.1.29 note (still true): scrollback persistence lives on the Rust PTY
    // reader thread (pty.rs::ScrollbackWriter) — no renderer-side save here.
    return paneCleanup(vis, ro);
    // [cwd] dep: a cwd-prop change re-runs this effect → park + re-attach (no
    // respawn). Live cwd comes from OSC 1337 PlutoCwd; the prop only matters
    // at first spawn.
  }, [cwd]);

  // Report visibility to the bridge so MultiExec broadcast only targets the
  // terminals the user can actually see (the active tab of each panel).
  useEffect(() => {
    setTabVisible(tabId, visible);
  }, [tabId, visible]);

  // When a hidden pane becomes visible, refit + focus + reset activity.
  useEffect(() => {
    if (!visible) return;
    // Reset via entry.ui: the activity machine is create-once (it lives in
    // the FIRST mount's closures), so a later fiber's local reset would miss
    // it and leave the dot stuck after a move.
    const reset = entryRef.current?.ui?.resetActivity;
    if (reset) {
      reset();
    } else {
      clearDoneTimer();
      bytesSinceSeenRef.current = 0;
      setActivity("idle");
    }
    const t = setTimeout(() => {
      const el = containerRef.current;
      if (el && el.clientWidth && el.clientHeight) {
        try { fitRef.current?.fit(); } catch {}
      }
      // Only the active pane of a (possibly split) tab steals focus on show.
      if (activeRef.current) {
        try { termRef.current?.focus(); } catch {}
      }
    }, 30);
    return () => clearTimeout(t);
  }, [visible]);

  useEffect(() => {
    if (!termRef.current || !xtermTheme) return;
    try { termRef.current.options.theme = xtermTheme; } catch {}
  }, [xtermTheme]);

  // Find-in-terminal helpers (Cmd/Ctrl+F). SearchAddon highlights matches with
  // decorations (needs allowProposedApi, which the terminal enables).
  const SEARCH_OPTS = {
    decorations: {
      matchBackground: "#4a5a2a",
      matchOverviewRuler: "#7fbf8a",
      activeMatchBackground: "#b58900",
      activeMatchColorOverviewRuler: "#ffd700",
    },
  };
  const runSearch = (q, dir) => {
    const s = searchAddonRef.current;
    if (!s || !q) { s?.clearDecorations?.(); return; }
    if (dir === "prev") s.findPrevious(q, SEARCH_OPTS);
    else s.findNext(q, { ...SEARCH_OPTS, incremental: dir === "incremental" });
  };
  const closeSearch = () => {
    setSearchOpen(false);
    searchAddonRef.current?.clearDecorations?.();
    try { termRef.current?.focus(); } catch { /* ignore */ }
  };

  // ── Block actions (Blocks UI, slice 2) ─────────────────────────────────────
  // Right-click a command block → copy its command / output / both, or re-run it.
  // Blocks are hit-tested by their decoration element's on-screen rect (xterm
  // positions those for us), so no fragile pixel math.
  const blockText = (block, which) => {
    if (which === "command") return block.command || "";
    const t = termRef.current; if (!t) return "";
    const out = blockOutputText(t.buffer.active, block.startLine, block.endLine);
    if (which === "output") return out;
    return (block.command ? block.command + "\n" : "") + out; // both
  };
  const onTermContextMenu = (e) => {
    let hit = null;
    for (const b of blocksRef.current) {
      const r = b.el && b.el.getBoundingClientRect();
      if (r && r.height > 0 && e.clientY >= r.top && e.clientY <= r.bottom) { hit = b; break; }
    }
    if (!hit) return; // not over a block → leave default behaviour
    e.preventDefault();
    setBlockMenu({ block: hit, x: e.clientX, y: e.clientY });
  };
  const copyToClipboard = (t) => { try { navigator.clipboard?.writeText(t); } catch { /* ignore */ } };

  // ── App-owned prompt editor wiring ──────────────────────────────────────────
  const showEditor = promptEditor && active && atPrompt && !altScreen;
  const capturePrompt = () => {
    const term = termRef.current;
    if (!term || !peEnabledRef.current) return;
    if (term.buffer.active.type === "alternate") return; // full-screen app
    const wrapEl = wrapperRef.current;
    const screen = containerRef.current?.querySelector(".xterm-screen");
    if (!wrapEl || !screen || !term.cols) return;
    const wrap = wrapEl.getBoundingClientRect();
    const sr = screen.getBoundingClientRect();
    if (!sr.width) return;
    const cellW = sr.width / term.cols;
    const cellH = sr.height / term.rows;
    const cx = term.buffer.active.cursorX;
    const cy = term.buffer.active.cursorY;
    setPeRect({
      top: (sr.top - wrap.top) + cy * cellH,
      left: (sr.left - wrap.left) + cx * cellW,
      width: Math.max(60, sr.width - cx * cellW - 4),
      height: Math.max(12, cellH),
    });
    setAtPrompt(true);
  };
  captureRef.current = capturePrompt;

  const sendToPty = (data) => { if (isBroadcast()) writeBroadcast(data); else writeToTab(tabId, data); };
  const submitPrompt = (text) => {
    setAtPrompt(false);
    sendToPty((text || "") + "\r");
    const c = (text || "").trim();
    if (c) recordCommand(c);
    setTimeout(() => termRef.current?.focus(), 0);
  };
  const promptCtrlC = () => { sendToPty("\x03"); setAtPrompt(false); };
  const promptClear = () => { sendToPty("\x0c"); };
  const promptEscape = () => { setAtPrompt(false); setTimeout(() => termRef.current?.focus(), 0); };

  // Hide xterm's idle caret while the editor owns input (avoids a double caret).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try { term.options.cursorInactiveStyle = showEditor ? "none" : "outline"; } catch { /* ignore */ }
  }, [showEditor]);

  // Reposition the editor as the viewport scrolls/resizes while shown.
  useEffect(() => {
    if (!showEditor) return;
    const term = termRef.current;
    if (!term) return;
    const reposition = () => captureRef.current?.();
    const d1 = term.onScroll?.(reposition);
    const d2 = term.onResize?.(reposition);
    return () => { d1?.dispose?.(); d2?.dispose?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEditor]);

  return (
    <div
      ref={wrapperRef}
      style={{
        position: "absolute",
        inset: 0,
        display: visible ? "block" : "none",
        overflow: "hidden",
      }}
    >
      <div ref={containerRef} onContextMenu={onTermContextMenu} style={{ width: "100%", height: "100%", padding: 6, boxSizing: "border-box" }} />
      {promptEditor && (
        <PromptEditor
          visible={showEditor}
          top={peRect.top}
          left={peRect.left}
          width={peRect.width}
          height={peRect.height}
          theme={xtermTheme}
          cwd={shellCwd}
          vimMode={promptEditorVim}
          onSubmit={submitPrompt}
          onEscape={promptEscape}
          onCtrlC={promptCtrlC}
          onClear={promptClear}
        />
      )}
      {stickyBlock && (
        <div style={{
          position: "absolute", top: 6, left: 6, right: 6, zIndex: 15, height: 22,
          display: "flex", alignItems: "center", gap: 8, padding: "0 10px",
          background: "var(--phn-surface-bg, #1a1d21)",
          borderLeft: `2px solid ${stickyBlock.exit ? "#E05B5B" : "#6FB85C"}`,
          borderBottom: "1px solid var(--phn-surface-border, #2b2b2b)", borderRadius: "0 0 6px 6px",
          fontSize: 11.5, fontFamily: "'JetBrains Mono', Menlo, monospace", color: "var(--phn-text-fg, #cfd6dd)",
          overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", opacity: 0.97, pointerEvents: "none",
        }}>
          <span style={{ color: stickyBlock.exit ? "#E05B5B" : "#6FB85C", flexShrink: 0 }}>{stickyBlock.exit ? "✗" : "✓"}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stickyBlock.command}</span>
        </div>
      )}
      {blockMenu && (
        <>
          <div onMouseDown={() => setBlockMenu(null)} onContextMenu={(e) => { e.preventDefault(); setBlockMenu(null); }}
            style={{ position: "fixed", inset: 0, zIndex: 60 }} />
          <div style={{
            position: "fixed", zIndex: 61,
            left: Math.min(blockMenu.x, window.innerWidth - 200),
            top: Math.min(blockMenu.y, window.innerHeight - 180),
            background: "var(--phn-surface-bg, #1a1d21)", border: "1px solid var(--phn-surface-border, #2b2b2b)",
            borderRadius: 8, padding: 5, minWidth: 188, boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
            fontSize: 12, fontFamily: "var(--phn-ui-font, -apple-system, sans-serif)", color: "var(--phn-text-fg, #cfd6dd)",
          }}>
            <div style={{ fontSize: 10.5, color: "var(--phn-text-faint, #6b7480)", padding: "3px 10px 5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {blockMenu.block.exit ? `✗ exit ${blockMenu.block.exit} · ` : "✓ "}{blockMenu.block.command || "(command)"}
            </div>
            {[
              { label: "Copy command", on: () => copyToClipboard(blockText(blockMenu.block, "command")), dis: !blockMenu.block.command },
              { label: "Copy output", on: () => copyToClipboard(blockText(blockMenu.block, "output")) },
              { label: "Copy command + output", on: () => copyToClipboard(blockText(blockMenu.block, "both")) },
              { label: "Re-run command", on: () => blockMenu.block.command && writeToTab(tabId, blockMenu.block.command + "\r"), dis: !blockMenu.block.command },
              { label: "Share block…", on: () => setShareTarget({
                  kind: "block",
                  title: blockMenu.block.command || "block",
                  rawText: blockText(blockMenu.block, "both"), // re-reads the buffer NOW, before the menu closes
                  dateStamp: todayDate(),                      // stamp the share filename's date at click time
                }) },
            ].map((it, i) => (
              <button key={i} disabled={it.dis} onClick={() => { it.on(); setBlockMenu(null); }}
                style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none",
                  color: it.dis ? "#5a626b" : "var(--phn-text-fg, #cfd6dd)", padding: "7px 10px", borderRadius: 5,
                  cursor: it.dis ? "default" : "pointer", fontSize: 12 }}
                onMouseEnter={(e) => { if (!it.dis) e.currentTarget.style.background = "rgba(127,127,127,0.16)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
      {searchOpen && (
        <div
          style={{
            position: "absolute", top: 8, right: 12, zIndex: 20,
            display: "flex", alignItems: "center", gap: 4,
            background: "var(--phn-surface-bg, #2d2d2d)",
            border: "1px solid var(--phn-surface-border, #151515)",
            borderRadius: 6, padding: "4px 6px",
            boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
          }}
        >
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); runSearch(e.target.value, "incremental"); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); runSearch(searchQuery, e.shiftKey ? "prev" : "next"); }
              else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
            }}
            placeholder="Find in terminal…"
            spellCheck={false}
            style={{
              background: "var(--phn-page-bg, #1c1c1c)",
              border: "1px solid var(--phn-surface-border, #151515)",
              color: "var(--phn-text-fg, #d4d4d4)",
              borderRadius: 4, padding: "4px 8px", fontSize: 12, width: 170,
              outline: "none", fontFamily: "var(--phn-ui-font)",
            }}
          />
          {["↑", "↓", "✕"].map((g, i) => (
            <span
              key={g}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (i === 0 ? runSearch(searchQuery, "prev") : i === 1 ? runSearch(searchQuery, "next") : closeSearch())}
              title={i === 0 ? "Previous (Shift+Enter)" : i === 1 ? "Next (Enter)" : "Close (Esc)"}
              style={{ cursor: "pointer", color: "var(--phn-text-fg, #d4d4d4)", padding: "2px 5px", fontSize: 12, borderRadius: 3, userSelect: "none" }}
            >
              {g}
            </span>
          ))}
        </div>
      )}
      {failedBlock && !explainBlock && (
        <div
          style={{
            position: "absolute", left: 12, bottom: 12, zIndex: 25,
            display: "flex", alignItems: "center", gap: 8,
            background: "var(--phn-surface-bg, #242424)",
            border: "1px solid var(--phn-danger, #ff6b6b)", borderRadius: 8, padding: "6px 8px 6px 12px",
            boxShadow: "0 6px 18px rgba(0,0,0,0.5)", fontFamily: "var(--phn-ui-font)",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--phn-text-fg, #d4d4d4)" }}>
            <span style={{ color: "var(--phn-danger, #ff6b6b)" }}>✗</span> command failed · exit {failedBlock.exitCode}
          </span>
          <button
            onClick={() => { setExplainBlock(failedBlock); setFailedBlock(null); }}
            style={{
              background: "var(--phn-link, #7c9cf5)", border: "none", color: "#06223a",
              borderRadius: 5, padding: "3px 10px", fontSize: 12, fontWeight: 600,
              cursor: "pointer", fontFamily: "var(--phn-ui-font)",
            }}
          >
            Explain
          </button>
          <span
            onClick={() => setFailedBlock(null)}
            title="Dismiss"
            style={{ cursor: "pointer", color: "var(--phn-text-dim, #888)", padding: "2px 5px", fontSize: 12, userSelect: "none" }}
          >
            ✕
          </span>
        </div>
      )}
      <ErrorExplainer
        block={explainBlock}
        onClose={() => setExplainBlock(null)}
        onRun={(cmd) => writeToTab(tabId, cmd.replace(/\n+$/, "") + "\r")}
      />
      {shareTarget && (
        <ShareModal
          open
          kind={shareTarget.kind}
          title={shareTarget.title}
          rawText={shareTarget.rawText}
          dateStamp={shareTarget.dateStamp}
          onClose={() => setShareTarget(null)}
          saveUser={saveUser}
        />
      )}
    </div>
  );
}
