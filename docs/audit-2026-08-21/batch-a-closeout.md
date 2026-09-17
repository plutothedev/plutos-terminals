<!-- (C) -->
# Batch A closeout: ship-blockers

Applied 2026-08-21 against `731afc5`, working branch `001-remote-sessions-parity`.
Nothing committed; all changes are in the working tree.

**Result: 3 of 4 streams SOUND after three rounds. Tests 449 -> 557 vitest and
174 -> 209 cargo, all green. Clippy unchanged at 3 pre-existing warnings; the new
Rust adds none. `npm run build` clean.**

## What the loop actually did

Round 1 review: **all five streams came back DEFECTIVE.** Round 2: zero CRITICAL,
zero HIGH, 8 MEDIUM, 13 LOW. Round 3: three streams SOUND, one MEDIUM left, which
was then fixed by hand.

Three of the defects the reviewers found were **introduced by the fixes
themselves**, which is the entire argument for this loop:

1. **A boot modal that could suspend the durable mirror forever.** The
   boot-recovery fix resolved an ambiguity by asking the user at boot. Its promise
   raced the recording-recovery prompt, and the loser's promise was orphaned with
   the mirror never resuming.
2. **SSH dead for non-ASCII Windows usernames.** The `known_hosts` fix added a
   fail-closed branch that refused to pin any new host when libssh2 could not open
   the file but Rust could. libssh2 opens with the narrow ANSI CRT on Windows, so
   any profile path with Cyrillic, CJK or accented characters hit it. The code
   even detected that exact case, printed a diagnostic about it, and refused
   anyway.
3. **Autosave silently wedged for the session.** The factory-reset write hold was
   checked before the debounce id was cleared, so a hold-blocked flush left a dead
   timer id, and `save` only arms a new timer when that id is falsy. Reachable
   when `write_store` fails: the reset is cancelled, the user is told "nothing was
   wiped", and the window quietly stops persisting anything.

## Design decisions worth recording

**The boot modal was deleted rather than patched.** Four findings were downstream
of one decision. The ambiguity it existed to resolve, "is this profile loss or a
factory reset?", was removable at the source: `handleFactoryReset` cleared
localStorage but left `store.json` behind, despite its own dialog promising it
"wipes ALL Pluto's Terminal state from this machine". Factory reset now clears the
durable backup **first**, before the local wipe, so a failure aborts the whole
reset with both copies intact rather than leaving a half-reset state that boot
would misread. With that ambiguity gone, "blob missing plus populated store.json"
can only mean profile loss, so recovery is silent with a non-blocking toast. Net
effect on the diff: roughly 100 lines smaller, and all four findings closed at
once.

**`known_hosts` appends instead of rewriting.** The original defect was a
read-modify-rewrite of a shared file with both error results discarded. It now
appends a single line through Rust's wide API, which is what OpenSSH accept-new
does, so entries libssh2 cannot parse are never at risk. When libssh2 cannot open
the file at all, a Rust-side scanner (`scan_known_hosts`) mirrors libssh2's own
matching rules and answers `Undecidable` rather than guessing, so the fix only
loosens where it has evidence.

**`StagedFs` was kept after being challenged.** `sftp.rs` grew a trait with a
`FakeFs` test double. That is the shape of the antipattern this audit exists to
kill (tests asserting on a copy of production logic), so it was checked
specifically: the decision logic lives in shared code that `FakeFs` genuinely
exercises, and `impl StagedFs for ssh2::Sftp` is a thin adapter. Kept, on
evidence.

## Findings closed

| Finding | Severity | Where |
|---|---|---|
| RDI-1 detach destroys the session | CRITICAL | `useWorkspaceTree.js` |
| R1 / SEC-1 `known_hosts` destructive rewrite | CRITICAL | `pty.rs` |
| RDI-2 scrollback GC keep-set always empty | HIGH | `storageKeys.js` |
| R-C3-1 / RDI-4 / R3 SFTP permission strip + symlink clobber | HIGH | `sftp.rs` |
| R-C2-1 / RDI-3 C2 misses the missing-blob case | HIGH | `App.jsx`, `workspaceBoot.js` |
| BRS-2 dismissed update suppresses a security patch | HIGH | `UpdateBanner.jsx` |
| BRS-1 tag-vs-source version drift | HIGH | `release.yml` |
| BRS-7 unsigned release ships unchecked | MEDIUM | `release.yml` |
| SEC-4 / BRS-6 mutable action tags, missing permissions floor | MEDIUM | `audit.yml`, `test.yml` |

Plus the three self-inflicted regressions above, and the factory-reset untruth
found while removing the modal.

## Accepted debt

Deliberately left, with reasons:

- **Hashed `known_hosts` entries still refuse** on the libssh2-cannot-open path.
  Matching them needs HMAC-SHA1 over the host name and no crate in this build
  exposes one. OpenSSH's `HashKnownHosts` defaults to off on Windows, so the
  non-ASCII acceptance case is unaffected.
- **`KnownHostsGap::Unparsed` still refuses outright.** The same Rust scanner
  would settle many of those, but that is a second security branch and was not in
  scope for a final round.
- **`contents_match` re-reads the destination** when a rename reports success yet
  leaves the temp behind. On a large upload to a copy-then-delete gateway that is
  a full re-read. Capping it by size would reintroduce the false data-loss report
  for exactly the files where it hurts most. It never runs on a normal save.
- **Behaviour change:** a rename that moved nothing, but whose payload happens to
  equal what was already at the destination, is now reported as success rather
  than failure. Judged correct (the server holds the bytes the user asked to
  save), and noted because it is a real change.
- **`resolve_local_link`'s two new error paths have no test.** They need real
  local symlinks, so `cfg(unix)` or Windows developer mode.
- **The SFTP stray-temp case is closed by cleanup, not disclosure.** When an
  unlink is refused the leftover is emptied but the user is not told the stray
  name exists. `sftp.rs` has no `AppHandle`, no emitter and no logging, so
  surfacing it means changing the `Ok` payload and its JS consumers.
- **The `flushNow` scheduler fix has no regression test.** Testing the ordering
  properly means extracting the debounce scheduler out of `App.jsx`, which is a
  refactor rather than a fix, and the same reviewer separately flagged that
  App.jsx wiring is untestable in general. **Carried into Batch D**, which is the
  test-integrity batch.
- **`UpdateBanner`'s `isNewer` docstring** is imprecise but not false. Two rounds
  produced three findings about its wording; left alone deliberately.

## Not code, and not mine to do

**The `v0.6.0` tag still points at different commits on the two remotes** (public
`8a5a1bd`, a 0.1.32-era commit; private `28e1bca`). **Corrected 2026-09-17:** a
v0.6.0 public release DOES exist (published 2026-08-03, six unsigned assets, no
`latest.json`; hidden in `gh release list` by GitHub's sort-by-tagged-commit-date,
visible with `gh release view v0.6.0`). The delete recipe that used to stand here
would have orphaned it and has been withdrawn. The CI gate now prevents a repeat.
To reconcile, re-point the public tag at the commit the private mirror has. It is a
force push, so pluto runs it; one command, no `cd`, works from cmd, PowerShell or
bash:

```powershell
git -C C:\Users\pluto\plutos-terminals push --force origin 28e1bca71a8ec65850c3dd54965d2b5e91a83157:refs/tags/v0.6.0
```

Or leave the tag alone: nothing is broken for users, the release keeps serving its
assets either way, and v0.6.1 stands as the first signed release.
