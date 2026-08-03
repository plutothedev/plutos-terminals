# Changelog

## Unreleased (v0.6.0)

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
  gist-share preview/upload and the agent context block.

### Fixed
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
