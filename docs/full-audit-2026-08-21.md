<!-- (C) -->
# Full audit, plutos-terminals @ `731afc5` (2026-08-21)

Eight surface teams, five regression-batch teams, 66 agents, adversarial refutation
on every CRITICAL and HIGH, plus a deterministic scanner baseline and a live
runtime pass. Zero agent errors.

**Verdict: no ship-blocker for the code that is already published, one data-loss
bug that should be fixed before the next release, and one release-integrity
problem that is a landmine rather than a live fault.**

The engineering here holds up. Six independent teams went looking for trouble in
surfaces that had already survived a six-dimension audit seven days earlier, and
what they found is concentrated in three places: **the Light theme**, which is
under-tested precisely because it is newer than the dark ones, **the boundary
between a window blob and the workspace tree inside it**, where two functions
disagree about the nesting level, and **release mechanics**, where nothing
mechanically checks what a tag means. The core session, PTY, scrollback, notebook
and IPC machinery survived again, as it did on 8/14.

## Scale

| | |
|---|---|
| Findings | **73**, 2 CRITICAL / 26 HIGH / 32 MEDIUM / 13 LOW |
| Surfaces verified sound | **133** explicitly checked and cleared items across 13 reports |
| Adversarial verdicts | 53 on the CRITICAL/HIGH set. 47 upheld, 6 refuted |
| Scanner baseline | ESLint 279 errors (first run ever), clippy 3, semgrep 31, knip 24, cargo-audit 5 (all pre-ignored), npm prod 0 |
| Test suites | 449 vitest + 174 cargo, all green, none skipped, none `.only`'d |
| IPC contract | 104 defined, 104 registered, 100 distinct call names, **zero mismatches** |

Per-team detail is in [`teams/`](teams/). Raw scanner output and the IPC manifest
are in [`00-baseline/`](00-baseline/). The live UI pass is in
[`runtime-ui-pass.md`](runtime-ui-pass.md).

## Calibration, stated up front

Three things about how to read the severities.

**The refuters pushed back hard on severity, not on substance.** Of 53 verdicts,
47 upheld the finding but only 23 voted KEEP. Nineteen recommended downgrading to
MEDIUM and six to LOW; four voted a finding *up*. So the HIGH bucket below is the
teams' own rating and is probably over-weighted by roughly a third. The ranking in
"Fix before the next release" is mine, based on findings I re-verified by hand,
not on the teams' labels.

**Six findings were killed outright.** Notably a claimed C2 regression (the fix is
not merely intact, it is stronger than when merged), and three test-quality
findings refuted as "correct code that lacks a test" rather than defects. That
distinction was worth enforcing.

**I got two things wrong myself during this audit and corrected them.** My initial
recon claimed the IPC contract had drifted (109 commands vs 167 call sites); a
proper manifest diff shows 104/104 and zero mismatches, and my numbers came from a
naive grep. And the first runtime contrast sweep reported the F-key bar at 1.93:1,
which was a frozen CSS transition in a non-compositing browser pane, not a bug.
Both are recorded because an audit that hides its own misses is not worth trusting.

## Fix before the next release

These six I opened and confirmed personally rather than taking a team's word.

### 1. Detach-to-new-window destroys the session (CRITICAL)

`src/features/terminals/hooks/useWorkspaceTree.js:300`

The per-window blob nests the workspace one level down: `TerminalsTab.jsx:444`
writes `{ ...prev, terminalsState: next }` and `:72` reads
`st?.terminalsState || defaultState()`. `detachTab` builds the inner shape and
writes it as the **whole** blob, with no `terminalsState` wrapper. The new window
boots, finds `st.terminalsState === undefined`, falls back to `defaultState()`,
and shows an empty Home panel. `closeTab` has already removed the tab from the
source window and a success toast has already fired.

