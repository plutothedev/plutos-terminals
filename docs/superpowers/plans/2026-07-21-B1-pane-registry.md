<!-- (C) -->
# Stream B1: Pane Registry (moveTab keeps the PTY) + Bridge Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** close invariant-1's last gap — moving a tab between panels re-parents the live xterm + PTY instead of kill+respawn — and give ptyBridge a `useSyncExternalStore` subscription surface (#27). Three pre-existing bugs get fixed on the way: mid-move agent-capture force-resolve, cost telemetry jumping backward after a move, start-commands retyped into a live shell.

**Architecture:** a new `paneRegistry.js` module (beside `ptyBridge.js`) owns each tab's create-once objects (xterm instance + addons, host DOM element, PTY session id + event listeners, per-tab counters, one-shot setup flags). TerminalPane becomes attach/detach: first mount for a tabId creates the entry and runs the full spawn/setup; later mounts re-attach the preserved host element and rebind only per-mount concerns (observers, fit, focus, theme). Close paths in `useWorkspaceTree` mark the tab closed in the registry BEFORE persisting, so the unmount cleanup knows its fate: consume-closed → full destroy; otherwise → park.

**Tech Stack:** React 18 (StrictMode ON in dev — a hard constraint, see Task 1), xterm 5.5, Tauri events, vitest.

**Foundation document:** the TerminalPane lifecycle map (produced 2026-07-21 by code exploration; its classifications are restated inline below where needed). Key line refs (current HEAD `3193956`): big effect `TerminalPane.jsx:485-1297` deps `[cwd]`; cleanup block `:1259-1296` with the undifferentiated close-only lines at `:1288-1293`; container div `:1448`; `term.open` `:742`; spawn branch `:851-899`; orphan guard `:900-903`; bridge registrations `:908-928`; listeners `:982-1013`; shell setup `:1103-1250`; `moveTab` `useWorkspaceTree.js:285-316`; `closeTab` `:127-158`; `closeOtherTabs` `:263-281` region; `closePanel` `:51-66`; `reopenTab` `:163-180`; `detachTab` `:237-265`.

**Build gates (before EVERY commit, unfiltered):** `npm run build` + `npx vitest run` green; Rust untouched in this stream (no cargo gates unless a task touches src-tauri, which none should).

**Safety rails:** forward-only commits; no rebase/reset/force-push; `git push` is pluto-only. Anchor tag `pre-v0.6-buildout-2026-07-20` + `backup/pre-v0.6-buildout` already exist (Stream A Task 0).

---

## Design decisions locked before tasks (from the lifecycle map)

