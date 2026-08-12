# P2 — Render containment plan (2026-08-12)

Parent spec: `../specs/2026-08-12-perf-optimization-design.md` (P2 section; file:line evidence there). Goal: high-frequency signals stop re-rendering the whole app; polling stops running blind. Build order T5 → T1 → T2 → T4 → T3 (riskiest last).

## T5 — Small independent fixes

1. Monitor gate: `useSystemStats(dockTab === "monitor" && !dockCollapsed)` (TerminalsTab.jsx:256 vs :997 — polls a main-thread disk stat every 2.5s into a collapsed dock forever). sysstats.rs `system_stats` → thin async wrapper + spawn_blocking (it's a sync command on the main thread today); period 2.5s → 5s.
2. totalCost (useTabTelemetry.js:120-139): replace the recursive whole-tree walk (runs per cost tick, up to 1/s/agent) with `allRenderedPaneIds(state.panels)` (already imported in TerminalsTab) memoized on `state.panels`.
3. bridgeVersion (independentEffects.js:77-79): TerminalsTab subscribes to EVERY dims change (split-drag = per-mousemove chrome re-render + sessionListJson JSON.stringify tree walk). Move the subscription into StatusBar, snapshot scoped to the active tab's dims; drop bridgeVersion from TerminalsTab and from sessionListJson's deps (audit: only activeDims consumes it).
4. Per-chunk JS (TerminalPane.jsx handleChunk): (a) cheap `includes()` prefilter before checkAutoApprove's stripAnsi pass (two regex passes per chunk today); (b) ONE module-level 5s transcript flush interval iterating registered panes (today: one interval per pane = 4 wakeups/s at 20 panes) — register/unregister in the pane lifecycle, same flush fn; (c) rAF-coalesce `updateSticky` exactly like checkCost (term.onScroll fires per scrolled line; updateSticky walks up to 200 blocks).

## T1 — Activity store (the #1 whole-app re-render)

Today: any pane's activity flip rebuilds the `tabActivities` object (useTabTelemetry.js:84-96) → direct prop of every TerminalPanel → memo broken app-wide (~1.5-3 full re-renders/s with 8 background agents) → projectActivities cascades the same way into ProjectSidebar + homeApi.

New `src/features/terminals/activityStore.js` (module-level, mirrors ptyBridge's store pattern):
- `setTabActivity(tabId, state, projectId)` — producer (TerminalPane's existing onActivityChange call site).
- `useTabActivity(tabId)` — useSyncExternalStore, per-tab listener set; only the components rendering THAT tab's dot subscribe (tab strip row, agent dashboard row).
- `useProjectActivity(projectId)` — per-project derived subscription (a tab change bumps only its project's listeners); ProjectSidebar rows + homeApi consume this.
- `clearTab(tabId)` on close (wired where cost cleanup already happens).
- getSnapshot returns primitives/frozen per-key values — stable identity when unchanged (React 18 tearing rule); server-snapshot arm returns "idle".
Delete: `tabActivities`/`projectActivities` objects + their prop threading through TerminalsTab → TerminalPanel → tabs, and the ProjectSidebar prop. `onTabActivityChange` stays as the single producer seam (now calling the store; the useTabTelemetry activity state goes away entirely).
StrictMode: subscribe/unsubscribe idempotent; no effects in the store itself.

## T2 — TerminalPane memo + stable identities

1. `memo(TerminalPane)` + kill the per-render closures at TerminalPanel.jsx:645-646: per-paneId cached handler map (the existing `h` pattern at TerminalPanel.jsx:167) for onActivityChange/onCostUpdate.
2. New `useStableValue(compute, deps, isEqual)` helper (or shallow-equal map variant): `tabAutoApprove` and `tabProjectNames` (useTabTelemetry.js:100-113) rebuild on every workspace mutation with fresh identity while contents rarely change — return the previous identity when shallow-equal, so panel memos hold across unrelated tab switches.
3. useProjects handlers (useProjects.js:34-124): adopt the stateRef pattern useWorkspaceTree already uses (deps [state, persist, projects] currently mint new fns per persist — TerminalsTab.jsx:757's "stable" comment is false today). homeApi (TerminalsTab.jsx:629-638) then stabilizes off T1's store + these.
Verification: React DevTools-style probe not available headless — instead a vitest render-count harness on TerminalPanel with a mock pane: assert an activity flip in tab A re-renders only A's subscribers, and a workspace mutation with unchanged auto-approve map does not re-render a memoized child (identity assertions on the maps).

## T4 — Sidebar polling: batch + gate

1. New Rust `git_branch_status_many(cwds: Vec<String>) -> HashMap<String, Option<BranchStatus>>`: async command, spawn_blocking, serial iteration inside (two git subprocesses per repo, off the runtime; N parallel workers would block N tokio threads — the audit's exact complaint). Frontend: ONE invoke per 30s cycle, ONE setState with the map (today: N invokes + N setStates, ungated).
2. Same shape for latency: `net_latency_many(hosts: Vec<String>) -> HashMap<String, Option<u32>>` — inside, bounded parallel probes via scoped threads in spawn_blocking (sequential 1.5s timeouts × 40 unreachable hosts = 60s/cycle otherwise); netools.rs `net_latency` body (blocking DNS + connect_timeout) moves under spawn_blocking either way, single command kept for any other callers.
3. Gates: both effects skip while `document.hidden` (visibilitychange listener triggers an immediate refresh on return) and while the session tree is collapsed (`collapsed` joins the effect deps — the audit's render-only-gate bug); latency probe also skips while the ribbon panel hides the tree (treeCollapsed unmounts it already — verified).
4. ProjectRow extraction: memoized row component; precompute `{icon, haystack}` per project in a useMemo keyed on `projects` (osIconFor regexes + matchesQuery haystacks run per row per keystroke today); search filter consumes the precomputed haystack.

## T3 — ModalHost: conditional render (RISKIEST — per-modal state audit gates it)

Today all 24 modal components execute their hooks + allocate full element trees on every TerminalsTab render (~600 createElement calls); Modal.jsx returns null when closed but the components stay MOUNTED — so any internal state persists across close/reopen. Conditional rendering (`{open && <X/>}`) unmounts on close and RESETS that state. Task = classify all 24:
- Stateless-when-closed (payload arrives via props on open; internal state is per-open scratch): convert to `{open && <X/>}`. Expected majority (SettingsModal, SshKeysModal, TunnelsModal, Serial/Vnc/Rdp connect, Workspaces, Shares, BroadcastGroup, NetTools, Macros, History, Ask, Summary, ModelPicker, McpInstaller, SetupChecker, CommandPalette, MasterPassword, ProjectDialog, RemoteControl…).
- Stateful-across-close (holds live process/run state while closed): keep always-rendered. Known candidate: **AgentMode** (an agent run continues with the modal closed — dashboard/needs-you machinery observes it). Anything else the classification pass finds.
The classification is per-modal evidence (read each component: does any state need to survive close?), recorded in the task commit message. lazy() code-splitting for these modals is deliberately DEFERRED to P4 (bundle stream) — one behavior change at a time; conditional render alone removes the per-render execution cost.
Verification: vitest per converted modal where a test exists; manual smoke list for pluto (open each modal, close, reopen — fresh state expected; agent run survives modal close).

## Gates & measurement

Per task: vitest (new render-count/identity tests where specified) + full suite + build; cargo test for the two new batched commands + sysstats wrapper. Whole-stream adversarial audit at the end; every fix re-reviewed. Measurable: before/after re-render counts from the T2 harness; poll-call counts per minute derivable from code (recorded in the stream log).

## Non-goals

lazy() modal chunks, PromptEditor/Notebook gates (P4); virtualized session tree (spec out-of-scope); any Rust hot-path work (P1 done).
