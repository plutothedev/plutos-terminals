# P4 — Bundle/boot plan (2026-08-13, rev 2 — folds the plan-audit's 3C/4H/4M/3L; audit verdict on rev 1 was BLOCKED)

Parent spec: `../specs/2026-08-12-perf-optimization-design.md` (P4 section; measured baseline there: index 1,475kB raw/432kB gz with CodeMirror ~407kB raw/130kB gz inside; Monaco editor.api2 3,627kB + ts.worker 6.9MB in dist; Meslo TTF 2.6MB). Build order T1 (cheap code-splits) → T2 (config) → T3 (font) → T4 (startup misc) → T5 (boot stagger — riskiest, last, own mini-audit) → T6 (Monaco slim — biggest dist win, isolated).

## T1 — Lazy boundaries (code)

1. **PromptEditor** (TerminalPane.jsx statically imports it; renders behind the default-off `promptEditor` flag): `lazy(() => import("./PromptEditor.jsx"))` + `<Suspense fallback={null}>` at the render site. Inside PromptEditor, the vim adapter (`@replit/codemirror-vim`, ~35kB gz) moves to a dynamic `import()` gated on `vimMode`. Removes ~130kB gz from EVERYONE's critical path.
2. **NotebookView Monaco gate** (audit C1 — rev 1's "one-liner" was a trap): the loader effect gains `if (!visible || Editor || monacoFailed) return;` AND its deps array becomes `[visible, Editor, monacoFailed]`. Rev 1 omitted the deps change; the existing effect runs once on mount (`[]`), so the early-return would fire for a hidden tab and the effect would NEVER re-run when `visible` flips true — editor permanently bricked for any tab not visible at mount. Acceptance: restore a notebook in a hidden tab, boot, confirm no monaco chunk in the network/module log, reveal the tab, editor loads.
3. **ImageAddon** (sixel, 20kB gz): static import → `await import("@xterm/addon-image")` at the FIRST instantiation site. Audit L3: the re-attach/continuation path does NOT re-import or re-instantiate — a once-per-term latch (the addon instance stored on the term's addon record) guards `loadAddon` so continuation reuses the already-loaded addon; dynamic import dedupes anyway but the latch is what stops double-`loadAddon` on the same term.

## T2 — Vite build config (config-only)

vite.config.js has NO build block. Add:
- `build.rollupOptions.output.codeSplitting.groups` — audit M1: rolldown-vite's API is **`codeSplitting`**, NOT `advancedChunks` (that name is rolldown-native but rolldown-vite renamed it; `advancedChunks` on vite 8 is silently ignored → zero-effect config). Groups: `react|react-dom|scheduler` → `vendor-react`, `@xterm/*` → `vendor-xterm`.
- Audit C2: acceptance is the CHUNK MAP, not config presence — before/after `dist/assets` listing committed in the task log; the groups must actually appear as separate emitted chunks (`vendor-react-*.js`, `vendor-xterm-*.js`) with index shrinking accordingly. If rolldown-vite's field silently no-ops (wrong nesting, version drift), the unchanged chunk map FAILS the task — do not ship config that changes nothing.
- `build.target` — audit H1: NOT `esnext`. Tauri's webview floor is WebView2 (evergreen chromium) on Windows but **WKWebView on macOS** — the app ships a universal .dmg and older-macOS Safari engines choke on late-esnext syntax. Pin `["chrome107", "safari16"]`.
- `build.modulePreload: { polyfill: false }` (single-webview app, no legacy).
- `chunkSizeWarningLimit` left default as the budget alarm.

## T3 — Font subset

Meslo TTF 2,594kB ships verbatim (14% of dist) and `document.fonts.load` fires BEFORE createRoot.
- Audit H3 (build hygiene): the subset woff2 is generated ONCE locally and **committed** to `public/fonts/` (CI/macbook builds must not need python/fonttools); the source TTF MOVES out of `public/` (→ `tools/fonts/`, with the exact `pyftsubset` command + ranges in a README next to it) so the 2.6MB original stops shipping in dist. Rev 1 kept the TTF in place as "source" — that left it in `public/` = still shipped.
- Audit M3 glyph ranges: Latin + Latin-1 + Latin Extended-A, box-drawing U+2500-257F, block elements U+2580-259F, braille U+2800-28FF (spinner glyphs — `ora`/CLI spinners render tofu without them), general punctuation U+2000-206F, arrows U+2190-21FF, dingbats incl. `❯` U+2713/2717/276F (starship/oh-my-posh prompts), powerline U+E0A0-E0D7, and the FULL BMP PUA U+E000-F8FF (Nerd Font icons land all over the PUA, not only the powerline strip). Record final ranges in the tools/fonts README.
- `styles.css` `src` updated to the woff2 (format("woff2")); fallback stack unchanged so a missed glyph degrades to the next mono font, not tofu.
- Audit L1: the `fonts.load` warm call move is a no-op for perf (it's async fire-and-forget; it never blocked createRoot) — DROP that sub-item instead of moving code for zero effect.
- Verify: powerline segments + box-drawing + braille spinner + `❯` in a dev terminal render (pluto smoke list); dist no longer contains the TTF.

## T4 — Startup misc

1. Per-pane double blob parse (TerminalPane spawn path reads `readUserSt()` + the window blob per pane — 2 full JSON.parses × N panes at boot): audit M2 picks the seam — a **module-level memo keyed by the raw localStorage string identity** (`memo.raw === s ? memo.parsed : reparse`) in the read helper itself. String identity is the correct invalidation (any write changes the string; comparison is O(len) only on miss... on hit it's a pointer-equality fast path in practice since localStorage returns the same string content); no TerminalPanel prop-drilling, no staleness window.
2. Welcome banner's hard `await sleep(450)` per fresh pane before shell init: audit L2 — floor is ~100-150ms, NOT first-output-gating (the banner-before-output conceal contract depends on the fixed delay; gating on output inverts the race it exists to hide). Ship `sleep(150)`; read the conceal logic first and keep the marker flow byte-identical.
3. `scrollback_sweep`/`transcript_sweep` boot calls take `allOpenTabIds()` (a full localStorage walk + parse of every per-window blob) computed synchronously post-paint: defer the whole sweep call — audit C3: `requestIdleCallback` does NOT exist in WKWebView/Safari; bare rIC = ReferenceError = **macOS builds never sweep** (unbounded scrollback dir growth). Use `const rIC = window.requestIdleCallback ?? ((cb) => setTimeout(cb, 3000)); rIC(runSweeps, { timeout: 10_000 })` (options arg harmless in the fallback).
4. headerSkins CSS-in-JS (42kB string in the JS bundle, injected twice): move the static skin CSS to a real imported `.css` file (vite extracts + caches it separately); keep ONLY the custom-theme variable injection dynamic. Verify the second injection site becomes a no-op/removed. Audit M4: smoke MUST include a **custom theme** (the dynamic injection path) — built-ins alone wouldn't catch the split severing the variable bridge.

## T5 — Boot stagger (riskiest; per-task adversarial review mandatory)

Today every restored tab mounts a full TerminalPane and spawns its PTY immediately (20-tab restore = 20 ConPTY spawns + 20 replays at once). Target: visible/active panes spawn immediately; HIDDEN panes defer spawn + replay until first reveal OR a background trickle so background sessions still come up without user action.

Audit H4 rebuild of the mechanism (rev 1's "gate the spawn IIFE on `visible || active || trickleReleased(tabId)`" had two faults — a mount-time-frozen condition (the IIFE runs once; a later reveal/trickle release would never re-trigger it) and a pane-count-keyed trickle that double-spawned split panes):
- Each pane registry entry gets a **once-latched `startSpawn()`** — idempotent, first call wins, subsequent calls no-op.
- `startSpawn` fires from (a) a `[visible]`-dep'd effect in TerminalPane (covers at-boot-visible AND first-reveal — the effect re-runs when visible flips), and (b) the trickle.
- The trickle is **anchored to the TREE mount (one instance, module-level guard), keyed by tabId** — one hidden TAB released per ~300ms tick after boot settles (~1s post-mount), calling `startSpawn()` on every pane of that tab. tabId keying is what stops a 3-split tab from consuming 3 trickle slots or spawning thrice.
- New distinct `spawnState: "unspawned"` for parked panes (registry today only knows spawned states) — the companion session list and status dots render it as pending, NOT as dead/error.
- startCommands/welcome flow runs at actual spawn (unchanged code path — startSpawn calls the existing spawn IIFE body).
- Constraints held from rev 1: agent tabs with startCommands the user EXPECTS running in background (trickle guarantees eventual spawn, bounded N×300ms); companion list populates as sessions spawn (registry channel updates); scrollback GC keep-set from state ids, not spawn state.
- Deviation lever unchanged: if the mini-review finds the trickle too risky, fall back to spawn-on-reveal only + a "start all" affordance note.

## T6 — Monaco slim

monacoSetup.js imports the full `monaco-editor` barrel → editor.api2 3.6MB + ts.worker 6.9MB + css/html/json workers ship in dist (~13.4MB of the 17.9MB total) while the notebook needs markdown editing. Switch to `monaco-editor/esm/vs/editor/editor.api` + register ONLY the languages `languageForFile` maps (~30 basic-languages via their individual contribution imports) + editor.worker only — drop the ts/css/html worker registrations. Audit H2 (consistency rule: a language must be in BOTH the worker map and the mode registration, or NEITHER): **json's rich mode + json.worker are dropped together** — json falls to basic-languages tokenization like css/html/ts; no orphaned rich-mode registration left pointing at a missing worker (that combo throws in-editor on first json open). Risk note for the commit: RemoteEditor edits arbitrary remote files — css/html/ts/json demote to basic tokenization (still colored, no intellisense) — acceptable. The bigger Monaco→CodeMirror consolidation stays OUT (spec non-goal).

## Gates & measurement

Per task: build + vitest + cargo (unchanged Rust); record the dist chunk map + total bytes before/after each task in the task log (objective wins; T2's acceptance is explicitly the chunk map per C2). T5 gets its own adversarial review before merge into the stream. Whole-stream audit + re-review-every-fix at the end. Measurables: index gz, dist total, boot spawn count for a 20-tab restore (design property), fonts bytes.

## Non-goals

Monaco→CodeMirror consolidation, virtualized tree, service-worker/preload games, P3 items.
