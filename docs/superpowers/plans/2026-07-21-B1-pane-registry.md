<!-- (C) -->
# Stream B1: Pane Registry (moveTab keeps the PTY) + Bridge Subscriptions Implementation Plan (rev 2, post-plan-audit)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Rev 2 (2026-07-21, after the 2-lens adversarial plan-audit; verdicts were BLOCK): the mark-then-persist fate protocol is REPLACED by a reconcile sweep (the mark design missed `closePane`, both wholesale-tree-replacement paths, and carried a stale-mark race); an `entry.ui` indirection layer is added (first-mount handlers close over per-fiber React setters that go permanently dead after a move — setFailedBlock/setShellCwd/setAtPrompt/setStickyBlock/setAltScreen/captureRef/autoApproveRef/visibleRef); the App lock screen gets `destroyAll()` (parked sessions must not keep auto-approving behind the password gate); Task 1's tests use an in-file DOM stub (vitest runs `environment: "node"`, jsdom is NOT installed — no new dependency); re-attach gets its own observer callback (reusing `openIfVisible` stacks a duplicate ImageAddon per move); the 9 migrated refs are classified shared-container vs value-replaced (6 are wholesale-reassigned and need write-through, not point-at-entry); pane-id semantics get a mandatory verification step (the "tabId" the pane receives is the LEAF id of the split tree — the sweep must enumerate exactly what TerminalPanel renders).

**Goal:** close invariant-1's last gap — moving a tab between panels re-parents the live xterm + PTY instead of kill+respawn — and give ptyBridge a `useSyncExternalStore` subscription surface (#27). Three pre-existing bugs get fixed on the way: mid-move agent-capture force-resolve, cost telemetry jumping backward after a move, start-commands retyped into a live shell.

