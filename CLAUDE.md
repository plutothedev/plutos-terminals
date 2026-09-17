# Pluto's Terminal — Codebase

Free (proprietary-licensed) desktop terminal workstation for the Pluto community.
Tauri 2 + React 18 + Vite + xterm.js. One window holds a saved-session tree, a
multi-panel/tab/split terminal grid, SSH/SFTP/serial/RDP/VNC, an AI assistant +
agent mode against ~16 LLM providers, a Warp-style prompt editor (beta), and a
phone companion server. Windows is the primary target; macOS/Linux build via CI.

> **Vault meta lives at:** `C:\Users\pluto\Documents\pluto-mind\03 Projects\plutos-terminals\`
> (CLAUDE.md, roadmap.md, iteration-log.md). Strategic context + project history
> live there; this file is the codebase-level map.

## Repo / distribution model

- `origin` = **github.com/plutothedev/plutos-terminals** (PUBLIC) — releases +
  download surface. Source on the working branch is visible there; license is
  proprietary (source-available, not open source). Versions ≤ v0.1.32 remain MIT.
- `private` = **github.com/plutothedev/plutos-terminals-app** (PRIVATE) — mirror.
  Push both remotes when shipping.
- Working branch: **`001-remote-sessions-parity`** (long-running; `main` is the
  stale v0.2.0-era branch kept for the public landing README).
- **Release process:** bump version in `package.json` + `src-tauri/Cargo.toml` +
  `src-tauri/tauri.conf.json` (must match; `src/appMeta.js` reads package.json) →
  write `releases/vX.Y.Z.md` + `CHANGELOG.md` entry → commit → `git tag vX.Y.Z`
  → push the BRANCH to both remotes and wait for the `test` workflow to go green
  (a tag push runs no tests: `test.yml` triggers on branches only, and
  `release.yml` only builds) → push the TAG to origin ONLY: the private mirror's
  copy of `release.yml` also publishes to the public repo through `RELEASES_REPO`,
  so a tag on both remotes races two publishes of one release (v0.6.1 shipped from
  origin) → `.github/workflows/release.yml` builds macOS + Windows
  on the tag (Linux is cut from the matrix), asserts the tag matches all three
  version files, asserts every matrix platform produced an installer, assembles
  the signed `latest.json` and asserts it carries `darwin-aarch64` +
  `darwin-x86_64` + `windows-x86_64`, then publishes. **A tag push is the only
  path that publishes.** A manual dispatch from the Actions tab builds the
  matrix and uploads the installers as workflow artifacts; the publish job is
  gated on the event and never runs for it.
  This bullet is the one canonical copy of the procedure: `docs/updater.md`
  (signing key, trust model, updater mechanics) and the header comment in
  `release.yml` point here rather than restate it, because three copies is how
  they drifted apart in the first place.
  **When a run fails:** a flaky build leg (v0.3.5's Windows leg failed in CI) →
  re-run that failed job on the same tag. No `.sig` files, i.e.
  `TAURI_SIGNING_PRIVATE_KEY` unset → the manifest step fails the release on
  purpose; restore the secret and re-run **all** jobs on the tag. Re-running
  only the failed publish job re-downloads the same unsigned artifacts from the
  build that already succeeded, so it fails identically.
  Do NOT ship the local `npm run tauri build` output by hand instead: local
  builds never load `src-tauri/tauri.release.conf.json`, so they carry no `.sig`
  and no `latest.json` can be assembled from them, and a hand-uploaded release
  also skips both of the workflow's completeness assertions (an installer for
  every matrix platform, and every platform key present in `latest.json`).
  Publishing one as the newest release points
  `/releases/latest/download/latest.json` at a 404 and takes auto-update dark
  for every installed copy (audit BRS-7).
  If a build genuinely has to go out before CI can sign it, the only survivable
  shape is `gh release create --prerelease` (never the newest release). Do not
  expect it to carry a signed manifest: it cannot. Nothing signed it, and a
  locally built copy has the empty pubkey, so its own updater is inert. What it
  buys is that `/releases/latest` keeps resolving to the last signed release, so
  the installed base keeps updating. It is a stopgap, not a release path: the
  tagged CI run still has to happen.
  Release titles follow `Pluto's Terminal vX.Y.Z — <headline> (Windows)`.

## Dev commands

```powershell
cd C:\Users\pluto\plutos-terminals
npm install
npm run tauri dev          # dev app (Vite on :5310 + cargo build)
npm run build              # frontend-only compile check (fast)
cd src-tauri; cargo check  # backend-only compile check
npm run tauri build        # release MSI + portable exe (~minutes)
scripts/clean-and-dev.bat  # kill stale processes + clean dev start
```

