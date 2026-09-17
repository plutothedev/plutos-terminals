<!-- (C) -->
# Frontend correctness (React)

Audit of plutos-terminals @ `731afc5`, 2026-08-21.

## Summary

The React layer is in genuinely good shape on the axes the 8/14 audit hardened: the pane-registry park/destroy lifecycle, the `entryLive()` vs per-mount `alive` split, the cancelled-flag-around-`await listen()` invariant, the functional-`save()` discipline after awaits, and the drag-listener AbortController cleanup all held up under direct reading. eslint's `rules-of-hooks` output is three false positives (`useModel` in ModelPicker is a plain helper named like a hook) , there is no conditional-hook hazard anywhere in `src`. The real debt is in a layer the prior audit did not reach: the chrome addresses terminals by TAB id while the PTY bridge, the recorder, and the macro capture are all keyed by PANE id, so every "act on the active terminal" action is wrong or dead on split tabs; and SftpBrowser's listing path is the one async surface in the app with no staleness token, which lets one host's directory listing render under another host's session id.

## Verified sound (11)

- Rules of Hooks , eslint reports exactly 3 rules-of-hooks errors, all in ModelPicker.jsx (148/160/163), and all are false positives: `useModel` is a plain helper function that happens to be named like a hook. I found no conditional, looped, or post-early-return hook calls anywhere in src; every modal that early-returns (`RemoteEditor.jsx:124`, `RdpConnectModal.jsx:41`, `CommandPalette.jsx:37`, `ErrorExplainer.jsx:74`) does so after all its hooks.
- Invariant #4 (cancelled-flag around `await listen()`) , verified at every call site: TerminalPane.jsx:1528/1543 detach a late-resolved handle, VncView.jsx:76/84/89 and RdpView.jsx:71/74 do the same per-listener, and TerminalsTab.jsx:686/710 use the `cancelled`-then-unlisten form. No leaked listener pinning a disposed xterm.
- Invariant #3 (functional `save()` / no post-await whole-blob spread) , I traced every persist that follows an await. `useWorkspaceTree`, `useSessionSpawn`, `useSessionDispatch`, `useSshConnect` and `useProjects` all re-read `stateRef.current` after the await (including the M7 fixes at useSessionDispatch.js:113 and useSshConnect.js:64); TerminalsTab's `setupSeen` (:421), App's migrations (:305, :441) and ShareModal's shareHistory append (:86) use the functional form. The remaining value-form `persist({...st})` calls are all synchronous event handlers.
- Invariant #2 (`readUserSt()` for keys) , the spawn path (TerminalPane.jsx:1277), AgentMode.jsx:80, DockAssistant.jsx:53 and ErrorExplainer.jsx:41 all go through `readUserSt()`; no raw `localStorage.getItem(USER_STORAGE_KEY)` outside App.jsx's own writer and ErrorBoundary's secret-carrying wipe.
- The pane registry lifecycle (paneRegistry.js + TerminalPane's main effect) , park-vs-destroy, the `entryLive()` identity check (not truthiness) used by every create-once closure, the LIFO destroy hooks, the orphan guard after `pty_spawn` (TerminalPane.jsx:1378), the jump-tunnel single-ownership split, and the `entry.ui` per-mount repoint table all hold up. I could not construct a sequence where a create-once handler writes into a dead fiber or a moved pane loses its counters.
- Drag-listener cleanup (audit L1) , TerminalPanel.jsx:353-383 and useDockResize.js:39-69 both own teardown through an AbortController aborted on unmount, including the ghost element and drop highlights. ProjectSidebar.jsx:372 still uses bare add/removeEventListener, but its `onUp` removes both listeners on the next mouseup regardless of unmount, so nothing is stranded.
- activityStore.js , the useSyncExternalStore contract is correct: `getMapSnapshot`/`getRollupSnapshot` are version-cached and content-diffed so identity is stable between changes, and `usePanelActivityStamp` returns a primitive string. `subscribeKeyed`'s captured-Set closure cannot delete a successor Set because React invokes each unsubscribe exactly once.
- notebookIo.js , the per-name write queue (`inflightWrites`) correctly chains writes and gates reads behind them, and the tail-check at :87 (`if (inflightWrites.get(name) === tracked)`) does not strand a newer chained write's readers.
- ProjectSidebar's two 30s pollers (latency at :167, git status at :223) , both single-flighted, hidden-gated inside the tick, with a `cancelled` flag and full interval/listener cleanup. The eslint `require-atomic-updates` hits on their `inFlight` flags are false positives (the flag is set and cleared on the same synchronous path around one await).
- Toast.jsx and ConfirmModal.jsx message coercion (`toastText`, ConfirmModal.jsx:48) is total over arbitrary values, so the 8/16 blank-window class stays closed; ErrorBoundary is correctly outermost and consumes no context.
- TerminalPane's OSC 1337 nonce provenance gate (:1075-1105) and the OSC 133 `restoringScrollback` suppression are intact , the H1 fix has not regressed, and the H5 tofu fix is gated on `entryLive()` (:1199), not the per-mount `alive`.

## Findings (5)

### HIGH FE-1, Chrome-level "active terminal" actions address the tab id, not the active pane id , wrong pane on splits, silently dead after the root pane closes

`src/features/terminals/TerminalsTab.jsx:584`

**What.** `TerminalPanel.jsx:695` passes `tabId={node.id}` , the LEAF id of the split tree , and `TerminalPane.jsx:1404` registers its bridge writer under that same leaf id (`registerPtyWriter(tabId, ...)`). So `ptyBridge`'s `writers`/`readers` maps are keyed by PANE id. But `useActiveTab.js:15` returns `activeTabId = activePanel?.activeTabId` , the TAB id , and every chrome call site feeds that straight into the bridge:

- `TerminalsTab.jsx:584` `const ok = writeToTab(activeTabId, command);` (snippet insert)
- `TerminalsTab.jsx:757` `else writeToTab(activeTabId, data);` (file browser "cd here" / insert path, DockAssistant send)
- `chrome/ModalHost.jsx:193` and `:222` `onRun={(cmd) => { if (activeTabId) writeToTab(activeTabId, cmd + "\r"); }}` (Ask AI → Run, History → Run)
- `chrome/ModalHost.jsx:279` `onReplay={(data) => activeTabId && writeToTab(activeTabId, data)}` (macro replay)
- `chrome/MenuBar.jsx:108` and `chrome/usePaletteCommands.jsx:65` `setSummary({ text: getTabText(activeTabId) })`
- `TerminalsTab.jsx:815` `recording.startRecording(activeTabId, …)` while `TerminalPane.jsx:1446` pushes with `pushRecordingOutput(tabId /* pane id */, payload)`
- `MacrosModal.jsx:32` `startMacroRecording(activeTabId)` while `TerminalPane.jsx:1564` calls `recordInput(tabId /* pane id */, data)`
- `BroadcastGroupModal.jsx:28` `tabs: (p.tabs || []).filter((t) => live.has(t.id))` against `getLiveTabIds()`, which returns `[...writers.keys()]` = pane ids

The codebase already knows the correct resolution and applies it in exactly one place , `chrome/ModalHost.jsx:201` passes AgentMode `tabId={activeTab?.activePaneId || activeTabId}` , and `AgentDashboard.jsx:15` correctly walks `leafIds(getLayout(tab))` for cost. The chrome write/read paths were never updated.

Two distinct failure modes:
(a) On any split tab, `tab.id` is still the id of the FIRST leaf (`splitTree.js:41` keeps the existing leaf's id and adds `newLeafId` as the b-side), so the action lands in the original pane regardless of which pane is focused.
(b) Close the ORIGINAL pane of a split and `removeLeaf` (`splitTree.js:63` `if (a === null) return b;`) collapses the tree to the sibling , after which NO leaf id equals `tab.id`, so `writers.get(tab.id)` and `readers.get(tab.id)` are both undefined for the life of that tab.

**Failure.** Split a tab (Ctrl+Shift+D), click into the new right-hand pane, then insert a Workflow snippet or run a command from Ask AI → it is typed into the LEFT pane instead. Then close the left (original) pane via its ✕ or Ctrl+Shift+X: from that point on, for that tab, snippet insert toasts "Active terminal isn't ready yet , try again in a moment." forever; the file browser's send-to-terminal and macro replay silently do nothing; "Summarize this session (AI)" opens with an empty transcript; arming a macro captures zero keystrokes so Stop&save reports "Nothing recorded."; and Start recording → Stop & save writes a .cast containing only the header line yet reports "Saved recording to <path>". The tab also vanishes from the broadcast-target picker.

**Fix.** Derive the pane id once in TerminalsTab , `const activePaneId = activeTab?.activePaneId || activeTabId;` (the exact expression already at ModalHost.jsx:201) , and thread it, not `activeTabId`, into `insertSnippet`, `sendToActiveTerminal`, ModalHost's `onRun`/`onReplay`, both `getTabText` call sites, `startRecordingActive`/`stopAndSaveRecording`, `MacrosModal`'s `activeTabId` prop, and AgentDashboard's `onSummarize`. For BroadcastGroupModal, offer one row per leaf (it already receives `panels`, so `leafIds(getLayout(tab))` is available) instead of filtering tabs by `t.id`.

### HIGH FE-2, SftpBrowser's directory listing has no staleness token , one host's listing can render under another host's live session id

`src/features/terminals/SftpBrowser.jsx:96`

**What.** `list()` awaits `sftp_list` and then commits unconditionally:

```js
const items = await invoke("sftp_list", { id: sessionId, path });
const entries = Array.isArray(items) ? items : [];
listingCache.set(key, { entries, at: Date.now() });
setEntries(entries);
setCwd(path);
```

There is no check that `sessionId` is still the session this call was issued for. The sibling hook that owns the binding does implement exactly this guard , `useSftpDock.js:24` "A monotonic token (sftpTokenRef) discards a connect that resolves after the user has switched away", checked at `:46` and `:57` , but the guard stops at the connect; the listing path never got one.

The race is reachable because SftpBrowser is NOT remounted when the active SSH tab changes: `TerminalsTab.jsx:1227` renders `activeTab?.connection ? <SftpBrowser …/> : <LocalFileBrowser/>`, so switching from SSH tab A to SSH tab B keeps the same component instance and the same `entries`/`cwd` state while only the `sessionId` prop changes. On the Rust side the in-flight request survives the disconnect: `sftp_list` (`src-tauri/src/sftp.rs:411`) dispatches down an already-cloned mpsc sender, so the worker services and replies to a request sent before `sftp_disconnect` removed the registry entry.

Every row action then combines the stale `entry.path` with the current `sessionId`: `:154` `sftp_download({ id: sessionId, path: entry.path })`, `:193` `sftp_remove({ id: sessionId, path: entry.path, isDir })`, `:207` `sftp_rename({ id: sessionId, from: entry.path, to: joinPath(cwd, …) })`, `:164` `sftp_upload({ id: sessionId, dir: cwd })`.

**Failure.** With the right dock on Files, open SSH tab A (host A) and navigate into a large/slow remote directory. Before the listing returns, switch to SSH tab B (host B). useSftpDock disconnects A, connects B and lists B's home; then A's listing resolves and overwrites `entries` and `cwd` with host A's contents. The dock now shows host A's directory while bound to host B's session. Clicking the trash icon on a row issues `sftp_remove` against host B with host A's path , deleting the wrong host's file whenever that path exists on both (very common: /etc/nginx/nginx.conf, ~/.bashrc, /var/www/html/index.html). Download pulls B's copy under A's name; Upload writes into B at A's cwd.

**Fix.** Give `list()` the same monotonic token useSftpDock already uses (or capture `const sid = sessionId` at entry and bail on `if (sid !== sessionId) return;` after the await) before `listingCache.set`, `setEntries` and `setCwd`. The same guard also stops the late write from re-populating `listingCache` for a session that `evictSftpCaches` just cleared.

### MEDIUM FE-3, moveTabIntoSplit discards everything about the dragged tab except its leaf's {id, cwd} , worktree tag, startCommands, systemPrompt and projectId are silently lost

`src/features/terminals/hooks/useWorkspaceTree.js:527`

**What.** The fold only carries the dragged tab's LAYOUT into the target:

```js
const nextLayout = splitLeaf(
  targetLayout, targetPaneId, dir, getLayout(dragged), freshId("split"), newFirst
);
```

and `getLayout` (`splitTree.js:20`) returns `tab.layout || { id: tab.id, cwd: tab.cwd ?? null }` , id and cwd only. The `dragged` tab object is then dropped from the tree at `:536` (`tabs = tabs.filter((t) => t.id !== draggedTabId)`) and never re-added, so `label`, `startCommands`, `systemPrompt`, `projectId`, `color` and `worktree` are gone from persisted state. The folded leaf is no longer the target tab's root, so `TerminalPanel.jsx:690-697` now passes it `startCommands={null}`, `systemPrompt={null}`, `projectName={null}` and `autoApprove={false}`.

The `worktree` loss is the sharp edge, and it is clearly unintentional here: the two sibling code paths strip `worktree` DELIBERATELY with comments naming the hazard , `useWorkspaceTree.js:274` ("two tabs sharing a worktree path would let a discard delete the folder out from under the sibling's still-running shell") and `workspaceModel.js:112-116`. `moveTabIntoSplit` drops it by omission, which produces the opposite problem: zero owners. `TerminalsTab.jsx:490-492` finds worktree owners by scanning `t.worktree?.path`, and `AgentDashboard.jsx:122` renders the "diff" button off `tab.worktree` , both now match nothing.

The drag is not gated against this: `TerminalPanel.jsx:278` sets `canSplitDrop = !isSpecialTab(tab) && !tab.connection && !tab.serial`, and a worktree agent tab is a plain local tab.

**Failure.** Start an agent worktree from the sidebar (a tab labelled `agent/xxxxx`, cwd = the worktree dir, startCommands `["claude"]`, tagged `worktree`). Drag that tab onto another tab's pane edge to merge it. The live shell survives, but the app immediately forgets what it is: the Fleet dashboard no longer lists it, so "Review diff + open PR" and "Discard worktree" are permanently unreachable for that branch and the git worktree is stranded on disk; the pane's session transcript switches mid-session from `<project>-<id>.md` to `tab-<id>.md` (TerminalPane.jsx:517 resolves the name through the current fiber's now-null projectName); and after an app restart the pane respawns as a bare shell in that directory with no `claude` and no system prompt.

**Fix.** Refuse the fold for tabs carrying identity that a leaf cannot hold , at minimum `if (dragged.worktree) return;` alongside the existing `isSpecialTab` check at :519, matching the caller-side gate on `connection`/`serial` , or widen the leaf shape to carry `startCommands`/`systemPrompt`/`projectId`/`worktree` and have TerminalPanel read them per-leaf instead of only when `isRoot`.

### LOW FE-4, WorkspacesModal deletes a saved workspace on a single unconfirmed click, next to a Load button that takes two

`src/features/terminals/WorkspacesModal.jsx:61`

**What.** The row renders `<Button variant="ghost" size="sm" onClick={() => setConfirmLoad(ws.name)}>Load</Button>` immediately followed by `<Button variant="subtle" size="sm" onClick={() => onDelete(ws.name)} title="Delete workspace">✕</Button>`. Load is deliberately two-step (`:52-57` renders a "replace current tabs?" / "Yes, load" / "No" confirm row), but the adjacent ✕ fires `onDelete` straight through to `useWorkspaces.js:36` `saveUser({ ...userSt, workspaces: workspaces.filter((w) => w.name !== name) })`, which persists immediately and , when cloud sync is on (`App.jsx:255` `if (isPrimaryWindow() && stamped?.sync?.enabled) notifyChange()`) , propagates the deletion to the user's other machines. There is no undo path: workspaces live only in `userSt.workspaces`. Every other destructive action in the app routes through `useConfirm` (SFTP delete, worktree discard, reset workspace, factory reset, quit, tab close with unsaved remote edits).

**Failure.** In Workspaces, aiming for "Load" on a saved layout and clicking one button too far right permanently deletes that saved panel/tab/split layout , no dialog, no toast, no undo , and cloud sync pushes the deletion to the user's other machines.

**Fix.** Gate the ✕ behind the same two-click pattern already implemented in this file for Load (a `confirmDelete` state mirroring `confirmLoad`), or route it through `useConfirm` like every other destructive action.

### LOW FE-5, `phn.tourDone` escapes the factory-reset prefix wipe, so a reset install never re-offers the guided tour it promises to restore

`src/features/terminals/storageKeys.js:73`

**What.** `ALL_STORAGE_PREFIXES = ["plutos-terminals:", "pt:"]`, and the comment directly above it asserts the invariant: "Every localStorage key the app writes lives under one of these prefixes … Factory reset wipes by prefix so new keys can't silently escape the reset." `wipeAllLocalState()` (`:77-87`) only removes keys matching those two prefixes.

`TerminalsTab.jsx` writes `phn.tourDone` at `:149` (`finishTour`) and `:154` (`startTour`), and reads it at `:126` to seed `tourOffered`. `phn.` matches neither prefix, so it survives the wipe. I enumerated every localStorage key written in `src` , the state/user blobs, `plutos-terminals:cmdhistory:v0`, `plutos-terminals:macros:v0`, `plutos-terminals:dismissed-update`, `plutos-terminals:update-check`, `plutos-terminals:syncsnap:v0`, `plutos-terminals:boot-bg*`, and the four `pt:*` dock keys , and `phn.tourDone` is the only one outside the two prefixes.

**Failure.** Settings → Factory reset (whose confirm text promises it wipes "the welcome/onboarding screens (they'll show again)") followed by the reload: Welcome and onboarding do replay, but `tourOffered` initializes from the surviving `phn.tourDone === "1"`, so the TourOffer card at TerminalsTab.jsx:1246 never renders. A user who resets to reproduce first-run behaviour, or who hands a reset machine to someone else, silently never sees the guided tour offer.

**Fix.** Rename the key to `plutos-terminals:tourDone` (with a one-time read-through of the old key), or add `"phn."` to `ALL_STORAGE_PREFIXES`. A cheap regression guard: a unit test that greps `src/` for `localStorage.setItem("` literals and asserts each matches a prefix in `ALL_STORAGE_PREFIXES`.