**Architecture (rev 2):** `paneRegistry.js` owns each pane's create-once objects (xterm + addons, host DOM element, PTY session, counters, one-shot flags, and a per-mount-repointed `ui` pointer table). TerminalPane attaches/detaches the registry-owned host. **Lifecycle truth is the rendered tree, not close-path bookkeeping:** a reconcile sweep in TerminalsTab destroys any registry entry whose pane id is no longer rendered — one mechanism covers closeTab, closeOtherTabs, closePanel, closePane (split panes), reset-workspace, loadWorkspace, discardWorktree, and any future mutation, with no per-path edits and no mark races. The pane's own cleanup only parks (detach), except a mid-spawn unmount which destroys. The App lock screen calls `destroyAll()` (restores today's kill-on-lock semantics — a safety property, see decision 5).

**Tech Stack:** React 18 (StrictMode ON in dev), xterm 5.5 (DOM renderer; `@xterm/addon-image` 0.9.0 confirmed 2D-canvas-only, no observers of its own), Tauri events, vitest (`environment: "node"` — kept).

**Foundation:** the TerminalPane lifecycle map + two plan audits (2026-07-21). Verified line refs @ `f3f4fad` (audits confirmed zero drift for the files in scope): big effect `TerminalPane.jsx:485-1297` deps `[cwd]`; cleanup `:1259-1296` with the six-statement close block `:1288-1293`; container `:1448`; `term.open` `:742`; `openIfVisible` `:739-745` (does open + `loadAddon(new ImageAddon())` + fit — NOT just fit); spawn `:851-899`; orphan guard `:900-903`; bridge registrations `:908-928`; listeners `:982-1013`; setup region `:1079-1250`; refs `currentBlockRef :234`, `blocksRef :235`, `blockDecorationsRef :236`, `scrollbackChunksRef :290`, `scrollbackBytesRef :291`, `lastCostRef :310`, `familyRef :315`, `userHasTypedRef :251`, `recentOutRef :297`; handler-captured setters `setFailedBlock :668`, `setShellCwd :684`, `setAtPrompt :698,:1069`, `updateSticky/setStickyBlock :706-717`, `setAltScreen :1067`, `captureRef :616-619`; `useWorkspaceTree.js` `closePanel :51-66`, `closeTab :127-158`, `reopenTab :163-180`, `duplicateTab :212-230`, `detachTab :237-265` (funnels to closeTab at `:263`), `closeOtherTabs :267-278`, `moveTab :285-316`, `closePane :374-397` (the split-pane close the rev-1 plan missed); wholesale replacements `useWorkspaces.js:28` (loadWorkspace) and `TerminalsTab.jsx:937-944` (reset-workspace); lock screen `App.jsx:345-347`.

**Build gates (before EVERY commit, unfiltered):** `npm run build` + `npx vitest run` green. No Rust in this stream.

**Safety rails:** forward-only commits; no rebase/reset/force-push; push is pluto-only.

---

## Design decisions (rev 2)

1. **Registry-owned host element.** One detached `<div class="phn-pane-host">` per pane id; xterm `open()`s into it exactly once. TerminalPane's `containerRef` div is a SLOT: mount = `attachHost` (appendChild moves the node), unmount = `detachHost`. After re-attach: `fit()`, `term.refresh(0, term.rows - 1)`, focus-if-active. Re-attach NEVER calls `openIfVisible` (its body does `term.open` + `loadAddon(new ImageAddon())` unconditionally — reuse stacks a duplicate addon per move); re-attach observers use a dedicated `refit`-only callback.
2. **Reconcile sweep = the only close mechanism.** TerminalsTab runs an effect on tree changes: enumerate the pane ids the tree currently renders; `destroyEntry` every registry id not in that set. Pane cleanup parks by default; nothing marks anything. React ordering guarantees the sweep effect runs after unmounted panes' cleanups in the same commit. The ~millisecond parked window between cleanup and sweep is accepted. This subsumes every close path (incl. `closePane` and both wholesale replacements) and eliminates the rev-1 stale-mark race entirely.
3. **Pane-id semantics are pinned by construction, not assumption.** The id TerminalPane receives as `tabId` is the LEAF id TerminalPanel derives when rendering the split tree. The sweep's enumeration MUST be the same derivation. Task 2 Step 1 requires reading `TerminalPanel.jsx` (pane map ~`:487-628`) and `splitTree.js` (`leafIds`), extracting the exact per-tab leaf-id derivation into a shared helper, and asserting parity in a test. If a tab's layout has no split tree (single pane), the leaf id and the tab id may coincide — the helper handles both, mirroring TerminalPanel byte-for-byte.
4. **`entry.ui` pointer table, repointed EVERY mount (both branches).** Create-once handlers (OSC 133/1337, onScroll, onBufferChange, onData, handleChunk/checkAutoApprove/checkCost) must never call a closed-over per-fiber setter/ref. The entry carries `ui`, an object the component overwrites on every mount with the CURRENT fiber's functions/reads: `{ setFailedBlock, setShellCwd, setAtPrompt, setStickyBlock, setAltScreen, capturePrompt, isAutoApprove: () => autoApproveRef.current, isVisible: () => visibleRef.current, isActive: () => activeRef.current, onCost, onActivity }`. Handlers call `entry.ui.<fn>(...)`. While parked, calls hit the unmounted fiber's setters — React 18 silently no-ops them; on re-attach the table repoints and everything resumes. Known cosmetic gap (documented): UI-derived state (shellCwd/atPrompt/altScreen/stickyBlock/failedBlock) updates that occur while parked are lost until the next OSC/scroll event after re-attach.
5. **Lock screen kills.** `App.jsx:345-347`'s lock branch unmounts the whole TerminalsTab subtree; the sweep dies with it. Today lock kills every PTY (cold but safe); park-by-default would leave invisible sessions running — and an auto-approve tab would keep self-approving behind the password gate once the app loses OS focus (violates the auto-approve safety invariant). Therefore: on the transition INTO locked (`unlocked` flipping false while `lockHash` set, and on initial locked boot before TerminalsTab ever mounts there is nothing to kill), App calls `paneRegistry.destroyAll()`. Restores today's semantics exactly.
6. **Mid-spawn unmount destroys (unchanged from rev 1).** Cleanup while `entry.spawnState === "starting"` destroys the entry; the in-flight spawn's orphan guard kills the PTY on arrival (`if (!getEntry(id))`). Dev StrictMode's synthetic double-mount always hits this window → dev keeps today's spawn-twice-kill-first behavior, no leak, no change. The has-guard protects POST-SPAWN remounts (real moves).
7. **Bridge registrations are registry-lifetime.** `registerPtyWriter`/`setPtyId`/`registerTabReader` happen at spawn; `unregisterPty` runs only in a destroy hook. `runAndCapture` survives moves (bug fix 1); the capture force-resolve fires only on real destroy.
8. **Counters + block state live on the entry** (bug fix 2), with per-ref conversion rules in Task 3b (audit-corrected: 6 of the 9 are wholesale-reassigned and need write-through at every assignment site, not point-at-entry).
9. **Start-command suppression is the `isFirstMount` gate itself** (re-attach skips the whole spawn IIFE). `entry.setupDone` stays as a defensive latch + self-documentation, but the changelog credits the gate, not the flag (bug fix 3).
10. **#27 minimal shape.** `getBridgeVersion()` + `subscribeBridge(cb)` on ptyBridge (version bumped in `emitDims`); `useDimsListener()` becomes a `useSyncExternalStore` hook RETURNING the version; TerminalsTab's single existing call site at `:131` changes to capture the return (`const bridgeVersion = useDimsListener();`), the `:435` `bridgeTick` state + `:436` effect are deleted, and the `sessionListJson` memo's `bridgeTick` dep becomes `bridgeVersion`. EXACTLY ONE `useDimsListener()` call may exist in the file afterward (a second call would silently re-add the duplicate subscription this consolidates away). Honest rationale: fewer listeners and less closure state — NOT fewer renders (React 18 already batches the two listeners' setStates into one render today).
11. **App exit unchanged** (`quit_app` kills backend-side; the registry never assumes its destroy runs on process death). **`reopenTab`/`duplicateTab`** mint-or-reuse semantics are safe under the sweep: a reopened id's old entry was destroyed by the sweep in the close commit; `duplicateTab` mints fresh ids. **Pre-existing, out of scope (recorded):** the `useWorkspaceTree` stale-`stateRef` multi-mutation-per-tick lost-update hazard (e.g. `discardWorktree`'s close loop keeping only the last removal) predates this plan; the sweep protocol is immune to it (no marks to orphan — a tab that survives a lost-update close simply stays in the tree and stays alive, and its recovery is a plain re-close), but the hazard itself is logged for a future fix, not silently absorbed here.

