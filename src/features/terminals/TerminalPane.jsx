import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { ImageAddon } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";
import { pushOutput as pushRecordingOutput } from "./recording.js";
import { envForModel } from "./providers.js";
import ErrorExplainer from "./ErrorExplainer.jsx";
import { recordInput } from "./macros.js";
import {
  registerPtyWriter,
  unregisterPty,
  setTabDims,
  setTabVisible,
  isBroadcast,
  writeBroadcast,
  getTabPassword,
  writeToTab,
  registerTabReader,
  recordCommand,
} from "./ptyBridge.js";

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

// Scrollback persistence: keep the last ~100KB of PTY output in memory; on
// unmount, save the last 500 lines to disk so a Pluto's Terminals restart replays history.
const SCROLLBACK_MAX_BYTES = 100_000;
const SCROLLBACK_REPLAY_LINES = 500;

// Session transcripts: ANSI-stripped output appended to a daily markdown
// file every 5s (or sooner if 8KB has accumulated). Lets the user grep
// "what did claude work on Monday?" later.
const TRANSCRIPT_FLUSH_MS = 5000;
const TRANSCRIPT_FLUSH_BYTES = 8000;

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

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
function stripAnsi(s) {
  return s.replace(ANSI_RE, "");
}

function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function transcriptName(projectName, tabId) {
  const base = projectName ? `${projectName}` : "tab";
  const short = (tabId || "").slice(-6);
  return `${base}-${short}`;
}

