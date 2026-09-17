<!-- (C) -->
# Audit plan: plutos-terminals @ 731afc5 (2026-08-21)

Framing: head of product signing off a release. Every team owns a surface, every
team produces a written pass, and the surfaces no team owns are named out loud
instead of quietly skipped. The output is one ranked verdict doc, not eight
opinions.

## What is actually here (measured, not assumed)

| Thing | Number |
|---|---|
| Rust | 12,650 LOC / 23 files (`commands.rs` 3,149, `pty.rs` 2,162) |
| Frontend | ~30,000 LOC / 191 JS+JSX files (`TerminalPane.jsx` 2,185, `TerminalsTab.jsx` 1,373) |
| CSS | 2,282 LOC (`headerSkins.css` 1,136, `terminals.css` 1,099) |
| IPC surface | 104 `#[tauri::command]`, 104 registered, 100 distinct names across 163 `invoke(` sites |
| Tests | 449 vitest (45 files, all green, 18s) + 174 Rust tests |
| CI | `test.yml` (vitest ubuntu, cargo windows), `audit.yml` (npm + cargo audit, gated), `release.yml` |
| Branch | `001-remote-sessions-parity` @ `731afc5`, clean tree, v0.6.1 |
| Since last audit | 50 commits, 78 files, +4,528 / -1,330 |

## Prior art (do not re-run these)

- `docs/full-audit-2026-08-14.md` at `8c40c62`. Six dimensions, 30 findings, marked
  RESOLVED 2026-08-16. Everything C1-C5, H1-H8, M1-M11, L1-L6 fixed except M2
  (downgraded with reason).
- `docs/security-audit-2026-06-08.md` and `docs/full-audit-2026-06-09.md`.
- Vault: `03 Projects/plutos-terminals/security-backlog.md` (8 items, 5 still open)
  and `live-test-matrix.md` (82-line runtime checklist).

This pass is **not** a rerun. It is: verify those fixes still hold 50 commits later,
plus the surfaces nobody has ever audited.

## Gaps found during recon (why this audit is not redundant)

1. **No JS linter and no type system.** Zero `eslint`/`biome`/`tsconfig`/`jsconfig`
   in the repo. 30k lines of JSX with no static analysis whatsoever. Rust has
   clippy available but CI runs `cargo test` only, no clippy gate, no `fmt` gate.
   A whole class of bug this codebase repeatedly hits (stale closures, missing
   hook deps, hook-order changes) is exactly what `eslint-plugin-react-hooks`
   catches for free, and it has never been run.
2. **Accessibility has never been audited.** 249 `onClick` against 30 total
   `aria-*`/`role=` attributes and 6 `tabIndex`. The v0.5.0 pass fixed modal
   dialogs only. Everything else (menu bar, toolbar, tab strip, dock, palette,
   session tree) is mouse-only as far as any tool can tell.
3. **Theme-token discipline regressed, not held.** FR8 on 8/14 measured 393 raw
   hex in JSX vs 467 `var(--…)`. Today: **502 vs 616**. It got worse, and light
   mode is the daily driver, so every raw hex is a queued light-mode regression.
4. **IPC contract still has zero tests** (FR2, explicitly left open). A manifest
   diff built during Phase 0 shows the contract currently HOLDS: 104 defined, 104
   registered, zero unresolved call sites. But nothing enforces it, so it can
   drift silently on any commit.
5. **`TerminalPane.jsx` is 2,185 lines.** FR1 said hold near 1,200. It grew.
6. **Cross-platform is unproven and shrinking.** Cargo tests run Windows-only in
   CI; Linux was **cut** from this release (`c507e00`). macOS ships to users and
   executes in no gate.
7. **The signed updater is brand new and barely exercised** (`c507e00`, `7b2b8e0`,
   `ed2dc03`, `c6fee05` all within the last handful of commits, one of them already
   a fix for a missing Windows platform key in `latest.json`). Highest blast radius,
   least mileage. Past releases shipped three updater bugs that passed clean builds
   and full green suites.
8. **Security backlog items 2, 4, 5, 6, 7 are open**: app-ACL/Rust gate on
   `pty_spawn`+`secret_get` (ROOT-A), VNC no-auth default, RDP/SSH TOFU auto-trust,
   Agent auto-run trusting a server-declared `read_only` hint, flat `secret_get`
   namespace.
9. **211 `.unwrap()` calls in Rust.** Each is a potential process-killing panic in
   a desktop app that holds live sessions.
10. **Docs drifted from reality.** The vault status block stops at 2026-08-09 and
    never records the 8/14 audit, the 8/16 fix wave, v0.6.1, the Linux cut, or the
    signed updater. Repo `CLAUDE.md` cites `TerminalPane.jsx` at 1,483 lines when
    it is 2,185, and `commands.rs` at 887 when it is 3,149. Agents read these
    files and act on them.

## Tooling

Checked what is already wired (`tools.md`) before proposing anything. Installed and
usable today: `cargo-audit`, `cargo clippy`, `gh`, `uvx`/`uv`, `pipx`, `npx`,
Browser pane + vite dev loop.

**Proposed additions, all local, all free:**

