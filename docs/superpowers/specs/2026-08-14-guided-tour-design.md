<!-- (C) -->
# Guided Tour — design spec (2026-08-14)

Approved by pluto 2026-08-14 ("detailed and in depth so users can get the most out of this application").

## Goal

A comprehensive, chaptered, spotlight-style guided tour of the whole app. Every visible control gets a stop: what it does + a concrete use case. New installers learn the full surface; anyone can replay it from Help.

## Decisions (locked with pluto)

- **Structure:** one chaptered tour, ~25 stops, every control covered. Chapter jump list; skippable at any point.
- **Trigger:** auto-OFFER once after the existing onboarding overlay completes (corner card, "No thanks" never nags again). Permanent "Take the tour" entry in Help menu.
- **Tech:** in-house spotlight engine, zero new deps (CSP-safe, token-themed, chapters need custom UI anyway). No driver.js.
- **Narration:** text cards (title / what-it-does / "Use it when"). aria-live polite so screen readers hear each stop.

## Architecture

```
src/features/terminals/tour/
  tourSteps.js      — pure data: chapters + steps (id, chapter, target, title, body, useCase, prep?)
  placement.js      — pure math: pick card side + clamp to viewport (unit-tested)
  TourOverlay.jsx   — engine: backdrop, glow ring, card, keyboard, chapter nav
```

- **Targets:** `data-tour="<id>"` attributes sprinkled on chrome components (one-line edits). Steps reference `[data-tour=...]` selectors — no coupling to class names.
- **Backdrop:** four fixed dim rects around the target's rect (no SVG mask). Everything pointer-blocked except the card.
- **Glow ring:** absolute border around target rect, `--phn-link` glow, 6px radius.
- **Card:** ~340px, `--phn-elevated-bg` + token border; chapter chip, step title, body, "Use it when:" line, progress `7/25`, Back / Next / Skip; "Chapters" toggle opens jump list.
- **Keyboard:** `→`/`Enter` next, `←` back, `Esc` end. Focus trapped in card.
- **Resilience:** window resize/scroll recomputes rect; target `scrollIntoView` nearest; missing target (feature not on screen) auto-skips the stop; `prep(ctx)` runs before measuring to put UI in the right state (`ctx` = `{ selectRibbon, setDockTab, ensureTab }` passed from TerminalsTab).
- **Persistence:** `localStorage phn.tourDone = "1"` on finish or skip or "No thanks". First-run offer renders when onboarding is complete AND `!tourDone`.
- **Centered stops:** `target: null` renders the card centered, no spotlight (welcome + finish).

## Chapters and step copy (the deliverable)

Copy style: plain, concrete, zero fluff. Every stop = what it is → what it does → "Use it when". No em dashes in user-facing copy (pluto rule); hyphens/colons/periods only.

### Ch. 1 — Welcome (1)

1. **welcome** (centered): "This is Pluto's Terminal: one window for every shell, server, and AI agent you work with. Left: your saved sessions. Middle: tabs and terminals. Right: file transfer, AI assistant, and system monitor. This tour walks every control: about 2 minutes, arrow keys to move, Esc to leave. Replay any time from Help > Take the tour."

### Ch. 2 — Connect (4)

2. **connect-local** (`Local` toolbar button): "Opens a local shell tab in your default shell (PowerShell, cmd, bash, zsh: set it in Settings). Use it when: you just need a terminal, fast."
3. **connect-ssh** (`SSH` button): "Connect to any remote machine over SSH. Password, key file, or agent auth; credentials go in the OS keychain vault, never plain text. Jump hosts supported. Use it when: VPS, home lab, cloud box, anything with an IP and port 22."
4. **connect-serial** (`Serial` button): "Talk to hardware over a COM port: routers, switches, Arduinos, ESP32s, anything USB-UART. Pick port and baud rate and you're in. Use it when: the device has no network yet, or you're debugging boot output."
5. **sessions-tree** (left rail): "Your saved session library. Folder it however you like; each SSH session shows a live latency dot so you can see health before you connect. Double-click connects; right-click for edit, duplicate, SFTP, tunnels. Use it when: you manage more than a couple of machines and never want to retype a host."

### Ch. 3 — Workspace (5)

6. **tab-strip** (tab strip): "Every session lives in a tab. Drag to reorder, double-click to rename, right-click for color, duplicate, recording. The + opens a new tab on your default shell. Use it when: always. Tabs are the workspace."
7. **split** (`Split` button): "Split the current tab into panes: right or down, as deep as you need. Each pane is its own live terminal; drag the divider to resize, Ctrl+Shift+D / Ctrl+Shift+S from the keyboard. Use it when: logs on one side, commands on the other; or four servers on one screen."
8. **broadcast** (`Broadcast` button): "Type once, send to every pane in the tab. The active pane's input mirrors to all of them while it's on. Use it when: same command on a fleet: apt upgrade on five boxes, config edit across a cluster."
9. **tunnel** (`Tunnel` button): "Port forwarding and SOCKS proxy over any SSH session. Local forward brings a remote port to your machine (remote database on localhost:5432); SOCKS turns a session into a browser proxy. Use it when: the service is bound to localhost on the server, or you need your traffic to exit from that box."
10. **terminal-menu** (Terminal menu): "The deeper workspace tools live here: session recording (save a terminal session as a replayable cast), Notebooks (runnable markdown: docs your team can execute), Saved Prompts, and sharing a block or transcript to a GitHub gist with secrets auto-masked. Use it when: you want a session you can hand to someone else."

