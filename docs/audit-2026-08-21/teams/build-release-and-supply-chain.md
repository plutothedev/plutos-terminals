<!-- (C) -->
# Build, release and supply chain

Audit of plutos-terminals @ `731afc5`, 2026-08-21.

## Summary

The signed-updater plumbing that landed in the last four commits is, in its own right, sound: the payload is minisign-verified before anything executes (tauri-plugin-updater-2.10.1 src/updater.rs:712), the comparator is a strict `>` so latest.json cannot force a downgrade (updater.rs:532), the macOS dual-arch key emission is correct, and the SHA256SUMS name-sanitization is self-verifying. The dependency posture is genuinely clean where it was claimed to be: cargo-audit's ignore list is honest and complete, cargo-deny licenses passes with zero third-party rejections (I ran it), and the dev-only npm vulns are not reachable from `npm run tauri dev`. The debt is entirely in the gates around the pipeline, not the pipeline's crypto. Two things are actually wrong today: the `v0.6.0` tag points at a commit whose three version files all say 0.1.32, and nothing in CI would have caught it , release.yml derives latest.json's `version` from the tag, so a repeat of that mistake on a tag that does have the workflow produces a permanent update loop and a downgrade. Separately, UpdateBanner can hide a signed security update behind a 24h-stale cached tag plus a prior dismissal. Beyond that: six symlink-escape security tests silently no-op, one production import is a phantom dependency, and the release job has no test gate at all.

## Verified sound (8)

