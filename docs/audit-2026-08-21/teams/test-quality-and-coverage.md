<!-- (C) -->
# Test quality and coverage

Audit of plutos-terminals @ `731afc5`, 2026-08-21.

## Summary

The suite is better than its size suggests: 449 vitest + 174 cargo tests, none skipped, none `.only`'d, nothing excluded by the vitest include glob (all 45 files under `src/` match and all 45 collect), and the notebook-write serialization, secret-scan, sync-merge, activity-store and render-containment files assert on real behaviour with self-aware comments about the vacuous drafts they replaced. The debt is not breadth, it is that the highest-stakes fixes are guarded by tests that test something other than the fix. Three tests assert on code the test file wrote itself or on a hand-copied duplicate of the production predicate, and two of those three are named after security/correctness guards they never touch. Below that sit the genuinely uncovered surfaces: the 104-command IPC boundary (88 commands named in no test on either side; only 2 of 45 vitest files mock `@backend` at all), the 564-line workspace reducer, the 2,185-line TerminalPane where the H1 provenance gate and the double-spawn latch both live, and the shell-vs-natural-language classifier that decides whether typed text is executed verbatim in a live terminal.

## Verified sound (12)

- No skipped, .only'd or .todo tests anywhere in the suite , grep for .skip/.only/.todo/xit/xdescribe across all 45 test files returns one false positive (a string literal inside a secretScan.test.js fixture at :49).
- The vitest include glob excludes nothing: `src/**/*.test.js` + `src/**/*.test.jsx` (vitest.config.js:19) matches all 45 test files on disk, and `npx vitest run` collects all 45 / 449 tests. No stray test file lives outside `src/`.
- CI actually runs both suites and gates on them (.github/workflows/test.yml: `npx vitest run` on ubuntu, `cargo test` on windows, push to all branches) , the 8/14 gap where nothing in CI ran the suites is closed.
- No test in the suite has zero assertions. I parsed all 436 top-level test/it blocks; the minimum is 1 expect() and none assert merely that a mock was called.
- The JS↔Rust argument contract is currently correct. I diffed all 163 `invoke()` call sites against the 104 Rust command signatures: every command name resolves, and every required (non-Option, non-AppHandle/State) parameter is supplied with the right camelCase key. It is unpinned, but not currently broken.
- mcp_install's shell-metacharacter guard is tested correctly , `mcp_install_guard_tests` (commands.rs:590) does `use super::first_shell_metachar_arg`, exercises the real function, and the `parens_and_bang_are_intentionally_allowed` test at :607 deliberately pins a rationale so a well-meaning tightening gets review. This is the pattern the check_command_version test should have followed.
- `reserved_names_match_js_mirror` (commands.rs:2801) is exemplary: it `include_str!`s notebookIo.js, parses the RESERVED_NAMES literal, fails loudly if the literal's shape changes, and pins set equality across the language boundary , a real cross-language duplicate guarded properly.
- The path-traversal validation shared by transcripts and in-flight recordings is genuinely covered: `recording_inflight_file` (commands.rs:1476) delegates to `transcript_name_valid`, which is tested by traversal_name_rejected, name_with_dotdot_rejected, invalid_calendar_date_rejected and reserved_device_names_rejected.
- notebookIo.test.js's write-serialization tests (:104-156) are real concurrency tests, not mock-shape assertions , they hold promises open, assert what is in flight at each step, and cover the failed-predecessor and different-name cases.
- renderContainment.test.jsx is unusually honest: its comments at :41-44 and :80-83 document the vacuous first drafts (reusing the same panels reference, minting fresh mocks per rerender) and the tests are written to defeat exactly those.
- activityStore's subscription containment is verified by real render counting (renderContainment.test.jsx:140-158), not by inspecting internals , a genuine behavioural test of the per-panel subscription boundary.
- The pure crypto surfaces are round-tripped rather than snapshot-pinned: sync/crypto.test.js and masterPassword.test.js each assert encrypt/decrypt round-trip, wrong-passphrase rejection, and fresh salt/IV per call.

## Findings (10)

