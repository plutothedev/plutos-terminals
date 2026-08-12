# Performance optimization — design (2026-08-12)

Pluto's ask: production-grade performance across run/render/cache/network. Method: 4 parallel read-only audits (render, IPC/Rust, network/caching, bundle/startup) before any code. Pluto approved building ALL 4 streams, sequential, v0.6.0 discipline per stream (adversarial plan-audit → subagent TDD → whole-stream audit → re-review every fix).

## Measured baseline

- dist 17.9MB; index chunk 1,475kB raw / 432kB gz; Monaco editor.api2 3,627kB (lazy but see P4-2); ts.worker 6.9MB; Meslo TTF 2.6MB unsubsetted.
- App data 209MB (198MB = WebView2 cache, normal). Transcripts 11MB/170 files, scrollback 180KB — audit-day GC works.
- PTY: one `app.emit` per 4KB read; measured JSON+JS-source inflation 1.39x avg / 2.0x worst; flood = 2,000-5,000 events/s/pane; Windows posted-message cap 10k → `let _ = app.emit` SILENTLY DROPS output past saturation.
- `spawn_blocking` count in backend: 1 (companion.rs). Everything else blocks tokio workers or the main thread.

## Stream P1 — PTY/Rust hot path

1. **Chunk coalescing in reader threads** (pty.rs:519-547 local, :1100 SSH, :1198 serial): accumulate, emit at ≤ every 8-16ms or 64KB. Kills the silent-drop bug + collapses 2-5k events/s to 60-125/s. Buf 4096→65536.
2. **Rotation off the read path** (pty.rs:200-246 truncate_tail): 15MB sync read+write inline before emit every 5MB → ping-pong segment files, O(1) rename.
3. **transcript_append** (commands.rs:971-993): sync command (main thread), open/write/close per 8KB flush per pane → async + pooled handles per (date,name); ideally fold into reader thread next to ScrollbackWriter.
4. **Kill-path mutex** (pty.rs:685-706 pty_kill, :1222-1241 kill_all, :564-570 reader-reap): kill()+wait() held under sessions lock on main thread → all panes freeze on tab close. Remove under lock, wait after release, spawn_blocking.
5. **pty_spawn sync→async** (pty.rs:414): ConPTY CreateProcess on UI thread, serialized per restored tab.
6. **scrollback_load** (commands.rs:765-780): main-thread full-file read up to 10MB per tab at boot, renderer keeps 100KB → async + tail-slice ~256KB newline-aligned; revive the dead SCROLLBACK_REPLAY_LINES cap (TerminalPane.jsx:95, never referenced).
7. **SSH idle spin** (pty.rs:1090,1106): 8ms sleep on WouldBlock = 125 wakeups/s/idle session → longer backoff when idle.

## Stream P2 — render containment

1. **tabActivities identity churn** (useTabTelemetry.js:84-96 → TerminalsTab.jsx:963): any pane's activity flip breaks TerminalPanel memo app-wide (~1.5-3 full renders/s with 8 agents) → per-tab useSyncExternalStore; no map prop.
2. **TerminalPane unmemoized + inline closures** (TerminalPane.jsx:219; TerminalPanel.jsx:645-6): memo() + cached per-paneId handler map (h-pattern exists at TerminalPanel.jsx:167).
3. **ModalHost** (chrome/ModalHost.jsx:34-262): 24 modal components execute per TerminalsTab render → `{open && <X/>}` + lazy() each (also P4 win).
4. **ProjectSidebar**: memoized ProjectRow + precomputed {icon,haystack} (ProjectSidebar.jsx:466,58-64,347-356); git_branch_status 30 IPC + 30 setStates/30s ungated (195-211) → ONE batched IPC returning map, one setState, document.hidden gate, spawn_blocking on the two git subprocesses (commands.rs:585-616); SSH latency probe (162-178) → batched, Promise.all, collapsed+hidden gates, netools.rs:164-181 spawn_blocking.
5. **Monitor gate** (TerminalsTab.jsx:256 vs :997): polls while dock collapsed → gate on `!dockCollapsed`; sysstats.rs sync→async; 2.5s→5s.
6. **totalCost deep-walk** (useTabTelemetry.js:120-139): recurses whole panel tree per cost tick → allRenderedPaneIds + memo on panels.
7. **bridgeVersion** (independentEffects.js:77-79): whole-chrome re-render per resize step → StatusBar-scoped subscription keyed to active tab.
8. **Per-chunk JS** (TerminalPane.jsx:1273-1317): cheap `includes()` gate before checkAutoApprove's stripAnsi; ONE shared transcript flush timer (not per-pane 5s); rAF-coalesce updateSticky (copy checkCost pattern :1290-1295).
9. tabAutoApprove/tabProjectNames/homeApi identity churn (useTabTelemetry.js:100-113, TerminalsTab.jsx:629-638) → stable derivations.

