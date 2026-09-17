<!-- (C) -->
# Audit fixes: complete

All four batches applied against `731afc5` on the working branch
`001-remote-sessions-parity`. **Nothing was committed until 2026-09-17**, when
the tree went in as one commit after a whole-tree re-review (four adversarial
reviewers over the combined result: no critical or high finding; the residuals
they did find are closed in the same commit or listed under v0.7.0 in
CHANGELOG.md).

## Final state, measured

| | before | after |
|---|---|---|
| vitest | 449 (45 files) | **836 (69 files)** |
| cargo | 174 | **232** |
| `npm run build` | clean | clean |
| clippy | 3 warnings | **3 warnings** (same three, pre-existing) |
| eslint errors | 279 | **241** |
| `moba-light` contrast failures | 27 | **4** |
| `daylight` contrast failures | never measured | 5 |
| `moba` / `oled` contrast failures | 13 / 13 | **13 / 13, unchanged** |
| dark-skin appearance changes | n/a | **0 across all 12** |

Change surface: 34 files, roughly +5,800 / -480 lines, plus new test and helper
modules.

## What was fixed

**Batch A, ship-blockers.** Detach-to-new-window destroying the session
(CRITICAL); the same nesting bug making the scrollback GC delete live tabs; SSH
host-key pinning rewriting the user's shared `~/.ssh/known_hosts` from a partial
parse (CRITICAL); the C3 SFTP fix's permission strip; C2's blindness to a missing
blob; a dismissed update suppressing a later security patch; and a version-vs-tag
CI gate. Details: [batch-a-closeout.md](batch-a-closeout.md).

**Batch B, theme correctness.** The undeclared `--phn-text-bright` and five more
undeclared tokens the audit missed, plus `--phn-hover-bg` declared across all 14
skins, a per-skin `--phn-text-bright`, a `--phn-focus-outline`, and the
`--phn-panel-fg` pattern. A 13-test token gate now makes this class of bug
impossible to ship. Details: [batch-b-closeout.md](batch-b-closeout.md).

**Batch D1, test integrity.** Three tests that asserted on copies of the guard
they were named for now call production code, proven by mutation. Six
symlink-escape tests that were asserting **nothing at all** on an unelevated
Windows box now assert on every platform. The IPC contract is a real test that
parses the sources at run time. Companion R4/R5. Details:
[batch-d1-closeout.md](batch-d1-closeout.md).

**Batch C+D2, keyboard and addressing.** Chrome actions addressing the tab id
instead of the active pane id (so `Ask AI -> Run` executed in an unfocused pane,
possibly a different host, and went permanently dead once a split's original pane
closed); `nextTab`/`prevTab`/`tab1..9` keybindings with `role="tablist"` semantics
and roving tabindex; the collapse rails that were a one-way door; a real ARIA menu
with window-level Escape; form-label associations; and three perf items.

## The loop earned its keep

**Every batch's first review came back DEFECTIVE.** Five of five streams in Batch
A. A CRITICAL in Batch B. Findings in all four Batch D1 streams.

Four defects were **introduced by the fixes themselves**:

1. A boot modal whose promise raced the recording prompt, leaving the durable
   mirror suspended forever.
2. SSH dead for any non-ASCII Windows username, because a fail-closed branch fired
   whenever libssh2's narrow-ANSI `fopen` failed on a path Rust could open.
3. Autosave silently wedged for the session: the factory-reset write hold was
   checked before the debounce id was cleared, and `save` only re-arms when that
   id is falsy.
4. A keyboard trap: making tabs focusable opened a route into a context menu that
   had no keyboard dismissal.

None of these were in the original audit. All four came from fixing it.

## Where a fix was reverted rather than shipped