### Ch. 4 — AI tools (5)

11. **ask-ai** (`Ask AI` button): "Plain English to command: describe what you want, get the exact command for YOUR shell and OS, review it, press Enter to run. Ctrl+I from anywhere. Use it when: you know what you want but not the flags: 'find files over 100MB modified this week'."
12. **agent-mode** (`Agent Mode` button): "An AI agent that works IN your terminal: it reads context (project rules files, git state, npm scripts: each read gated by your approval), proposes commands, and you approve each step. Nothing runs without you. Use it when: multi-step jobs: 'set up this repo, install deps, run the tests, fix what breaks'."
13. **models** (`Models` button): "Bring your own key for ~40 providers: Anthropic, OpenAI, Google, local Ollama, anything OpenAI-compatible. Keys live in the OS keychain. The active model shows in the top bar; Ctrl+M switches. Use it when: first AI setup, or hopping between a fast cheap model and a smart one."
14. **workflows** (`Workflows` button): "Saved multi-step command sequences you can re-run on any session: deploy scripts, server health checks, log collection. Use it when: you catch yourself typing the same five commands in order."
15. **fleet** (`Fleet` button): "The agent control center: run agents across multiple tabs at once and watch status per tab: working, done, needs you. The sidebar and tab dots mirror the same states. Use it when: several agents in flight and you want one place that shows who's stuck."

### Ch. 5 — Tools dock (4)

16. **dock-sftp** (SFTP dock tab, prep: open dock to SFTP): "A file browser for the active SSH session. Upload, download, rename, delete; double-click a remote file to edit it locally and it writes back on save. F4 toggles it. Use it when: config edits and file moves without ever typing scp."
17. **dock-assistant** (Assistant dock tab, prep): "The chat AI with your terminal as context: it can read your scrollback (you control how much) and answer about errors on screen. Use it when: a wall of stack trace just hit and you want 'what broke?' answered in place."
18. **dock-monitor** (Monitor dock tab, prep): "Live CPU, memory, and disk for the machine you're ON in the active tab: local shows local, SSH shows the remote. Use it when: 'is it my machine or the server' takes one glance."
19. **dock-collapse** (dock collapse control): "The whole dock collapses to a rail when you want pure terminal width; drag the edge to resize. Use it when: ultrawide focus mode, or small laptop screens."

### Ch. 6 — Speed (5)

20. **quick-connect** (search box): "Type user@host or an IP and hit Enter: instant SSH, no session setup. It also searches your saved sessions by name. Use it when: one-off connections, or jumping to a saved box by typing three letters."
21. **palette** (via F-key bar chip or Ctrl+K stop, centered fallback): "Ctrl+K: every command in the app, searchable. New tab, split, start recording, switch theme, open settings: type a word, Enter. Use it when: you know what you want and don't want to find the button."
22. **fkey-bar** (bottom F-key bar): "The MobaXterm-style function row: F1 help, F2 new tab, F3 split, F4 SFTP, F9 macros, plus the Ctrl chords. Click or press. Use it when: muscle memory from MobaXterm, or discovering shortcuts."
23. **status-bar** (status bar): "Live session facts: active session name, terminal size in columns x rows, your shell, recording indicator, app version, and the GitHub and Discord links. Use it when: quick 'what am I looking at' checks."
24. **theme-toggle** (theme toggle in menu bar): "Dark, light, and OLED-black skins; the terminal palette is separately themeable (import Warp/iTerm themes in Settings). Use it when: bright room, dark room, AMOLED battery, taste."

### Ch. 7 — Finish (1)

25. **finish** (centered): "That's the whole surface. Three things worth doing now: save your first SSH session (Sessions > Save), pick an AI model (Ctrl+M), and join the Discord for packs, tips, and help. Replay this tour any time: Help > Take the tour."

## First-run offer

Corner card bottom-right after onboarding completes (and `!tourDone`): "New here? Take the 2-minute tour of everything." [Start tour] [No thanks]. Either choice writes `tourDone`; Start opens the tour. Token-styled, no modal, doesn't block the app.

## Testing

- `placement.js`: pure function `pickPlacement(targetRect, cardSize, viewport)` returns side + clamped x/y. Unit tests: fits-below preferred, flips above near bottom edge, clamps at corners, centered mode for null target.
- `tourSteps.js` integrity test: unique ids, every step has chapter/title/body/useCase, chapters contiguous and ordered, selectors non-empty for non-centered stops.
- Engine behavior (jsdom): missing target skips forward; Esc ends and persists tourDone; chapter jump moves to first step of chapter.
- Visual: dev-pane loop across dark/oled/light skins.

## Out of scope

- Audio narration.
- Per-area mini-tours (chapter jump list covers it).
- Coach marks outside the tour (no permanent hint badges).