### HIGH TQ-1, check_command_version's allowlist test asserts on a hand-copied duplicate, not the production guard

`src-tauri/src/commands.rs:558`

**What.** `mod check_command_version_guard_tests` (commands.rs:554-587) defines its own private `fn accepted(name: &str) -> bool` at :558-562 and all three of its tests call that local copy. Its own comment says so: "Mirrors the predicate in check_command_version." The production predicate is inline in the command body at commands.rs:704-709 (`if name.is_empty() || name.len() > 32 || !name.chars().all(...) { return None; }`). Grepping the whole file, `check_command_version` appears only at :554 (mod name), :557 (that comment), :697 (definition), :716, :722 , no test ever calls it or `check_command_version_sync`. The test module and the guard share zero code. The comment at :555-557 states the stakes correctly: the Windows branch at commands.rs:726-732 routes `name` into `silent_command("cmd").arg("/c").arg(name)`, so the allowlist is a security boundary. Contrast the sibling `mcp_install_guard_tests` at :590, which does it right (`use super::first_shell_metachar_arg`), and `reserved_names_match_js_mirror` at :2801, which goes as far as `include_str!`-parsing the JS source to pin a cross-language duplicate , the codebase demonstrably knows this failure mode.

**Failure.** A future edit widens or deletes the guard at commands.rs:704-709 (e.g. someone adds `.` to the allowed set so `claude.cmd` can be probed directly, or drops the block while refactoring the command into a `_sync` helper). `cargo test` stays 174/174 green and CI's rust job passes, because the three tests are still exercising the untouched copy at :558. On Windows, `invoke("check_command_version", {name: "npm&calc"})` from the webview then spawns `cmd /c npm&calc --version`, executing `calc` , the exact RCE class the guard exists to close, shipped with a green suite named after it.

**Fix.** Make the predicate a real function (`fn command_name_allowed(name: &str) -> bool`), call it from commands.rs:704, and change the test module to `use super::command_name_allowed;`. Delete the local `accepted`. The existing three test bodies then become load-bearing unchanged.

### HIGH TQ-2, The OSC-1337 provenance gate (audit H1) has zero coverage; the only test named for H1 covers the emitter half

`src/features/terminals/TerminalPane.jsx:1105`

**What.** The H1 fix has two halves. The emitter half is extracted and tested: `shellIntegration.test.js` (3 tests, titled "shell-integration OSC-1337 nonce (audit H1)") asserts `buildPosixShellInit(nonce)` and `buildPowerShellInit(nonce)` bake the nonce into the emitted hook. The enforcement half , the part that actually decides what enters trusted history , is inline in the `registerOscHandler(1337, ...)` closure at TerminalPane.jsx:1102-1105: `const payload = data.slice("PlutoCmd=".length); const sep = payload.indexOf(":"); const reportNonce = sep >= 0 ? payload.slice(0, sep) : ""; if (!entry.oscNonce || reportNonce !== entry.oscNonce) return true;`. No test file imports TerminalPane.jsx , grep across all 45 test files returns only comments mentioning it. Downstream is untested too: `recordCommand` (ptyBridge.js:131) is called from TerminalPane.jsx:1110 and :1980, and ptyBridge.test.js's 10 tests cover only `runAndCapture` and the two-channel version surface (titles at ptyBridge.test.js:27-123), never the history write.

**Failure.** The nonce comparison at TerminalPane.jsx:1105 is weakened or dropped during a refactor of that 2,185-line file , e.g. reduced to `if (!entry.oscNonce) return true;`, or the `sep` split is changed so a colon-free payload no longer yields the empty-string reject. All 449 vitest tests stay green, including all three "audit H1" tests. A compromised or hostile SSH host then `printf`s `ESC]1337;PlutoCmd=<base64>BEL` inside otherwise-ordinary output; the screen shows nothing unusual, but the attacker's string is written into persistent, cross-session, one-click-re-runnable command history , the original H1 attack, silently reopened.