**The cost accrual.** PERF-2 (the model family latching to "opus" so Sonnet and
Haiku spend read 5 to 10 times high) is fixed and mutation-proven. A follow-on
change tried to make the authoritative `/cost` figure accrue tokens on top of
itself instead of freezing. It is correct in isolation and cannot be correct on
this input: `tokens` upstream is a monotonic MAX over four signals on **two
different scales**, since the `/cost` summary forms and per-model lines are
cumulative session totals while the status-banner form is context size. So the
accrual either re-freezes anyway, or, when the `/cost` block straddles two
rAF-coalesced scans (Claude prints "Total cost:" before the per-model lines),
roughly **doubles** the displayed cost.

A 2x overstatement is worse than the freeze it replaced, and fixing it properly
needs the live `/cost` format, which is not verifiable from this repo. Reverted to
the documented pre-existing behaviour, with the reasoning written into the code
and pinned by an exhaustive-shape test that fails if the accrual returns without
the two-scale problem being solved first.

**Adopting each skin's own body colour for assistant replies and Monitor rows.**
Semantically tidier, but it recolours all 12 dark skins and drops `amber` below
AA. That is a taste call for pluto to make deliberately, not a side effect of a
bug fix.

## Where an agent corrected me, and was right

I asked for three `:root` token bridges to be deleted and the use sites renamed
instead. The agent deleted the bridges and refused the renames:
`--phn-accent: var(--phn-link)` at `:root` and `var(--phn-link)` at the site
**resolve to identical pixels in every skin**, so the rename is not an alternative
to the bridge, it *is* the bridge, and produces the same recolour that was the
complaint.

I also briefed Batch B as three skins when there are fourteen, two of them light.
Every regression in that batch traces back to that error.

## Still open, deliberately

- **The `v0.6.0` tag points at different commits on the two remotes** (public
  `8a5a1bd`, a 0.1.32-era commit; private `28e1bca`). A v0.6.0 public release DOES
  exist (2026-08-03, unsigned, hidden by GitHub's sort order; the claim here that
  none existed was wrong, corrected 2026-09-17). The CI gate now prevents a repeat.
  Reconciling means re-pointing the public tag at `28e1bca`, never deleting it,
  which would orphan that release; the command is in
  [batch-a-closeout.md](batch-a-closeout.md) and is a force push, so pluto runs it.
- **The follow-the-link regression is untestable here.** Changing
  `symlink_metadata` to `metadata` leaves the suite green, because a directory
  fixture is not a regular file under either call. Needs a cargo leg on a platform
  where symlinks can be created; `test.yml` now carries a `rust-macos` leg for
  exactly this (added in Batch A, so this bullet was stale the day it was written).
- **`Alt+1..9` will not fire on macOS**, where Option composes a character so
  `KeyboardEvent.key` never reads the digit. Documented in the registry and
  remappable; `Ctrl+Tab` works everywhere.
- **The `flushNow` scheduler fix has no regression test**, because testing the
  ordering means extracting the debounce out of `App.jsx`.
- **241 eslint errors remain**, mostly `react-hooks/refs` (49),
  `no-static-element-interactions` (42) and `set-state-in-effect` (32). The
  targeted ones are closed: `label-has-associated-control` went 25 to 0. One new
  `rules-of-hooks` hit is in a test helper, not production.
- **`default` skin measures 45 contrast failures** and was never measured before.
  `.moba-tool-label` and `.moba-tool-caption` are unchanged since `731afc5`, so it
  is pre-existing, but `default` is the fallback skin and deserves its own pass.
- **The three misspelled tokens** (`--phn-accent`, `--phn-border`, `--phn-fg-dim`)
  are locked in the gate's `KNOWN_GAPS`, asserted by exact equality so the set can
  only shrink.

## Not verified by anyone

Everything behind a live transport. The runtime passes ran under `npm run dev` in
a plain browser, where `isTauri()` is false and every `invoke()` rejects, so PTY,
SSH, SFTP, RDP, VNC and keychain paths were never exercised. `live-test-matrix.md`
still needs a real build and pluto's hands, and nothing here substitutes for it.

Given the size of this change set, a packaged-build smoke pass before any tag is
not optional.
