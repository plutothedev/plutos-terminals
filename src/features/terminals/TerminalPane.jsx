import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { pushOutput as pushRecordingOutput } from "./recording.js";

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
  cwd,
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

  // Live-prop refs so we don't have to re-run the spawn effect on prop change.
  const onActivityRef = useRef(onActivityChange);
  onActivityRef.current = onActivityChange;
  const onCostRef = useRef(onCostUpdate);
  onCostRef.current = onCostUpdate;
  const autoApproveRef = useRef(autoApprove);
  autoApproveRef.current = autoApprove;
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

  // In-pane hint: subtle overlay shown on fresh terminals. Dismissed on
  // user input, after 12s of visibility, or if scrollback was restored
  // (returning tab, not new). Pointer-events:none so it never blocks input.
  const [showHint, setShowHint] = useState(true);
  // Use a ref so the listen() closure can dismiss without forcing a stale
  // setShowHint reference into the spawn effect.
  const dismissHintRef = useRef(() => setShowHint(false));
  dismissHintRef.current = () => setShowHint(false);

  const setActivity = (next) => {
    if (activityRef.current === next) return;
    activityRef.current = next;
    try { onActivityRef.current?.(next); } catch {}
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
    if (!autoApproveRef.current || !ptyId) return;
    const now = Date.now();
    if (now - lastApproveAtRef.current < AUTO_APPROVE_DEBOUNCE_MS) return;
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
    if (hasArrow && hasYes && hasEsc) {
      lastApproveAtRef.current = now;
      invoke("pty_write", { id: ptyId, data: "1\r" }).catch(() => {});
      // Clear the buffer so we don't re-match the same prompt
      recentOutRef.current = "";
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
    let unlistenExit = null;
    const cmdsAtSpawn = Array.isArray(startCommandsRef.current) ? [...startCommandsRef.current] : [];

    const term = new Terminal({
      theme: xtermThemeRef.current,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    try { fit.fit(); } catch {}
    termRef.current = term;
    fitRef.current = fit;

    // Replay saved scrollback if we have one for this tab id.
    const replayScrollback = async () => {
      const id = tabIdRef.current;
      if (!id) return;
      try {
        const saved = await invoke("scrollback_load", { tabId: id });
        if (saved && alive) {
          term.write(saved);
          if (!saved.endsWith("\n")) term.writeln("");
          term.writeln("\x1b[90m─── scrollback restored ───\x1b[0m");
          // Returning tab — not a fresh terminal, hide the hint immediately.
          dismissHintRef.current?.();
        }
      } catch {}
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
      await replayScrollback();
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
            if (userPersisted && typeof userPersisted.anthropicKey === "string" && userPersisted.anthropicKey.length > 0) {
              env.ANTHROPIC_API_KEY = userPersisted.anthropicKey;
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
        const id = await invoke("pty_spawn", { cwd: cwd || null, cols, rows, extraEnv });
        if (!alive) {
          await invoke("pty_kill", { id }).catch(() => {});
          return;
        }
        ptyId = id;

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
          if (alive) term.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
        });

        term.onData((data) => {
          if (!alive || !ptyId) return;
          userHasTypedRef.current = true;
          // Any user input dismisses the welcome hint.
          dismissHintRef.current?.();
          // Clear the auto-approve match buffer when the user types — they
          // intend to answer the prompt themselves.
          recentOutRef.current = "";
          invoke("pty_write", { id: ptyId, data }).catch(() => {});
        });

        term.onResize(({ cols, rows }) => {
          if (alive && ptyId) {
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
        let skipPackCommands = false;
        if (cmdsAtSpawn.length > 0) {
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

    const ro = new ResizeObserver(() => {
      if (!alive) return;
      try { fit.fit(); } catch {}
    });
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

      // Persist scrollback (last N lines) before tearing down the PTY.
      const id = tabIdRef.current;
      if (id) {
        const all = scrollbackChunksRef.current.join("");
        const lines = all.split(/\r?\n/);
        const tail = lines.slice(-SCROLLBACK_REPLAY_LINES).join("\n");
        invoke("scrollback_save", { tabId: id, content: tail }).catch(() => {});
      }

      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();
      if (ptyId) invoke("pty_kill", { id: ptyId }).catch(() => {});
      try { term.dispose(); } catch {}
      termRef.current = null;
      fitRef.current = null;
    };
  }, [cwd]);

  // When a hidden pane becomes visible, refit + focus + reset activity.
  useEffect(() => {
    if (!visible) return;
    clearDoneTimer();
    bytesSinceSeenRef.current = 0;
    setActivity("idle");
    const t = setTimeout(() => {
      try { fitRef.current?.fit(); } catch {}
      try { termRef.current?.focus(); } catch {}
    }, 30);
    return () => clearTimeout(t);
  }, [visible]);

  useEffect(() => {
    if (!termRef.current || !xtermTheme) return;
    try { termRef.current.options.theme = xtermTheme; } catch {}
  }, [xtermTheme]);

  // Auto-dismiss the hint after 12 seconds of being visible. Resets when
  // the user toggles back to a tab so each pane gets a fair window.
  useEffect(() => {
    if (!showHint || !visible) return;
    const t = setTimeout(() => setShowHint(false), 12000);
    return () => clearTimeout(t);
  }, [visible, showHint]);

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
      {showHint && (
        <div
          style={{
            position: "absolute",
            inset: 16,
            pointerEvents: "none",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            color: "#6e7681",
            fontFamily: "'JetBrains Mono', Menlo, Monaco, monospace",
            fontSize: 11,
            lineHeight: 1.7,
            opacity: 0.55,
            transition: "opacity 0.5s",
            textAlign: "center",
            gap: 2,
            textShadow: "0 1px 2px rgba(0,0,0,0.6)",
          }}
        >
          <div style={{ fontSize: 13, marginBottom: 8, color: "#9D9D9D" }}>💡  Quick tips</div>
          <div>type commands like any terminal</div>
          <div>drag tabs between panels &nbsp;·&nbsp; double-click to rename</div>
          <div>right-click projects for git, npm scripts, recent files</div>
          <div>📦 load a .deck.json prompt pack from the header</div>
          <div style={{ fontSize: 10, opacity: 0.55, marginTop: 10 }}>fades in 12s · or just start typing</div>
        </div>
      )}
    </div>
  );
}
