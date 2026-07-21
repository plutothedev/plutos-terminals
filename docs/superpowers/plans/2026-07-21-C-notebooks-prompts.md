<!-- (C) -->
# Stream C: Notebooks + Saved Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** runnable markdown notebooks (shell blocks execute in a target pane; outputs written back inline as owned fences) as a new `tab.notebook` type, plus a Saved Prompts library (cloud-synced collection, slash-menu insertion into the two AI inputs).

**Architecture:** pure markdown block model (`notebookModel.js`) + two narrow dir-scoped Rust commands (`notebook_read`/`notebook_write`, atomic) + a `NotebookView` tab component (lazy Monaco via `monacoSetup.js`, textarea fallback, side-rail block list with Run buttons reusing `runAndCapture` unchanged) + `savedPrompts` as a `userSt` sync COLLECTION with a shared `PromptSlashMenu` wired into DockAssistant and AgentMode.

**Grounding:** the 2026-07-21 Stream C integration map + the corrected spec section (docs/superpowers/specs/2026-07-20-v0.6-buildout-design.md, Stream C — read it; its grounding-correction notes are binding). Verified line refs @ fd74781: typed-tab ternary `TerminalPanel.jsx:501-507`, tooltip ternary `:383`, `addHomeTab` `useWorkspaceTree.js:88-95`, paneIds exclusion `paneIds.js:26-35` + test `:70-84`, `runAndCapture` `ptyBridge.js:242-257`, `reportBlockDone` `:227-240`, AgentMode target-pane resolution `chrome/ModalHost.jsx:163-171`, `write_store` atomic pattern `commands.rs:73-84`, `get_data_dir` `:39-59`, `list_directory` `:1210-1248`, `safe_filename` exists, snippets precedent `useSnippets.js` + `SnippetsDrawer.jsx` (drawer header says "Workflows"), sync registry `sync/syncState.js:7-11` (collections vs fields semantics per `sync/merge.js:11-51`), Monaco: `monacoSetup.js` + `RemoteEditor.jsx:38-51` lazy pattern, `DockAssistant.jsx:105-112` plain textarea, `AgentMode.jsx:224-229` goal Input.

**Build gates (before EVERY commit, unfiltered):** `npm run build` + `npx vitest run` (baseline 117); Rust-touching tasks also `cd src-tauri && cargo check && cargo test`.

**Safety rails:** forward-only commits; no rebase/reset/force-push; push is pluto-only. **No auto-run ever:** notebook blocks execute ONLY on explicit click; Run All is sequential with stop-on-nonzero-exit; nothing executes on open/load/restore.

---

### Task C-1: Rust notebook IO (narrow, dir-scoped)

**Files:** Modify `src-tauri/src/commands.rs` (+ registration in `src-tauri/src/lib.rs`), tests in-module.

Three commands, ALL scoped to `<get_data_dir>/notebooks/` by RELATIVE name — never an arbitrary path (IPC narrowness rule):

