<!-- (C) -->
# Phase 0: deterministic baseline (2026-08-21, HEAD `731afc5`)

Machine output captured **before** any agent looked at the code, on purpose. A
scanner result is evidence; an agent's opinion about a scanner result is not.
Everything here is raw. Interpretation lives in the team reports and the verdict
doc.

Four of these tools had **never been run against this repo**. That is the headline:
the codebase shipped ~30,000 lines of JSX with no linter, no type system, and no
JS static analysis of any kind.

## What was installed

| Tool | Version | State before today |
|---|---|---|
| ESLint 9 + react + react-hooks + jsx-a11y | 9.39.5 | **never installed** |
| knip | latest via npx | **never run** |
| Semgrep (local CLI, `pipx`) | 1.174.0 | **never run** |
| cargo-deny | 0.20.2 | **never run** |
| cargo clippy | bundled | installed, **never gated in CI** |
| cargo-audit | installed | already gated in CI |

Semgrep runs from the **local** CLI over Bash. Claude Code's default Semgrep
plugin routes scans through Semgrep's hosted server, which would mean shipping a
proprietary codebase off-machine. Rules are downloaded; source is not uploaded.
`--metrics=off`.

## Results

### ESLint: 279 errors, 56 warnings across 196 files

First run in the project's life. By rule:

| Count | Rule | Class |
|---|---|---|
| 51 | `jsx-a11y/no-static-element-interactions` | accessibility |
| 49 | `react-hooks/refs` | correctness |
| 39 | `jsx-a11y/click-events-have-key-events` | accessibility |
| 32 | `react-hooks/set-state-in-effect` | correctness |
| 31 | `no-empty` | correctness |
| 27 | `react/no-unescaped-entities` | correctness |
| 25 | `jsx-a11y/label-has-associated-control` | accessibility |
| 23 | `no-unused-vars` (warn) | hygiene |
| 18 | `react-hooks/exhaustive-deps` (warn) | correctness |
| 10 | `require-atomic-updates` (warn) | **race conditions** |
| 8 | `jsx-a11y/no-autofocus` | accessibility |
| 3 | `react-hooks/rules-of-hooks` | **correctness, error class** |
| 2 | `jsx-a11y/mouse-events-have-key-events` | accessibility |
| 2 | `jsx-a11y/no-noninteractive-tabindex` | accessibility |
| 1 each | `react-hooks/immutability`, `react-hooks/use-memo`, `jsx-a11y/interactive-supports-focus`, `jsx-a11y/no-noninteractive-element-interactions` | mixed |

~129 of the 279 errors are accessibility. The rest are correctness.

Highest-value individual hits, for the teams to confirm or refute:

- `src/features/terminals/ModelPicker.jsx:148,160,163` `rules-of-hooks`: hook
  called inside a callback.
- `src/App.jsx:281` `react-hooks/immutability`: `userStRef` mutated after being
  passed to a hook.
- `src/features/terminals/hooks/useTabTelemetry.js:19`: the `useMemo` dep list is not
  an array literal.
- `require-atomic-updates` at `NotebookView.jsx:230,240,428`,
  `ProjectSidebar.jsx:192,242`, `PromptEditor.jsx:23`, `TerminalPane.jsx:20,44`,
  `hooks/independentEffects.js:109`, `sync/syncEngine.js:117`. This is the
  read-then-write-after-await race class the repo's own `CLAUDE.md` calls its
  recurring footgun.

Also notable: the codebase already contains `eslint-disable-next-line
react-hooks/exhaustive-deps` comments (e.g. `TerminalPane.jsx:2003`,
`hooks/usePromptSlashMenu.js:48`, `hooks/useTabTelemetry.js:18`) written by
someone who never had ESLint installed to check them. Two of them are now reported
as **unused directives**, meaning they were suppressing nothing.

### cargo clippy: 3 default warnings, 460 under pedantic+nursery

Default clippy is effectively clean: `commands.rs:316` single-char `push_str`,
`commands.rs:468` needless borrow, `llm_tools.rs:216` identical if-blocks. **Three
fixes away from being gateable at `-D warnings`.**

Pedantic/nursery census (top signal, ignoring pure style):

| Count | Lint | Why it matters here |
|---|---|---|
| 17 | `significant_drop_tightening` | Mutex guards held longer than needed. Same class as the disk-mutex hang fixed on 8/14. |
| 14 | `cast_possible_truncation` | See below. |
| 15 | `cast_lossless` | mostly benign |
| 94 | `needless_pass_by_value` | style |
| 77 | `doc_markdown` | style |

Truncating casts worth a human look: `companion.rs:626,630` (u64 → u16),
`rdp.rs:378-381` (usize → u16, and RDP parses data from a remote server),
`netools.rs:198` (u128 → u32), `pty.rs:607` (u64 → usize).