---

### Task 1: `paneRegistry.js` core + tests (DOM-stubbed, no new dependency)

**Files:**
- Create: `src/features/terminals/paneRegistry.js`
- Test: `src/features/terminals/paneRegistry.test.js`

Registry API:

```js
ensureEntry(paneId) -> entry       // create-if-missing placeholder (synchronous)
getEntry(paneId) -> entry | null
attachHost(paneId, slotEl)         // slotEl.appendChild(entry.host); entry.currentSlot = slotEl
detachHost(paneId)                 // entry.host.remove(); currentSlot = null
registerDestroyHook(paneId, fn)    // teardown closures; run LIFO on destroy
destroyEntry(paneId)               // run hooks LIFO (throw-safe), remove host, delete entry
reconcile(liveIds)                 // Set/array of pane ids; destroyEntry every id NOT in it; returns destroyed ids
destroyAll()                       // destroyEntry everything (lock screen / panic path)
listEntries() -> paneId[]
```

Entry shape:

```js
{
  host: <div>,
  currentSlot: null,
  term: null, fit: null, search: null,
  ptyId: null, jumpFwdId: null,
  spawnState: "starting",          // "starting" | "live" | "dead"
  setupDone: false,
  onDestroy: [],
  ui: null,                        // per-mount pointer table; repointed on EVERY mount (decision 4)
  counters: { lastCost: { tokens: 0, cost: 0 }, family: null,
              scrollbackChunks: [], scrollbackBytes: 0,
              userHasTyped: false, recentOut: "" },
  blocks: { list: [], current: null, decorations: [] },
}
```

- [ ] **Step 1: Write the failing tests**

Create `src/features/terminals/paneRegistry.test.js`. vitest runs `environment: "node"` (verified: `vitest.config.js:11`; jsdom/happy-dom NOT installed) — the tests install a minimal DOM stub; the registry only needs `document.createElement` returning objects with `appendChild`/`remove`/`className`/`style`:

