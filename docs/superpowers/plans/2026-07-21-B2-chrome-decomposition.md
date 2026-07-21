<!-- (C) -->
# Stream B2: TerminalsTab Chrome Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** extract TerminalsTab.jsx's chrome (1,448 lines) into `src/features/terminals/chrome/` modules with ZERO behavior change, preserving the render-perf contract exactly.

**Architecture:** seven extractions in risk order (FKeyBar → TabStrip → StatusBar → MenuBar → ModalHost → Toolbar → CommandPalette-wiring), one commit each, each gated on build + full vitest + a scope diff check. State stays in the parent per the state inventory; new components receive props only. NO `React.memo` on the new wrappers (`MobaMenuBar`/`MobaToolbar` are not memo'd today; adding memo would be NEW behavior — explicitly out of scope).

**Foundation document:** the TerminalsTab chrome map (2026-07-21 exploration). Load-bearing facts: JSX ranges (menu bar `:966-978`, toolbar `:979-1001`, right-dock tab strip `:1123-1139`, status bar `:1338-1425`, F-key bar `:1427-1444`, modals `:1161-1336` — 24 modals enumerated, NOT ~27); memos (`menuBarMenus` `:758-835` 17 deps, `toolbarGroups` `:837-870` 10 deps, `paletteCommands` `:872-961` 24 deps); the hot-path contract (sysstats 2.5s + cost-telemetry ticks must not recompute those three memos — protected by their dep arrays, which must survive extraction byte-equivalent); `useActiveTab` deliberately unmemoized (`useActiveTab.js:3-6` comment); `toast`/`confirm` are CONTEXT values closed over in memos; the quick-connect `<input>` at `:990-996` is uncontrolled DOM state (remount wipes it); `dockTab` gates `useSystemStats(dockTab === "monitor")` at `:252` so the state cannot move; StatusBar embeds an inline `persist(...)` mutation at `:1370-1381`; `MobaRibbon.jsx` is dead code; 15 dead icon imports on TerminalsTab's import lines 31-33; ProjectSidebar (`memo`-wrapped, stable callbacks) is the precedent pattern but NOT the pattern for these (no memo).

**Build gates (before EVERY commit, unfiltered):** `npm run build` + `npx vitest run` green, plus `git diff --stat` showing ONLY the intended files.

**Safety rails:** forward-only commits; no rebase/reset/force-push; push is pluto-only. This plan runs AFTER B1 lands (B1 Task 4 edits TerminalsTab.jsx `:435-463`; sequencing avoids conflicts).

**The extraction recipe (applies to every task below unless overridden):**
1. Create `src/features/terminals/chrome/<Name>.jsx` with `// (C)` marker. Move the JSX block verbatim into a function component whose props are exactly the identifiers the block reads (the chrome map lists them per candidate — re-derive from the actual code, the map is the checklist not the source).
2. In TerminalsTab, replace the block with `<Name {...props} />`, importing from `./chrome/<Name>.jsx`.
3. NO logic changes ride along. NO new memo/useCallback in the parent unless a task explicitly says so. Prop lists are spelled out per task; anything extra the implementer discovers goes in the report, not silently added.
4. Gates; commit `refactor(chrome): extract <Name> (behavior-identical)`.

---

### Task 0: dead-code sweep (pre-extraction hygiene)

**Files:** Delete `src/features/terminals/MobaRibbon.jsx`; Modify `src/features/terminals/TerminalsTab.jsx` (imports only).

- [ ] Verify `MobaRibbon` has zero imports repo-wide (`grep -rn "MobaRibbon" src/`), then delete the file.
- [ ] Remove the 15 unused icon imports from TerminalsTab import lines 31-33 (verify each with a grep before removing: `IconSession, IconServers, IconTools, IconGames, IconStar, IconView, IconSplit, IconMultiExec, IconTunneling, IconPackages, IconSettings, IconHelp, IconModels, IconAsk, IconFolder` — keep `IconMoon, IconSun, IconExit`, they ARE used).
- [ ] Gates; commit `chore(chrome): remove dead MobaRibbon + unused icon imports`.

### Task 1: FKeyBar

**Files:** Create `chrome/FKeyBar.jsx`; Modify TerminalsTab.jsx.

Props (from `:1427-1444`): `addTab`, `activePanelId` (pass `state.activePanelId` value, not `state`), `activeTabId`, `activeTab`, `splitPane`, `selectRibbon`, `setCommandPaletteOpen`, `setAskOpen`, `setHistoryOpen`, `setModelsOpen`, `setMacrosOpen`. Module imports it drags: `GITHUB_URL`, `openExternal` from `../../appMeta.js` — import directly in the new file, don't prop-drill constants.

- [ ] Recipe steps 1-4.

### Task 2: TabStrip (right-dock selector)

**Files:** Create `chrome/DockTabStrip.jsx` (named to avoid confusion with TerminalPanel's own tab strip); Modify TerminalsTab.jsx (`:1123-1139`).

Props: `dockTab`, `setDockTab` ONLY. `dockTab` state STAYS in TerminalsTab (it gates `useSystemStats` at `:252` and the dock body at `:1141-1154`). Icons `SFolder, SAsk, SPulse` imported directly in the new file.

- [ ] Recipe steps 1-4.

### Task 3: StatusBar

**Files:** Create `chrome/StatusBar.jsx`; Modify TerminalsTab.jsx (`:1338-1425` + one new useCallback in the parent).

Pre-step (declared logic-adjacent change, the ONLY one in this plan): hoist the inline recording-jump mutation (`:1370-1381`, direct `persist({...state, ...})` inside JSX) into a parent `useCallback`:

```js
const jumpToRecordingTab = useCallback((recTabId) => {
  const target = state.panels.find((p) => p.tabs.some((t) => t.id === recTabId));
  if (!target) return;
  persist({
    ...state,
    activePanelId: target.id,
    panels: state.panels.map((p) => (p.id === target.id ? { ...p, activeTabId: recTabId } : p)),
  });
}, [state, persist]);
```

(TRANSCRIBE the actual inline logic from `:1370-1381` — the snippet above is the shape, the file is the truth. Byte-preserve the behavior including which tab id it targets.) StatusBar then receives `onJumpToRecording={jumpToRecordingTab}` and neither `state` nor `persist` crosses into chrome.

Props (re-derive from `:1338-1425`): `activeTab`, `activeTabId`, `tabActivities`, `activeDims`, `shellName`, `broadcast`, `bcastTargets`, `setBroadcastGroupOpen`, `recordingTabIds`, `activeTabRecording`, `recordingCapHit`, `stopAndSaveRecording`, `onJumpToRecording`, `totalCost`, `activeModelName` (pass `userSt?.activeModel?.model` as a string), `claudeAvailable`. Constants (`APP_VERSION`, `GITHUB_URL`, `DISCORD_URL`, `openExternal`) imported directly in the new file.

- [ ] Recipe steps 1-4 (with the pre-step hoist in the same commit).

### Task 4: MenuBar wrapper

**Files:** Create `chrome/MenuBar.jsx`; Modify TerminalsTab.jsx (`:966-978`; the `menuBarMenus` memo at `:758-835` MOVES with it).

Shape: `chrome/MenuBar.jsx` exports a component that (a) contains the `menuBarMenus` `useMemo` VERBATIM (same deps array, byte-equivalent — this is the hot-path protection; a changed dep array is a plan violation), (b) renders `<MobaMenuBar menus={menuBarMenus} brand={...} right={...} />` with the brand/right JSX moved verbatim from `:967-978`. Props: everything the memo's dep array lists (`addTab, addHomeTab, addPanel, canAddPanel, splitPane, closeTab, activeTabId, activeTab, panels` (pass `state.panels`), `activePanelId` (pass `state.activePanelId`), `importSshConfig, selectRibbon, openTunnels, broadcast, toggleBroadcast, ribbon`) plus the `right`-JSX needs (`activeDims`, `activeModelName`, `toggleTheme`, `headerSkinId`, `exitApp`). `toast` is CONTEXT: the new component calls `useToast()` itself (the provider wraps the whole app — verify by reading where ToastProvider mounts; if it doesn't cover TerminalsTab's subtree, STOP and report).

Dep-array note: inside the new component the memo's deps reference the PROPS (`panels` instead of `state.panels`) — value-identical references, same invalidation behavior. Spell the final array in the code and compare against `:830-835` element-for-element in the report.

- [ ] Recipe steps 1-4.

### Task 5: ModalHost

**Files:** Create `chrome/ModalHost.jsx`; Modify TerminalsTab.jsx (`:1161-1336`).

Moves all 24 modal/overlay renders verbatim. Props: the aggregate of every open-flag + payload + handler the 24 blocks read (large — enumerate from the code; the chrome map's table is the checklist). Cross-candidate reads stay in the parent and flow down (`tunnelsOpen`, `vncOpen`/`vncLaunch`, `rdpOpen`/`rdpLaunch`, `sshPrompt`, `dialog`, `summary`, `diffWorktree`, `agentOpen`...). `userSt`/`saveUser`/`st`/`save` pass through where modals already receive them. NO modal's own props change; this is pure re-homing of JSX.

Practical guard: because the prop list is wide, the implementer builds it mechanically — copy the block, then enumerate every free identifier in it BY READING (grep each candidate name in the moved JSX against the new file's scope; note that undefined JSX identifiers fail at RUNTIME, not at vite build, so the build gate does NOT catch a missed prop). Wire each as a pass-through of an existing parent identifier (no new derivations), and list the final prop inventory in the report for the reviewer to check off.

- [ ] Recipe steps 1-4.

### Task 6: Toolbar wrapper

**Files:** Create `chrome/Toolbar.jsx`; Modify TerminalsTab.jsx (`:979-1001`; `toolbarGroups` memo `:837-870` moves with it).

Same shape as Task 4 (memo moves verbatim, deps byte-equivalent: `activeTabId, activeTab, splitPane, broadcast, toggleBroadcast, tunnelsOpen, setTunnelsOpen, openTunnels, ribbon, selectRibbon`). The `right` JSX (`:982-998`) moves verbatim INCLUDING the uncontrolled quick-connect `<input>` and the live `totalCost` reads — pass `totalCost` and `quickConnect` as props.

**Uncontrolled-input hazard (declared, accepted):** the extraction changes the component identity above the input, so the ONE render where the swap ships remounts it (any in-progress typed text is lost once, at upgrade). Steady-state behavior after that is identical (the component type is stable module-scope). This is the accepted cost; do NOT convert the input to controlled state to "fix" it — that's a behavior change.

- [ ] Recipe steps 1-4.

### Task 7: CommandPalette wiring

**Files:** Create `chrome/usePaletteCommands.js` (a HOOK, not a component); Modify TerminalsTab.jsx (memo `:872-961` moves into the hook; the 5-line render `:1326-1330` stays in the parent, or moves into ModalHost if Task 5 already took it — match whichever home it has by now).

Fork resolution (decided): the 90-line `paletteCommands` memo becomes `usePaletteCommands(args)` in its own file — keeps memo semantics, no new render boundary, shrinks TerminalsTab. The hook takes ONE args object with the 24 dependencies as named fields and internally calls the same `useMemo` with a dep array listing `args.<field>` for each — element-for-element equivalent to `:955-961`. `toast`/`confirm` come from `useToast()`/`useConfirm()` INSIDE the hook (context). `state`/`persist` DO cross into the hook (the `reset-workspace` action needs them) — acceptable for a hook (it's parent logic relocated, not chrome), and declared here. `MAX_PANELS` imported in the hook file.

- [ ] Recipe steps 1-4 (commit message `refactor(chrome): extract usePaletteCommands hook (behavior-identical)`).

### Task 8: B2 gate

- [ ] Full gates + `git diff <B2-first-commit>^..HEAD --stat` sanity, where `<B2-first-commit>` is Task 0's commit (record its SHA when it lands): only chrome/ + TerminalsTab + deleted dead files in the range.
- [ ] Line-count checkpoint: report TerminalsTab.jsx's new line count (expect roughly 500-600 lines removed).
- [ ] Manual smoke list for pluto: every menu opens + fires (File/View/Tools spot-checks), toolbar buttons + quick-connect Enter works, F-keys fire, right-dock tabs switch + Monitor still polls only when open, status bar chips live-update (cost ticks, dims, recording jump), every modal opens/closes from its every entry point (menu + palette + shortcut), palette commands complete + reset-workspace confirm works, no visual diff.
- [ ] Review pass: code-reviewer over the whole B2 diff with an explicit render-perf lens (the three memos' dep arrays byte-checked against pre-extraction; no new memo; no lost useCallback stability). Fix findings; re-review every fix.