### Semgrep: 31 findings, 297 rules, 408 files

| Count | Rule | Severity |
|---|---|---|
| 15 | `temp-dir` (Rust) | INFO |
| 10 | `github-actions-mutable-action-tag` | **HIGH** |
| 3 | `dependabot-missing-cooldown` | HIGH/MEDIUM |
| 2 | secret detection | ERROR |
| 1 | `current-exe` | INFO |

The 10 mutable-action-tag hits are all in **`.github/workflows/audit.yml`** (lines
33, 34, 48, 49, 51) and **`.github/workflows/test.yml`** (17, 18, 27, 28, 29). The
vault security backlog records "Release GitHub Actions pinned to commit SHAs" as
DONE. That pinning covered `release.yml` only. Two workflows still resolve
mutable tags.

The 2 secret detections are the previously-triaged test fixtures
(`agentContext.test.js:248`, `secretScan.test.js:26`), already allowlisted against
GitHub push protection as sequential-alphabet placeholders.

7 parse warnings, all in `.specify/` scaffolding scripts. Not app code.

### knip: 24 issues

Mostly explained by the build model and not real dead code:
`src-tauri/companion-web/*` is `include_str!`'d into the Rust binary,
`public/boot.js` is loaded by `index.html`, `.claude/hooks/*.mjs` are Claude Code
hooks, `src-tauri/tests/fixtures/mock_mcp_server.mjs` is spawned by a cargo test.

Genuinely worth a look:

- `src/features/terminals/themes.js` is reported as an unused **file**.
- `src/features/terminals/safeParse.js` exports `safeParse`, reported **unused**.
  The 8/14 L2 fix created this helper to close the silent-reset-on-parse-failure
  class. If it has no callers, that class was not actually closed.
- `src/features/terminals/icons.jsx` has 17 unused icon exports.
- `PromptEditor.jsx` imports `@lezer/highlight`, which is **unlisted** in
  `package.json` (works only because it is a transitive dep of CodeMirror).
- Unused exports in `ptyBridge.js` (`getTabDims`, `getBroadcastTargets`),
  `secretVault.js` (`isLoaded`, `loadSecretKeys`), `storageKeys.js`
  (`ALL_STORAGE_PREFIXES`), `masterPassword.js` (`clearUnlocked`),
  `headerSkins.js` (4).

### cargo-audit: 5 vulnerabilities, 27 warnings

The 5 vulnerabilities are exactly the 4 IDs the CI job already ignores with written
reasons (`RUSTSEC-2026-0194`/`-0195` quick-xml, `-0235` rkyv, `RUSTSEC-2023-0071`
rsa ×2). **The CI ignore list is honest and complete.**

The warnings are the part nothing gates, because cargo-audit does not fail on them:
19 unmaintained, 7 unsound, 1 yanked. Worth naming:

- **`git2` carries three unsound advisories** (`RUSTSEC-2026-0008`, `-0183`,
  `-0184`) and this app uses git2 for cloud sync.
- **`spin` is yanked.**
- `anyhow`, `event-listener`, `glib`, `rand` unsound; the whole gtk-rs GTK3 stack
  unmaintained (Linux-only, and Linux was cut from this release).

### npm audit: production clean, dev not

`npm audit --omit=dev --audit-level=high` → **0 vulnerabilities**. Nothing that
reaches a user's machine is flagged.

All deps: 5 (3 moderate, 1 high, 1 critical), entirely dev tooling.

- **CRITICAL** `vitest`: the Vitest UI server allows arbitrary file read and execute.
- **HIGH** `vite`: path traversal in optimized-deps `.map` handling; `launch-editor`
  NTLMv2 hash disclosure.
- **MODERATE** `esbuild`: any website can send requests to the dev server and read
  the response.

Deliberately deferred since June (documented in the vault security backlog). The
reachability question for a developer running `npm run tauri dev` is assigned to
the release team.

### cargo-deny: licenses clean

New policy at `src-tauri/deny.toml`. **Zero third-party crates rejected.** The
entire dependency tree, including the vendored OpenSSL / libssh2 / libgit2 /
IronRDP / vnc-rs surface, satisfies a permissive allowlist. No GPL or AGPL
contamination in a proprietary binary. This is a genuinely clean result and worth
recording as such.

The only failure is the app's own crate reporting as unlicensed: `Cargo.toml` uses
`license-file = "../LICENSE"`, which cargo-deny cannot resolve to an SPDX
expression. Cosmetic.

### Test suites

449 vitest across 45 files, green in 18s. 174 Rust tests. Both suites pass at HEAD.

## Files in this directory

`eslint.json`, `clippy-pedantic.txt`, `semgrep.json`, `knip.json`,
`cargo-audit.json`, `npm-audit.json`, `npm-audit-prod.txt`, `npm-audit-all.txt`.
