# Changelog

## v0.7.0: Audit closeout, keyboard-complete chrome, Light-skin correctness (2026-09-17)

The whole 2026-08-21 audit (73 findings across 13 review teams,
`docs/full-audit-2026-08-21.md`), applied in four reviewed batches and then
re-reviewed as one tree by four independent adversarial passes before this tag
(no critical or high finding survived; what they did find is fixed below or
listed under "Known, deliberately open"). The keyboard features make this a
minor bump rather than a patch.

### Added
- **Tab keyboard navigation.** Ctrl+Tab / Ctrl+Shift+Tab cycle tabs and
  Alt+1..9 jump to a tab by position, all remappable under Settings →
  Keybindings → Tabs. (Alt+digit does not fire on macOS, where Option composes
  a character; Ctrl+Tab works everywhere.)
- **The tab strip is a real tablist.** Arrow keys, Home and End move between
  tabs, exactly one tab sits in the Tab order (roving tabindex), Delete closes,
  F2 renames, and Shift+F10 or the Menu key opens the tab's context menu, which
  is itself a keyboard menu: arrows walk it, Escape or Tab leave it, and focus
  is handed back to the tab afterwards instead of falling to the page.
- **Every control in the chrome is reachable by keyboard.** The collapsed
  sidebar and dock rails are buttons now (collapsing a panel from the keyboard
  used to be a one-way door, because the rail that reopens it was click-only
  and the collapsed state persists across restarts); form fields carry their
  labels; a visible focus ring follows the skin (`--phn-focus-outline`).
- **Static analysis in CI** (`static.yml`): eslint with react-hooks and
  jsx-a11y, knip, clippy, cargo-deny and semgrep. Only the licence check
  blocks; the rest report, each with a written condition for flipping it to
  blocking. A token gate test now fails the suite when any skin lacks a colour
  token another part of the app uses.

### Fixed
- **Detach to new window no longer destroys the session.** The new window was
  seeded without the wrapper it reads, then the source tab was closed anyway.
- **Scrollback cleanup can no longer delete an open tab's history.** The same
  nesting bug made the keep-set empty, so the age-based sweep saw every tab as
  closed.
- **SSH host-key pinning no longer rewrites your `~/.ssh/known_hosts`** from a
  partial parse. It appends only, repairs a missing trailing newline, refuses
  to pin when the file cannot be fully read, and treats hashed, marker and
  non-UTF-8 lines as "ask" instead of "unknown host". Windows usernames with
  non-ASCII characters can connect again (a fail-closed branch fired whenever
  the SSH library's narrow file open failed on a path the app could open).
- **SFTP staged uploads keep the destination's permissions** (a 0600 key file
  came back 0644 after the atomic-rename fix), and the staging file is opened
  exclusive so a symlink pre-planted at the predictable temp name cannot
  redirect the upload.
- **Workspace backup recovers from a missing blob**, not only a corrupt one,
  and boot recovery, autosave and factory reset no longer race each other: a
  boot prompt could suspend the durable mirror forever, a write hold could
  wedge autosave for the whole session, and a recovery that resolved after a
  factory reset could repopulate the backup the reset had just emptied.
- **"Later" on an update no longer hides a newer security patch for 24 hours.**
- **Chrome actions target the pane you are in, not a hidden one.** Ask AI →
  Run, macros, recording and broadcast addressed the tab instead of its active
  pane, so they ran in an unfocused split (possibly a different host) and went
  dead once the split's original pane closed.
- **Light skins.** `--phn-text-bright` and five more tokens were used but never
  declared, leaving the Assistant input and Monitor values invisible on Light;
  every token is now declared in all 14 skins, including the accent wash that
  11 skins had been painting with a fixed fallback colour. Light-theme contrast
  failures went from 27 to 4; the 12 dark skins are pixel-identical.
- The AI cost readout latched every model to the Opus price, so Sonnet and
  Haiku spend read 5 to 10 times high.
- Factory reset now says what it does: secrets in the OS keychain (API keys,
  saved SSH passwords) are not removed by it; delete those from Models or the
  session tree first.
- Tests that were not testing: three asserted on copies of the guard they were
  named for, six symlink-escape tests asserted nothing on Windows, and the IPC
  contract test compared two nulls. All now exercise production code, with a
  macOS cargo leg in CI where symlinks can actually be created.

