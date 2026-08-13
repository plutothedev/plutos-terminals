# P4 — Bundle/boot plan (2026-08-13)

Parent spec: `../specs/2026-08-12-perf-optimization-design.md` (P4 section; measured baseline there: index 1,475kB raw/432kB gz with CodeMirror ~407kB raw/130kB gz inside; Monaco editor.api2 3,627kB + ts.worker 6.9MB in dist; Meslo TTF 2.6MB). Build order T1 (cheap code-splits) → T2 (config) → T3 (font) → T4 (startup misc) → T5 (boot stagger — riskiest, last, own mini-audit) → T6 (Monaco slim — biggest dist win, isolated).

## T1 — Lazy boundaries (code)

1. **PromptEditor** (TerminalPane.jsx statically imports it; renders behind the default-off `promptEditor` flag): `lazy(() => import("./PromptEditor.jsx"))` + `<Suspense fallback={null}>` at the render site. Inside PromptEditor, the vim adapter (`@replit/codemirror-vim`, ~35kB gz) moves to a dynamic `import()` gated on `vimMode`. Removes ~130kB gz from EVERYONE's critical path.
2. **NotebookView Monaco gate** (the audited one-liner): `if (!visible || Editor || monacoFailed) return;` in the loader effect — a hidden restored notebook tab currently pulls the full ~3.9MB (950kB gz) Monaco chain at boot. RemoteEditor's `!open` gate is the in-repo correct pattern.
3. **ImageAddon** (sixel, 20kB gz): static import → `await import("@xterm/addon-image")` inside openIfVisible + the re-attach path (both instantiation sites).

## T2 — Vite build config (config-only)

vite.config.js has NO build block. Add: `build.rollupOptions.output.advancedChunks.groups` splitting `react|react-dom|scheduler` and `@xterm/*` into named vendor chunks (rolldown API — NOT manualChunks; vite 8 on rolldown); `build.target: "esnext"` (Tauri ships its own webview); `build.modulePreload: { polyfill: false }`; `chunkSizeWarningLimit` left default as the budget alarm. Verify chunk map before/after in the task log (no total-bytes claim — this is cacheability + warning hygiene).

## T3 — Font subset

Meslo TTF 2,594kB ships verbatim (14% of dist) and `document.fonts.load` fires BEFORE createRoot. (a) Subset to woff2: Latin + Latin-1 + box-drawing + powerline/Nerd PUA ranges via fonttools `pyftsubset` (python available on the build machine; `pip install fonttools brotli` if missing — record exact ranges + command in the commit so CI/macbook can reproduce; the TTF stays in the repo as the subsetting SOURCE, only dist ships the woff2). Update styles.css `src` + format. (b) Move the `fonts.load` warm call below createRoot. Verify: glyph coverage smoke = powerline segments + box-drawing in a dev terminal render (visual, pluto smoke list); fallback stack unchanged so a missed glyph degrades to the next mono font, not tofu.

## T4 — Startup misc

1. Per-pane double blob parse (TerminalPane spawn path reads `readUserSt()` + the window blob per pane — 2 full JSON.parses × N panes at boot): parse ONCE per boot burst — module-level memo keyed by a storage version/timestamp, or hoist to TerminalPanel and pass down; pick the smallest correct seam after reading the call sites.
2. Welcome banner's hard `await sleep(450)` per fresh pane before shell init: trim to ~150ms or gate on first-output-received, preserving the banner-before-output visual contract (read the surrounding conceal logic first; do not break the boot-conceal marker flow).
3. `scrollback_sweep`/`transcript_sweep` boot calls take `allOpenTabIds()` (a full localStorage walk + parse of every per-window blob) as an argument computed synchronously post-paint: defer the whole sweep call to `requestIdleCallback` (timeout ~10s) — GC latency is irrelevant.
4. headerSkins CSS-in-JS (42kB string in the JS bundle, injected twice): move the static skin CSS to a real imported `.css` file (vite extracts + caches it separately); keep ONLY the custom-theme variable injection dynamic. Verify the second injection site becomes a no-op/removed.

## T5 — Boot stagger (riskiest; per-task adversarial review mandatory)

Today every restored tab mounts a full TerminalPane and spawns its PTY immediately (20-tab restore = 20 ConPTY spawns + 20 replays at once). Target: visible/active panes spawn immediately; HIDDEN panes defer spawn + replay until first reveal OR a background trickle (one hidden pane per ~300ms after boot settles) so background sessions still come up without user action. Mechanism: gate the first-mount spawn IIFE on `visible || active || trickleReleased(tabId)` — the paneRegistry park/attach machinery already supports late attach; startCommands/welcome flow runs at actual spawn. Constraints to design against (the review's focus): agent tabs with startCommands the user EXPECTS running in background (trickle guarantees eventual spawn — bounded by N×300ms); the companion session list (sessions appear as they spawn — acceptable, registry channel updates); scrollback GC keep-set unaffected (ids from state, not spawn). Explicit deviation lever: if review finds the trickle too risky, fall back to spawn-on-reveal only + a "start all" affordance note.

## T6 — Monaco slim

monacoSetup.js imports the full `monaco-editor` barrel → editor.api2 3.6MB + ts.worker 6.9MB + css/html/json workers ship in dist (~13.4MB of the 17.9MB total) while the notebook needs markdown editing. Switch to `monaco-editor/esm/vs/editor/editor.api` + register ONLY the languages `languageForFile` maps (~30 basic-languages via their individual contribution imports) + editor.worker only (drop ts/css/html/json worker registrations). Dist shrinks by several MB; language chunks stay lazy per-language. Risk: RemoteEditor edits arbitrary remote files — losing rich modes for css/html/ts demotes them to basic tokenization (basic-languages still cover them) — acceptable; note in commit. The bigger Monaco→CodeMirror consolidation stays OUT (spec non-goal).

## Gates & measurement

Per task: build + vitest + cargo (unchanged Rust); record the dist chunk map + total bytes before/after each task in the task log (objective wins). T5 gets its own adversarial review before merge into the stream. Whole-stream audit + re-review-every-fix at the end. Measurables: index gz, dist total, boot spawn count for a 20-tab restore (design property), fonts bytes.

## Non-goals

Monaco→CodeMirror consolidation, virtualized tree, service-worker/preload games, P3 items.