1. **Registry-owned host element.** The registry creates ONE detached `<div class="phn-pane-host">` per tab; xterm `open()`s into it exactly once. TerminalPane's `containerRef` div becomes a SLOT: mount = `slot.appendChild(entry.host)`, unmount = `entry.host.remove()` (detach, DOM node + xterm subtree survive). No second `term.open()` ever. After re-attach: `fit()`, `term.refresh(0, term.rows - 1)`, focus if active.
2. **Fate signal = synchronous mark-then-persist.** `closeTab` / `closeOtherTabs` / `closePanel` call `paneRegistry.markClosed(tabId)` synchronously BEFORE `persist(...)`. The pane cleanup calls `paneRegistry.consumeClosed(tabId)`: true → full destroy (pty_kill, tunnel stop, unregisterPty, term.dispose, entry delete); false → park (detach host, keep everything alive). `moveTab` marks nothing — parking is the default. This is race-free: mark and persist happen in the same synchronous mutation call; React runs the old pane's cleanup strictly after.
3. **StrictMode discipline (precise).** Entry creation is SYNCHRONOUS at effect start (placeholder entry with `spawnState:"starting"` before any await). Dev StrictMode's synthetic mount→cleanup→mount fires while the spawn is still `"starting"`, so the cleanup's mid-spawn rule (decision 4) DESTROYS the placeholder and the in-flight spawn's orphan guard kills the PTY on arrival — i.e. dev double-mount keeps today's exact spawn-twice-kill-first behavior, no leak, no change. What the registry's has-guard protects is every POST-SPAWN remount: real moves (and any dev remount after `spawnState === "live"`) find the entry and re-attach without a second spawn.
4. **Mid-spawn move = today's behavior (documented).** If the pane unmounts while `entry.spawnState === "starting"` AND not closed: we do NOT attempt a live handoff of a half-spawned session. The cleanup destroys the entry the same way close does (the existing orphan-guard semantics at `:900-903` generalize). Rationale: the spawn IIFE's `openIfVisible` waits on an IntersectionObserver bound to the first slot; re-pointing every in-flight continuation is high-risk for a sub-second window. Recorded as an accepted gap.
5. **Bridge registrations become registry-lifetime.** `registerPtyWriter` / `setPtyId` / `registerTabReader` happen once per spawn and are NOT unregistered on park — only on destroy. Consequence: `runAndCapture` survives a move (bug fix 1); the pending-capture force-resolve in `unregisterPty` now only fires on real close.
6. **Per-tab counters move into the entry.** `lastCost` / `family` (cost monotonic guard), `scrollbackChunks` / `scrollbackBytes` (10KB scan ring), `blocks` / `currentBlock` / `blockDecorations` (command blocks), `userHasTyped`, `recentOut` — all become entry fields so a move cannot reset them (bug fix 2). The component keeps thin refs pointing at the entry.
7. **One-shot setup flags in the entry.** `setupDone` guards the whole `:1079-1250` region (claude preflight, start-commands typing, welcome banner/shell-integration, system-prompt injection). Runs once per real spawn; a re-mount never re-types anything (bug fix 3).
8. **#27 minimal shape.** ptyBridge grows `getVersion()` (monotonic int bumped inside `emitDims`) + `subscribeBridge(cb)` (alias of `onDimsChange`). New hook `useBridgeVersion()` = `useSyncExternalStore(subscribeBridge, getVersion)`. TerminalsTab's two ad-hoc subscriptions (`independentEffects.js:76-79` used at `TerminalsTab.jsx:131`, and the inline one at `:436`) become consumers of the version number. Single-channel notify semantics preserved exactly (the map warns per-Map splitting is invasive; we don't).
9. **App exit unchanged.** `quit_app` (backend kill-everything) remains the real teardown for exit; the registry never assumes its destroy runs on process death (the scrollback lesson at `TerminalPane.jsx:1279-1286` stands).
10. **Recording/`detachTab`/`reopenTab`:** recording.js already survives moves (module-level) — untouched. `detachTab` closes the source tab after `spawn_new_window` → normal close path (mark+destroy), new window has its own module singletons. `reopenTab` reuses an id only after a real close fully destroyed the entry synchronously in cleanup — no debounce exists to race.

---

### Task 1: `paneRegistry.js` core + tests

**Files:**
- Create: `src/features/terminals/paneRegistry.js`
- Test: `src/features/terminals/paneRegistry.test.js`

Registry API (all functions take `tabId` first):

```js
ensureEntry(tabId) -> entry            // create-if-missing placeholder (sync); entry.host is a created <div>
getEntry(tabId) -> entry | null
markClosed(tabId)                      // close paths call this BEFORE persist
consumeClosed(tabId) -> boolean        // cleanup calls once; true means "destroy now"; clears the mark
attachHost(tabId, slotEl)              // appendChild(entry.host); records entry.currentSlot = slotEl
detachHost(tabId)                      // entry.host.remove(); currentSlot = null
destroyEntry(tabId, { killPty })       // runs entry.onDestroy hooks (registered by the pane), deletes entry
registerDestroyHook(tabId, fn)         // pane registers pty-kill/tunnel/unlisten/dispose closures here
listEntries() -> tabId[]               // debugging/tests
```

Entry shape (plain object, documented in a comment):

```js
{
  host: HTMLDivElement,        // xterm opens into this exactly once; survives parks
  currentSlot: null,           // the React slot currently holding host (or null when parked)
  term: null, fit: null, search: null,   // set by the pane on create
  ptyId: null, jumpFwdId: null,
  spawnState: "starting",      // "starting" | "live" | "dead"
  setupDone: false,            // one-shot shell setup / start-commands / system prompt
  closedMark: false,           // set by markClosed, consumed by consumeClosed
  onDestroy: [],               // teardown closures (unlisteners, pty_kill invoker, term.dispose)
  counters: { lastCost: { tokens: 0, cost: 0 }, family: null,
              scrollbackChunks: [], scrollbackBytes: 0,
              userHasTyped: false, recentOut: "" },
  blocks: { list: [], current: null, decorations: [] },
}
```

- [ ] **Step 1: Write the failing tests**

Create `src/features/terminals/paneRegistry.test.js`:

```js
// (C)
import { describe, it, expect, vi } from "vitest";
import {
  ensureEntry, getEntry, markClosed, consumeClosed,
  attachHost, detachHost, destroyEntry, registerDestroyHook, listEntries,
} from "./paneRegistry.js";

const fresh = (id) => { destroyEntry(id, { killPty: false }); return ensureEntry(id); };

describe("paneRegistry", () => {
  it("ensureEntry is idempotent and synchronous (StrictMode guard)", () => {
    const a = fresh("t1");
    const b = ensureEntry("t1");
    expect(b).toBe(a); // same object, no second creation
    expect(a.host).toBeInstanceOf(HTMLDivElement);
    expect(a.spawnState).toBe("starting");
  });

  it("markClosed then consumeClosed reads true exactly once", () => {
    fresh("t2");
    markClosed("t2");
    expect(consumeClosed("t2")).toBe(true);
    expect(consumeClosed("t2")).toBe(false); // consumed
  });

  it("consumeClosed is false for a plain move (nothing marked)", () => {
    fresh("t3");
    expect(consumeClosed("t3")).toBe(false);
    expect(getEntry("t3")).not.toBeNull(); // entry survives (parked)
  });

  it("attachHost/detachHost move the SAME host node between slots", () => {
    const e = fresh("t4");
    const slot1 = document.createElement("div");
    const slot2 = document.createElement("div");
    attachHost("t4", slot1);
    expect(slot1.contains(e.host)).toBe(true);
    detachHost("t4");
    expect(slot1.contains(e.host)).toBe(false);
    attachHost("t4", slot2);
    expect(slot2.contains(e.host)).toBe(true);
    expect(e.currentSlot).toBe(slot2);
  });

  it("attachHost re-parents implicitly when called on a new slot without detach", () => {
    const e = fresh("t5");
    const s1 = document.createElement("div");
    const s2 = document.createElement("div");
    attachHost("t5", s1);
    attachHost("t5", s2); // appendChild moves the node — no duplicate
    expect(s1.contains(e.host)).toBe(false);
    expect(s2.contains(e.host)).toBe(true);
  });

  it("destroyEntry runs hooks LIFO and deletes the entry", () => {
    fresh("t6");
    const order = [];
    registerDestroyHook("t6", () => order.push("a"));
    registerDestroyHook("t6", () => order.push("b"));
    destroyEntry("t6", { killPty: true });
    expect(order).toEqual(["b", "a"]); // LIFO: listeners detach before term.dispose
    expect(getEntry("t6")).toBeNull();
  });

  it("destroy hooks that throw do not stop the rest", () => {
    fresh("t7");
    const ran = [];
    registerDestroyHook("t7", () => ran.push("late"));
    registerDestroyHook("t7", () => { throw new Error("boom"); });
    destroyEntry("t7", { killPty: true });
    expect(ran).toEqual(["late"]);
    expect(getEntry("t7")).toBeNull();
  });

  it("close-then-reopen same id gets a FRESH entry", () => {
    const first = fresh("t8");
    markClosed("t8");
    expect(consumeClosed("t8")).toBe(true);
    destroyEntry("t8", { killPty: true });
    const second = ensureEntry("t8");
    expect(second).not.toBe(first);
    expect(second.spawnState).toBe("starting");
    expect(second.setupDone).toBe(false);
  });

  it("counters live on the entry and survive park cycles", () => {
    const e = fresh("t9");
    e.counters.lastCost = { tokens: 42, cost: 0.5 };
    e.counters.scrollbackBytes = 999;
    detachHost("t9"); // park
    const again = ensureEntry("t9");
    expect(again.counters.lastCost.tokens).toBe(42);
    expect(again.counters.scrollbackBytes).toBe(999);
  });

  it("markClosed on an unknown id is a safe no-op; consumeClosed false", () => {
    markClosed("ghost");
    expect(consumeClosed("ghost")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd C:\Users\pluto\plutos-terminals && npx vitest run src/features/terminals/paneRegistry.test.js`
Expected: FAIL, cannot resolve `./paneRegistry.js`.

- [ ] **Step 3: Implement**

Create `src/features/terminals/paneRegistry.js`:

```js
// (C)
// Pane registry: the create-once side of a terminal tab, owned OUTSIDE React so
// a cross-panel move (unmount in one panel subtree, mount in another) re-attaches
// the same live xterm + PTY instead of kill+respawn (invariant 1). The registry
// owns: the host DOM element xterm opened into, the Terminal/addons, the live
// session id, per-tab counters (cost/scrollback/blocks), and one-shot setup
// flags. TerminalPane is reduced to attach/detach + per-mount concerns.
//
// Fate protocol: close mutations (closeTab/closeOtherTabs/closePanel) call
// markClosed(tabId) synchronously BEFORE persist(); the pane's effect cleanup
// calls consumeClosed(tabId) — true means destroy now, false means park.
// moveTab marks nothing; parking is the default. StrictMode dev double-mount
// parks then re-attaches; ensureEntry's has-guard prevents a double spawn.
// App exit does NOT rely on this module: quit_app kills PTYs backend-side.

const entries = new Map(); // tabId -> entry

export function ensureEntry(tabId) {
  let e = entries.get(tabId);
  if (e) return e;
  const host = document.createElement("div");
  host.className = "phn-pane-host";
  host.style.width = "100%";
  host.style.height = "100%";
  e = {
    host,
    currentSlot: null,
    term: null, fit: null, search: null,
    ptyId: null, jumpFwdId: null,
    spawnState: "starting",
    setupDone: false,
    closedMark: false,
    onDestroy: [],
    counters: {
      lastCost: { tokens: 0, cost: 0 }, family: null,
      scrollbackChunks: [], scrollbackBytes: 0,
      userHasTyped: false, recentOut: "",
    },
    blocks: { list: [], current: null, decorations: [] },
  };
  entries.set(tabId, e);
  return e;
}

export function getEntry(tabId) {
  return entries.get(tabId) || null;
}

export function markClosed(tabId) {
  const e = entries.get(tabId);
  if (e) e.closedMark = true;
}

export function consumeClosed(tabId) {
  const e = entries.get(tabId);
  if (!e || !e.closedMark) return false;
  e.closedMark = false;
  return true;
}

export function attachHost(tabId, slotEl) {
  const e = entries.get(tabId);
  if (!e || !slotEl) return;
  slotEl.appendChild(e.host); // appendChild MOVES the node if parented elsewhere
  e.currentSlot = slotEl;
}

export function detachHost(tabId) {
  const e = entries.get(tabId);
  if (!e) return;
  try { e.host.remove(); } catch { /* already detached */ }
  e.currentSlot = null;
}

export function registerDestroyHook(tabId, fn) {
  const e = entries.get(tabId);
  if (e && typeof fn === "function") e.onDestroy.push(fn);
}

export function destroyEntry(tabId) {
  const e = entries.get(tabId);
  if (!e) return;
  // LIFO: listener detach hooks were registered before term.dispose, so running
  // newest-first tears the stack down in reverse construction order.
  for (let i = e.onDestroy.length - 1; i >= 0; i--) {
    try { e.onDestroy[i](); } catch { /* one bad hook must not strand the rest */ }
  }
  try { e.host.remove(); } catch { /* detached is fine */ }
  entries.delete(tabId);
}

export function listEntries() {
  return [...entries.keys()];
}
```

NOTE to implementer: the test calls `destroyEntry(id, { killPty: false })` — the options argument is accepted-and-ignored (`destroyEntry(tabId)` signature takes it as an unused second param for call-site readability). Match the tests: add the parameter `(tabId, _opts)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/terminals/paneRegistry.test.js`
Expected: 10 passed. (vitest environment: check `vitest.config.js` — if `environment` is not `jsdom`/`happy-dom`, these DOM tests need a per-file `// @vitest-environment jsdom` pragma at the top of the test file; add it and, if the dependency is missing, STOP and report BLOCKED rather than adding packages silently.)

- [ ] **Step 5: Full gates + commit**

`npm run build && npx vitest run` green.

```bash
git -C C:\Users\pluto\plutos-terminals add src/features/terminals/paneRegistry.js src/features/terminals/paneRegistry.test.js
git -C C:\Users\pluto\plutos-terminals commit -m "feat(panes): pane registry core — park/attach/destroy with close-mark fate protocol"
```

---

### Task 2: close paths mark the registry

**Files:**
- Modify: `src/features/terminals/hooks/useWorkspaceTree.js`

Add `markClosed` calls (import `{ markClosed } from "../paneRegistry.js"`), each BEFORE the mutation's `persist(...)`:

- `closeTab` (`:127-158`): `markClosed(tabId)` beside the existing `clearTabPassword(tabId)` (`:145`).
- `closeOtherTabs` (`:263-281` region): for each removed tab id, beside its `clearTabPassword`.
- `closePanel` (`:51-66`): for each tab of the closing panel, beside the existing loop at `:57`.
- `detachTab` (`:237-265`): NO new call — it already funnels through `closeTab` (`:263`) after `spawn_new_window`.
- `moveTab`, `reorderTab`, `duplicateTab`, `reopenTab`: NO calls (move parks by default; duplicate/reopen create fresh ids/entries).

- [ ] **Step 1: Apply the edits** (anchor by content; the `clearTabPassword` call sites are the landmarks)
- [ ] **Step 2: Gates + commit**

`npm run build && npx vitest run` green.

```bash
git -C C:\Users\pluto\plutos-terminals add src/features/terminals/hooks/useWorkspaceTree.js
git -C C:\Users\pluto\plutos-terminals commit -m "feat(panes): close mutations mark the pane registry before persist"
```

---

### Task 3: TerminalPane surgery (the core task)

**Files:**
- Modify: `src/features/terminals/TerminalPane.jsx`

This is the careful one. The implementing agent MUST read the whole big effect (`:485-1297`) before editing. The refactor, hunk by hunk:

**3a. Effect entry — synchronous entry creation + create-once guard:**

At the top of the big effect (after the `containerRef.current` guard at `:486-487`):

```js
const entry = ensureEntry(tabId);
const isFirstMount = !entry.term; // no Terminal yet -> this mount creates everything
attachHost(tabId, containerRef.current);
```