**Fix.** Extract the gate as a pure function (`parsePlutoCmdReport(data, sessionNonce) -> {cmd} | null`) alongside the existing `shellIntegration.js` builders and unit-test it: matching nonce accepts, wrong nonce rejects, absent nonce rejects, no-colon payload rejects, and a round-trip against `buildPosixShellInit(n)`'s own emitted format so emitter and verifier are pinned to each other.

### HIGH TQ-3, Both tests named for the startSpawn double-spawn latch assert on a copy of the latch written inside the test file

`src/features/terminals/paneRegistry.test.js:49`

**What.** paneRegistry.test.js:42-58 is titled "startSpawn latch: state transition is the once-latch (P4-T5)". Its body does `const e = R.ensureEntry("p-latch")` then immediately assigns its own implementation at :49-53 (`e.startSpawn = () => { if (e.spawnState !== "unspawned") return; e.spawnState = "starting"; fired++; }`), calls it three times, and asserts `fired === 1`. The comment at :46 admits it: "Mirror TerminalPane's wiring: the guard IS the spawnState check." paneRegistry.js:88 sets `startSpawn: null` and never implements it , the module under test contributes only an object with a `spawnState` string. This test would pass identically if paneRegistry.js's `ensureEntry` returned a bare `{spawnState:"unspawned"}`. trickle.test.js:8-16 does the same thing in `mkEntry`, and trickle.test.js:62 ("Latch held: nothing ever fired twice") asserts on that same fake. The real latch is TerminalPane.jsx:1254-1257, where `entry.spawnState = "starting"` is set synchronously before the `(async () => { ... })()` body , the comment at :1246-1251 explains that the synchronous flip is precisely what makes the first caller win. Two independent callers exist: TerminalPane.jsx:1833 (`if (visible) entry.startSpawn()`) and trickle.js:18 (`e.startSpawn?.()`).

**Failure.** A refactor moves the `entry.spawnState = "starting"` assignment inside the async IIFE at TerminalPane.jsx:1257 (a natural-looking tidy-up, since everything else in the function lives there) so the flip now happens after the first `await replayScrollback()`. A restored hidden pane that is revealed in the same frame the trickle tick reaches it then passes the `!== "unspawned"` check twice and spawns two PTYs for one pane: two shell children, two reader threads, both appending to the same scrollback file under that pane id, and only one of them tracked for `pty_kill`. Both paneRegistry.test.js:42 and trickle.test.js:37 stay green because neither ever executes TerminalPane's latch.

**Fix.** Hoist the latch into paneRegistry.js (e.g. `entry.requestSpawn(fn)` that owns the unspawned→starting transition and calls `fn` at most once), have TerminalPane.jsx:1254 register only the spawn body, and rewrite paneRegistry.test.js:42 to call the registry's own latch instead of assigning one. trickle.test.js's `mkEntry` should then use the real entry factory.

### MEDIUM TQ-4, classifyInput decides whether typed text is executed verbatim in the live terminal and has no tests at all

`src/features/terminals/inputClassify.js:43`

**What.** `classifyInput(text)` (inputClassify.js:43-78) returns `{kind:"command"|"nl"}` from ~8 interacting heuristics: a shell-metacharacter regex (:51), a flag regex (:52), a path-prefix regex (:53), an assignment regex (:54), a PowerShell verb-noun regex (:55), a 130-entry `KNOWN_CMDS` set (:9-28), a 20-entry `AMBIGUOUS` overlay (:32-35), and a word-count tiebreak (:68, :72, :77). AskBar.jsx:78-83 consumes it: `const looksCommand = cls.kind === "command"` and `if (looksCommand) runDirect(); else generate();`, where `runDirect` (AskBar.jsx:74) is `onRun(intent.trim())` , the raw typed text sent straight to the active terminal. Grep across all 45 test files for `inputClassify` or `classifyInput` returns 0 hits. There is no test file for it, and no other test imports it.