| Tool | Why | Install |
|---|---|---|
| ESLint 9 flat + `react-hooks` + `jsx-a11y` | The two teams with no tooling at all. Statically catches the hook-order and stale-closure class, and gives the first real a11y signal. | `npm i -D eslint @eslint/js eslint-plugin-react eslint-plugin-react-hooks eslint-plugin-jsx-a11y` |
| `knip` | Dead files, unused exports, unused/unlisted deps across 191 files. ESLint cannot see a file nothing imports. | `npx knip` (no install) |
| Semgrep (**local engine only**) | Rule-based security patterns over both JS and Rust. | `pipx install semgrep` |
| `cargo-deny` | License compliance + duplicate crates + advisory policy. Matters because the shipped binary vendors OpenSSL, libssh2 and libgit2 under a proprietary license. `cargo-audit` does not check licenses. | `cargo install cargo-deny` |
| `cargo clippy -D warnings` | Already installed, never gated. | none |

**Hard constraint on Semgrep:** Claude Code's default Semgrep plugin routes scans
through Semgrep's **hosted remote server**, which means source leaves the machine.
This repo is proprietary/source-available with a private mirror. Use the local CLI
via Bash only. Not the hosted plugin, not the remote MCP.

Considered and rejected for this pass: SonarQube (server install, heavyweight),
Snyk (account + upload), CodeQL (needs a DB build per language, hours), Trail of
Bits static-analysis plugin (useful wrapper, but it only drives semgrep/codeql
which we would be running directly anyway).

## Execution

### Phase 0: deterministic baseline (no LLM opinions yet)

Install the tools above, write minimal configs, run every scanner, and capture raw
output. This happens first on purpose: it converts "an agent believes" into "a tool
proves," and it gives every downstream team machine-truth to start from instead of
vibes. Deliverable: `docs/audit-2026-08-21/00-baseline/` with clippy, eslint, knip,
semgrep, cargo-deny, npm-audit, cargo-audit, and both test suites captured.

### Phase 1: eight team audits, in parallel

Each team is an independent adversarial reviewer over its own surface, handed the
Phase 0 output, forbidden from reporting anything without a `file:line`.

1. **Frontend correctness**: React lifecycle, hooks, the `ptyBridge` second state
   manager, `splitTree`/`workspaceModel`, the five documented invariants.
2. **Rust backend and IPC**: the 109 commands, thread/mutex ownership, the 211
   `unwrap()` panic surface, blocking work on async paths, registry teardown.
3. **Security**: the 5 open backlog items plus the never-audited new surface:
   signed updater, MCP client, Agent Mode auto-run, phone companion, share-to-gist.
4. **UI, UX and accessibility**: keyboard reachability, focus management, the
   502-hex light-mode regression risk, contrast, the chrome nobody can tab through.
5. **Performance**: render cost under an agent fleet, xterm renderer, boot path,
   memory growth across long sessions.
6. **Resilience and data integrity**: atomic writes, crash recovery, corruption
   handling, scrollback, notebooks, cross-window and cross-process races.
7. **Build, release and supply chain**: the updater end to end, the three-file
   version bump, CI gate coverage, the Linux cut, dependency health, vendored-C
   license compliance.
8. **Test quality**: are 623 tests meaningful or decorative? What is asserted vs
   what is merely executed? Where is the IPC contract? Spot-check by breaking code
   and confirming a test actually fails.

### Phase 2: regression pass on the 8/14 fixes

Separate agents re-verify each of the 30 resolved findings against current HEAD, 50
commits later. This is not paranoia: on this codebase the re-review round has caught
a regression or a wrong fix in nearly every previous wave, including a private-key
leak introduced by a size-cap fix.

### Phase 3: adversarial verification

Every CRITICAL and HIGH from Phases 1 and 2 goes to independent refuters with
distinct lenses (does it reproduce, is it reachable, does the cited code actually
say that). Majority-refuted findings die and never reach you. Target: zero false
positives in the final doc, same bar the 8/14 pass hit.

### Phase 4: runtime proof

Statics cannot prove the app runs. Vite dev plus the Browser pane for the UI and
a11y checks, `npm run tauri dev` for a boot smoke, and the real built artifact for
anything updater-related, because on this project a green build has proven nothing
three separate times. The GUI-only items from `live-test-matrix.md` need your hands
and get listed explicitly rather than silently marked done.

### Phase 5: head-of-product synthesis

One ranked doc: ship-blockers, next-pass, accepted debt, with per-team sign-off
status and an explicit "no team could cover this" list. Plus doc reconciliation so
the repo `CLAUDE.md` and the vault status block stop lying to the next agent.

## Deliverables

- `docs/full-audit-2026-08-21.md`, the verdict doc.
- `docs/audit-2026-08-21/`, per-team reports and raw scanner output.
- Repo `CLAUDE.md` line counts and open-items list corrected.
- Vault `03 Projects/plutos-terminals/CLAUDE.md` status block brought current.
- `tools.md` updated in the same session if anything gets installed.

## Cost and shape

Roughly 35 to 45 agents across the five phases. That is above this session's default
workflow-size guideline of 15, which is why it is being stated up front rather than
discovered mid-run.

## Decisions needed before starting

1. **Audit only, or audit and fix?** Fixing means the full adversarial loop
   (plan-audit, TDD, re-review every fix), which roughly triples the run.
2. **May I install the Phase 0 tooling** (eslint, knip, cargo-deny, semgrep local)
   and wire the passing ones as CI gates?
3. **Depth** as scoped above, or narrower.