```js
// (C)
import { describe, it, expect, beforeAll } from "vitest";

// Minimal DOM stub: the registry uses document.createElement + appendChild +
// remove only. vitest runs in node (no jsdom dependency in this repo — a
// deliberate choice); this stub keeps it that way.
beforeAll(() => {
  const makeEl = () => {
    const el = {
      className: "", style: {}, parentNode: null, children: [],
      appendChild(child) {
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((c) => c !== child);
        child.parentNode = el; el.children.push(child); return child;
      },
      remove() {
        if (el.parentNode) { el.parentNode.children = el.parentNode.children.filter((c) => c !== el); el.parentNode = null; }
      },
      contains(node) { return el.children.includes(node); },
    };
    return el;
  };
  globalThis.document = globalThis.document || { createElement: () => makeEl() };
  globalThis.__makeSlot = makeEl;
});

const load = async () => await import("./paneRegistry.js");

describe("paneRegistry", () => {
  it("ensureEntry is idempotent and synchronous", async () => {
    const R = await load();
    R.destroyAll();
    const a = R.ensureEntry("p1");
    const b = R.ensureEntry("p1");
    expect(b).toBe(a);
    expect(a.spawnState).toBe("starting");
    expect(typeof a.host.appendChild).toBe("function");
  });

  it("attachHost moves the SAME host node between slots (implicit re-parent)", async () => {
    const R = await load();
    R.destroyAll();
    const e = R.ensureEntry("p2");
    const s1 = globalThis.__makeSlot();
    const s2 = globalThis.__makeSlot();
    R.attachHost("p2", s1);
    expect(s1.contains(e.host)).toBe(true);
    R.attachHost("p2", s2); // no detach first — appendChild moves it
    expect(s1.contains(e.host)).toBe(false);
    expect(s2.contains(e.host)).toBe(true);
    expect(e.currentSlot).toBe(s2);
    R.detachHost("p2");
    expect(s2.contains(e.host)).toBe(false);
    expect(e.currentSlot).toBe(null);
  });

  it("destroyEntry runs hooks LIFO and survives a throwing hook", async () => {
    const R = await load();
    R.destroyAll();
    R.ensureEntry("p3");
    const order = [];
    R.registerDestroyHook("p3", () => order.push("first-registered"));
    R.registerDestroyHook("p3", () => { throw new Error("boom"); });
    R.registerDestroyHook("p3", () => order.push("last-registered"));
    R.destroyEntry("p3");
    expect(order).toEqual(["last-registered", "first-registered"]);
    expect(R.getEntry("p3")).toBeNull();
  });

  it("reconcile destroys exactly the ids missing from the live set", async () => {
    const R = await load();
    R.destroyAll();
    R.ensureEntry("keep1"); R.ensureEntry("keep2"); R.ensureEntry("gone1"); R.ensureEntry("gone2");
    const killed = [];
    R.registerDestroyHook("gone1", () => killed.push("gone1"));
    R.registerDestroyHook("gone2", () => killed.push("gone2"));
    const destroyed = R.reconcile(new Set(["keep1", "keep2"]));
    expect(destroyed.sort()).toEqual(["gone1", "gone2"]);
    expect(killed.sort()).toEqual(["gone1", "gone2"]);
    expect(R.listEntries().sort()).toEqual(["keep1", "keep2"]);
  });

  it("reconcile with everything live destroys nothing (move case)", async () => {
    const R = await load();
    R.destroyAll();
    R.ensureEntry("m1");
    expect(R.reconcile(new Set(["m1", "m2-not-yet-mounted"]))).toEqual([]);
    expect(R.getEntry("m1")).not.toBeNull();
  });

  it("destroyAll clears everything and runs hooks", async () => {
    const R = await load();
    R.destroyAll();
    R.ensureEntry("a"); R.ensureEntry("b");
    let hooks = 0;
    R.registerDestroyHook("a", () => hooks++);
    R.registerDestroyHook("b", () => hooks++);
    R.destroyAll();
    expect(hooks).toBe(2);
    expect(R.listEntries()).toEqual([]);
  });

  it("close-then-reopen same id gets a FRESH entry; counters do not leak across", async () => {
    const R = await load();
    R.destroyAll();
    const first = R.ensureEntry("r1");
    first.counters.lastCost = { tokens: 42, cost: 0.5 };
    R.reconcile(new Set()); // closed
    const second = R.ensureEntry("r1");
    expect(second).not.toBe(first);
    expect(second.counters.lastCost.tokens).toBe(0);
    expect(second.setupDone).toBe(false);
  });

  it("counters and ui pointer survive a park cycle (detach only)", async () => {
    const R = await load();
    R.destroyAll();
    const e = R.ensureEntry("k1");
    e.counters.scrollbackBytes = 999;
    e.ui = { marker: 1 };
    R.detachHost("k1");
    const again = R.ensureEntry("k1");
    expect(again.counters.scrollbackBytes).toBe(999);
    expect(again.ui.marker).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run src/features/terminals/paneRegistry.test.js` — FAIL (module missing).