- When `isFirstMount` is false (re-attach after a move / StrictMode remount): SKIP Terminal creation (`:497-518`), SKIP handler registration (`:521-717`), SKIP the spawn IIFE (`:800-1254`) entirely. Run only the per-mount block (3d).
- When true: run the existing setup, with the changes in 3b/3c. `term.open(entry.host)` replaces `term.open(container)` at `:742` — xterm opens into the registry host (already appended into this mount's slot), never into the React div directly. Store `entry.term = term; entry.fit = fit; entry.search = search;` right after creation. Keep `termRef.current = term` etc. for the component's own consumers, set in BOTH branches (re-attach sets them from the entry).

**3b. Move the per-tab mutable state onto the entry:**

The refs at `:234-236` (`currentBlockRef`, `blocksRef`, `blockDecorationsRef`), `:290-291` (`scrollbackChunksRef`, `scrollbackBytesRef`), `:310` (`lastCostRef`), `:315` (`familyRef`), plus `userHasTypedRef` and `recentOutRef`: keep the refs (so downstream code is untouched) but initialize them FROM the entry on every mount and write THROUGH to the entry. Mechanical pattern — replace `const blocksRef = useRef([])` style with:

```js
const blocksRef = useRef(null);
if (blocksRef.current === null) blocksRef.current = entryRefFor(tabId); // see below
```

Simplest correct shape (implementer's choice, must be consistent): a tiny helper in TerminalPane that maps each ref to the entry field once per mount:

```js
// after ensureEntry:
blocksRef.current = entry.blocks.list;
// ... but ARRAYS/objects must be shared by REFERENCE, not copied.
```

Rule: every one of these refs points at the ENTRY-OWNED object (`entry.blocks`, `entry.counters`), so a re-mount sees the same live state. Where current code REASSIGNS a ref's `.current` wholesale (e.g. `scrollbackChunksRef.current = []`), it must instead mutate the entry object's fields (`entry.counters.scrollbackChunks.length = 0`) or reassign through the entry. The implementer walks each usage site (grep each ref name) and converts. The cost-monotonic guard (`:436-454`) now reads/writes `entry.counters.lastCost` — moving a tab no longer zeroes it (bug fix 2).

**3c. Spawn IIFE changes (first mount only):**

- Orphan guard `:900-903`: replace the `!alive` check body with fate-aware logic: if the component unmounted mid-spawn, kill ONLY if the entry is gone or was closed: `if (!getEntry(tabId)) { invoke("pty_kill", { id }); return; }` — and set `entry.spawnState = "dead"` on the kill path. Additionally, per design decision 4, the mid-spawn-move case is handled in the cleanup (3e): unmount during `spawnState === "starting"` destroys the entry (kill+dispose) even when not marked closed.
- After successful registration (`:904-928`): `entry.ptyId = id; entry.spawnState = "live";` and `entry.jumpFwdId = jumpFwdId` where the tunnel is created (`:871-882`).
- The whole `:1079-1250` setup region gains the one-shot guard: `if (!entry.setupDone) { ...existing code...; entry.setupDone = true; }` (bug fix 3). (On first mount it always runs; the guard's value is for any future respawn-into-same-entry path and self-documentation.)
- Register destroy hooks WITH the registry as resources come live, in construction order (they run LIFO):

```js
registerDestroyHook(tabId, () => { try { term.dispose(); } catch {} });          // registered FIRST -> runs LAST
// ...after listeners resolve:
registerDestroyHook(tabId, () => { if (unlistenData) unlistenData(); if (unlistenExit) unlistenExit(); });
// ...after spawn:
registerDestroyHook(tabId, () => {
  if (entry.ptyId) invoke("pty_kill", { id: entry.ptyId });
  if (entry.jumpFwdId) invoke("port_forward_stop", { id: entry.jumpFwdId });
  unregisterPty(tabId); // bridge cleanup + capture force-resolve: CLOSE-ONLY now (bug fix 1)
});
```

**3d. Per-mount block (BOTH branches):**

Runs on every mount (first or re-attach): `IntersectionObserver` (`:750-753`) and `ResizeObserver` (`:1256-1257`) are recreated against `containerRef.current` (the slot) — their callbacks call `safeFit()` which must reference `entry.fit`/`entry.term` (not effect-closure locals) so they work in the re-attach branch too. On re-attach additionally: `entry.fit?.fit(); entry.term?.refresh(0, entry.term.rows - 1);` then focus restore if this pane is active (mirror the pattern at `:1317-1319`). `document.fonts.ready` refit (`:759-768`) stays first-mount-only (fonts load once).

**3e. Cleanup split (the five-line block `:1288-1293` dissolves):**

```js
return () => {
  alive = false;
  vis.disconnect(); ro.disconnect();
  clearDoneTimer();
  clearTimeout(bannerRedrawTimerRef.current);
  /* conceal + costRaf + transcript timer teardown: unchanged (:1265-1276) */
  flushTranscript(); // safe on both paths (idempotent)
  detachHost(tabId);
  const entryNow = getEntry(tabId);
  const closing = consumeClosed(tabId);
  const midSpawn = entryNow && entryNow.spawnState === "starting";
  if (closing || midSpawn) {
    destroyEntry(tabId); // runs the LIFO hooks: pty_kill + tunnel + unregisterPty + listeners + dispose
  }
  // parked: everything lives on in the registry; nothing else to do.
  termRef.current = null; fitRef.current = null;
};
```

Delete the old unconditional `unregisterPty` / `unlisten` / `pty_kill` / `port_forward_stop` / `term.dispose` lines — they live in destroy hooks now. IMPORTANT: `unlistenData`/`unlistenExit` were effect-closure locals; they must be captured by the destroy hook registered in 3c (closure over the same variables in the first-mount branch), NOT referenced from the cleanup.

**3f. Effect deps:** the big effect's `[cwd]` dependency stays. A cwd change on a LIVE entry (rare: same tab id, changed cwd prop) re-runs the effect: cleanup parks (not closed), re-mount re-attaches. The old behavior (respawn on cwd change) is intentionally gone — cwd changes mid-session come from OSC PlutoCwd, not props; the prop only matters at first spawn. Add a one-line comment stating this.

- [ ] **Step 1: Read `TerminalPane.jsx:400-1300` in full.** Map every usage site of the refs listed in 3b (grep each name). Report NEEDS_CONTEXT if any usage doesn't fit the entry-backed pattern.
- [ ] **Step 2: Apply 3a-3f.**
- [ ] **Step 3: Gates**

`npm run build && npx vitest run` green (no unit tests cover this file; the build + full suite + Task 5's registry tests are the automated net).

- [ ] **Step 4: Commit**

```bash
git -C C:\Users\pluto\plutos-terminals add src/features/terminals/TerminalPane.jsx
git -C C:\Users\pluto\plutos-terminals commit -m "feat(panes): TerminalPane attaches registry-owned xterm; moveTab parks instead of kill+respawn"
```

---

### Task 4: #27 — `useSyncExternalStore` bridge subscriptions

**Files:**
- Modify: `src/features/terminals/ptyBridge.js` (append)
- Modify: `src/features/terminals/hooks/independentEffects.js` (`useDimsListener`, `:76-79`)
- Modify: `src/features/terminals/TerminalsTab.jsx` (inline subscription at `:436`)
- Test: `src/features/terminals/ptyBridge.test.js` (append)

**ptyBridge append:**

```js
// ── React subscription surface (#27) ────────────────────────────────────────
// One monotonic version, bumped by emitDims() — the bridge's single existing
// notify channel. useSyncExternalStore consumers re-read whatever getters they
// need when the version moves. Deliberately NOT per-Map subscriptions: the
// single-channel coupling is the current behavior, kept exactly.

let bridgeVersion = 0;
export function getBridgeVersion() { return bridgeVersion; }
export function subscribeBridge(cb) {
  dimsListeners.add(cb);
  return () => dimsListeners.delete(cb);
}
```

And inside `emitDims()` (before the listener loop): `bridgeVersion++;`.

**`useDimsListener` becomes:**

```js
export function useDimsListener() {
  return useSyncExternalStore(subscribeBridge, getBridgeVersion);
}
```

(import `useSyncExternalStore` from react; import the two bridge functions; delete the old `bumpDims` state pattern. The hook now RETURNS the version; its caller at `TerminalsTab.jsx:131` ignores the return today — unchanged call site keeps working, the re-render-on-change contract is identical.)

**TerminalsTab `:436` inline subscription:** replace the `useEffect(() => onDimsChange(() => setBridgeTick(...)), [])` + `bridgeTick` state pair with the same hook: `const bridgeTick = useDimsListener();` — wait: `useDimsListener` is already called at `:131`. Call it ONCE, keep the returned version in a variable, and use it as the `bridgeTick` dependency of the `sessionListJson` memo (`:437-463` deps swap `bridgeTick` → the version value). Delete the `bridgeTick` useState (`:435`) and the `:436` effect. Net: one subscription instead of two, same re-render semantics (the map noted the duplication; consolidating is a deliberate, declared improvement — one re-render per dims event instead of two).

**Tests (append to `ptyBridge.test.js`, matching its existing style):**

```js
test("bridge version bumps on dims changes and subscribe delivers", () => {
  const before = getBridgeVersion();
  let called = 0;
  const un = subscribeBridge(() => { called += 1; });
  setTabDims("vtab", 80, 24);
  expect(getBridgeVersion()).toBeGreaterThan(before);
  expect(called).toBeGreaterThan(0);
  un();
  const at = getBridgeVersion();
  setTabDims("vtab", 100, 30);
  expect(getBridgeVersion()).toBeGreaterThan(at); // version still moves
  expect(called).toBe(1); // but unsubscribed callback didn't fire again
});
```

(Adjust imports/counts to the file's real conventions; verify the real test file's import list first.)

- [ ] **Step 1: tests first (red), Step 2: implement, Step 3: gates, Step 4: commit**

```bash
git -C C:\Users\pluto\plutos-terminals add src/features/terminals/ptyBridge.js src/features/terminals/ptyBridge.test.js src/features/terminals/hooks/independentEffects.js src/features/terminals/TerminalsTab.jsx
git -C C:\Users\pluto\plutos-terminals commit -m "feat(bridge): useSyncExternalStore subscription surface; consolidate dims listeners (#27)"
```

---

### Task 5: B1 gate

- [ ] **Step 1: Full gates:** `npm run build && npx vitest run` (all green, report counts).
- [ ] **Step 2: Manual smoke list for pluto (append to the stream report, do NOT attempt GUI automation):**
  - open 2 panels; run `ping -t 8.8.8.8` (or a long `npm run dev`) in a tab; drag the tab to the other panel → output CONTINUES, no respawn banner, no retyped start-commands; scroll position/history intact; cost/token chip does not jump backward.
  - agent mode: start a long `run_command`, move the tab mid-run → capture still resolves.
  - close tab → process actually dies (check with `tasklist`); Ctrl+Shift+T reopen → fresh clean shell.
  - dev-mode (`npm run tauri dev`, StrictMode): open a new tab → exactly ONE shell process per tab (`tasklist | findstr` the shell), no orphan accumulation after several open/close cycles.
  - SSH tab with jump host: move it → session stays connected; close → tunnel torn down.
  - detach tab to new window → old window's session dies, new window spawns fresh (unchanged behavior).
- [ ] **Step 3: Review pass:** code-reviewer subagent over the B1 diff; fix findings; re-review every fix.