> **Release-build gotchas (git-bash):**
> 1. The vendored OpenSSL build (`openssl-sys`, pulled in by `ssh2` + `web-push`)
>    needs a real perl. Git-bash puts MSYS perl first on PATH, which lacks
>    `Locale::Maketext::Simple` and fails `Configure`. Prepend Strawberry first:
>    `export PATH="/c/Strawberry/perl/bin:$PATH"`.
> 2. `npm run tauri build` exits 1 even on success: `bundle.targets` is `"all"`
>    and the NSIS bundler always dies on the apostrophe in the product name
>    (`NSISCOMCALL` macro error) — *after* the MSI is already produced. Check
>    for the `.msi` in `target/release/bundle/msi/`, don't trust the exit code.
>    (Config stays `"all"` because the CI macOS leg reads bundle targets from
>    config; don't narrow it to `["msi"]` without testing a mac CI run.)

## Frontend architecture (`src/`)

Two persistence layers, both localStorage-backed (see `storageKeys.js`):
- **Per-window state `st`** (layout, panels/tabs, skin) — `App.jsx` owns it;
  `save()` accepts a value **or functional updater** (always prefer
  `save(prev => …)`; whole-blob `save({...st})` after an `await` is the
  lost-update footgun that bit us repeatedly).
- **User state `userSt`** (provider API keys, keybindings, custom themes,
  snippets) — shared across windows; API keys mirror into the OS keychain and
  are **stripped from localStorage** once mirrored. Anything that needs keys at
  runtime must read via `readUserSt()` (keychain-overlaid), never raw
  localStorage — a raw read silently sees no keys on a healthy system.

Key files:
- `App.jsx` (592 L) — window shell, st/userSt providers, lock screen, migrations.
- `features/terminals/TerminalsTab.jsx` (1,373 L) — all chrome: menu bar,
  toolbar, sidebar dock, tab strip, status bar, F-key bar, ~27 modals, command
  palette. Menu/toolbar/palette arrays are `useMemo`'d and sidebar handlers are
  `useCallback`-stable so the 2.5s sysstats poll + per-token cost telemetry
  don't re-render the world. Keep new chrome arrays memoized.
- `features/terminals/TerminalPane.jsx` (2,185 L) — one xterm instance: spawn
  (local PTY / SSH / serial transports), OSC 133/1337 handling, scrollback
  replay, command blocks, auto-approve, find, recording. Pure string builders
  are extracted: `welcomeBanner.js`, `shellIntegration.js` (POSIX + PowerShell
  prompt/OSC setup), `spawnEnv.js` (provider-key → env resolution).
- `features/terminals/hooks/` — the workspace reducer (`useWorkspaceTree`, all
  mutations go through `stateRef`), spawn/dispatch, telemetry (cost emission
  throttled to 1 Hz/tab), tunnels, SFTP dock, snippets, workspaces, etc.
- `features/terminals/ptyBridge.js` — singleton event bridge between Tauri PTY
  events and panes (second state manager outside React; treat with care).
- `splitTree.js` / `workspaceModel.js` — flat %-positioned split tree; panes
  never remount on layout changes (PTYs survive splits/drags — invariant).
- `providers.js` — LLM provider catalog + `envForModel()` env-var injection.
- `keybindings.js` + `KeybindingsSection.jsx` — remappable shortcuts; resolved
  map cached module-level (`setResolved`) — mutate only from effects, never
  during render.
- Component idioms: functional components, inline styles consuming `--phn-*`
  CSS vars from `headerSkins.js` (refined-dark default since v0.4.0), `Toast`/
  `ConfirmModal` instead of native dialogs, monochrome stroke icons from
  `toolbarIcons.jsx` (no emoji in chrome).

## Backend architecture (`src-tauri/src/`)

Worker-thread-per-session model: each transport spawns a thread (or tokio task)
owning the connection; an mpsc channel receives writes; dropping the session
struct tears it down. Sessions live in Tauri-managed registries. Output reaches
the webview via `pty://…` events after a `pty_ready` handshake.

- `pty.rs` (2,162 L) — local PTY (portable-pty/ConPTY) + SSH shell sessions
  (libssh2), reader threads, scrollback persistence v3 (reader-thread-owned,
  atomic truncation), kill+wait reaping, 4 MB outbound buffer cap, UTF-8
  chunk-boundary carry (never split multibyte — applies to every reader loop).
- `commands.rs` (3,149 L) — store (atomic tmp+rename), pickers, git status/diff,
  npm scripts, scrollback/transcript IO, `mcp_install` (allowlist-guarded),
  `check_command_version`, window spawning.
- `companion.rs` (920 L) — phone companion HTTP/WS server (axum) + web-push;
  Tailscale serve integration (torn down on stop); blocking IO via
  `spawn_blocking`; subscribe dedup + cap.
- `rdp.rs` / `vncclient.rs` — remote desktop sessions (IronRDP / vnc-rs); RDP
  pins server certs SPKI trust-on-first-use (`rdp-known-hosts.txt`); VNC
  validates PixelFormat + handshake timeouts.
- `sftp.rs`, `forward.rs` (tunnels), `sshconfig.rs` (config import, keygen),
  `netools.rs` (ping/traceroute/ports/DNS), `llm.rs` (chat completion proxy +
  SSE streaming; check HTTP status before JSON), `sysstats.rs`, `vault.rs`
  (OS keychain), `session.rs`, `lib.rs` (app entry, tray, command registration).
- **Conventions:** new blocking commands must be `async fn` (UI freezes were the
  #1 perceived-quality bug; only `rfd` dialog commands stay main-thread for
  macOS). Secrets never touch argv or plaintext disk. File writes that matter
  are tmp+rename. snake_case Rust / camelCase JS across the IPC boundary.

## Static analysis (added 2026-08-21)

```powershell
npx eslint .                  # react-hooks + jsx-a11y; 279 errors at baseline
npx knip                      # dead files / unused exports / unlisted deps
cargo clippy --all-targets    # 3 warnings from gateable at -D warnings
cargo deny check licenses     # BLOCKING in CI; clean on win/linux/macos trees
semgrep scan --metrics=off --config=p/javascript --config=p/rust
```

`.github/workflows/static.yml` runs all five. Only `licenses` blocks; the rest
are reporters (`continue-on-error`) because each has a real backlog, and each
job comments the exact condition for flipping it to blocking. Config lives in
`eslint.config.js` and `src-tauri/deny.toml`.

Semgrep must be the LOCAL CLI. The Claude Code Semgrep plugin routes scans
through Semgrep's hosted server, which would send this proprietary source
off-machine.

## Cross-cutting invariants

1. **PTYs survive React.** Layout changes must never remount a live pane.
   (Known accepted gap: `moveTab` across panels kills + respawns — fixing it
   needs a pane registry outside React; `ptyBridge` is most of the way there.)
2. **`readUserSt()` for keys** — never raw localStorage (keychain stripping).
3. **Functional `save()` updaters** — never spread a captured `st` after await.
4. **Cancelled-flag around `await listen()`** in effects (see
   `TerminalsTab.jsx` ~470) — a leaked listener pins a disposed xterm.
5. **UTF-8 boundary carry** in any new byte-stream reader.
6. **`(C)` marker** on Claude-authored files; comments explain *why*/invariants.
7. Run `npm run build` + `cargo check` before claiming a change compiles; do a
   dev-binary restart test after touching component top-level hook order (the
   v0.1.3 TDZ blank-screen lesson).

## Docs index

- `docs/audit-2026-08-21/FIXES-COMPLETE.md` — the audit's fixes, ALL APPLIED (working
  tree, uncommitted). Final state, per-batch closeouts, what was reverted and why,
  and what is still open. Read this before the audit doc itself.