- [ ] **Step 3: Implement**

Create `src/features/terminals/paneRegistry.js` per the API above. Module comment explains: ownership inversion, sweep-as-lifecycle-truth, park-vs-destroy, StrictMode/mid-spawn semantics, lock-screen destroyAll, and that `ui` is a per-mount pointer table (decision 4). Implementation notes: `reconcile` accepts Set or array (`const live = ids instanceof Set ? ids : new Set(ids)`), returns the destroyed id list; `destroyEntry` runs hooks newest-first with per-hook try/catch, removes the host, deletes the entry; `ensureEntry` builds the host via `document.createElement("div")` with `className = "phn-pane-host"` and 100% width/height styles.

- [ ] **Step 4: tests pass** (8), **Step 5: full gates + commit**

```bash
git -C C:\Users\pluto\plutos-terminals add src/features/terminals/paneRegistry.js src/features/terminals/paneRegistry.test.js
git -C C:\Users\pluto\plutos-terminals commit -m "feat(panes): pane registry core — park/attach/destroy with reconcile-sweep lifecycle"
```

---

### Task 2: the reconcile sweep + lock-screen destroyAll + leaf-id parity

**Files:**
- Create: `src/features/terminals/paneIds.js` (shared leaf-id derivation)
- Test: `src/features/terminals/paneIds.test.js`
- Modify: `src/features/terminals/TerminalsTab.jsx` (one new effect)
- Modify: `src/App.jsx` (lock transition)

- [ ] **Step 1 (MANDATORY verification): read `TerminalPanel.jsx` (the pane map, ~:487-628, and the `<TerminalPane>` element ~:531-547) and `splitTree.js` (`leafIds`).** Extract the EXACT derivation of the ids TerminalPanel renders panes with (per tab: the split-tree leaf ids when a layout exists; the pattern for single-pane tabs as the code actually does it — do not guess; if the derivation differs per transport (RDP/VNC render other components), capture only what mounts a TerminalPane OR mounts any component that creates registry entries — for B1 only TerminalPane does). Report the derivation in your task report.

- [ ] **Step 2: write `paneIds.js` + tests.** `allRenderedPaneIds(panels) -> string[]` mirroring the TerminalPanel derivation byte-for-byte (import `leafIds` from `splitTree.js` if that is what TerminalPanel uses). Tests: a panels fixture with (a) a single-pane tab, (b) a split tab with a layout, (c) multiple panels — assert the ids match what the derivation yields, and assert parity with a hand-derived expectation copied from the TerminalPanel logic. (These tests are the guard that a future TerminalPanel change breaks loudly.)

- [ ] **Step 3: the sweep effect in TerminalsTab** (place near the other top-level effects; import `reconcile` from paneRegistry and `allRenderedPaneIds` from paneIds):

```js
// Registry lifecycle truth: any pane id no longer rendered by the tree is dead —
// covers every close path (tab/panel/pane close, reset-workspace, workspace
// load, worktree discard) with one mechanism. Runs after unmounted panes'
// cleanups in the same commit (React child-cleanup-before-parent-effect order).
useEffect(() => {
  reconcile(new Set(allRenderedPaneIds(state.panels)));
}, [state.panels]);
```

- [ ] **Step 4: lock-screen destroyAll in App.jsx.** Locate the lock branch (`App.jsx:345-347`) and the state that flips it (`unlocked`). Add an effect that fires on the transition INTO locked while the app is past the welcome gate:

```js
// Locking must kill live sessions, exactly like the pre-registry behavior —
// a parked PTY behind the password gate could keep auto-approving with zero
// supervision once the window loses OS focus.
useEffect(() => {
  if (welcomeDone && lockHash && !unlocked) destroyAll();
}, [welcomeDone, lockHash, unlocked]);
```

(Adapt names to the actual App.jsx state; on a locked cold boot this runs with an empty registry — harmless. Import from the registry module.)

- [ ] **Step 5: full gates + commit**