**Failure.** Any edit to the heuristics flips the default the wrong way with nothing to catch it. Concretely: adding `"delete"`, `"remove"`, `"list"` or `"install"` to `KNOWN_CMDS` (:9) without also adding them to `AMBIGUOUS` (:32) makes `classifyInput("delete every log file older than a week")` return `{kind:"command", confidence:"high"}` at :64. The Ask-AI bar then labels it "● command · Enter runs it as-is" and Enter executes that English sentence verbatim in the user's active shell instead of asking the model to write a command. All 449 tests stay green. The inverse regression (loosening `AMBIGUOUS` so `git status` routes to the LLM) is equally invisible.

**Fix.** Add `inputClassify.test.js` with a table of ~30 pinned pairs covering each branch: hard shell-syntax signals, each ambiguous verb bare vs wordy (`find` vs `find files over 100MB`), known-command first tokens, single-token command shapes, and multi-word English. The function is pure and free of imports, so this is a cheap, high-leverage file.

### MEDIUM TQ-5, 88 of 104 IPC commands are named in no test on either side; 22 sit in Rust files with no test module at all

`src-tauri/src/lib.rs:270`

**What.** I built a manifest from the 104 `#[tauri::command]` fns registered in `generate_handler!` (lib.rs:270-375) and cross-referenced both sides. Rust: 13 commands are referenced by name inside any `#[cfg(test)]` module. JS: exactly 5 command-name strings appear anywhere in the 45 vitest files (`collect_rule_files`, `git_branch_status`, `list_directory`, `read_npm_scripts`, `recording_checkpoint`), and only 2 of 45 files mock `@backend` at all (notebookIo.test.js, recording.test.js). 88 commands appear in neither. 22 of those live in files that contain no `#[cfg(test)]` block whatsoever: sshconfig.rs (4), vault.rs (4), forward.rs (4), vncclient.rs (4), mcp/manager.rs (6). The commands.rs pattern of splitting a `_sync`/pure helper out for testing (`scrollback_tail`, `transcript_read_all_capped`, `notebook_write_sync`, `git_branch_status_sync`) is not applied in those files , e.g. `parse_ssh_config` (sshconfig.rs:114) reads `local_home()/.ssh/config` and then inlines its whole 50-line block-parsing state machine at :144-193, so no test can reach the parser without touching the developer's real home directory. On the argument-shape side I diffed all 163 JS `invoke()` call sites against the Rust signatures and found no mismatches, so the contract is currently correct , it is just unpinned.

**Failure.** Rename a Rust parameter (`tab_id` -> `session_id`), change a serde field, or flip a return from `Option<T>` to `Result<T, String>` in any of the 88, and both suites stay green and CI passes; the break surfaces only when a human manually opens that feature. `parse_ssh_config` is the sharpest case: a change to `ssh_split_kv` quoting (sshconfig.rs:36-49) or the `Match`/wildcard skip at :161 silently drops or mis-populates hosts in the Sessions tree, with no test and no scanner able to see it.

**Fix.** Two cheap steps that cover most of it. (1) Extract the pure cores in the five zero-test files the way commands.rs already does , `parse_ssh_config_lines(&[String]) -> Vec<SshHostEntry>` is a 10-minute change that makes a 50-line state machine testable. (2) Generate the command manifest from `generate_handler!` at test time and assert every JS `invoke("name", ...)` string resolves to a registered command with matching arg names; that single test pins all 104 names and the 163 call sites against rename drift.

### MEDIUM TQ-6, useWindowTitle.test.js asserts only the half of the M8 fix that was never broken

`src/features/terminals/hooks/useWindowTitle.test.js:24`

**What.** The M8 fix is the serializer at independentEffects.js:92-111: module-level `titleInFlight`/`titlePending`, and `applyNativeTitle` draining the latest pending title in a `while (titlePending !== null)` loop so out-of-order native `setTitle` completions cannot leave a stale OS titlebar. `useWindowTitle` (:112-118) calls `document.title = title` and then `applyNativeTitle(title)`. The test at useWindowTitle.test.js:24-34 renders the hook and asserts `document.title` three times. It never observes `applyNativeTitle`, never mocks `@tauri-apps/api/window`, and never asserts a call count or ordering. The 2026-08-14 audit's own M8 text says "document.title is fine" , the test asserts exactly the branch that was already correct.