Right-click a live SSH tab, "Detach to new window", and the label, cwd, connection
binding and start commands are gone. If it was the panel's last tab, `closePanel`
runs instead of the stash path, so even Ctrl+Shift+T cannot bring it back.

Verified: `grep terminalsState src` returns exactly three hits, two of which are
the read and write above. There is no normaliser in `App.jsx` and no test for
detach.

Fix is one wrapper: `JSON.stringify({ terminalsState: newState })`.

### 2. The same nesting confusion makes the scrollback GC delete live tabs (HIGH)

`src/features/terminals/storageKeys.js:59`

`allOpenTabIds()` iterates `st.panels`, which is `undefined` on every real blob,
so it returns `[]` unconditionally. That array is the only keep-set passed to
`scrollback_sweep` (`App.jsx:413`), so the exclusion is inert and the sweep
degrades to a pure 30-day mtime reaper. The Rust side comments at
`commands.rs:1206` warn about exactly this, noting that a rotated `.old.txt`
freezes its mtime and that "this app lives in the tray for weeks".

Worse, Windows `OpenOptions` sets `FILE_SHARE_DELETE`, so the delete succeeds
underneath the live append handle: the tab keeps writing into an unlinked inode
and silently stops persisting for the rest of the session.

The unit test written to prevent this builds its fixtures in the same wrong shape,
so it passes while certifying the bug.

### 3. SSH host-key pinning can destroy the user's shared `known_hosts` (CRITICAL)

`src-tauri/src/pty.rs:1291`. Found independently by the Rust team and the security
team, which is why it ranks here.

```rust
let _ = known.read_file(&kh_path, ssh2::KnownHostFileKind::OpenSSH);
...
let _ = known.write_file(&kh_path, ssh2::KnownHostFileKind::OpenSSH);
```

Both results are discarded. `write_file` serialises the entire in-memory
collection over the file. So whatever libssh2's parser failed to load on the way
in is simply absent on the way out. Connecting to one new host can silently drop
unrelated entries from `~/.ssh/known_hosts`, which is the file the user's real
`ssh`, `git` and `scp` depend on. Losing a pin loses MITM protection for that host
and does it quietly.

The accept-new logic itself is correct. The problem is the read-modify-rewrite of
a shared file with both error paths thrown away.

### 4. `--phn-text-bright` is used eight times and declared zero times (HIGH)

`src/features/terminals/terminals.css:1029` and seven siblings.

Verified by grep: eight `var(--phn-text-bright, #F2F4F7)` uses, no declaration in
`:root`, in any of the three skin blocks, or in `customThemes.js`. It always
resolves to the literal near-white fallback. Under the Light skin, whose surfaces
are `#ffffff` and `#ececec`, that puts the Assistant textarea at roughly 1.05:1,
your own sent chat bubbles at 1.3:1, and the CPU/MEM/DISK values at 1.08:1.

Type a prompt into the Assistant under Light and you see a blinking cursor and
nothing else.

This is one missing declaration, not eight mistakes, and the neighbouring rule
`.moba-rd-close:hover` gets it right by using `--phn-text-active`.

### 5. The `v0.6.0` tag means two different things on the two remotes (HIGH)

The team reported that `v0.6.0` names a 0.1.32-era commit. Checking it turned up
something they did not see:

| Remote | `v0.6.0` resolves to | `package.json` there |
|---|---|---|
| `origin` (public) | `8a5a1bd` "docs: v0.2.0 landing" | **0.1.32** |
| `private` (mirror) | `28e1bca` "fix(agents): close the five ways…" | 0.6.0 |

The local clone agrees with the public one. **Correction, 2026-09-17:** the
paragraph that stood here said there was no v0.6.0 GitHub release at all. There
is one: "Pluto's Terminals v0.6.0", published 2026-08-03 by the private mirror's
cross-repo publish, six unsigned assets (msi, dmg, deb, AppImage, app.tar.gz,
SHA256SUMS), no `.sig`, no `latest.json`. `gh release list` hides it because
GitHub orders releases by the tagged commit's date and `8a5a1bd` is from May, so
it sorts below v0.3.2; `gh release view v0.6.0` shows it. The vault status doc's
"v0.6.0 SHIPPED 2026-08-03" was right about the assets and wrong only about the
tag. The delete recipe that followed from the wrong claim has been withdrawn (see
batch-a-closeout.md): the tag should be re-pointed, never deleted, because
deleting it would orphan a live release.