```bash
git -C C:\Users\pluto\plutos-terminals add src/features/terminals/paneIds.js src/features/terminals/paneIds.test.js src/features/terminals/TerminalsTab.jsx src/App.jsx
git -C C:\Users\pluto\plutos-terminals commit -m "feat(panes): reconcile sweep drives registry lifecycle; lock screen destroys all sessions"
```

---

### Task 3: TerminalPane surgery

**Files:** Modify `src/features/terminals/TerminalPane.jsx`.

Read `:400-1300` in full before editing. The refactor:

**3a. Entry + first-mount guard (effect top, after the `:486-487` container guard):**

```js
const entry = ensureEntry(tabId);
const isFirstMount = !entry.term;
attachHost(tabId, containerRef.current);
```

Re-attach branch (`!isFirstMount`): skip Terminal creation, handler registration, and the whole spawn IIFE; run only 3d + repoint 3b'/3b'' below; set `termRef.current = entry.term; fitRef.current = entry.fit; searchAddonRef.current = entry.search;`.

**3b. The 9 refs — classified conversion (audit-corrected):**

- SHARED-CONTAINER (only ever mutated in place — point the ref at the entry object once per mount): `blocksRef` → `entry.blocks.list`, `blockDecorationsRef` → `entry.blocks.decorations`, `scrollbackChunksRef` → `entry.counters.scrollbackChunks`.
- VALUE-REPLACED (wholesale-reassigned at write sites — EVERY assignment converts to writing the entry field; reads convert too; the ref disappears or becomes a thin accessor): `scrollbackBytesRef` (`:355,358`) → `entry.counters.scrollbackBytes`, `recentOutRef` (`:389,411,944,1031`) → `entry.counters.recentOut`, `familyRef` (`:467`) → `entry.counters.family`, `userHasTypedRef` (`:1027` write; reads at `:1054,1058` and the activity gate) → `entry.counters.userHasTyped`, `lastCostRef` (`:480`) → `entry.counters.lastCost`, `currentBlockRef` (`:600,:622`) → `entry.blocks.current`.
- Walk EVERY usage site of each (grep the ref name); list the conversions in the task report. A missed write site silently reverts state on the next move — this exact failure mode is why the classification exists.

**3b'. `entry.ui` pointer table (audit CRITICAL fix), set on EVERY mount (both branches):**

```js
entry.ui = {
  setFailedBlock, setShellCwd, setAtPrompt, setStickyBlock, setAltScreen,
  capturePrompt: (b) => { /* the existing :616-619 prompt-editor capture body, via current refs */ },
  isAutoApprove: () => autoApproveRef.current,
  isVisible: () => visibleRef.current,
  isActive: () => activeRef.current,
  onCost: (next) => onCostRef.current?.(next),
  onActivity: (a) => onActivityRef.current?.(a),
};
```

