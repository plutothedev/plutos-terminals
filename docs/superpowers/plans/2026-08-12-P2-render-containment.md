# P2 — Render containment plan (2026-08-12, rev 2 after adversarial audit)

Parent spec: `../specs/2026-08-12-perf-optimization-design.md`. Rev 1 BLOCKED (2 CRITICAL, 6 HIGH); every must-fix + medium folded in below. Build order T5 → T1 → T2 → T4 → T3; note (audit H2): T1's headline win fully materializes only once T2's pane memo lands — T1 alone contains flips to one panel's strip.

## T5 — Small independent fixes

1. **Monitor gate + async sysstats.** `useSystemStats(dockTab === "monitor" && !dockCollapsed)`; sysstats `system_stats` → thin async wrapper + spawn_blocking; 2.5s → 5s; **single-flight skip-if-inflight in useSystemStats** (audit M6: a hung disk stat must not queue overlapping ticks). Only DockMonitor consumes sysStats (the "status bar" comment in independentEffects is stale — fix it).
2. **totalCost** — swap the recursive tree walk for `allRenderedPaneIds(state.panels)` memoized on panels; edit lands in useTabTelemetry.js (add the import there). Verified: tabCosts keys are exactly leaf ids; special-tab exclusion safe.
3. **bridge split (audit C1 — the rev-1 CRITICAL).** `bridgeVersion` is TWO signals today: dims changes AND pty-registry changes (`setPtyId`/`unregisterPty` bump it via emitDims; ptyBridge's own comment says this is what re-pushes the companion session list when panes spawn). Split: `registryVersion` (bumped by setPtyId/unregisterPty) + `dimsVersion` (bumped by setTabDims). TerminalsTab keeps a `useRegistryListener()` subscription driving `sessionListJson` (rare bumps — spawn/death only); the DIMS subscription moves out of TerminalsTab into a shared `ActiveDims` leaf component used by BOTH StatusBar and MenuBar (MenuBar shows activeDims too — audit F2). Update ptyBridge.test.js deliberately for the two-channel surface. Split-drag then re-renders one leaf, not the chrome + 24 modals.
4. **Per-chunk JS.**
   (a) checkAutoApprove prefilter: cheap `includes("❯")`-class token check (single char, ANSI-interleave-proof; false positives fall through to the full scan). **The 2KB trim stays BEFORE the prefilter** (it is the only bound on recentOut), and **a prefilter miss MUST take the same waiting→active exit branch as a full-scan miss** (audit H5: the no-match path is the ONLY un-block signal — a bare early-return freezes "waiting" forever, the exact needs-you bug class the v0.6.0 audit fixed).
   (b) Shared transcript flush: ONE module-level 5s interval iterating registered flushers. **Registration is CREATE-ONCE (first mount) + unregistered via registerDestroyHook** — registry-lifetime like the bridge writer — because the transcript machinery is first-fiber-bound (audit H4: per-mount registration would flush the moved pane's empty new-fiber buffer forever while output accrues in the first fiber's closure). Each registered fn owns its own date-roll (flush under the OLD date, then roll — preserving the midnight semantics P1's transcript pool write-through contract depends on). Net behavior change worth a commit line: moved panes REGAIN periodic flush (today their interval dies).
   (c) updateSticky rAF-coalesced like checkCost; its raf ref canceled in paneCleanup (mirror costRafRef).

## T1 — Activity store

Store `src/features/terminals/activityStore.js`, module-level:
- Data: `Map<paneId, activity>` — **paneId only, NO projectId at set-time** (audit H1: producer-captured projectId goes stale across moveTabIntoSplit absorption, removeProject detach, and T2's cached handlers). Producer seam unchanged: TerminalPane's onActivityChange → `setPaneActivity(paneId, state)`. Replicate the idle-drop normalization useTabTelemetry does today.
- **Project mapping lives in a TerminalsTab-maintained index**: `rootPaneId → projectId`, rebuilt in a cheap effect on `[state.panels, projects]` (those changes re-render everything anyway); index rebuild notifies project listeners. Root-tab-ids only — preserving today's exact rollup semantics (split panes never feed project rollups).
- Hooks (audit C2 — full consumer set):
  - `useTabActivity(tabId)` → string primitive. Consumers: StatusBar active-session dot, TerminalPane's own needs (none — producer), anything per-tab.
  - `useProjectActivity(projectId)` → derived through the index. Consumers: ProjectSidebar row coloring, MobaHomeScreen (subscribe-ALL there instead — audit M2: per-card hooks in a `.map` are illegal; home screen renders only on home tabs, cheap).
  - `useActivitiesSnapshot()` → versioned CACHED-object whole-map subscription (React 18: getSnapshot must return a stable reference between versions). Consumers: DockMonitor (per-session status + fleet counts), AgentDashboard (header counts, filter pills, waiting-first sort), ProjectSidebar's shake transition-detection effect.
  - Panel strip (audit H2 — no per-tab row component exists): **TerminalPanel subscribes to its own leaf-id set** (per-panel subscription; an activity flip re-renders that ONE panel's strip + border rollup, and T2's pane memo keeps the panes out).
- Cleanup (audit M1): NOT a fictional "cost cleanup site" — wire store reconciliation into the EXISTING registry sweep (`reconcile(new Set(allRenderedPaneIds(...)))` effect in TerminalsTab): prune store keys not in the rendered set. Covers close, workspace load/reset (fresh ids), reopenTab id-reuse. The "needs you"/waiting state flows through this same activity value — clear semantics preserved because the producer seam and the visibility-reset path (TerminalPane) are untouched.
- Delete after migration: tabActivities/projectActivities objects in useTabTelemetry + all prop threading (TerminalsTab → TerminalPanel / ProjectSidebar / DockMonitor / StatusBar / AgentDashboard / homeApi).
- StrictMode: Set-based idempotent subscribe; no effects in the store.

## T2 — TerminalPane memo + stable identities

1. `memo(TerminalPane)`; per-paneId cached handler map for onActivityChange/onCostUpdate (existing `h` pattern). Verified stable already: notify, save/saveUser, useWorkspaceTree handlers; tab-object field identities survive unrelated mutations (targeted spreads).
2. `useStableValue` (prev-identity-when-shallow-equal, plain-object shallow equal incl. key-count): applied to `tabAutoApprove`, `tabProjectNames`. Toggle direction verified: content change → new identity → pane re-renders.
3. stateRef migration: useProjects AND **useSessionDispatch** (audit H3: focusExistingProjectTab/openProjectInPanel deps [state, persist] re-mint per persist → homeApi churns → every panel memo busts on every tab switch; runProjectScript's activePanelId dep and sidebarClickProject bust the sidebar the same way). Prior art: useWorkspaceTree's stateRef. activePanelId read from the ref at call time.
4. Harness (extended per H3): vitest render-count/identity tests asserting (a) activity flip re-renders only the affected panel's subscribers, (b) a switchTab persist leaves homeApi + sidebar handler + tabAutoApprove identities UNCHANGED, (c) an auto-approve toggle DOES change the map identity.

## T4 — Sidebar polling: batch + gate

1. `git_branch_status_many(cwds) -> map`: async command, ONE spawn_blocking slot, **inside it chunks of ~6 scoped threads** (audit M3: serial = sum of 2 subprocesses × N repos, can blow past the 30s cadence on cold/network repos; prior art netools port-scan batching). Frontend: one invoke, one setState, **skip-if-inflight guard**.
2. `net_latency_many(hosts) -> map`: same shape, **chunks(16)** scoped threads; **per-host addr cap = first 2 resolved addrs** (audit M4: the addr loop walks every resolved addr at 1.5s each — dual-stack dead host = 3s+). Existing `net_latency` body moves under spawn_blocking (kept for other callers).
3. Gates (audit M5): **per-tick `document.hidden` check INSIDE the interval** (never tear the interval down — a missed visible-event must not strand polling off) + immediate refresh on the visible flip; verified in-repo prior art (App.jsx flush-on-hidden) that WebView2 fires visibility on hide-to-tray; verify hide-to-tray + minimize once in-task with a log line. The rev-1 "collapsed joins effect deps" sub-item is DROPPED — dead code; the docked sidebar unmounts entirely when treeCollapsed, which already stops both polls.
4. ProjectRow: memoized row; precompute `{icon, haystack, tags}` per project (tags separate for the `#tag` filter branch); context menu + search input stay at sidebar level (verified clean surface).

## T3 — ModalHost conditional render (classification RESOLVED by audit — table adopted)

**AgentMode is the SOLE keep-mounted modal**: its agent loop lives in the component's start() closure; unmount mid-run orphans a running loop (shell commands keep executing, no step log, hangs forever at the next approval). All other 23 convert to `{open && <X/>}`:
RemoteControl (server state Rust-owned, status re-fetched per open) · Macros (recording is module-level; mid-record close/reopen correct) · SetupChecker · ModelPicker · McpInstaller (mid-install close loses only the spinner; invoke completes) · Settings (**improves**: stale headerSkin one-shot initializer re-hydrates per open) · DiffView (preserve the `diffWorktree` render-gate) · NetTools · Tunnels (form drafts stop surviving close — trivial, note in commit) · SshKeys (**improves**: typed passphrase no longer survives close) · Serial · HistorySearch · AskBar · SessionSummary · Workspaces · Shares · BroadcastGroup · VncConnect (**preserve the compound gate `vncOpen || !!vncLaunch`**) · RdpConnect (same) · ProjectDialog · SshPassword (**improves**: password fiber-state destroyed) · MasterPassword (**improves**: same) · CommandPalette.
7 of 24 already self-return null (hooks-only win); the other ~17 build full children trees per render today. lazy() chunks stay deferred to P4. Known pre-existing flag (NOT this task): AgentMode's on-open effect desyncs UI from a live run (setRunning(false) mid-run) — chip it.
Smoke list for pluto: open/close/reopen each converted modal (fresh state expected); agent run survives modal close.

## Gates & measurement

Per task: vitest (incl. the T2 harness) + full suite + build; cargo test for the two batched commands + sysstats wrapper. Whole-stream audit at end; every fix re-reviewed. Record before/after: renders-per-activity-flip (harness), polls-per-minute hidden vs visible (derivable), main-thread IPC count at boot.

## Non-goals

lazy() modal chunks, PromptEditor/Notebook boot gates (P4); virtualized tree; Rust hot path (P1 done).