- cargo-audit ignore list is honest and complete. All 5 vulnerability rows in the baseline map to exactly the 4 IDs audit.yml ignores: RUSTSEC-2023-0071 twice (rsa 0.9.10 and rsa 0.10.0-rc.9), RUSTSEC-2026-0194 and -0195 (quick-xml 0.39.4), RUSTSEC-2026-0235 (rkyv 0.7.46). Nothing is being suppressed beyond what the comments at audit.yml:59-67 declare, and each stated reason (parent-capped by tauri/plist at quick-xml 0.39.x, no patched rsa release since 2023) matches the `patched` fields in the scanner output.
- cargo-deny licenses genuinely passes with zero third-party rejections. I ran `cargo deny check licenses` in src-tauri myself against deny.toml and got `licenses ok`. The only output is three `license-not-encountered` warnings for unused allowances (NCSA, OpenSSL, Unicode-DFS-2016) and one deprecated-identifier note on unescaper v0.1.8 via serialport. No GPL/AGPL crate is anywhere in the tree of a proprietary statically-vendored binary. Worth noting the config and the static.yml job that runs it are both still untracked (`git ls-files src-tauri/deny.toml` is empty), so the gate is not yet in CI.
- npm's dev-dep CRITICAL and HIGH are not reachable from `npm run tauri dev`. The vulnerable vite is 5.4.21 nested at node_modules/vitest/node_modules/vite and node_modules/vite-node/node_modules/vite; the dev server and production build use top-level vite 8.2.1, outside every affected range (<=6.4.1 / <=6.4.2). The vitest CRITICAL (GHSA-5xrq-8626-4rwp) is conditioned on the Vitest UI server listening , @vitest/ui is not installed and no package.json script passes --ui or --api. audit.yml's `npm audit --omit=dev --audit-level=high` gate is the right call here.
- Version consistency at HEAD is correct: package.json:4, src-tauri/Cargo.toml:3 and src-tauri/tauri.conf.json:4 all read 0.6.1. The uncommitted working-tree changes to package.json and Cargo.toml are audit tooling only (eslint devDeps, a `publish = false` line for cargo-deny) and touch no version field. The tag-level problem is BRS-1, not the current tree.
- The three git2 unsound advisories are not reachable. sync_git.rs is the only consumer (plus one line in lib.rs) and imports exactly `Cred, FetchOptions, PushOptions, RemoteCallbacks, Repository, Signature` (sync_git.rs:7). RUSTSEC-2026-0183 needs Remote::list(), which is never called; -0184 needs Signature::from_buffer, and the only signature construction is `Signature::now("Pluto Sync", ...)` with static strings at sync_git.rs:127; -0008 needs a null-buffer Buf deref from APIs the file does not touch.
- The updater's trust model holds end to end. verify_signature runs over the full downloaded buffer before install_inner is ever reached (tauri-plugin-updater-2.10.1 src/updater.rs:712), and the default comparator is `release.version > self.current_version` (updater.rs:532), so a tampered latest.json cannot force a rollback to an older signed payload without also inflating the version field. tauri_plugin_updater and tauri_plugin_process are both registered (lib.rs:106-107) and `updater:default` + `process:allow-restart` are both granted to the `main` window (capabilities/default.json), so the macOS relaunch path is actually wired. The base/overlay pubkey split documented at docs/updater.md:22-44 is real and correct.
- The SHA256SUMS generation is right and self-proving. release.yml:168-190 sanitizes asset names to GitHub's own [A-Za-z0-9._-] alphabet before hashing, errors on a sanitized-name collision, hashes into a path outside the globbed directory, and then runs `sha256sum -c` on the exact bytes about to be uploaded. The latest.json step correctly runs after the rename so its URLs match what GitHub serves, and the macOS dual-key emission (darwin-aarch64 + darwin-x86_64 for one universal payload, release.yml:245) is the correct fix for the lipo/cfg!(target_arch) mismatch.
- Repo hygiene on the artifacts that matter: src-tauri/Cargo.lock and package-lock.json are both tracked, so the yanked spin 0.9.8 cannot break a `--locked` build (it will block a future `cargo update -p spin`, and cargo-audit will never fail on it since yanked is warning-only). scripts/*.log (dev-out.log, git-out.log, cleanup-out.log) are covered by the `*.log` rule in .gitignore and are untracked.

## Findings (10)

### HIGH BRS-1, Tag v0.6.0 names a 0.1.32-era commit; nothing checks tag vs. the three version files, and latest.json's version comes from the tag

`.github/workflows/release.yml:209`

**What.** `git rev-list -n1 v0.6.0` resolves to 8a5a1bd, "docs: v0.2.0 landing , workstation README, proprietary license, changelog" (2026-05-28) , the stale `main` landing commit. At that tag `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` all read 0.1.32. (v0.5.0 and v0.6.1 are consistent; only v0.6.0 is mislabelled.) That tag survived because nothing verifies it. release.yml line 209 is `VERSION="${TAG#v}"` and line 266 writes `'{version: $v, ...}' > latest.json`, so the manifest's version is taken from the git ref, never from the artifact that was actually built. There is no bump script in `scripts/` and no version-match step in any workflow , CLAUDE.md lines 22-24 make the bump a three-file manual edit. This particular tag was harmless only by accident: `git ls-tree -r --name-only v0.6.0 .github/` shows no `workflows/` directory at all at that commit, so GitHub had no release.yml to run.

**Failure.** Tag a commit whose three version files still say the previous version (exactly what happened at v0.6.0) on any commit from v0.5.0 forward, where release.yml exists. CI builds installers stamped with the SOURCE version and publishes latest.json stamped with the TAG version. Every installed client compares latest.json's version against its own compiled version (updater.rs:532, `release.version > self.current_version`), sees a newer number, downloads, msiexec-installs the older MSI, relaunches on the same version it started on, and is offered the identical update on every subsequent launch , a permanent nag loop. In the v0.6.0 shape specifically the payload would be a 0.1.32 build, i.e. a 0.5.0 → 0.1.32 downgrade past every fix in the June and August security passes, delivered with a valid signature.

**Fix.** Add a step to release.yml before the build that asserts `${GITHUB_REF_NAME#v}` equals the version in package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json, and fails the job otherwise. Then either delete/retag v0.6.0 locally and on both remotes, or (if it was never pushed) delete it locally. Verify on GitHub whether a v0.6.0 release object or tag exists on plutothedev/plutos-terminals before deciding which.

### HIGH BRS-2, UpdateBanner suppresses a signed update entirely when the 24h-cached GitHub tag matches a prior dismissal

`src/components/UpdateBanner.jsx:130`

**What.** Two independent effects populate one `latest` slot. The GitHub-API effect short-circuits on a 24h cache (lines 62-67) and calls `setLatest({ tag: cached.tag, ... })` synchronously, then returns. The signed-updater effect is async (`await import`, `await check()`), so it always resolves second, and line 119 is `setLatest((cur) => cur || { tag: `v${up.version}`, url: RELEASES_URL })` , deliberately non-overwriting. Line 130 then gates the whole banner on `dismissed === latest.tag`, where `dismissed` is persisted in localStorage under `plutos-terminals:dismissed-update` (lines 44-50, 159). So the render gate is evaluated against the STALE cached tag, never against the version the signed updater actually has ready. `pluginUpdate` is set but nothing renders it.

**Failure.** User on 0.6.1 sees the banner for v0.6.2 and clicks "Later" (dismissed = "v0.6.2"). Two hours later a forced security patch v0.6.3 ships with a valid latest.json. On next launch the API effect hits its 24h cache, restores latest = {tag: "v0.6.2"}, and returns; the updater effect finds 0.6.3, sets pluginUpdate, but line 119 leaves latest.tag at "v0.6.2"; line 130 sees dismissed === latest.tag and returns null. The user is shown nothing at all for up to 24 hours while a verified patch sits ready to install. docs/updater.md lines 3-8 name this exact scenario as the reason the updater exists.

**Fix.** Have the updater effect win when it finds a higher version: replace line 119's `cur || …` with a comparison (`setLatest(cur => (!cur || isNewer(`v${up.version}`, cur.tag.replace(/^v/,''))) ? {tag:`v${up.version}`, url:RELEASES_URL} : cur)`), and gate dismissal on the version being offered rather than on whichever tag landed first.

### MEDIUM BRS-3, Six symlink-escape security regression tests silently pass without asserting anything, and cargo tests run only on the one platform where the primitive can be refused

`src-tauri/src/commands.rs:1967`

**What.** Six tests guard the symlink-escape vector on transcripts, rule files and notebooks , `symlinked_md_file_is_not_listed`, `read_direct_on_symlinked_target_is_err` (two of each), `symlinked_rule_file_is_skipped`, `write_onto_symlinked_target_is_err_and_target_untouched`. Each writes a file literally containing "PRIVATE KEY MATERIAL", attempts a symlink to it, and then bails: `let made = …symlink…(…).is_ok(); if !made { return; }` at lines 1967, 1986, 2650, 2878, 2913 and 2933. The bail is silent , no assertion, no eprintln, no skip marker; the test reports green. The in-code comment states the reason plainly: "symlink creation on Windows needs Developer Mode / privilege". And `.github/workflows/test.yml:25` pins the cargo job to `runs-on: windows-latest` , the only platform where that privilege can be absent. There is no second platform leg where the same tests would still execute, and macOS (which ships to users) runs no cargo tests at all.

**Failure.** If the windows-latest image ever tightens SeCreateSymbolicLinkPrivilege, or the job is moved to a non-elevated runner, all six tests degrade to no-ops and CI still reports 174 passing. A subsequent refactor of transcript_list_sync / transcript_read_sync / collect_rule_files_sync / notebook_read_sync that drops the is_symlink() check is then caught by zero tests. At runtime, a user (or an agent-mode action) plants a symlink named `linked.md` in the transcripts or notebook directory pointing at ~/.ssh/id_rsa; the app follows it and renders the private key into the webview.

**Fix.** Make the bail loud instead of silent: assert that symlink creation succeeded on at least one CI platform (e.g. `if !made { assert!(cfg!(windows), "symlink guard tests must execute on non-Windows"); return; }`), and add a `runs-on: macos-latest` cargo leg to test.yml. The keyring blocker cited in test.yml's header comment no longer applies , src-tauri/Cargo.toml:50 now enables `sync-secret-service` alongside apple-native and windows-native.

### MEDIUM BRS-4, Phantom production dependency: @lezer/highlight is imported but never declared

`src/features/terminals/PromptEditor.jsx:27`

**What.** Line 27 is `import { tags as t } from "@lezer/highlight";`. `@lezer/highlight` appears nowhere in package.json (neither dependencies nor devDependencies). It resolves today only because `node_modules/@codemirror/language` declares `"@lezer/highlight": "^1.0.0"` and npm hoists it to the top level (installed: 1.2.3). PromptEditor is a real build input , `src/features/terminals/TerminalPane.jsx:71` lazy-imports it (`const PromptEditor = lazy(() => import("./PromptEditor.jsx"))`) and renders it at line 2019 , so vite must resolve the specifier at build time. The app therefore has an undeclared, unversioned dependency on the public API of a package it does not control the range of.

**Failure.** `@lezer/highlight` releases 2.0.0 and `@codemirror/language` widens its range in a patch release (its own version stays inside the app's `^6.10.8`). Anyone who runs `npm install` or `npm update` instead of `npm ci`, or regenerates package-lock.json, gets 2.x hoisted; `tags` changes shape and `npm run build` breaks or silently produces a prompt editor with no syntax colours. The same import fails outright under any non-hoisting install (`npm install --install-strategy=nested`, pnpm's default node_modules, yarn PnP), which is the shape a fresh contributor or a container build is most likely to hit.

**Fix.** Add `"@lezer/highlight": "^1.2.3"` to package.json dependencies and re-lock.

### MEDIUM BRS-5, release.yml publishes installers with no test gate, and test.yml never runs on a tag push

`.github/workflows/release.yml:22`

**What.** release.yml triggers on `push: tags: - "v*"` (lines 22-24) and its `build` job has no `needs:` on anything and no test step , it goes straight from `npm ci` to tauri-action to publish. test.yml is `on: push: branches: ["**"]` (lines 10-12); a `branches` filter excludes tag refs, so the suite does not run on the tag. CLAUDE.md's documented release step is "commit → git tag vX.Y.Z → push branch + tag", which fires two independent push events concurrently , the branch event starts test.yml, the tag event starts release.yml, and neither waits on the other. There is nothing in the repo that makes a red suite block a publish.

**Failure.** Run the documented release (`git push origin 001-remote-sessions-parity v0.6.2`). release.yml begins building immediately. If vitest or cargo test fails on that commit, test.yml turns red some minutes later , by which time release.yml has already uploaded signed MSIs and .dmgs plus a latest.json to the public releases repo, and every installed copy's updater will offer the broken build on next launch. Tagging a commit that was never pushed to a branch skips the suite entirely, with no signal at all.

**Fix.** Either add a `test` job to release.yml that runs `npx vitest run` and `cargo test`, with `build: needs: [test]`, or convert the release trigger to `workflow_run` on a successful test.yml completion.

### MEDIUM BRS-6, test.yml declares no permissions floor and pins none of its actions, while running on every branch push

`.github/workflows/test.yml:17`

**What.** test.yml has no `permissions:` block anywhere in its 32 lines, so its GITHUB_TOKEN inherits the repository/organisation default , write-scoped unless the repo has been explicitly restricted. It uses three mutable refs: `actions/checkout@v4` (line 17), `actions/setup-node@v4` (line 18), `dtolnay/rust-toolchain@stable` (line 28, and `stable` is a BRANCH in that repo, not even a tag), plus `Swatinem/rust-cache@v2` (line 29). This is the exact inverse of the other two workflows: release.yml pins every action to a full SHA with a `# v4` comment (lines 67, 70, 75, 80, 97, 133, 147), and audit.yml declares `permissions: contents: read` (line 26). audit.yml is also unpinned but at least has the read-only floor. test.yml runs on `branches: ["**"]` , every push, on every branch.

**Failure.** An upstream compromise or a maintainer-account takeover that force-moves the `v4` tag on actions/checkout or the `stable` branch on dtolnay/rust-toolchain executes attacker code on the next push to any branch, holding a write-scoped GITHUB_TOKEN in a repo that also carries TAURI_SIGNING_PRIVATE_KEY and RELEASES_TOKEN. release.yml is immune to the same tag move; test.yml is not, and it is the workflow that runs most often.

**Fix.** Add `permissions: contents: read` to test.yml and audit.yml, and pin all four actions in test.yml (and the five in audit.yml) to full commit SHAs with a trailing version comment, matching release.yml's existing convention.

### MEDIUM BRS-7, The missing-platform assertion is skipped whenever signing is unconfigured, so an unsigned release ships uncheckedand takes every installed updater dark

`.github/workflows/release.yml:213`

**What.** The "Build updater manifest" step opens with `sigs=(*.sig); if [ ${#sigs[@]} -eq 0 ]; then echo "::warning::…"; exit 0; fi` (lines 213-221). That early exit is BEFORE the platform-completeness assertion at lines 275-282, which is the only step in the whole workflow that checks the release actually contains what the matrix was supposed to build. Meanwhile the artifact upload uses `if-no-files-found: warn` (line 137), so a build leg that produces nothing still lets its job go green. The two combine: when signing is unavailable, nothing checks completeness at all and the release is created regardless (lines 298-303). Separately, the updater endpoint is `https://github.com/plutothedev/plutos-terminals/releases/latest/download/latest.json` (src-tauri/tauri.release.conf.json:10), which resolves against whatever GitHub currently calls the latest release.

**Failure.** TAURI_SIGNING_PRIVATE_KEY expires, is rotated, or the secret is dropped when the workflow is copied to the mirror repo. Tag v0.6.2. No .sig files are produced, the step exits 0 with only a `::warning::` in the log, the platform assertion never runs, and the release is published , possibly missing a platform entirely and definitely with no latest.json. From that moment every installed 0.6.1 copy's `check()` requests /releases/latest/download/latest.json, gets a 404, and the catch at UpdateBanner.jsx:120 swallows it: auto-update is dark for the entire user base until the next correctly-signed release, with no signal to anyone. The same hole is open on the manual path CLAUDE.md documents ("built locally … and uploaded with gh release create when CI is flaky"), which produces no latest.json at all.

**Fix.** Make the empty-sigs case fail the job rather than warn (docs/updater.md lines 52-57 already argue for exactly this posture, and the workflow contradicts it), and move the platform-completeness assertion out of the latest.json step so it runs unconditionally.

### LOW BRS-8, No concurrency group on any workflow; a re-run or a second-remote run clobbers release assets from a different, non-reproducible build

`.github/workflows/release.yml:298`

**What.** `grep -rn concurrency .github/workflows/` returns nothing. The publish step is `gh release create "$TAG" … all-installers/* || gh release upload "$TAG" --repo "$TARGET_REPO" --clobber all-installers/*` (lines 298-303) , the fallback path exists precisely to handle "the release already exists". The repo has two remotes (`origin` = public plutothedev/plutos-terminals, `private` = plutothedev/plutos-terminals-app), CLAUDE.md line 19 says "Push both remotes when shipping", and both carry the same `.github/workflows/release.yml` on the working branch, so a tag pushed to both fires the workflow twice. Nothing in this project produces reproducible builds, so two runs of the same tag yield byte-different MSIs , and therefore different SHA256SUMS entries and different minisign signatures.

**Failure.** Re-run the release workflow on a tag after a flaky leg (the documented recovery), or push the tag to both remotes. The second run's `--clobber` replaces assets one at a time. During that upload window the release holds latest.json and SHA256SUMS from run B alongside a payload still from run A. A user who launches in that window downloads the run-A MSI, verifies it against the run-B signature, and gets a verification failure surfaced as "Couldn't install automatically" (UpdateBanner.jsx:152); a user running `sha256sum -c SHA256SUMS` in the same window gets a FAILED line on a genuine file.

**Fix.** Add `concurrency: { group: release-${{ github.ref }}, cancel-in-progress: false }` to release.yml, and add a guard so the workflow only publishes from the repo it is meant to publish from (e.g. `if: github.repository == vars.SOURCE_REPO`).

### LOW BRS-9, docs/updater.md still documents the Windows updater payload as .msi.zip , the exact wrong shape that caused c6fee05

`docs/updater.md:101`

**What.** Line 101 describes the flow as producing "a signed updater payload (`.app.tar.gz` / `.msi.zip`) and a `.sig` for each". The `.msi.zip` shape is Tauri v1's; commit c6fee05 exists because Tauri v2 signs the .msi directly and matching only `.msi.zip` silently omitted `windows-x86_64` from latest.json on the first real release. release.yml's own comment at lines 238-243 spells that out and now matches both shapes. The doc that a maintainer reads before touching the updater still teaches the shape that broke it. Related: release.yml line 276 hardcodes the assertion list `darwin-aarch64 darwin-x86_64 windows-x86_64` rather than deriving it from the build matrix, so re-enabling the Linux leg under the conditions written at lines 49-56 would re-arm the same silent-omission class the assertion was written to catch.

**Failure.** A maintainer following docs/updater.md to add a platform or debug a dark updater matches on `.msi.zip`, sees no error (the case arm just doesn't fire), and ships a latest.json missing that platform , the failure mode the doc's own "Verifying it works" section cannot detect, since it needs two real releases.

**Fix.** Correct line 101 to `.app.tar.gz` / `.msi` (+ `.sig`), and derive the assertion list in release.yml from the matrix rather than hardcoding it.

### LOW BRS-10, GitHub release bodies never use releases/*.md; the documented release-notes step has silently stopped happening

`.github/workflows/release.yml:301`

**What.** The publish step passes a fixed `--notes "Download the installer for your platform below. …"` string (line 301) , it never reads `releases/vX.Y.Z.md`. latest.json's notes field is likewise the literal "See the release notes for $TAG." (line 264). CLAUDE.md's Docs index calls `releases/vX.Y.Z.md` the "source for GitHub release bodies", which is not true of the automated path. And the step has quietly lapsed: `ls releases/` stops at v0.5.0 with no v0.6.0.md or v0.6.1.md, while HEAD is 0.6.1 and commit 6bf0139 is "chore(release): 0.6.1". CHANGELOG.md's top section is still "## Unreleased".

**Failure.** A user on 0.5.0 is offered v0.6.1, opens the release page to decide whether to take it, and finds boilerplate telling them to pick an installer , no statement of what changed, and no changelog entry either. For a proprietary unsigned binary that asks the user to click through SmartScreen, that is the only information they had to go on.

**Fix.** Change the publish step to `--notes-file releases/${TAG}.md` with a fallback, and add a step that fails the release when that file is missing , which also forces the missing v0.6.0/v0.6.1 notes and the stale "## Unreleased" CHANGELOG heading to be filled in.