```rust
// ── Notebooks (Stream C) ───────────────────────────────────────────
// (C) Narrow, dir-scoped IO: names are sanitized single-segment filenames under
// <data_dir>/notebooks/ — no separators, no traversal, no arbitrary paths.
// Writes are atomic (tmp+rename, same pattern as write_store).

fn notebooks_dir(app: &AppHandle) -> std::path::PathBuf {
    get_data_dir(app).join("notebooks")
}

// AUDIT-CORRECTED: safe_filename is a MUTATING sanitizer whose allowlist has no
// '.', so validating the whole name against it rejects every legal *.md name.
// Validate the STEM only, then re-append a normalized ".md". Also reject the
// reserved Windows device names (win32-primary app).
const RESERVED_NAMES: [&str; 22] = ["con","prn","aux","nul",
    "com1","com2","com3","com4","com5","com6","com7","com8","com9",
    "lpt1","lpt2","lpt3","lpt4","lpt5","lpt6","lpt7","lpt8","lpt9"];

fn notebook_path(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let lower = name.to_lowercase();
    if name.len() < 4 || !lower.ends_with(".md") {
        return Err("notebook name must end in .md".into());
    }
    let stem = &name[..name.len() - 3];
    let clean = safe_filename(stem);
    if clean.is_empty() || clean != stem {
        return Err("invalid notebook name".into());
    }
    if RESERVED_NAMES.contains(&clean.to_lowercase().as_str()) {
        return Err("reserved name".into());
    }
    Ok(notebooks_dir(app).join(format!("{clean}.md")))
}

#[tauri::command]
pub async fn notebook_list(app: AppHandle) -> Vec<String> { /* create_dir_all; read_dir; .md files only; name-sorted */ }

#[tauri::command]
pub async fn notebook_read(app: AppHandle, name: String) -> Result<String, String> { /* notebook_path; fs::read_to_string; "" if absent is an Err (caller decides) */ }

#[tauri::command]
pub async fn notebook_write(app: AppHandle, name: String, content: String) -> Result<(), String> { /* notebook_path; create_dir_all; tmp write; rename (write_store pattern) */ }
```

(The implementer writes the real bodies. `safe_filename` at `commands.rs:736-746` is confirmed a MUTATING sanitizer with an ASCII-alnum/`_`/`-` allowlist and NO `.` — which is exactly why the gate validates the stem, never the full name. UI rule, Task C-3: the name prompt appends `.md` ITSELF — the user types a stem; the Rust check is the backstop, not the UX. A name that changes under sanitization is rejected, never silently rewritten.)