- `docs/full-audit-2026-08-21.md` — CURRENT audit (66 agents, 13 teams, 73
  findings, adversarial refutation, plus a deterministic scanner baseline and a
  live runtime pass). Per-team detail in `docs/audit-2026-08-21/teams/`, raw
  scanner output + the IPC manifest in `docs/audit-2026-08-21/00-baseline/`, the
  live UI pass in `docs/audit-2026-08-21/runtime-ui-pass.md`.
- `docs/full-audit-2026-08-14.md` — prior audit @ `8c40c62`; all 30 findings
  fixed by 8/16. The 8/21 pass re-verified every one: all present at HEAD, but
  C2, C3 and C4 each traded one failure mode for another.
- `docs/full-audit-2026-06-09.md` — last full audit; P1/P2 fixed (commits
  `ee805c1`, `45d63e6`), P3 items #24–#26 partially done, #16 (signed updater),
  #27–#29 open by choice.
- `docs/security-audit-2026-06-08.md` — security pass (criticals + 19/22 highs
  closed in v0.3.6).
- `specs/001-remote-sessions-parity/` — the SSH/remote-parity feature spec that
  named the branch. `design/` + `design-mockups/` — reskin research; mockup 23
  ("refined") is the shipped v0.4.0 look.
- `releases/vX.Y.Z.md` — per-release notes (source for GitHub release bodies).

## Known open items (deliberate, not forgotten)

- Binaries are still UNSIGNED (code-signing certs ~$400/yr), so SmartScreen and
  Gatekeeper still warn on first launch. The signed UPDATER channel, which is a
  different thing, DID ship in v0.6.1: minisign keypair, `createUpdaterArtifacts`
  + pubkey live in the release-only overlay `src-tauri/tauri.release.conf.json`
  (kept out of the base config so local builds do not need the private key), and
  CI assembles `latest.json`. Verified live 2026-08-21: the published manifest
  carries darwin-aarch64, darwin-x86_64 and windows-x86_64, each signed.
- CSP still allows `unsafe-eval` (Monaco requirement); the webview is the
  privilege boundary — keep new IPC commands narrow.
- `main` branch / public README intentionally lag the working branch.