Nothing is broken for users today, because that commit predates
`.github/workflows/` entirely, so no CI ran on it. It is a landmine, not a fire.
The general shape is what matters: `release.yml:209` takes the version from the
git ref (`VERSION="${TAG#v}"`) and `:266` writes it into `latest.json`, while the
installer is stamped from source. Tag a commit whose three version files still say
the old number and every client compares a higher manifest version against its own
compiled version, downloads, installs the older build, relaunches unchanged, and
is offered the same update forever. In this specific shape the payload would have
been a 0.1.32 downgrade past every fix from the June and August security passes,
delivered with a valid signature.

Fix: assert `${GITHUB_REF_NAME#v}` equals all three version files before the build,
then reconcile the divergent tag on both remotes.

### 6. A dismissed update suppresses a later security patch for 24 hours (HIGH)

`src/components/UpdateBanner.jsx:130`

Two effects write one `latest` slot. The GitHub-API effect short-circuits on a
24-hour cache and sets `latest` synchronously; the signed-updater effect is async,
always resolves second, and line 119 is deliberately non-overwriting
(`setLatest(cur => cur || …)`). Line 130 then gates the entire banner on
`dismissed === latest.tag`, comparing against the stale cached tag rather than the
version the updater actually has ready.

Click "Later" on v0.6.2, then ship a forced v0.6.3 patch two hours later: on next
launch the user is shown nothing at all for up to 24 hours while a verified update
sits ready. `docs/updater.md` names this exact scenario as the reason the updater
exists.

## The good news, and it is not small

The single highest-risk new surface came out clean under direct artifact
inspection, which is the check this project has historically most needed.

**The live updater manifest is healthy.** Fetching the real endpoint
(`releases/latest/download/latest.json`) returns version `0.6.1` with three
platform keys, `darwin-aarch64`, `darwin-x86_64` and `windows-x86_64`, each with a
non-empty signature and url. The `c6fee05` fix for the omitted Windows key is
confirmed working in the shipped artifact, not merely in the source. No Linux key,
consistent with the deliberate cut. The v0.6.1 release carries `latest.json`, both
`.sig` files and `SHA256SUMS`.

Also verified sound:

- **The signed updater fails closed** on an empty or placeholder pubkey, and the
  version comparator is a strict `>`, so `latest.json` cannot force a downgrade.
  The `tauri.release.conf.json` overlay is a deliberate, documented design that
  keeps local builds working without the signing key.
- **The IPC contract holds exactly.** 104 commands defined, 104 registered, every
  frontend call site resolves, one dynamic call site (the `backend.js` wrapper).
  A manifest checker now exists at [`00-baseline/ipc-manifest.json`](00-baseline/ipc-manifest.json).
- **cargo-deny licenses passes clean** across the Windows, Linux and macOS
  dependency trees, zero third-party rejections. No copyleft crate in a
  proprietary statically-vendored binary.
- **The 211 `.unwrap()` calls are almost entirely test code or poison-recovering
  `lock_recover`.**
- **The React render-containment work is still holding at HEAD.** All six chrome
  components are still memoised and, more importantly, the prop chain feeding them
  is identity-stable end to end.
- **The write primitives are in good shape:** tmp+rename applied consistently, the
  H2 unique-tmp fix landed correctly in both `write_store` and
  `notebook_write_sync`, the C5 recording checkpoint streams to disk and recovers
  on launch.