### Release and CI
- **The release workflow refuses to ship a mismatch.** A tag whose version
  differs from `package.json`, `Cargo.toml` or `tauri.conf.json` fails before
  the build (an installer stamped older than its manifest would trap every
  client in an update loop). It asserts an installer for every matrix
  platform, fails instead of warning when no signature exists (an unsigned
  "latest" would 404 every installed copy's updater), and never publishes from
  a manual run.
- All GitHub Actions in every workflow are pinned to commit SHAs, with
  read-only token floors; `cargo-deny` licence check blocking.
- Dependency advisories cleared: js-yaml 4.3.2, cryptoki 0.10.1,
  rustls 0.23.45.

### Known, deliberately open
- 241 eslint errors remain (mostly react-hooks/refs, static-element
  interactions and set-state-in-effect), reported, not blocking.
- The `default` skin measures 45 contrast failures, pre-existing; the primary
  menu bar (File / Sessions / Tools ...) has no ARIA menu semantics yet, unlike
  the tab context menu.
- VNC: the client library is unmaintained and does not bound every field it
  parses, so a malicious VNC server can crash the app. Connect only to servers
  you trust, preferably through the SSH tunnel.
- A PEM fragment with both banner lines severed stays undetectable by the
  share scanner, by design (bare base64 needs the entropy heuristic the
  scanner declines).

## v0.6.1: Performance overhaul, guided tour, MobaXterm redesign, signed updates (2026-08-16)

The public `v0.6.0` tag was cut against the old v0.2.0 commit and never
carried real content, so it was never really shipped: v0.6.1 is the first
public release since v0.5.0, and includes everything under v0.6.0 below plus
150 more commits (a four-stream performance pass, a six-dimension audit with
30 findings closed, a MobaXterm-styled redesign, a 25-stop guided tour, and a
signed auto-updater).

### Added
- **Split panes, the modern way.** Four new surfaces for one mental model:
  - **Keyboard**: Ctrl+Shift+D splits right, Ctrl+Shift+S splits down,
    Ctrl+Shift+X closes the focused pane (splits only, never the tab), and
    Ctrl+Alt+Arrows move focus between panes geometrically (on macOS that's
    ⌘⌥-arrows, Warp's default). All remappable under Settings → Keybindings →
    Panes. Focus nav moves real keyboard focus, not just the highlight.
  - **Hover controls on every pane**: a translucent cluster (split right /
    split down, plus zoom / close on split tabs) fades in at the pane's
    top-right corner (no trip to the toolbar), and the action lands on the
    pane under your cursor instead of the "active" one. Splitting a zoomed
    pane un-zooms first so you see what you made.
  - **Drag a tab onto a pane** to split there: edge zones (VS Code-style)
    show an accent preview of the half the tab will take; drop folds the
    tab's live terminal into that side, and the PTY survives via the pane
    registry. Center drops keep the classic move-to-panel behavior. Remote
    (SSH/serial) tabs keep the classic drop only: pane leaves don't carry
    connection config yet, so a merged remote tab would respawn local after
    a restart.
  - **Dividers**: double-click resets a divider to 50/50; "Equalize splits"
    (palette + Terminal menu) resets every divider in the tab.
- "My shares" lists newest first and paginates (25 per page + "show more")
  instead of rendering every share oldest-first in one unbounded list.
  (Deferred item from the 2026-08-03 forward-risk review.)
- The cloud-sync repo now compacts itself: once a push leaves ~64 accumulated
  loose git objects behind, the local clone is swapped for a fresh clone
  (shallow where the transport supports it); previously it grew forever,
  since libgit2 never garbage-collects. Compaction runs only immediately after
  a successful push (local == remote, so it is lossless) and can never fail
  the push. (Deferred item from the same review.)
- sync_git unit tests now pass on macOS/Linux: the test-only `file://` URL
  helper produced an invalid four-slash URI for Unix absolute paths, so the
  suite had only ever run green on Windows.
- **About dialog** (Help → About Pluto's Terminal): version, license, and
  links to GitHub, Discord, and the changelog.
- `SECURITY.md`: how to report vulnerabilities, plus a summary of the app's
  security posture and links to the two full-codebase audits.
- **Readable errors.** Raw backend errors ("[Session(-18)] …", "os error 2")
  are now translated to plain sentences ("Authentication failed, check your
  credentials", "File not found") everywhere they surface (toasts, SFTP,
  tunnels, RDP/VNC status, AI panels, sync), with the full raw error kept for
  diagnostics. Error toasts stay up 8s (was 4s) and clicking one copies the
  raw error to the clipboard for bug reports; toasts are also announced to
  screen readers now.
- **A 25-stop guided tour**, offered on first run and replayable from Help
  → Take the tour: an in-house spotlight overlay walks the chrome, session
  tree, grid, and tools dock, with Tab trapped inside the tour card.
- **Right-click pastes into the shell**, PuTTY-style, via xterm's
  bracketed-paste path so a multi-line paste can't auto-execute in a
  full-screen app.
- **The OS window title now mirrors the active tab** ("session name -
  Pluto's Terminal", MobaXterm-style) in the titlebar, taskbar, and Alt+Tab.

### Changed
- One product name everywhere: **Pluto's Terminal** (singular) across the
  README, LICENSE, docs, and in-app strings, matching the shipped window
  title and installer name.
- **The window remembers its size, position, and maximized state** across
  launches (visibility is deliberately not tracked, so quitting from the tray
  while hidden can't save an invisible boot state).
- **No more white flash at boot.** The window and page pre-paint the app
  background before anything loads: dark by default, light when your saved
  skin is light.
- **Light theme fixes:** the tab strip now follows the Light skin (it was
  stuck dark on a light page, since the strip read a CSS token no skin
  defined), and Light's secondary/faint text colors were bumped to readable
  contrast.
- Close buttons use one glyph (✕) everywhere; the update banner's buttons are
  now "Download" / "Later".
- **Tabs and the boot banner now match the MobaXterm reference**: trapezoid tabs (18° flare, domed shoulders, gloss) replace the
  old flat pill tabs, and the ASCII boot banner is back at full size after
  fixing the width-measurement bug that had forced it borderless.
- **App-wide copy sweep**: 44 control renames, "Workflows" as the one name
  for saved commands, capitalized button voice, plus a rewritten onboarding.
- Vivid ANSI restored in the Dark/OLED palettes; custom themes now get any
  missing ANSI slot auto-filled instead of showing gaps.

### Removed
- Legacy prompt-pack files (`prompt-packs/`, the pack-submission issue
  template, and the pack sections of CONTRIBUTING.md); packs were retired at
  v0.1.7.

### Fixed
- **Six-dimension audit (2026-08-14): 30 findings, all closed** (5 critical,
  8 high, 11 medium, 6 low; six load-bearing ones re-verified directly
  against the code). Worst five: OSC 1337 command reports (a remote host
  could inject a hidden `PlutoCmd=` sequence into persistent cross-session
  history for a later one-click "re-run") are now nonce-gated per session;
  SFTP upload/download used to truncate the destination before streaming, now
  staged to a temp file and renamed into place; workspace/session-tree state
  lived in one localStorage blob with no backup and reset silently on
  corruption, now mirrored through the durable Rust store with a recovery
  offer; a render crash in one pane used to kill every other live session in
  the window, now contained per pane instead of by the single app-wide
  boundary; two windows editing the same notebook could race the same temp
  file, now locked per target path. Also closed: a stalled disk no longer
  wedges the status bar, recordings checkpoint to disk instead of living
  only in memory, ssh-keygen/RDP connects moved off the UI thread, Agent
  Mode's Stop now actually stops a pending approval, and the secret scanner
  catches bare AWS-style keys, env-dump shapes, and base64/hex secrets.
- **Launch-hardening pass (2026-08-16)**, a second sweep across cold start,
  crash paths, and distribution: an uncoerced error toast used to blank the
  whole window with no way back in, now caught by an outermost boundary; a
  bad settings value could crash and, because a top-level crash used to kill
  every session, take every live connection with it; a fresh Windows
  install's Setup Checker misreported npm, npx, and the Claude Code CLI as
  missing (the probe couldn't see `.cmd` shims), now routed through `cmd /c`
  behind a strict allowlist; a keyring with no Linux backend silently wiped
  stored secrets on next launch; published SHA256SUMS never matched what
  GitHub actually serves.
- Replaced the dead Discord invite (was 404ing) across the binary, welcome
  banner, README, `SECURITY.md`, and `CONTRIBUTING.md`; the new one is
  verified to never expire.

### Performance
Four audit-first streams, back to back (2026-08-12/13):
- **PTY hot path**: coalesced output emits (~8ms/64KB instead of per 4KB
  read), O(1) scrollback rotation instead of rewriting up to 15MB inline, a
  256KB async scrollback restore instead of a blocking 10MB read, and
  spawn/kill/transcript writes moved off the main thread.
- **Render containment**: `TerminalPane` is memoized with stable callbacks,
  tab activity moved to a sliced store so switching tabs stops re-rendering
  the app, and 23 of 24 modals render conditionally instead of always.
- **Network/LLM**: every AI surface streams (first token, not last, with a
  real cancel path), Anthropic prompt caching stops agent runs from paying
  O(n²) tokens, and MCP/SFTP/update-check lookups are cached, not re-fetched.
- **Bundle/boot**: Monaco dropped from 15.7MB to 6.6MB (basic tokenization
  instead of full CSS/HTML/TS language services), the font subset dropped
  from 2.59MB to 428KB, and heavy panes defer loading until actually shown.

### Release
- **Signed, in-place auto-updates.** Releases now ship a minisign-signed
  payload; the app verifies it against a public key baked into the build
  before installing, so controlling the GitHub assets alone can't push code,
  only the private key can. Updates install in place and relaunch; older
  versions have no updater and need one manual install to join the chain.
- **Linux is cut from this release's build matrix** (reversible, conditions
  noted next to the disabled leg): it shipped every prior release without
  ever running by CI or by hand, a Linux keyring gap was found silently
  wiping stored credentials during this pass, and the canvas renderer is
  Windows-verified only.
- Fixed the Windows updater manifest: built for Tauri v1's `.msi.zip`
  naming, it never matched Tauri v2's actual `.msi` output, so `latest.json`
  silently omitted Windows entirely; the release job now asserts every
  platform is present before publishing.

## v0.6.0 — Agent context, notebooks, saved prompts, gist sharing (2026-08-03)

### Added
- Agent mode reads project context before its first turn: AGENTS.md / CLAUDE.md
  rule files (cwd up to the git root; symlinks skipped; each file requires a
  one-time in-chip approval of its exact content before it is ever sent, and
  re-approval when the content changes), git branch + dirty state, top-level
  dirs, npm scripts, and a global user Rules text (Settings → Agent, cloud-
  synced). Capped at 16 KB, secret-scanned and masked before it reaches the
  model, shown in a context chip with an exact-text preview, toggleable.
  Rule files are data: they cannot authorize destructive actions or enable
  auto-run.
- Shared secret scanner (`secretScan`) covering AWS (AKIA/ASIA), GitHub
  PATs, provider `sk-`/`sk_` keys, Slack tokens (incl. xapp), spanning PEM
  private-key blobs (with an unpaired-BEGIN fallback), and JWTs; used to mask
  the agent context block.
- **Notebooks** — a new tab type: runnable markdown documents. Shell code
  blocks get a Run button that sends the command to a chosen terminal pane and
  writes the captured output back into the document as an `output` fence
  (rerun overwrites it). Files are plain `.md` under an app-data notebooks
  folder (git-friendly, atomic saves, 2s autosave; same-notebook saves are
  strictly ordered so a close mid-autosave can't revert your last edit).
  Editor is Monaco with a plain-textarea fallback. Nothing runs without an
  explicit click. v1 runs single-line commands; multi-line blocks are shown
  but not run (v1.1). New / Open notebook live in the Terminal menu; typed
  names are sanitized to a safe filename. Known limits: a single line with an
  unclosed quote/paren isn't detected as incomplete and can leave the target
  pane waiting for more input; killing the app the hard way (Task Manager /
  kill -9) can drop the final unsaved ~2s of edits.
- **Saved Prompts** — a reusable AI-prompt library (Tools → Snippets drawer,
  Prompts section), synced across machines. Type `/` in the AI assistant or
  agent goal box to fuzzy-search and insert a saved prompt.
- **Share to GitHub gist** — right-click a command block ("Share block...") or a
  tab ("Share transcript...") to publish it as a gist. A preview shows exactly
  what will upload, secret-scanned and masked first (API keys, tokens, PEM
  blocks, JWTs are hidden before anything leaves your machine). Secret-gist by
  default (note: secret gists are unlisted, not private). The URL is copied to
  your clipboard; "My shares" (Tools menu) lists and revokes them — a revoke
  whose delete fails is durably marked "still live" in the list. Paste a
  gist-scope token in Settings → Sharing, or use the `gh` CLI. Share history
  stays on this machine (not synced). Very large shares are truncated to the
  most recent portion (the preview says so). On a split tab, "Share
  transcript..." shares the root pane's session.

### Changed
- Moving a tab to another panel now keeps its live terminal: the running
  process, scrollback, scroll position, command blocks, cost/token counters,
  and any in-flight agent command all survive the move (previously the
  session was killed and respawned, retyping start commands). A pane
  registry outside React owns each terminal; closing a tab/pane/panel,
  loading a workspace, resetting the workspace, locking the app, or a
  crashed UI still tear sessions down fully.
- "Copy output" / "Copy command + output" on a block now join soft-wrapped
  lines instead of inserting a newline at the pane width — the copied bytes
  for wrapped lines changed (this is what keeps a wrapped secret scannable
  for the share flow's masking too).

### Security
- Secret masking now covers a private key that was cut in half by a size
  limit, in both directions — previously a PEM block missing its `BEGIN`
  line was not detected at all, and one missing its `END` line had only its
  banner masked while the key material itself went through. Affects the
  gist-share preview/upload and the agent context block. Masking recognizes
  key material next to a banner even when the capture is messy (terminal
  padding, blank or short lines inside the block, several partial keys in
  one transcript). It still cannot recognize a fragment where *both* banner
  lines were cut away — nothing in it identifies bare base64 on sight, by
  design, since ordinary command output is full of hashes and base64.
  Always eyeball the preview before sharing.

### Fixed
- Session transcripts are now cleaned up automatically: day-folders older than
  90 days are removed, and the sweep runs daily rather than only at startup
  (closing the window hides to the tray, so a long-running app never used to
  reclaim anything). Previously transcripts grew forever with no way to clear
  them from inside the app.
- A failed transcript write is reported to the console instead of being
  discarded silently.
- Agent-mode command capture no longer aborts when its tab is moved between
  panels mid-command.
- Cost/token telemetry no longer jumps backward after moving a tab.
- Jump-host tunnels are torn down on every abort path of an SSH connection
  (previously a spawn interrupted at the wrong moment could leak the tunnel).

### Internal
- The main terminals view was decomposed: menu bar, toolbar, status bar,
  F-key bar, right-dock tab strip, the ~24 modals, and the command-palette
  command list now live in focused `chrome/` modules (behavior-identical;
  every moved block byte-verified). TerminalsTab.jsx shrank from 1,448 to
  ~1,090 lines. Dead code swept (MobaRibbon, unused icons, orphaned handlers).

## v0.5.0 — Security hardening + reliability pass (2026-07-06)

Bundles the remote-sessions-parity work (SSH/SFTP/RDP/VNC/tunnels, phone
companion, cloud sync, native agent + MCP, prompt editor beta) with a full
adversarial security audit and a production-readiness pass.

### Security
- Full multi-subsystem audit (state persistence, remote transports, MCP, and the
  companion server). No critical or exploitable-high found. Closed the
  defense-in-depth tail: IPv6 private-range classification in the LLM proxy,
  atomic MCP-config writes with a serialized add/remove cycle, an RDP
  known-hosts TOCTOU lock (plus poison recovery), worktree-command guards, and a
  masked in-app token prompt (was a cleartext `window.prompt`).

### Fixed
- **Quit** confirmation crashed the whole UI into the error screen (an object was
  passed where a string message was expected). Quit now confirms and exits
  correctly, and the confirm modal fails soft on a non-string message.
- **SFTP** New-folder / Rename used native OS prompts; both now use branded
  in-app input modals (new `usePrompt()` hook).
- Agent-mode command capture no longer stalls ~120s when its tab is closed
  mid-command.
- The error explainer no longer overwrites a newer answer with a slow stale one.
- Keystroke-macro recording is capped (256 KB) so a runaway recording can't grow
  memory without bound.
- Closed three lost-update save sites (master-password set/remove, theme delete).

### Added
- Modals are accessible dialogs: `role="dialog"`, `aria-modal`, a Tab focus
  trap, and focus restored to the trigger on close; only the topmost stacked
  modal responds to Escape.
- 14 regression tests (master-password verifier, macro scoping/cap, ptyBridge
  capture, IPv6 classification, MCP metachar-guard rationale).

### Changed
- In-app copy: "open-source" / "MIT" → "source-available" to match the
  proprietary / source-available license (earlier MIT-published versions
  remain MIT). The lock screen now follows the active skin instead of stock dark.

### Install
- First launch on unsigned builds now has per-OS recovery steps in the README
  (macOS Gatekeeper right-click → Open / `xattr` quarantine clear; Windows
  SmartScreen → Run anyway). Code signing is still pending.

## v0.4.3 — OLED Black by default (2026-06-10)

### Changed
- OLED Black is the default skin: fresh installs and installs still on the old
  default dark ("moba") switch to `oled` via a one-time migration; explicit
  picks (Light, custom themes, legacy skins) are preserved. Sun/moon toggle
  now flips OLED ⇄ Light; OS-sync dark slot defaults to OLED.

## v0.4.2 — OLED Black theme (2026-06-10)

### Added
- **OLED Black** appearance (Settings → Appearance, third option next to
  Dark/Light): true `#000000` on every surface including the terminal;
  hairline borders carry the structure. Selectable in the OS-sync slots too.

## v0.4.1 — Clean terminal boot (2026-06-10)

### Fixed
- New/restored local panes no longer flash the echoed shell-integration setup
  ("wall of code") before the welcome box: the PTY stream is concealed until a
  boot marker emitted right before the clear, with a 4s/64KB flush failsafe.
  Setup noise is also kept out of saved scrollback and transcripts.

## v0.4.0 — Refined-dark reskin + stability overhaul (2026-06-10)

### Changed
- **Refined-dark reskin** (design mockup 23): new default token set — luminance
  ladder, hairline borders, a single periwinkle accent, pill tabs, monochrome
  stroke icons. Emoji and the stale blue/magenta accent hexes swept from chrome.

### Fixed (stability — full-audit P1/P2)
- **Spawned shells get API keys again** after the keychain migration (the spawn
  path read raw localStorage, which is key-stripped on healthy systems).
- **29 blocking backend commands converted to async** — no more frozen UI on
  slow SSH connects, large SFTP transfers, VNC/RDP connects, or network tools.
- Tauri event-listener leaks on fast tab close/move (TerminalPane / VncView /
  RdpView) fixed with the cancelled-flag pattern; xterm block decorations are
  disposed on eviction.
- Lost-update races: `save()`/`saveUser()` accept functional updaters; all
  workspace-tree mutations read live state. SSH passwords survive tab
  duplicate/reopen.
- UTF-8 chunk-boundary carry in every PTY/SSH/LLM reader — no more `�`
  corruption in output or persisted scrollback.
- PTY sessions reaped on exit (no zombie children); SSH outbound buffering
  capped at 4 MB; `store.json` written atomically.
- **RDP server certificates pinned trust-on-first-use** (parity with SSH);
  VNC handshake timeouts + PixelFormat validation.
- Companion server hardening: blocking IO off the async runtime, subscribe
  dedup + cap, Tailscale serve torn down and push subscriptions cleared on stop.
- Windows fixes: SSH `Include` globs, status-bar disk stats; `ssh-keygen`
  passphrase off argv (unix); LLM completions surface real HTTP errors;
  git porcelain paths parsed correctly (unstaged + renames).
- Factory reset now wipes all local state prefixes; cost telemetry throttled to
  1 Hz/tab; menu/toolbar/palette arrays memoized + sidebar memoized (no more
  whole-app re-render on the 2.5s stats poll); secondary windows covered by the
  IPC capability; multi-window storage keys unified.

### Internal
- `TerminalPane` decomposition: welcome banner, shell-integration strings, and
  spawn-env resolution extracted to pure modules (`welcomeBanner.js`,
  `shellIntegration.js`, `spawnEnv.js`).
- Codebase `CLAUDE.md` rewritten as an accurate architecture/onboarding doc;
  README refreshed.

## v0.3.6 — Security hardening (2026-06-08, unreleased)

- Closed both criticals + 19/22 highs from `docs/security-audit-2026-06-08.md`
  (keychain keys kept on cross-window sync, secrets/lock fixes, agent/terminal
  correctness, companion hardening, `detachTab` race).

## v0.3.5 — Path completion (2026-06-08)

- cwd-aware Tab path completion in the prompt editor (live shell cwd; folders
  first, spaces auto-quoted, relative/absolute prefixes).

## v0.3.4 — App-owned prompt editor, beta (2026-06-07)

- Warp-style input line: syntax highlighting, multiline, ghost-text
  autosuggest, fuzzy completions, automatic passthrough for full-screen apps.
- One shared monospace (Cascadia Code + MesloLGS NF fallback).

## v0.3.3 — Custom themes + agent streaming (2026-06-07)

- Warp-YAML theme import/export theming terminal + chrome, OS light/dark sync.
- Agent Mode streams reasoning token-by-token; Ask AI auto-detects natural
  language vs. a literal command.

## v0.3.2 — Customizable keybindings (2026-06-04)

- Remap/reset/disable every shortcut incl. the OS-level summon hotkey;
  conflict detection; live palette chips. First public cut carrying the v0.3.0/1
  work: command-block UI, PowerShell-7 autocomplete, Workflows (Warp Drive
  import/export), native Agent Mode.

## v0.2.2 — Maintenance (2026-05-30)

- Post-overhaul fixes on the workstation layout; last multi-platform (macOS /
  Linux / Windows) release until the v0.4.x CI builds.

## v0.2.1 — Panel polish + fixes (2026-05-29)

### Added
- **Resizable + collapsible side panels.** Drag the splitter to resize the right
  dock (persisted); collapse either the session tree or the tools dock to a thin
  rail (click to re-expand). They can no longer be fully closed/lost.
- **Assistant: "Clear" button** + the conversation history sent to the model is
  now bounded (last ~12 turns) so cost/latency don't grow unbounded.

### Fixed
- SFTP: disconnect the previous session before opening a new one (no leaked
  backend connections when switching SSH tabs); discard a connect that resolves
  after you've switched away; connect lazily only when the SFTP tab is viewed.
- Local file browser breadcrumb + "Up" are now separator-agnostic (works on
  Windows paths).
- Monitor: guard the MEM gauge against a zero total.
- Removed dead code and relabeled the obsolete "show sessions panel" menu item.

## v0.2.0 — Workstation overhaul (2026-05-28)

A ground-up UI overhaul into a MobaXterm-style "industrial-navy" workstation,
plus a built-in AI assistant, a live system monitor, and a multi-provider model
picker.

### Added
- **Workstation layout** matching the locked `industrial-navy` design: macOS-style
  menu bar with brand + active session/model, a lean stroke-icon toolbar grouped
  into Connect / Workspace / AI·Tools, a permanent session tree, a tabbed
  terminal grid, a right tools dock, a segmented status bar, and an F-key bar.
- **Right tools dock with three tabs** — **SFTP** (breadcrumb + Name/Size/Mod
  columns + colored file-type icons; local browser when no SSH tab), **Assistant**
  (built-in AI chat against your active model, with run/insert on commands), and
  **Monitor** (live CPU/MEM/DISK gauges + open-session list).
- **Multi-LLM provider picker** — ~40 models across Anthropic, OpenAI, Google,
  Groq, Mistral, OpenRouter, Moonshot/Kimi and more, with env-var injection at
  shell spawn (bring your own key).
- **Colored, labeled toolbox icons** per the design (Local/SSH/Serial,
  Split/MultiX/Tunnel, Ask AI/Models/Snippets/Agents).
- Local file browser gained a modified-time ("Mod") column.

### Changed
- Both side panels (session tree + tools dock) are now **always open** and can't
  be accidentally closed; Snippets/Agents open as a secondary panel beside the
  tree instead of replacing it.
- Flat terminal tabs (`● name ×`) with a blue active top-border; removed the old
  rounded "Chrome tabs", the house button, tab numbering, and the animated
  rainbow panel border.
- Status bar de-duplicated: one model indicator, no repeated "claude"; CPU/MEM/
  DISK moved to the Monitor tab.
- Multi-platform release builds (macOS / Windows / Linux) via GitHub Actions.

### Removed
- The faint "Quick tips" overlay behind the terminal.

### Notes
- Distribution moved to a hybrid model: source is developed privately, compiled
  installers are published publicly. Licensing changed from MIT to proprietary
  for this and future versions (prior MIT versions remain MIT).