Then EVERY create-once handler body (OSC 133 at `:591-672`, OSC 1337 at `:676-703`, `updateSticky`/`term.onScroll` at `:706-717`, `term.onBufferChange` at `:1065-1071`, `handleChunk`/`checkAutoApprove`/`checkCost` and the done-timer/activity path) replaces its direct setter/ref reads with `entry.ui.*` calls. Enumerate every replacement in the report. (While parked, these hit the old fiber's setters — React 18 no-ops them silently; the table repoints on the next mount. Documented cosmetic gap: UI-derived state changes during a parked window are lost until the next event after re-attach.)

**3c. Spawn IIFE (first mount only):** orphan guard `:900-903` becomes `if (!getEntry(tabId)) { invoke("pty_kill", { id }); return; }`; on success `entry.ptyId = id; entry.spawnState = "live";`, tunnel id into `entry.jumpFwdId`; the `:1079-1250` setup region wraps in `if (!entry.setupDone) { ...; entry.setupDone = true; }`; destroy hooks registered in construction order (term.dispose first-registered, then listeners-detach, then the pty_kill/tunnel/unregisterPty hook — LIFO runs kill+bridge first, dispose last).

**3d. Per-mount block (both branches):** recreate IntersectionObserver + ResizeObserver against the CURRENT slot. First-mount IO callback = the existing `openIfVisible`. **Re-attach IO/RO callback = a new `refitOnly` closure (`entry.fit?.fit()` + guard) — NEVER `openIfVisible`** (its `term.open` no-ops safely per xterm source, but its unconditional `loadAddon(new ImageAddon())` stacks a duplicate addon per move — audit HIGH). On re-attach additionally run once: `entry.fit?.fit(); entry.term?.refresh(0, entry.term.rows - 1);` + focus-if-active (mirror `:1317-1319`). `document.fonts.ready` refit stays first-mount-only.

**3e. Cleanup (replaces `:1259-1296`; the six-statement close block `:1288-1293` dissolves into destroy hooks):**

```js
return () => {
  alive = false;
  vis.disconnect(); ro.disconnect();
  clearDoneTimer();
  clearTimeout(bannerRedrawTimerRef.current);
  /* conceal + costRaf + transcript timer teardown: unchanged */
  flushTranscript();
  detachHost(tabId);
  const e = getEntry(tabId);
  if (e && e.spawnState === "starting") destroyEntry(tabId); // mid-spawn: no live handoff (decision 6)
  // otherwise: park. Closes are the sweep's job (Task 2), lock is destroyAll's.
  termRef.current = null; fitRef.current = null;
};
```

**3f. `[cwd]` dep note:** a cwd-prop change re-runs the effect → park + re-attach (no respawn). One-line comment records that live cwd comes from OSC PlutoCwd, the prop matters only at first spawn.

- [ ] **Step 1: read + map (report NEEDS_CONTEXT on any mismatch). Step 2: apply 3a-3f. Step 3: gates. Step 4: commit**

```bash
git -C C:\Users\pluto\plutos-terminals add src/features/terminals/TerminalPane.jsx
git -C C:\Users\pluto\plutos-terminals commit -m "feat(panes): TerminalPane attaches registry-owned xterm; ui pointer table; park-by-default cleanup"
```

---

### Task 4: #27 — `useSyncExternalStore` bridge subscriptions

**Files:**
- Modify: `src/features/terminals/ptyBridge.js` (append `getBridgeVersion`/`subscribeBridge`; bump `bridgeVersion` inside `emitDims`)
- Modify: `src/features/terminals/hooks/independentEffects.js` (`useDimsListener` → `useSyncExternalStore(subscribeBridge, getBridgeVersion)`, RETURNING the version)
- Modify: `src/features/terminals/TerminalsTab.jsx` — TWO edit sites: **`:131`** becomes `const bridgeVersion = useDimsListener();` (capture the return; this is the only call — grep afterward that exactly one `useDimsListener(` exists in the file), and **`:435-463`**: delete the `bridgeTick` useState + the `:436` effect; the `sessionListJson` memo's `bridgeTick` dep becomes `bridgeVersion`. (`bridgeTick` has no other readers — verified `:435,:436,:463` only.)
- Test: append to `src/features/terminals/ptyBridge.test.js` (match its existing flat `test()` style): version bumps on `setTabDims`, subscriber fires, unsubscribe stops delivery while the version still moves.

- [ ] tests red → implement → gates → commit

```bash
git -C C:\Users\pluto\plutos-terminals add src/features/terminals/ptyBridge.js src/features/terminals/ptyBridge.test.js src/features/terminals/hooks/independentEffects.js src/features/terminals/TerminalsTab.jsx
git -C C:\Users\pluto\plutos-terminals commit -m "feat(bridge): useSyncExternalStore subscription surface; single dims listener (#27)"
```

---

### Task 5: B1 gate

- [ ] Full gates (`npm run build && npx vitest run`), report counts.
- [ ] Manual smoke list for pluto (report, do not GUI-automate):
  - long-running command in a tab → drag to another panel → output continues, no respawn banner, no retyped start-commands, scrollback + scroll position intact, cost/token chip never jumps backward; the colored pass/fail block bars from before the move render at the right rows after the move; an in-progress selection or find overlay resets on move (expected, cosmetic).
  - failed command AFTER a move still shows the red block bar + AI explainer; sticky header still updates; prompt editor still captures on a moved pane; auto-approve toggled after a move actually changes behavior.
  - agent capture survives a mid-run move; close tab → process dies (tasklist); Ctrl+Shift+T reopen → fresh shell; SPLIT a tab, close ONE pane → that pane's process dies (the closePane path); reset-workspace and loading a workspace → ALL previous processes die; locking the app → all processes die.
  - dev mode: one shell process per tab, no orphan accumulation across open/close cycles.
- [ ] Review pass: code-reviewer over the whole B1 diff; fix findings; re-review every fix.