- **The modal layer is genuinely good:** focus-into, focus-restore, scoped Tab
  traps and topmost-only Escape all correct, with a real `aria-live` region on
  Toast.
- **eslint's three `rules-of-hooks` errors are false positives** (a prop named
  `useModel`), confirmed by the frontend team.
- **The 8/14 fixes largely held.** All five C-batch and all four H1-H4 fixes are
  physically present at HEAD and none were reverted or relocated by the 50
  intervening commits. H1's OSC nonce gate is correct with no leak or false reject.

## Regression pass: what the 8/14 fixes cost

The most interesting result is not that fixes broke, but that two of them traded
one failure mode for another.

**C3 (SFTP truncate) fixed the truncation and introduced a permissions leak.**
`do_upload` now stages to a temp and renames. `Sftp::create` in the pinned ssh2
crate hardcodes mode `0o644`, and POSIX `open()` ignores the mode when a file
already exists, so the old in-place write preserved the destination's mode while
the new rename swaps in a fresh 0644 inode. Upload over a 0600 remote
`.pgpass`, `.netrc` or private key and it becomes world-readable, with a success
toast. There is no `setstat` anywhere in the file. A symlinked destination is
likewise replaced rather than followed.

**C2 (workspace backup) covers the wrong failure mode.** `parseWorkspace` flags
`corrupt: true` only for a non-empty string that fails to parse. But the scenario
C2 was written for, WebView2 profile loss after an unclean shutdown, presents as a
**missing** key: Chromium's LevelDB discards a damaged database and starts empty.
On that path `corrupt` is false, so recovery never runs, the mirror is never
suspended, and the one-time OLED migration flushes the empty default over
`store.json` about 200 ms later. Both copies gone, no error shown. The suspension
mechanism was built for exactly this clobber but is armed off the wrong flag.

**C4 (unsaved remote edits) is bypassable by keyboard.** The dirty guard covers
only *closing*. The global shortcut handler is a window capture-phase listener
that stands down only for capture mode and the tour, not for an open modal, so
Ctrl+Shift+T, Ctrl+1-8 and Ctrl+Shift+Z all change the active tab, which unmounts
RemoteEditor outright with no `onClose` and no registry consultation. Ctrl+Shift+Z
is the sharpest case: it is Monaco's Redo, and the capture-phase handler eats it
first.

## Theme correctness is the largest cluster

Eleven findings, and the pattern is consistent: hardcoded dark-mode colours that
predate the Light skin and never got tokenised. Beyond `--phn-text-bright` above:

- Tab-rename and session-rename inputs hardcode `color:#fff` over a `#ffffff`
  active-tab fill. Renaming under Light is blind typing.
- The phone-pairing dialog's Link and Access token boxes hardcode `#0e1114` with
  inherited `#2a2a2a` text, roughly 1.3:1. The whole point of that screen is to
  read the token off it.
- `UpdateBanner` and the Add/Edit Session heading hardcode `#E6E6E6` on themed
  surfaces. The updater's own notification surface is invisible in Light.
- `src/styles.css` sets `body { background:#0a0a0a; color:#E6E6E6 }` and the global
  focus ring `#7c9cf5`, none tokenised. The focus ring lands near 1.96:1 on the
  light page, under the 3:1 minimum for a non-text indicator.
- Session-tree row hover is 4% white over a `#ffffff` sidebar: zero hover response.

Measured across every visible text node with transitions disabled: **light 27
contrast failures, oled 13, moba 13**. Light is the worst of the three and is the
daily driver.

The cheap systemic defence is a CI grep asserting every `var(--phn-*)` name used
has at least one declaration. That one check would have caught finding 4, and it
is invisible to eslint and to a dark-mode eye.

## Keyboard reachability

Verified three ways (DOM probe, keybinding registry, running app): the tab strip,
the `+` control and the right-dock tabs are not focusable, carry no role and no
`tabindex`, and `KEY_ACTIONS` has `newTab` / `closeTab` / `reopenTab` but **no
next-tab, prev-tab or tab-by-index action**. Ctrl+1-8 switches panels, a different
axis. Because the action does not exist in the registry, a user cannot even bind
it themselves in Settings.