- [ ] TDD: `#[cfg(test)] mod notebook_io_tests` FIRST (tempdir-based, mirroring `rule_file_tests`' style): list on empty/missing dir → `[]`; write-then-read roundtrip for a LEGAL name (`"notes.md"` — this test alone would have caught the rev-1 gate bug); write is atomic (tmp file gone after; content replaced not appended); traversal names rejected (`"../x.md"`, `"a/b.md"`, `"..\\x.md"`, empty, no-extension, `"a.MD"` accepted case-insensitively but stored as `.md`); reserved names rejected (`"con.md"`, `"NUL.md"`, `"com1.md"`); overwrite works. NOTE: the commands take `AppHandle` — for testability split sync cores (`notebook_*_sync(dir: &Path, ...)`) like `collect_rule_files_sync`, and test the cores (`notebook_path` core takes the dir, not the app).
- [ ] Implement; register all three in `lib.rs`'s `generate_handler!`.
- [ ] Full gates (incl. cargo test) + commit `feat(notebooks): dir-scoped atomic notebook IO commands`.

### Task C-2: `notebookModel.js` (pure block model)

**Files:** Create `src/features/terminals/notebookModel.js` + `notebookModel.test.js`.

Pure functions, no Tauri imports:

- `parseBlocks(md) -> { blocks: [{ index, lang, code, start, end, outputFence: {start, end} | null }], frontmatter: { targetPane? } }` — finds fenced code blocks whose lang is one of `sh|bash|powershell|pwsh|cmd`; associates an IMMEDIATELY-FOLLOWING fence of lang `output` (allowing one blank line between) as that block's owned output; parses a minimal YAML-ish frontmatter (only `targetPane: <id>` — no YAML dependency, a regex on the leading `---` block).
- `writeOutput(md, blockIndex, { output, exit, timestamp }) -> md'` — replaces the block's owned output fence (or inserts one right after the code fence) with:
  ````
  ```output (<timestamp>, exit <exit|timeout>)
  <output — 256*1024 char slice; if sliced, last line is "[...truncated at 256KB]">
  ```
  ````
  NEVER touches anything outside the owned fence range; idempotent (writing the same output twice = byte-identical); user prose and non-runnable fences untouched (pin with tests).
- `setFrontmatterTarget(md, paneId) -> md'` — writes/updates the `targetPane` frontmatter key, creating the frontmatter block if absent.
- `splitRunnableLines(code, lang) -> { lines } | { notRunnable: reason }` — the audit-mandated line-runnability guard + splitter for C-4's per-line execution: drops empties and sh-family `#` comments; returns `notRunnable` when any line ends with `\`, the code contains `<<`, or (sh-family) compound-keyword imbalance (`do`/`done`, `then`/`fi`, `{`/`}` counts) is detected.
- `runBlockLines(lines, runOne) -> { output, exit, timedOut }` — sequential executor over an injected `runOne(line) -> Promise<captureResult>` (fake-able): concatenates outputs (each prefixed `$ <line>` when >1 line), stops at first nonzero/timeout exit.

- [ ] TDD: tests FIRST — parse (mixed doc: prose, runnable + non-runnable fences, nested backticks in prose, existing output fences, output fence NOT owned when a prose paragraph intervenes), writeOutput (replace, insert-after, idempotence, never-touch-prose pinned by full-document equality, the 256KB slice + marker, timeout exit label), frontmatter roundtrip, CRLF tolerance (parse both, write back preserving the document's dominant line ending), PLUS the audit's adversarial set: (a) two runnable blocks back-to-back with no prose between (block 2 must not be mistaken for block 1's output; `block.index` stays correct after a writeOutput insert shifts lines), (b) an output fence immediately after a NON-runnable fence stays untouched, (c) 4-plus-backtick fences parse or are cleanly ignored (never misparse), (d) literal "```output" mid-paragraph is NOT treated as a fence (scanner is line-anchored), (e) output fence at EOF with no trailing newline. And for the new helpers: splitRunnableLines (comments/empties dropped; each notRunnable trigger: trailing backslash, heredoc, do/done imbalance) + runBlockLines with a fake runOne (ordering, prefixing, stop-on-nonzero, stop-on-timeout, single-line no-prefix).
- [ ] Implement; gates; commit `feat(notebooks): pure markdown block model — parse, owned output fences, frontmatter target`.

### Task C-3: `tab.notebook` type plumbing

**Files:** Modify `hooks/useWorkspaceTree.js` (`addNotebookTab`), `paneIds.js` (+ test), `TerminalPanel.jsx` (ternary + tooltip arms), `chrome/MenuBar.jsx` or the home screen (an entry point: "New notebook" — put it in the File menu beside New tab, prompting via the existing `usePrompt()` hook for a name), plus a minimal `NotebookView.jsx` STUB (renders the raw file text read via `notebook_read` in a `<pre>`; full editor is C-4) so the type is end-to-end walkable.

- `addNotebookTab(panelId, name)` mirrors `addHomeTab` (`useWorkspaceTree.js:88-95`): `{ id, label: name, notebook: { name }, cwd: null, startCommands: [] }`.
- `paneIds.js:30`: `if (tab.home || tab.vnc || tab.rdp || tab.notebook) continue;` + extend the exclusion test (`paneIds.test.js:70-84` pattern).
- `TerminalPanel.jsx:501-507`: fourth ternary arm before the TerminalPane fallback: `tab.notebook ? <NotebookView name={tab.notebook.name} tabId={tab.id} visible={tabVisible} /> : ...`; tooltip arm at `:383`: `tab.notebook ? "Notebook" : ...`.
- Session restore: nothing special (NotebookView reads the file on mount — home/vnc/rdp precedent).

- [ ] TDD where testable (paneIds test extension red→green); the rest is wiring gated on build + the C-6 smoke.
- [ ] Gates; commit `feat(notebooks): notebook tab type — mutation, render arm, sweep exclusion, File-menu entry`.

### Task C-4: `NotebookView` editor + Run rail

**Files:** Create `src/features/terminals/NotebookView.jsx` (replaces the C-3 stub); Modify nothing else.

- **Editor:** lazy Monaco exactly per the RemoteEditor pattern (`RemoteEditor.jsx:38-51`): `await import("./monacoSetup.js")` then `@monaco-editor/react`; `language="markdown"`; textarea fallback on load failure. Content state: local string + a `contentRef` mirror (RemoteEditor's `textRef` precedent — all async writers read the ref). Loaded via `notebook_read` on mount; dirty flag; Ctrl+S → `notebook_write`; **debounced autosave (2 s after last edit)** + save-on-unmount (audit warning: fire-and-forget unmount saves are the exact pattern the v0.1.29 scrollback fix retired because tray→Quit kills the process before the invoke lands — the debounce bounds the exposure to ≤2 s of edits; the residual hard-quit gap is DOCUMENTED in the changelog, not silent).
- **Open-dedupe (audit warning):** the open flow reuses the `focusOrAddHomeTab` pattern (`useWorkspaceTree.js:99-109`): if a tab with `tab.notebook?.name === name` exists in any panel, focus it instead of minting a duplicate (two live views of one file = last-writer-wins clobber).
- **Missing-file semantics (audit warning):** creation flow passes `isNew: true` → template seed. A RESTORED tab whose `notebook_read` errs shows an empty editor + a warning banner ("notebook file not found — it may have been moved or deleted"), NEVER a silent template reseed over a file that used to have content.
- **Run rail:** a slim right-hand rail listing `parseBlocks()` results (lang + first line of code + Run button + the owned output's exit badge if present). NO Monaco glyph-margin widgets (API risk; the rail is the v1 surface). Buttons disabled while a run is in flight (one at a time).
- **Run flow:** resolve target pane: frontmatter `targetPane` if that pane id is in `getLiveTabIds()` (import from ptyBridge), else `activeTab?.activePaneId || activeTabId` — passed down as a `defaultTargetId` prop from TerminalPanel? NO — TerminalPanel doesn't know it; simplest correct: NotebookView receives nothing and computes nothing global — it gets `defaultTargetId` via a small prop added at the ternary arm (`TerminalPanel` has `panel` but not the active-tab resolution...). DECISION (keep it simple and honest): the rail has an explicit target-pane dropdown fed by `getLiveTabIds()` (ptyBridge), defaulting to the frontmatter value when live, else the first live id; the picker writes back to frontmatter via `setFrontmatterTarget` on change. No hidden global resolution.
- Execute — AUDIT-CORRECTED (the rev-1 "send as-is" premise was false: without bracketed paste, every embedded newline submits its line as a SEPARATE command with its own OSC PlutoCmd, so a whole-block `runAndCapture` NEVER correlates and every multi-line Run would hang to the 120 s timeout). v1 semantics, implemented in a pure helper `runBlockLines` in `notebookModel.js` (unit-tested with a fake runAndCapture):
  1. Split `block.code` into lines; drop empty lines and (for sh-family langs) pure-`#` comment lines.
  2. **Line-runnability guard:** if ANY line ends with `\`, or the block contains `<<` (heredoc), or the lang is sh-family and the block contains an unterminated compound keyword (a lone `do`, `then`, `{` opener heuristic: count `do`/`done`, `then`/`fi`, `{`/`}` imbalance), the block is NOT line-runnable: the rail shows an explicit "multi-line construct — not runnable in v1" disabled state. No silent hang, ever.
  3. Otherwise run each line SEQUENTIALLY via `runAndCapture(targetId, line)` (unchanged ptyBridge; exact per-line correlation; cd/env continuity preserved because it is the same live pane). Concatenate outputs in order (each prefixed by `$ <line>` when the block has >1 line). Stop at the first nonzero/timeout exit; that becomes the block's exit.
  4. Single-line blocks behave exactly as before: one capture, no prefix.
  Then write the fence via a LATEST-CONTENT REF (audit warning: `setContent(writeOutput(contentRef.current, ...))` — the run can take minutes; closing over the render-time `content` would clobber edits made during the run; mirror RemoteEditor's `textRef` pattern) with `{ output, exit: timedOut ? "timeout" : exit, timestamp }` + mark dirty. **Run All:** sequential for-of; stop when a block's exit is nonzero/timeout; progress in the rail; skips not-line-runnable blocks with a visible "skipped" state.
- Empty/new notebook: `notebook_read` Err → seed with a template (title + one example block + a comment that output fences are overwritten on rerun).

- [ ] Gates (no unit tests for the component — model/IO layers carry the coverage; C-6 smoke is the UI net); commit `feat(notebooks): NotebookView — lazy Monaco editor, run rail, capture-to-fence`.

### Task C-5: Saved Prompts

**Files:** Modify `sync/syncState.js` (+ `syncState.test.js`), `hooks/useSnippets.js` or a new `hooks/useSavedPrompts.js` (mirror the snippets hook against `userSt.savedPrompts`), `SnippetsDrawer.jsx` (a "Prompts" section: same grammar — list, search shares the existing filter box, add-form name+body+tags, delete; NO variable-fill machinery), Create `src/features/terminals/PromptSlashMenu.jsx` (shared), Modify `DockAssistant.jsx` + `AgentMode.jsx` (wire the menu over their inputs).

- **Sync:** `syncState.js:8` userSt entry gains `collections: ["customThemes", "savedPrompts"]` (COLLECTION — per-item merge; NOT a field). Test: extend the positive lock test (agent-fields pattern) asserting `savedPrompts` in the userSt COLLECTIONS and NOT in fields.
- **Data:** `{ id, name, body, tags: [] }`; `useSavedPrompts({ userSt, saveUser })` with add/update/remove via functional `saveUser`.
- **PromptSlashMenu:** props `{ prompts, inputValue, onInsert }` — renders a floating list when `inputValue` starts with `/` (filter = fuzzy on name/tags via simple includes-scoring; ArrowUp/Down + Enter select; Escape closes; selection calls `onInsert(prompt.body)` which replaces the input value AND explicitly closes the menu — audit note: a body that itself starts with "/" must not re-open it; open-state is not purely derived). Pure-ish component; unit-testable pieces exported separately (`filterPrompts(prompts, query)` + a keyboard-decision helper `menuKeyAction(key, menuOpen) -> "select"|"close"|"passthrough"`) with tests — including the audit-mandated case pinning that Enter with the menu OPEN selects (and does NOT reach the host input's Enter-to-send: the host's onKeyDown consults the helper before firing send/start; DockAssistant.jsx:108 and AgentMode.jsx:226 are the two guarded sites).
- **Wiring:** DockAssistant textarea + AgentMode goal Input each render the menu when their local value starts with `/` and prompts exist. Keyboard guard per the helper above; Enter-to-send unchanged when the menu is closed.

- [ ] TDD: syncState lock test + `filterPrompts` tests red→green; gates; commit `feat(prompts): saved prompts library — synced collection, drawer section, slash-menu inserts`.

### Task C-6: Stream gate

- [ ] Full gates everywhere (npm + vitest + cargo check + cargo test); report counts.
- [ ] CHANGELOG Unreleased additions (notebooks + saved prompts bullets, no overclaim — no auto-run, outputs owned-fence-only, prompts per-item sync).
- [ ] Whole-stream review (code-reviewer over the C diff): end-to-end trace (create notebook → run block → output fence → save → close → reopen → rerun), security lens (dir-scope traversal attempts on the Rust commands; no execution path without a click; the slash menu can't fire prompts as commands), seams (paneIds exclusion complete, registry untouched by notebook tabs, sync merge semantics). Fix findings; re-review every fix.
- [ ] Manual smoke list for pluto (appended to the report): create/edit/save/reopen a notebook; Run writes an output fence + rerun overwrites it; Run All stops on failure; target-pane picker; 256KB truncation marker on a huge output (`yes | head -c 400000` style); prompts: add/edit/delete, `/` menu in Assistant + Agent inputs, sync round-trip if two machines available.
