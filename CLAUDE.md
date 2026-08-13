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
  → push branch + tag → `.github/workflows/release.yml` builds macOS/Linux/Windows
  on the tag and uploads to the GitHub release. The Windows MSI + portable exe
  are also built locally (`npm run tauri build`) and uploaded with
  `gh release create` when CI is flaky (v0.3.5's Windows leg failed in CI).
  Release titles follow `Pluto's Terminal vX.Y.Z — <headline> (Windows)`.
  Mark the new release **latest** explicitly (`--latest`).

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
- `App.jsx` (405 L) — window shell, st/userSt providers, lock screen, migrations.
- `features/terminals/TerminalsTab.jsx` (1,404 L) — all chrome: menu bar,
  toolbar, sidebar dock, tab strip, status bar, F-key bar, ~27 modals, command
  palette. Menu/toolbar/palette arrays are `useMemo`'d and sidebar handlers are
  `useCallback`-stable so the 2.5s sysstats poll + per-token cost telemetry
  don't re-render the world. Keep new chrome arrays memoized.
- `features/terminals/TerminalPane.jsx` (1,483 L) — one xterm instance: spawn
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

- `pty.rs` (1,179 L) — local PTY (portable-pty/ConPTY) + SSH shell sessions
  (libssh2), reader threads, scrollback persistence v3 (reader-thread-owned,
  atomic truncation), kill+wait reaping, 4 MB outbound buffer cap, UTF-8
  chunk-boundary carry (never split multibyte — applies to every reader loop).
- `commands.rs` (887 L) — store (atomic tmp+rename), pickers, git status/diff,
  npm scripts, scrollback/transcript IO, `mcp_install` (allowlist-guarded),
  `check_command_version`, window spawning.
- `companion.rs` (786 L) — phone companion HTTP/WS server (axum) + web-push;
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

- No signed updater channel (needs code-signing certs ~$400/yr; UpdateBanner
  links to GitHub releases instead).
- CSP still allows `unsafe-eval` (Monaco requirement); the webview is the
  privilege boundary — keep new IPC commands narrow.
- `main` branch / public README intentionally lag the working branch.