One refuter called this a feature gap rather than a defect, and that is fair. It
is carried here as a product gap, not a bug: for a workstation positioned against
MobaXterm around many concurrent agent tabs, five tabs open and no keystroke that
reaches tab 1 is a competitive problem more than a correctness one.

The collapse rails are a genuine defect though: `.moba-railcol` is a click-only
`div` while the *collapse* direction is a real `<button>`, and the collapsed state
persists to localStorage. Tab to the dock's collapse button, press Enter, and
there is no keyboard route back, across restarts.

## Test quality

Three findings share one shape: a test named for a security or concurrency
guard that asserts on a **copy of the guard written inside the test file**.

- `check_command_version`'s allowlist tests call a local `fn accepted` that
  "mirrors the predicate". The production predicate is inline in the command body.
  They share zero code, and on Windows that name reaches `cmd /c`.
- Both tests for the `startSpawn` double-spawn latch assign their own latch
  implementation and assert on it. `paneRegistry.js` sets `startSpawn: null`.
- The OSC-1337 provenance gate from H1 has no coverage; the tests named for H1
  cover the emitter half only.

The sibling `mcp_install_guard_tests` does it correctly with `use super::`, and
`reserved_names_match_js_mirror` goes as far as `include_str!`-parsing the JS to
pin a cross-language duplicate. The codebase knows this failure mode; three places
missed it. **88 of 104 IPC commands are named in no test on either side.**

## What no team could cover

Everything behind a live transport. The runtime pass ran `npm run dev` in a plain
browser, where `isTauri()` is false and every `invoke()` rejects, so PTY, SSH,
SFTP, RDP, VNC and keychain paths were never exercised. Nothing here replaces
`live-test-matrix.md`, which needs a real build and your hands. Specifically
unverified: the packaged app's boot, an actual update install, and every item in
the security backlog that needs a live VNC or RDP peer.

## Doc drift found along the way

- Repo `CLAUDE.md` cites `TerminalPane.jsx` at 1,483 lines (it is 2,185) and
  `commands.rs` at 887 (it is 3,149). Agents read this file and act on it.
- The vault status block stops at 2026-08-09 and records none of: the 8/14 audit,
  the 8/16 fix wave, v0.6.1, the Linux cut, or the signed updater. It also claims
  v0.6.0 shipped publicly, which the release list contradicts.
- `docs/updater.md:101` still documents the Windows payload as `.msi.zip`, the
  exact wrong shape that caused `c6fee05`.
- The security backlog records "Release GitHub Actions pinned to commit SHAs" as
  done. That covered `release.yml` only; `audit.yml` and `test.yml` still use nine
  mutable tags.
- GitHub release bodies never use `releases/*.md`; the documented release-notes
  step has silently stopped happening.

## Recommended order

**Before the next tag** (data loss and release integrity): finding 1 (detach, one
line), 2 (GC keep-set, one line), 5 (version assert in CI plus reconcile the tag),
3 (`known_hosts` rewrite), C3's permission strip, C2's missing-blob path.

**Next pass** (the Light skin, cheap and highly visible): declare
`--phn-text-bright`, tokenise the five hardcoded-colour sites, tokenise
`styles.css`, add the `var(--phn-*)`-is-declared CI grep. Then finding 6 and the
C4 keyboard bypass.

**Infrastructure, do once**: make the three mirrored guards call production code
instead of copies; wire the IPC manifest diff as a test; pin `audit.yml` and
`test.yml`; add a Linux or macOS cargo leg.

**Deliberate non-goals**: the dev-only npm advisories (production is 0), the four
pre-ignored cargo advisories, and the 460 clippy pedantic warnings, which are
overwhelmingly style. Default clippy is three warnings from being gateable.