## Stream P3 — network/LLM

1. **Shared reqwest Client** (llm.rs:163,255; llm_tools.rs:196; share.rs:317,358): fresh client per request = TLS handshake per call, 14/agent run → static OnceLock client(s).
2. **Wire streaming** (llmStream.js has ZERO callers; llm_stream fully built llm.rs:246): DockAssistant.jsx:61, AskBar.jsx:57, ErrorExplainer.jsx:55, SessionSummary.jsx:36 all buffer → stream tokens. Also DockAssistant flattens 12 turns into one user string (:54-60) → role-structured messages.
3. **Anthropic prompt caching** (llm_tools.rs:203-217): no cache_control anywhere; agent run resends full tool schemas + history every step (O(n²), ~100k redundant tokens/14-step run) → cache_control ephemeral on tools tail + system + second-to-last message.
4. **Sync fetch-per-mutation** (App.jsx:164 notifyChange on EVERY save; synced surface = 4 keys, syncState.js:8-12): pane focus schedules GitHub fetch → surfaceValueKey early-return when synced keys unchanged. sync_push inline full-reclone gc every ~21st push on async runtime (sync_git.rs:259-272,185-231) → spawn_blocking + detached gc task. busy-drop (syncEngine.js:80) → pending-resync flag. pushWithRePull zero-delay retries → backoff+jitter.
5. **spawn_blocking sweep**: sync_git all 3 commands, netools (ping/tracert .output(), net_latency), sftp.rs:279-297 dispatch blocking recv, git_branch_status.
6. **Caches**: MCP tool list per server invalidated on add/remove/reconnect (manager.rs:99-109, refetched every agent start); SFTP listing Map+TTL~10s + sftp_home per session (SftpBrowser.jsx:56-89); UpdateBanner ETag + 24h gate + single mount (UpdateBanner.jsx:48-71, App.jsx:381+389).
7. **LLM resilience**: retry/backoff on 429/503 honoring Retry-After; streaming idle timeout instead of 120s total cap (kills long generations mid-stream today).

## Stream P4 — bundle/startup

1. **PromptEditor lazy** (TerminalPane.jsx:19, renders behind default-off flag :1809): 407kB raw/130kB gz CodeMirror+vim to everyone → lazy() + vim sub-import behind vimMode.
2. **NotebookView Monaco gate** (NotebookView.jsx:186-199): missing `visible` check → hidden restored notebook tab pulls 3.9MB at boot. One line: `if (!visible || ...)`. RemoteEditor.jsx:40 is the correct pattern.
3. **Boot stagger** (TerminalPanel.jsx:570-586 all tabs mount; TerminalPane spawn :1196 + replay :1089 ungated): 20-tab restore = 20 ConPTY spawns + replays at once → visible/active-first, parked placeholder for hidden tabs, spawn on first reveal (paneRegistry late-attach exists). Riskiest UX change in the plan — needs its own mini-audit.
4. **Meslo subset** (public/fonts 2.59MB TTF, loaded before createRoot main.jsx:8-10): woff2 subset Latin+powerline/Nerd PUA ~250-400KB; fonts.load after createRoot.
5. **vite build block** (vite.config.js has NONE): advancedChunks groups (react, xterm vendors — rolldown API not manualChunks), target esnext, modulePreload polyfill off.
6. **ImageAddon dynamic** (TerminalPane.jsx:8 vs :1027): 20kB gz.
7. **headerSkins CSS-in-JS** (headerSkins.js:346-1467, 42kB in JS, injected twice App.jsx:310 + independentEffects.js:82-86): real stylesheet; keep only custom-theme vars dynamic.
8. **Monaco slim** (monacoSetup.js:6 full barrel; ts.worker 6.9MB shipped, notebook needs markdown only): esm editor.api + registered-languages-only + drop ts/css/html workers. Candidate: replace Monaco with already-shipped CodeMirror later (bigger, separate decision).
9. **Startup misc**: per-pane double blob parse (TerminalPane.jsx:1108,1118 × N panes) → one shared read; welcome banner 450ms setTimeout per fresh pane (:1513) → trim; allOpenTabIds localStorage full-walk in sweep arg (App.jsx:321-332) post-paint idle.

## Verification

Per stream: TDD for every behavior change (Rust: coalescing/rotation/tail-slice unit tests; JS: store/memo/cache logic vitest). Measurables recorded before/after in the stream commit: bundle chunk sizes (build output), emit-rate counter under synthetic flood (dev instrument), boot IPC counts. Whole-stream adversarial audit + re-review-every-fix (non-optional). Full gates each commit: cargo test + vitest + build.

## Out of scope (explicitly)

Monaco→CodeMirror consolidation (separate product decision), virtualized session tree (only if >100 projects becomes real), VNC/RDP frame-path base64 rework (same class as P1-1 but lower usage — do after P1 proves the pattern).