**Failure.** Delete lines 92-111 entirely and replace the body of `applyNativeTitle` with a bare fire-and-forget `getCurrentWindow().setTitle(title)`, and all 4 tests in the file pass, along with the other 445. M8 is then live again: fast Ctrl+Tab through several tabs under variable IPC latency leaves the OS titlebar, taskbar entry and alt-tab label on a tab the user is no longer on, while the in-window `document.title` reads correctly , the exact split that made the bug hard to notice the first time.

**Fix.** Export `applyNativeTitle`'s injection seam (or accept a `setTitle` function parameter), then assert the serialization directly: fire three rapid title changes against a deferred fake `setTitle`, resolve them out of order, and assert the final applied title is the newest and that at most one call was in flight at a time.

### MEDIUM TQ-7, splitTree.removeLeaf and setRatio are untested; they are the pane-close and divider-drag paths

`src/features/terminals/splitTree.js:58`

**What.** splitTree.js exports 8 functions. Tests import 4 of them: paneIds.test.js:4 takes `getLayout, leafIds`; paneNav.test.js:4 takes `equalizeRatios, splitLeaf`. Grep for `removeLeaf` or `setRatio` across all test files returns 0 hits. `removeLeaf` (splitTree.js:58-66) is the sole consumer for closing a split pane: useWorkspaceTree.js:439 (`const next = removeLeaf(layout, paneId)`), whose result at :440-447 decides the surviving `activePaneId` and the persisted layout. `setRatio` (:75-83) backs `setPaneRatio` at useWorkspaceTree.js:475, the divider drag. The collapse logic at :63-64 (`if (a === null) return b; if (b === null) return a;`) is the load-bearing line and is order-sensitive.

**Failure.** Swap the two lines at splitTree.js:63-64, or change :60 to `node.id !== targetId ? null : node`, and every test still passes. Closing the right-hand pane of a 2-way split then collapses to the wrong sibling: the persisted layout keeps the id of the pane the user just closed and drops the id of the one they kept. On the next render `allRenderedPaneIds` (paneIds.js) no longer lists the surviving pane, the registry sweep calls `destroyEntry` on it, and the user's live shell , including an in-flight SSH session , is killed while a dead pane id stays in the tree.

**Fix.** Add removeLeaf/setRatio cases to paneNav.test.js using the existing `row`/`col`/`L` fixture helpers at :7-9: remove the a-side and the b-side of a row, remove a leaf from a nested 2x2, remove the last leaf (expect null), remove an unknown id (expect the tree unchanged by identity), and setRatio on a nested split id leaving siblings untouched and the input unmutated.

### MEDIUM TQ-8, useWorkspaceTree.js , the entire 564-line workspace reducer , has zero tests; only its one extracted helper is covered

`src/features/terminals/hooks/useWorkspaceTree.js:24`

**What.** Every panel/tab/pane mutation lives here: `closePanel`, `addTab`, `addNotebookTab`, `closeTab` (:161-201), `closeTabs` (:203-212), `reopenTab` (:214-231), `switchTab`, `moveTab`, `detachTab`, `closePane` (:428-451), `setPaneRatio` (:466). Grep for `useWorkspaceTree` in test files returns 2 hits, both comments (renderContainment.test.jsx:43, workspaceModel.test.js header). The one piece that was extracted for testability, `removeTabsFromWorkspace`, has a good 6-test file , which makes the contrast the point: `closeTab` reimplements the same survivor-selection math inline at :180-191 (`const nextIdx = Math.min(idx, tabs.length - 1); activeTabId = tabs[nextIdx].id;`) and that copy is untested. The recently-closed stack at :175-178 (12-entry cap, SSH-password stash via `getTabPassword`) and its restore at :217-218 (`setTabPassword`) are likewise untested. renderContainment.test.jsx does render `useSessionDispatch` and `useProjects`, but only compares returned callback identities across rerenders (:104-106, :124-125) , it never invokes a single handler, so the bodies of those hooks are also unexecuted by any test.

