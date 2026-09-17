<!-- (C) -->
# Batch D part 1 closeout: test integrity

Applied 2026-08-21 against `731afc5`. Nothing committed.

**Result: 3 of 4 streams SOUND, the fourth closed by hand. 622 vitest across 54
files and 232 cargo, all green. `npm run build` clean, clippy 3 pre-existing
warnings.**

Test totals since the audit began: **449 to 622 vitest, 174 to 232 cargo.**

## The finding this batch existed to close, and the proof it worked

Three tests named for a guard asserted on a **copy** of that guard written inside
the test file. The proof is the mutation, not the description:

**`check_command_version` (TQ-1).** The predicate is now
`fn command_name_allowed(name: &str)`, called from the command body, and the test
module does `use super::command_name_allowed;`. Mutation run, using the audit's own
scenario of adding `.` to the allowlist so `claude.cmd` could be probed:

- **Before the fix**, with the real predicate widened and the test's private copy
  untouched: **3 passed, 0 failed. GREEN.** The tests were provably vacuous.
- **After the fix**, same mutation: **FAILED**, with
  `"a.exe" must be rejected, cmd /c would reparse it`.

That matters because the Windows branch routes `name` into
`silent_command("cmd").arg("/c").arg(name)`.

**The `startSpawn` double-spawn latch (TQ-3)** now lives in `paneRegistry.js` and
the tests drive the registry's own latch instead of one they wrote themselves.

**The OSC-1337 provenance gate (TQ-2)** is extracted as a pure function next to the
`shellIntegration.js` builders and unit-tested, including a round trip against
`buildPosixShellInit`'s own emitted format so the emitter and the verifier are
pinned to each other. This is the enforcement half of the 8/14 H1 fix, which
decides what enters trusted, one-click-rerunnable command history, and it had zero
coverage.

## What the mutation discipline found that the audit did not

**Six symlink-escape tests were asserting nothing at all on this machine, every
run.** BRS-3 said they "silently pass without asserting anything". The agent probed
the primitive directly: `mklink` on pluto's unelevated Windows box returns "You do
not have sufficient privilege", so all six were reaching `if !made { return; }` and
exiting. Not weak coverage. Zero coverage, invisibly, for as long as they have
existed.

They now assert a privilege-free half first (a directory named `*.md` is rejected
by the same `symlink_metadata(..).is_file()` line), so they check something on every
platform, and a shared helper asserts that link creation actually succeeded on
platforms where it should.

The reviewer then caught that three of the six still survived deleting the guard,
because a bare `.is_err()` cannot distinguish the guard's own message from the OS
refusing to read a directory. Those now assert the guard's exact error text.

## Closed by hand: a regression sweep covering 1 of 7 commands

The final review left one MEDIUM. `no_sync_command_in_this_file_touches_the_lifecycle_lock`
gated on `chunk.contains(".inner")`, and only `companion_notify_finish` names that
field literally. `companion_start`, `stop` and `status` reach the same lock through
helpers, so **the test checked one of seven commands** and the precise R4 regression
would not have failed it.

Inverted: async is now REQUIRED, with an explicit three-entry `DELIBERATELY_SYNC`
allowlist for the `companion_set_*` commands, plus `assert_eq!(checked, 4)` so
coverage cannot silently shrink again.

Mutation-proven in two steps, because the first attempt was not representative:

1. Reverting `companion_start` to sync **does not compile** (its body awaits), so
   the compiler already blocks that specific regression. Not a valid proof.
2. Injecting a new sync `#[tauri::command]` that reaches the lock **without naming
   `.inner`**, which is exactly the old test's blind spot: **FAILED**, naming the
   offending declaration. The old gate would have skipped it.

## Also landed

- **The IPC contract is a real test** that parses the Rust and JS sources at run
  time rather than asserting against the checked-in snapshot, which would have been
  another copy-of-production-truth test. Verifies every `invoke("x")` names a
  registered command and every registered command is defined, with the four
  known-uncalled commands allow-listed and explained.
- **Companion R4/R5:** `companion_start`/`stop` moved off the UI event loop with
  bounded subprocess calls, and the event relay's unbounded channel is now bounded
  with a drop-and-count policy, so a slow phone cannot grow desktop RSS without
  limit. The three security rules held: no `write_store`, keys never leave the
  desktop, relay gated to `pty://`.
- **PERF-1:** the file browser no longer renders whole directory listings
  unvirtualized after the backend cap went 5k to 50k.

## Accepted debt

- **The follow-the-link regression is still invisible.** Changing
  `symlink_metadata` to `metadata` leaves the whole suite green, because a
  directory fixture is not a regular file under either call. Closing it needs a
  cargo leg on a platform where symlinks can be created. `test.yml` still pins
  cargo to `windows-latest`, the one platform where creation can be refused. This
  is BRS-3's second half and it is a CI change, not a test change.
- **Two read/write directory halves are weaker than the two list halves**, because
  reading or renaming over a directory fails at the OS level regardless. Making
  them load-bearing needs a testable seam in the read path.
- **`check_command_version_sync` has no allowlist check of its own**; the guard
  sits in the async command that is its only caller. Cheap defence in depth if a
  second caller ever appears.
- **The `flushNow` scheduler fix from Batch A still has no regression test.**
  Testing the ordering needs the debounce scheduler extracted out of `App.jsx`,
  which is a refactor. Carried forward.
- **`TerminalPane.jsx` is imported by zero test files**, so the OSC gate's
  production call site is covered only by the extracted function's tests.