// One terminal pane: spawns its own PTY on mount, kills it on unmount.
// `visible` toggles display so a hidden tab keeps its PTY + scrollback alive.
// `startCommands` is captured at mount and auto-typed after the shell init.
// `xtermTheme` is the xterm.js theme object (background / foreground / cursor /
//   ANSI palette). Driven by the active app skin via headerSkins.js
//   getSkinXtermTheme(). Passed down from TerminalsTab → TerminalPanel → here.
// `tabId` keys the on-disk scrollback file.
// `projectName` shapes the transcript filename.
// `autoApprove` enables Claude permission auto-confirmation.
// `onActivityChange(state)` and `onCostUpdate({tokens, cost})` report up.
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
  onActivityChange,
  onCostUpdate,
}) {
  const containerRef = useRef(null);
  const fitRef = useRef(null);
  const termRef = useRef(null);
  const searchAddonRef = useRef(null);
  // Find-in-terminal (Cmd/Ctrl+F) overlay state.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Command blocks (OSC 133): track the block boundaries the shell marks so we
  // can flag a failed command + feed it to the AI explainer.
  const currentBlockRef = useRef(null); // { startLine } between A and D
  const [failedBlock, setFailedBlock] = useState(null);  // banner: most recent failure
  const [explainBlock, setExplainBlock] = useState(null); // explainer popover target
  const startCommandsRef = useRef(startCommands);
  startCommandsRef.current = startCommands;
  const systemPromptRef = useRef(systemPrompt);
  systemPromptRef.current = systemPrompt;
  const xtermThemeRef = useRef(xtermTheme);
  xtermThemeRef.current = xtermTheme;

  // Activity tracking refs.
  const activityRef = useRef("idle");
  const bytesSinceSeenRef = useRef(0);
  const userHasTypedRef = useRef(false);
  const doneTimerRef = useRef(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Whether this pane is the focused one within its tab (relevant when the tab
  // is split into multiple panes). Gates autofocus-on-show so siblings don't
  // fight over focus. Read via ref so the visibility effect needn't re-run.
  const activeRef = useRef(active);
  activeRef.current = active;

  // Live-prop refs so we don't have to re-run the spawn effect on prop change.
  const onActivityRef = useRef(onActivityChange);
  onActivityRef.current = onActivityChange;
  const onCostRef = useRef(onCostUpdate);
  onCostRef.current = onCostUpdate;
  const autoApproveRef = useRef(autoApprove);
  autoApproveRef.current = autoApprove;
  const lastNotifyAtRef = useRef(0);

  // "Away" = this tab isn't the one you're looking at, or the app window isn't
  // focused. Used to gate OS notifications + the done audio cue.
  const isAway = () =>
    !visibleRef.current ||
    (typeof document !== "undefined" && document.hasFocus && !document.hasFocus());
  const notifyOS = (title, body) => {
    invoke("notify", { title, body }).catch(() => {});
  };
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;

  // Scrollback / transcript buffers — populated from the PTY stream.
  const scrollbackChunksRef = useRef([]); // [{s, len}]
  const scrollbackBytesRef = useRef(0);
  const transcriptBufRef = useRef("");
  const transcriptTimerRef = useRef(null);
  const transcriptDateRef = useRef(todayDate());

  // Auto-approve state.
  const recentOutRef = useRef("");
  const lastApproveAtRef = useRef(0);

  // Cost tracker state — only emit when the latest seen value changes.
  const lastCostRef = useRef({ tokens: 0, cost: 0 });
  // Sticky model family detected from the welcome banner. Held across
  // checkCost calls so the family signal survives the banner scrolling out
  // of the 10KB cost-scan window. Initialized to null; first banner hit
  // locks it in.
  const familyRef = useRef(null);

  const setActivity = (next) => {
    if (activityRef.current === next) return;
    const prev = activityRef.current;
    activityRef.current = next;
    try { onActivityRef.current?.(next); } catch {}
    // v0.1.25: audio cue when an agent transitions from working to done.
    // Soft Web-Audio-generated tone — no asset to bundle. Only fires when
    // the tab is NOT currently visible (you don't need a ding for the tab
    // you're staring at). Respects user gesture requirements: AudioContext
    // is created on demand and resumed if needed.
    if (prev === "active" && next === "done" && isAway()) {
      try { playDoneCue(); } catch {}
      notifyOS("Agent finished ✓", projectNameRef.current ? `${projectNameRef.current} is done` : "A session finished");
    }
  };
  const clearDoneTimer = () => {
    if (doneTimerRef.current) {
      clearTimeout(doneTimerRef.current);
      doneTimerRef.current = null;
    }
  };

  const appendScrollback = (chunk) => {
    if (!chunk) return;
    scrollbackChunksRef.current.push(chunk);
    scrollbackBytesRef.current += chunk.length;
    while (scrollbackBytesRef.current > SCROLLBACK_MAX_BYTES && scrollbackChunksRef.current.length > 1) {
      const dropped = scrollbackChunksRef.current.shift();
      scrollbackBytesRef.current -= dropped.length;
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
    const name = transcriptName(projectNameRef.current, id);
    invoke("transcript_append", {
      date: transcriptDateRef.current,
      name,
      content: buf,
    }).catch(() => {});
  };

  const checkAutoApprove = (ptyId) => {
    if (!ptyId) return;
    const now = Date.now();
    // Trim recent buffer to last 2KB for cheap pattern matching.
    if (recentOutRef.current.length > AUTO_APPROVE_BUFFER_BYTES) {
      recentOutRef.current = recentOutRef.current.slice(-AUTO_APPROVE_BUFFER_BYTES);
    }
    const text = stripAnsi(recentOutRef.current);
    // Heuristic: a Claude permission prompt has the arrow on option 1, the
    // word "Yes" nearby, and an "(esc)" hint. All three must appear.
    const hasArrow = /❯\s*1[.)]/.test(text);
    const hasYes = /\bYes\b/.test(text);
    const hasEsc = /\(esc\)/i.test(text) || /\[esc\]/i.test(text);
    if (!(hasArrow && hasYes && hasEsc)) return;
    if (autoApproveRef.current) {
      if (now - lastApproveAtRef.current < AUTO_APPROVE_DEBOUNCE_MS) return;
      lastApproveAtRef.current = now;
      invoke("pty_write", { id: ptyId, data: "1\r" }).catch(() => {});
      recentOutRef.current = ""; // don't re-match the same prompt
    } else if (isAway() && now - lastNotifyAtRef.current > 15000) {
      // Auto-approve off + you're elsewhere → ping that a session needs you.
      lastNotifyAtRef.current = now;
      notifyOS("Needs your input", projectNameRef.current ? `${projectNameRef.current} is waiting for approval` : "A session is waiting for approval");
    }
  };

  const checkCost = () => {
    // Scan the LAST ~10KB of scrollback rather than the 2KB recent buffer —
    // the welcome banner with "38.1k tokens" and /cost summaries scroll out
    // of the recent buffer fast on a busy session.
    let bytes = 0;
    const parts = [];
    for (let i = scrollbackChunksRef.current.length - 1; i >= 0; i--) {
      const chunk = scrollbackChunksRef.current[i];
      parts.unshift(chunk);
      bytes += chunk.length;
      if (bytes >= COST_SCAN_BYTES) break;
    }
    const text = stripAnsi(parts.join(""));

    let next = { ...lastCostRef.current };
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
    if (!familyRef.current) {
      const detected = detectFamily(text);
      if (detected) familyRef.current = detected;
    }
    if (next.tokens > 0) {
      const family = familyRef.current || DEFAULT_FAMILY;
      const rate = FAMILY_BLENDED_RATE_PER_M[family] || FAMILY_BLENDED_RATE_PER_M[DEFAULT_FAMILY];
      const estimated = (next.tokens * rate) / 1_000_000;
      if (estimated > next.cost) {
        next.cost = estimated;
        changed = true;
      }
    }

    if (changed) {
      lastCostRef.current = next;
      try { onCostRef.current?.(next); } catch {}
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let alive = true;
    let ptyId = null;
    let unlistenData = null;
    let jumpFwdId = null; // jump-host tunnel to tear down on unmount
    let restoringScrollback = false; // suppress OSC 133 while replaying old output
    let unlistenExit = null;
    const cmdsAtSpawn = Array.isArray(startCommandsRef.current) ? [...startCommandsRef.current] : [];

    const term = new Terminal({
      theme: xtermThemeRef.current,
      fontSize: 13,
      // MesloLGS NF first so the MobaXterm-style prompt's powerline arrows ()
      // render; falls back to JetBrains Mono / Menlo if the bundled font fails.
      fontFamily: "'MesloLGS NF', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
      cursorBlink: true,
      cursorStyle: "bar",
      // v0.1.32: bumped from 5000 to 10000 lines so restored scrollback from
      // disk (now up to ~50000 lines worth at 5MB/100chars) has enough live
      // buffer to actually be scrollable. Memory cost is modest — xterm cells
      // are compact; ~16MB per pane at full fill, ~150MB across 8 packed panes.
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    // Cmd/Ctrl+F opens the find overlay (intercepted before the PTY).
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === "keydown" && (ev.metaKey || ev.ctrlKey) && !ev.shiftKey && ev.key.toLowerCase() === "f") {
        setSearchOpen(true);
        return false;
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
        const re = /(?:~|\/)[^\s'"()<>:]{2,}(?::\d+(?::\d+)?)?/g;
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
    term.open(container);
    // Inline images: Sixel + iTerm2 inline-image protocol (image previews,
    // `imgcat`-style output, charts from CLIs that emit them). NOTE: the WebGL
    // renderer (@xterm/addon-webgl) was tried here but renders blank glyphs in
    // Tauri's WKWebView, so we stay on xterm's default DOM renderer.
    try { term.loadAddon(new ImageAddon()); } catch { /* ignore */ }
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
        currentBlockRef.current = { startLine: here };
      } else if (data === "D" || data.startsWith("D;")) {
        const blk = currentBlockRef.current;
        currentBlockRef.current = null;
        if (!blk) return true; // first D (after our init) — no block open
        const exit = data.includes(";") ? parseInt(data.split(";")[1], 10) : 0;
        if (!Number.isNaN(exit) && exit !== 0) {
          let text = "";
          for (let i = blk.startLine; i <= here && i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line) text += line.translateToString(true) + "\n";
          }
          text = text.replace(/\n{3,}/g, "\n\n").trim();
          if (text) setFailedBlock({ exitCode: exit, text, key: `${here}:${Date.now()}` });
        }
      }
      return true; // handled (don't pass the OSC through to the screen)
    });
    // Command history: the shell's preexec hook emits ESC]1337;PlutoCmd=<base64>
    // with each command it's about to run (1337 is iTerm2's namespace — we only
    // claim the PlutoCmd payload and pass anything else through).
    term.parser.registerOscHandler(1337, (data) => {
      if (!data.startsWith("PlutoCmd=")) return false;
      if (restoringScrollback) return true; // don't re-record replayed scrollback
      try {
        const bin = atob(data.slice("PlutoCmd=".length));
        const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
        recordCommand(new TextDecoder().decode(bytes));
      } catch { /* malformed payload — ignore */ }
      return true;
    });
    termRef.current = term;
    fitRef.current = fit;
    // Only fit when the container is actually on-screen with a real size. A
    // hidden tab is display:none (0×0); fitting then clamps the PTY to a tiny
    // width and makes zsh redraw a WRAPPED prompt in the background — the
    // "wonky prompt on tab switch" bug. Skipping 0-size keeps hidden tabs intact.
    const safeFit = () => {
      if (!alive || !container.clientWidth || !container.clientHeight) return;
      try { fit.fit(); } catch {}
    };
    safeFit();

    // Once the bundled powerline font is ready, RE-ASSIGN fontFamily so xterm
    // rebuilds its glyph atlas with MesloLGS NF (a plain refresh() keeps the
    // fallback atlas, so the  powerline glyphs wouldn't render otherwise),
    // then re-fit for the corrected glyph widths.
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (!alive) return;
        try {
          term.options.fontFamily = "'MesloLGS NF', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace";
          safeFit();
          term.refresh(0, term.rows - 1);
        } catch {}
      }).catch(() => {});
    }

    // Replay saved scrollback if we have one for this tab id.
    const replayScrollback = async () => {
      const id = tabIdRef.current;
      if (!id) return false;
      try {
        const saved = await invoke("scrollback_load", { tabId: id });
        if (saved && alive) {
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

    // Periodic transcript flush. Persistent across the pane's lifetime.
    transcriptTimerRef.current = setInterval(() => {
      // Roll over to a new date file at midnight.
      const today = todayDate();
      if (today !== transcriptDateRef.current) {
        flushTranscript();
        transcriptDateRef.current = today;
      } else {
        flushTranscript();
      }
    }, TRANSCRIPT_FLUSH_MS);

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
          let userRaw = null;
          try { userRaw = localStorage.getItem("plutos-terminals:user:v0"); } catch (_) { /* ignore */ }
          if (userRaw) {
            const userPersisted = JSON.parse(userRaw);
            const keys = (userPersisted && userPersisted.providerKeys) || {};
            const baseUrls = (userPersisted && userPersisted.providerBaseUrls) || {};
            // Default Claude key now lives in the Models section as
            // providerKeys.anthropic (legacy userPersisted.anthropicKey is the
            // pre-consolidation fallback for not-yet-migrated state).
            const defaultAnthropic =
              (typeof keys.anthropic === "string" && keys.anthropic.length > 0)
                ? keys.anthropic
                : (typeof userPersisted?.anthropicKey === "string" ? userPersisted.anthropicKey : "");
            if (defaultAnthropic) env.ANTHROPIC_API_KEY = defaultAnthropic;
            // Multi-LLM routing: if the user picked an active provider/model,
            // inject its env vars so `claude` / `codex` route there. Takes
            // precedence over the default ANTHROPIC_API_KEY above.
            const am = userPersisted && userPersisted.activeModel;
            if (am && am.providerId && am.model && typeof keys[am.providerId] === "string" && keys[am.providerId].length > 0) {
              Object.assign(env, envForModel(am.providerId, am.model, keys[am.providerId], baseUrls[am.providerId]));
            }
          }
          // envOverrides (and the legacy anthropicKey for not-yet-migrated
          // users) still live in the per-window state.
          const winRaw = localStorage.getItem("plutos-terminals:state:v0");
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
            jumpFwdId = jf.id;
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
        if (!alive) {
          await invoke("pty_kill", { id }).catch(() => {});
          return;
        }
        ptyId = id;

        // Expose this tab's PTY to the snippets drawer / status bar via the
        // bridge. Writer closes over the local ptyId; dims reported below.
        registerPtyWriter(tabId, (data) => {
          if (ptyId) invoke("pty_write", { id: ptyId, data }).catch(() => {});
        });
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

        unlistenData = await listen(`pty://${id}`, (e) => {
          if (!alive) return;
          const payload = e.payload || "";
          term.write(payload);

          // v0.1.18: feed the asciinema recorder if this tab is being recorded.
          // Helper is a no-op when there's no active recording for tabId.
          pushRecordingOutput(tabId, payload);

          // Feed the various analysis buffers.
          appendScrollback(payload);
          appendTranscript(payload);
          recentOutRef.current += payload;
          checkAutoApprove(ptyId);
          checkCost();

          // Activity tracking: only count when user isn't watching this tab.
          if (visibleRef.current) return;
          bytesSinceSeenRef.current += payload.length;
          if (bytesSinceSeenRef.current >= ACTIVITY_BYTE_THRESHOLD && userHasTypedRef.current) {
            setActivity("active");
            clearDoneTimer();
            doneTimerRef.current = setTimeout(() => {
              if (alive && !visibleRef.current) setActivity("done");
            }, DONE_TIMEOUT_MS);
          }
        });

        unlistenExit = await listen(`pty-exit://${id}`, () => {
          if (!alive) return;
          const msg = serial ? "[serial port closed]" : connection ? "[ssh disconnected]" : "[process exited]";
          term.writeln(`\r\n\x1b[90m${msg}\x1b[0m`);
        });

        // Both listeners are live — tell the backend it may begin streaming.
        // SSH sessions gate their first read on this so the server's initial
        // MOTD/prompt burst can't race ahead of the pty://{id} subscription
        // above (the old fixed 150ms warm-up lost that race under load).
        // No-op for local/serial sessions. If this invoke is lost, the backend
        // falls back to a short timeout, so surface (don't swallow) the failure.
        invoke("pty_ready", { id }).catch((e) => console.warn("pty_ready failed", e));

        term.onData((data) => {
          if (!alive || !ptyId) return;
          userHasTypedRef.current = true;
          recordInput(data); // macro recording (no-op unless armed)
          // Clear the auto-approve match buffer when the user types — they
          // intend to answer the prompt themselves.
          recentOutRef.current = "";
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
          if (alive && ptyId) {
            setTabDims(tabId, cols, rows);
            invoke("pty_resize", {
              id: ptyId,
              cols: Math.max(cols, MIN_COLS),
              rows: Math.max(rows, MIN_ROWS),
            }).catch(() => {});
          }
        });

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
            if (!claudeAvailable && alive) {
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
            if (!alive || !ptyId) break;
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
        if (!connection && !serial && cmdsAtSpawn.length === 0 && !isWindowsUA && alive && ptyId) {
          // Let the shell render its first prompt before we send the (now short)
          // welcome line so the colours/box land cleanly.
          await new Promise(r => setTimeout(r, 450));
          // Colorful output like MobaXterm: BSD/GNU ls colors + colored grep/less
          // + a few quality-of-life aliases. (Kept short so the welcome init fits
          // comfortably in one shell line alongside the big welcome box.)
          const colors = "export CLICOLOR=1; export LSCOLORS=ExGxFxdaCxDaDahbadacec; export LESS='-R'; alias grep='grep --color=auto'; alias ll='ls -lah'; alias la='ls -laGh';";
          // MobaXterm v12.4 segmented prompt: green 📅 date  cyan 🕐 time
          // yellow 📁 path, joined by powerline  arrows (rendered via the
          // bundled MesloLGS NF font). Each  carries fg = the colour it comes
          // from, bg = the colour it goes to, so the segments blend like
          // MobaXterm's prompt.
          const zshPrompt = "PROMPT='%K{2}%F{0} 📅 %D{%d/%m/%Y} %K{6}%F{2}%F{0} 🕐 %* %K{3}%F{6}%F{0} 📁 %~ %k%F{3}%f '";
          const bashPrompt = "PS1='\\[\\e[42;30m\\] 📅 \\D{%d/%m/%Y} \\[\\e[32;46m\\]\\[\\e[30;46m\\] 🕐 \\t \\[\\e[36;43m\\]\\[\\e[30;43m\\] 📁 \\w \\[\\e[0;33m\\]\\[\\e[0m\\] '";
          // MobaXterm-style welcome box: a white-bordered rectangle on the pure
          // black terminal, with a cyan title, yellow ► markers, and green ✓
          // checks. Plain text is padded to a fixed inner width BEFORE color is
          // layered on so the box edges align across every line. The box is
          // written to a file (real ESC bytes) and the shell `cat`s it before
          // the first prompt — clean ordering, and the short `cat` command
          // avoids the tty canonical line-length limit that truncates a 2.4 KB
          // inline printf.
          const E = "\x1b";
          // Per-segment colour: each line is a list of [text, ansiCode|null]
          // pairs (+ optional center / hang). The box edges align because the
          // inner width is measured on the PLAIN text (✓ ✗ · ► are all width 1)
          // and colour is layered on after. CRUCIALLY the box is sized to the
          // pane's actual column count and content is word-wrapped, so a narrow
          // split pane never wraps a line past the border. MobaXterm-style.
          const BORDER = "1;36";       // cyan box (MobaXterm header vibe)
          const TITLE_BG = "1;30;46";  // black-on-cyan title bar
          const wrap = (code, s) => (code ? `${E}[${code}m${s}${E}[0m` : s);
          const C = (c, t) => [t, c];  // coloured segment
          const T = (t) => [t, null];  // plain segment
          const lines = [
            { center: true, segs: [C(TITLE_BG, "  ✦ Pluto's Terminal ✦  ")] },
            { center: true, segs: [C("36", "free multi-terminal for the Pluto community")] },
            { segs: [] },
            { hang: 2, segs: [C("1;36", "► "), T("Saved sessions live in the "), C("1;33", "Sessions"), T(" panel — SSH · local · serial · RDP/VNC")] },
            { hang: 2, segs: [C("1;36", "► "), T("Scrollback is "), C("1;32", "persistent"), T(" — every tab is saved and replayed on restart")] },
            { hang: 2, segs: [C("1;36", "► "), C("1;35", "MultiExec"), T(" broadcasts your typing to every visible terminal at once")] },
            { hang: 2, segs: [C("1;36", "► "), C("1;36", "Models"), T(": route to any LLM — Claude · GPT · Gemini · GLM · Kimi · 16 providers")] },
            { hang: 2, segs: [C("1;36", "► "), T("Split panes, drag tabs and pin sessions to shape your workspace")] },
            { hang: 2, segs: [C("1;36", "► "), T("Tools, snippets and a file browser are one click away in the toolbar")] },
            { hang: 2, segs: [C("1;36", "► "), T("Command status shows as a symbol   ("), C("1;32", "✓"), T(" ok · "), C("1;31", "✗"), T(" failed)")] },
            { segs: [] },
            { hang: 2, segs: [C("1;36", "► "), C("1;31", "Tip!")] },
            { hang: 6, segs: [T("   Run "), C("1;33", "Claude Code"), T(", Codex and other AI agents side by side — each in")] },
            { hang: 6, segs: [T("   its own git worktree, on "), C("1;33", "any model"), T(" you pick.")] },
            { hang: 6, segs: [T("   Press "), C("1;33", "Ctrl+K"), T(" for the command palette, or "), C("1;36", "Home"), T(" to launch.")] },
            { segs: [] },
            { hang: 3, segs: [C("1;32", "➜ "), T("Docs: "), C("4;36", "https://github.com/plutothedev/plutos-terminals")] },
            { hang: 3, segs: [C("1;35", "➜ "), T("Community: "), C("4;35", "https://discord.gg/3cZQVgKF")] },
          ];
          const plainLen = (segs) => segs.reduce((n, [t]) => n + t.length, 0);
          // Fit to the pane: -6 leaves the border (space+│+space ... space+│) and
          // a 1-col right margin so terminals with a magic margin don't wrap.
          const maxInner = Math.max(...lines.map((l) => plainLen(l.segs)));
          const W = Math.max(24, Math.min(maxInner, (term.cols || 80) - 6));
          // Word-wrap coloured segments to width, hang-indenting continuations
          // and hard-splitting any token longer than a row (e.g. a URL).
          const wrapLine = (segs, width, hang = 0) => {
            const rows = [];
            let cur = [], curLen = 0;
            const startRow = (withHang) => { cur = []; curLen = 0; if (withHang && hang) { cur.push([" ".repeat(hang), null]); curLen = hang; } };
            startRow(false);
            for (const [t, c] of segs) {
              for (const tok of t.split(/(\s+)/)) {
                if (tok === "") continue;
                if (/^\s+$/.test(tok)) {
                  if (curLen > 0 && curLen + tok.length <= width) { cur.push([tok, c]); curLen += tok.length; }
                  continue;
                }
                let w = tok;
                while (w.length > width - curLen) {
                  if (curLen > (hang || 0)) { rows.push(cur); startRow(true); continue; }
                  const avail = Math.max(1, width - curLen);
                  cur.push([w.slice(0, avail), c]); curLen += avail; w = w.slice(avail);
                  rows.push(cur); startRow(true);
                }
                if (w.length) { cur.push([w, c]); curLen += w.length; }
              }
            }
            rows.push(cur);
            return rows;
          };
          const box = [" " + wrap(BORDER, "┌" + "─".repeat(W + 2) + "┐")];
          const pushRow = (rowSegs, center) => {
            const len = rowSegs.reduce((n, [t]) => n + t.length, 0);
            const left = center ? Math.max(0, Math.floor((W - len) / 2)) : 0;
            const right = Math.max(0, W - len - left);
            const inner = " ".repeat(left) + rowSegs.map(([t, c]) => wrap(c, t)).join("") + " ".repeat(right);
            box.push(" " + wrap(BORDER, "│") + " " + inner + " " + wrap(BORDER, "│"));
          };
          lines.forEach((l) => {
            if (!l.segs.length) { pushRow([[" ", null]], false); return; }
            const rows = wrapLine(l.segs, W, l.hang || 0);
            rows.forEach((rowSegs, idx) => pushRow(rowSegs, l.center && idx === 0));
          });
          box.push(" " + wrap(BORDER, "└" + "─".repeat(W + 2) + "┘"));
          const boxRaw = "\n" + box.join("\n") + "\n\n";
          // OSC 133 shell integration (command blocks): emit a prompt mark (A)
          // and a command-done mark (D;<exit>) so the UI can pair them into
          // blocks and flag failures. zsh via add-zsh-hook precmd; bash by
          // prepending to PROMPT_COMMAND (both preserve the user's own hooks).
          // $? is read FIRST so the real exit code survives.
          const osc133 =
            `__plt133z(){ printf '\\033]133;D;%s\\007\\033]133;A\\007' "$?"; }; ` +
            `__plt133b(){ local __e=$?; printf '\\033]133;D;%s\\007\\033]133;A\\007' "$__e"; }; ` +
            `if [ -n "$ZSH_VERSION" ]; then autoload -Uz add-zsh-hook 2>/dev/null; add-zsh-hook precmd __plt133z 2>/dev/null; ` +
            `elif [ -n "$BASH_VERSION" ]; then PROMPT_COMMAND="__plt133b\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; fi`;
          const promptSetup = `${colors} if [ -n "$ZSH_VERSION" ]; then ${zshPrompt}; elif [ -n "$BASH_VERSION" ]; then ${bashPrompt}; fi; ${osc133}`;
          // Command-history capture: emit ESC]1337;PlutoCmd=<base64> for each
          // command the shell is about to run. zsh via preexec (clean); bash via
          // a guarded DEBUG trap (best-effort — dedup on the app side handles
          // pipeline repeats). Sent as its own line so promptSetup stays under
          // the tty canonical line-length limit (MAX_CANON).
          const cmdCapture =
            `__pltcmdz(){ printf '\\033]1337;PlutoCmd=%s\\007' "$(printf '%s' "$1" | base64 | tr -d '\\n')"; }; ` +
            `__pltcmdb(){ case "$BASH_COMMAND" in __plt*|"$PROMPT_COMMAND") return;; esac; printf '\\033]1337;PlutoCmd=%s\\007' "$(printf '%s' "$BASH_COMMAND" | base64 2>/dev/null | tr -d '\\n')"; }; ` +
            `if [ -n "$ZSH_VERSION" ]; then autoload -Uz add-zsh-hook 2>/dev/null; add-zsh-hook preexec __pltcmdz 2>/dev/null; ` +
            `elif [ -n "$BASH_VERSION" ]; then trap '__pltcmdb' DEBUG; fi`;
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
          let display;
          if (restored) {
            display = `printf '\\033[2J\\033[H'`;
          } else {
            display = "clear";
            try {
              const p = await invoke("write_welcome_file", { content: boxRaw });
              if (p) display = `clear; cat '${String(p).replace(/'/g, "'\\''")}'`;
            } catch { /* no file → just clear */ }
          }
          if (alive && ptyId) {
            try { await invoke("pty_write", { id: ptyId, data: promptSetup + "\r" }); } catch {}
            try { await invoke("pty_write", { id: ptyId, data: cmdCapture + "\r" }); } catch {}
            try { await invoke("pty_write", { id: ptyId, data: display + "\r" }); } catch {}
          }
        }

        // System prompt injection (v0.1.8 Tier 1 #1) — after start commands
        // run (typically `claude`), wait for Claude Code to finish booting,
        // then type the system prompt as the first user message. Turns
        // packs from "tab labels" into actual specialized agents.
        const sysPrompt = systemPromptRef.current;
        if (!skipPackCommands && sysPrompt && typeof sysPrompt === "string" && sysPrompt.trim().length > 0 && alive && ptyId) {
          // 2s lets `claude` finish initializing + render its prompt before
          // we paste. If Claude isn't ready yet, the input buffers and gets
          // consumed once the REPL is alive.
          await new Promise(r => setTimeout(r, 2000));
          if (alive && ptyId) {
            try {
              await invoke("pty_write", { id: ptyId, data: sysPrompt.trim() + "\r" });
            } catch {}
          }
        }
      } catch (err) {
        if (alive) term.writeln(`\r\n\x1b[31m[spawn failed: ${err}]\x1b[0m`);
      }
    })();

    const ro = new ResizeObserver(safeFit);
    ro.observe(container);

    return () => {
      alive = false;
      ro.disconnect();
      clearDoneTimer();
      if (transcriptTimerRef.current) {
        clearInterval(transcriptTimerRef.current);
        transcriptTimerRef.current = null;
      }
      flushTranscript();

      // v0.1.29: scrollback persistence moved to the Rust PTY reader thread
      // (see pty.rs::ScrollbackWriter). The renderer-side save here was racy
      // — invoke() is async, .catch() swallows errors, and tray→Quit fires
      // app.exit(0) which kills the process before the IPC message reaches
      // Rust. Even if it had landed, it would have overwritten the rich
      // byte-level file Rust now owns with a lossy "last 500 lines,
      // newline-split, ANSI stripped via join" version. So this is now a
      // no-op — Rust already wrote every chunk to disk as it streamed.

      unregisterPty(tabId);
      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();
      if (ptyId) invoke("pty_kill", { id: ptyId }).catch(() => {});
      if (jumpFwdId) invoke("port_forward_stop", { id: jumpFwdId }).catch(() => {});
      try { term.dispose(); } catch {}
      termRef.current = null;
      fitRef.current = null;
    };
  }, [cwd]);

  // Report visibility to the bridge so MultiExec broadcast only targets the
  // terminals the user can actually see (the active tab of each panel).
  useEffect(() => {
    setTabVisible(tabId, visible);
  }, [tabId, visible]);

  // When a hidden pane becomes visible, refit + focus + reset activity.
  useEffect(() => {
    if (!visible) return;
    clearDoneTimer();
    bytesSinceSeenRef.current = 0;
    setActivity("idle");
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
      matchOverviewRuler: "#5fd75f",
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

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: visible ? "block" : "none",
        overflow: "hidden",
      }}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%", padding: 6, boxSizing: "border-box" }} />
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
            border: "1px solid #ff6b6b", borderRadius: 8, padding: "6px 8px 6px 12px",
            boxShadow: "0 6px 18px rgba(0,0,0,0.5)", fontFamily: "var(--phn-ui-font)",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--phn-text-fg, #d4d4d4)" }}>
            <span style={{ color: "#ff6b6b" }}>✗</span> command failed · exit {failedBlock.exitCode}
          </span>
          <button
            onClick={() => { setExplainBlock(failedBlock); setFailedBlock(null); }}
            style={{
              background: "var(--phn-link, #4aa8c0)", border: "none", color: "#06223a",
              borderRadius: 5, padding: "3px 10px", fontSize: 12, fontWeight: 600,
              cursor: "pointer", fontFamily: "var(--phn-ui-font)",
            }}
          >
            Explain ✨
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
    </div>
  );
}