**Failure.** Change `Math.min(idx, tabs.length - 1)` at :186 to `idx` and closing the last tab in a panel throws `Cannot read properties of undefined (reading 'id')` inside the reducer, which the single App-level ErrorBoundary catches by calling `destroyAll()` , every live PTY, SSH session and in-flight SFTP transfer in the window dies. Or drop the `password: getTabPassword(tabId)` stash at :178 and Ctrl+Shift+T silently reopens a passworded SSH tab that can no longer authenticate. Both ship green.

**Fix.** The hook already reads everything through `stateRef.current` and writes through an injected `persist`, so it renders under `renderHook` with a fake `persist`/`toast` and no DOM. Add a `useWorkspaceTree.test.jsx` that drives the real callbacks and asserts the persisted tree: close the active middle tab, close the last tab in a panel, close the last panel, reopen into a vanished panel, and close one pane of a 3-way split.

### MEDIUM TQ-9, spawnEnv.js was extracted expressly so the API-key-to-shell-env mapping could be tested, and never was

`src/features/terminals/spawnEnv.js:19`

**What.** The file header (:1-18) states its purpose: "Pure environment-resolution transform for spawned shells... This is the side-effect-free part of env resolution", with `envForModel` taken as a parameter specifically to keep it dependency-free. `resolveEnvFromUserState` (:19-40) implements the precedence rule that matters , the legacy `anthropicKey` fallback at :27-31, then the active-model override at :35-38 that `Object.assign`s the selected provider's env on top. It is called from TerminalPane.jsx's spawn body (around :1280) to build the env of every shell the app starts. Grep for `spawnEnv` or `resolveEnvFromUserState` across all 45 test files: 0 hits. `providers.js` (231 lines, including `envForModel` itself) is likewise referenced by no test.

**Failure.** Two silent regressions, both green. (1) Invert the guard at :36 (drop the `keys[am.providerId].length > 0` check) and selecting a provider whose key was never entered `Object.assign`s an empty/undefined key over `ANTHROPIC_API_KEY`, so every newly spawned tab's `claude` CLI is unauthenticated with no error path back to the user. (2) Move the `defaultAnthropic` block after the `Object.assign` and the Anthropic key overwrites the user's chosen provider's env, sending prompts to the wrong endpoint with the wrong key.

**Fix.** Add `spawnEnv.test.js` with a stub `envForModel`: empty/null user state returns `{}`; `providerKeys.anthropic` wins over legacy `anthropicKey`; an active model with a present key overrides `ANTHROPIC_API_KEY`; an active model with a missing or empty key leaves the default intact; `providerBaseUrls` is threaded through. Five assertions, no mocks needed.

### LOW TQ-10, safeParse.js , the shared corrupt-blob guard added for audit L2 , has no tests

`src/features/terminals/safeParse.js:8`

**What.** safeParse.js was written to centralize corrupt-localStorage handling (header at :1-7 cites audit L2) and carries two behaviours worth pinning: `onCorrupt` is invoked with `(e, raw)` and is itself wrapped so it can never throw (:13, `try { onCorrupt?.(e, raw); } catch {}`), and `loadJSON` (:22-27) guards the localStorage *access* as well as the parse, because module-load callers such as ptyBridge's history would otherwise ReferenceError under node. Grep for `safeParse` or `loadJSON` in test files: 0 hits. The corrupt-handling behaviour this module exists to make uniform is therefore unverified everywhere it is used.

**Failure.** Drop the inner try/catch at :13 and a consumer whose `onCorrupt` throws (a toast helper called before the toast provider mounts) turns a recoverable corrupt-blob read into an uncaught exception at module load , a blank window on boot, the v0.1.3 failure shape. Or drop the `typeof localStorage !== "undefined"` guard at :25 and every test that transitively imports ptyBridge fails to collect. Neither is currently detectable by the suite.

**Fix.** Six-line test file: valid JSON parses; null/empty string returns the fallback without calling `onCorrupt`; malformed JSON returns the fallback and calls `onCorrupt` once with the raw string; a throwing `onCorrupt` still returns the fallback; `loadJSON` returns the fallback when `localStorage` is absent.

