// (C)
// Tour data. body = what it is / what it does. useCase = "Use it when: ...".
// target = [data-tour=...] selector or null for a centered card.
// prep(ctx) puts the UI in the right state BEFORE the target is measured;
// ctx = { setDockTab, collapseDock } (passed from TerminalsTab).
// Copy source of truth: docs/superpowers/specs/2026-08-14-guided-tour-design.md.
// Style rule: no em dashes anywhere in user-facing copy (pluto rule).
export const TOUR_CHAPTERS = [
  "Welcome", "Connect", "Workspace", "AI tools", "Tools dock", "Speed", "Finish",
];

export const TOUR_STEPS = [
  // ── Welcome ──────────────────────────────────────────────────────────
  {
    id: "welcome", chapter: "Welcome", target: null,
    title: "Welcome to Pluto's Terminal",
    body: "One window for every shell, server, and AI agent you work with. Left: your saved sessions. Middle: tabs and terminals. Right: file transfer, AI assistant, and system monitor. This tour walks every control: about 2 minutes. Arrow keys move, Esc leaves. Replay any time from Help > Take the tour.",
  },

  // ── Connect ──────────────────────────────────────────────────────────
  {
    id: "connect-local", chapter: "Connect", target: '[data-tour="local"]',
    title: "Local shell",
    body: "Opens a local shell tab in your default shell: PowerShell, cmd, bash, zsh. Change the default in Settings.",
    useCase: "Use it when: you just need a terminal, fast.",
  },
  {
    id: "connect-ssh", chapter: "Connect", target: '[data-tour="ssh"]',
    title: "SSH sessions",
    body: "Connect to any remote machine over SSH. Password, key file, or agent auth; credentials go in the OS keychain vault, never plain text. Jump hosts supported.",
    useCase: "Use it when: VPS, home lab, cloud box, anything with an IP and port 22.",
  },
  {
    id: "connect-serial", chapter: "Connect", target: '[data-tour="serial"]',
    title: "Serial console",
    body: "Talk to hardware over a COM port: routers, switches, Arduinos, ESP32s, anything USB-UART. Pick the port and baud rate and you're in.",
    useCase: "Use it when: the device has no network yet, or you're debugging boot output.",
  },
  {
    id: "sessions-tree", chapter: "Connect", target: '[data-tour="sessions-tree"]',
    title: "Session tree",
    body: "Your saved session library. Folder it however you like; each SSH session shows a live latency dot so you can see health before you connect. Double-click connects; right-click for edit, duplicate, SFTP, tunnels.",
    useCase: "Use it when: you manage more than a couple of machines and never want to retype a host.",
    prep: (ctx) => { ctx.collapseTree?.(false); },
  },

  // ── Workspace ────────────────────────────────────────────────────────
  {
    id: "tab-strip", chapter: "Workspace", target: '[data-tour="tab-strip"]',
    title: "Tabs",
    body: "Every session lives in a tab. Drag to reorder, double-click to rename, right-click for color, duplicate, recording. The + opens a new tab on your default shell.",
    useCase: "Use it when: always. Tabs are the workspace.",
  },
  {
    id: "split", chapter: "Workspace", target: '[data-tour="split"]',
    title: "Split panes",
    body: "Split the current tab into panes: right or down, as deep as you need. Each pane is its own live terminal; drag the divider to resize. Ctrl+Shift+D and Ctrl+Shift+S from the keyboard.",
    useCase: "Use it when: logs on one side, commands on the other; or four servers on one screen.",
  },
  {
    id: "broadcast", chapter: "Workspace", target: '[data-tour="multiexec"]',
    title: "Broadcast",
    body: "Type once, send to every pane in the tab. The active pane's input mirrors to all of them while it's on.",
    useCase: "Use it when: same command on a fleet: apt upgrade on five boxes, config edit across a cluster.",
  },
  {
    id: "tunnel", chapter: "Workspace", target: '[data-tour="tunnel"]',
    title: "Tunnels",
    body: "Port forwarding and SOCKS proxy over any SSH session. Local forward brings a remote port to your machine (remote database on localhost:5432); SOCKS turns a session into a browser proxy.",
    useCase: "Use it when: the service is bound to localhost on the server, or you need your traffic to exit from that box.",
  },
  {
    id: "terminal-menu", chapter: "Workspace", target: '[data-tour="menu-terminal"]',
    title: "The Terminal menu",
    body: "The deeper workspace tools live here: session recording (save a terminal session as a replayable cast), Notebooks (runnable markdown: docs your team can execute), Saved Prompts, and sharing a block or transcript to a GitHub gist with secrets auto-masked.",
    useCase: "Use it when: you want a session you can hand to someone else.",
  },

  // ── AI tools ─────────────────────────────────────────────────────────
  {
    id: "ask-ai", chapter: "AI tools", target: '[data-tour="ask"]',
    title: "Ask AI",
    body: "Plain English to command: describe what you want, get the exact command for YOUR shell and OS, review it, press Enter to run. Ctrl+I from anywhere.",
    useCase: "Use it when: you know what you want but not the flags: 'find files over 100MB modified this week'.",
  },
  {
    id: "agent-mode", chapter: "AI tools", target: '[data-tour="agent"]',
    title: "Agent Mode",
    body: "An AI agent that works IN your terminal: it reads context (project rules files, git state, npm scripts: each read gated by your approval), proposes commands, and you approve each step. Nothing runs without you.",
    useCase: "Use it when: multi-step jobs: 'set up this repo, install deps, run the tests, fix what breaks'.",
  },
  {
    id: "models", chapter: "AI tools", target: '[data-tour="models"]',
    title: "Models",
    body: "Bring your own key for ~40 providers: Anthropic, OpenAI, Google, local Ollama, anything OpenAI-compatible. Keys live in the OS keychain. The active model shows in the top bar; Ctrl+M switches.",
    useCase: "Use it when: first AI setup, or hopping between a fast cheap model and a smart one.",
  },
  {
    id: "workflows", chapter: "AI tools", target: '[data-tour="snips"]',
    title: "Workflows",
    body: "Saved multi-step command sequences you can re-run on any session: deploy scripts, server health checks, log collection.",
    useCase: "Use it when: you catch yourself typing the same five commands in order.",
  },
  {
    id: "fleet", chapter: "AI tools", target: '[data-tour="agents"]',
    title: "Fleet",
    body: "The agent control center: run agents across multiple tabs at once and watch status per tab: working, done, needs you. The sidebar and tab dots mirror the same states.",
    useCase: "Use it when: several agents in flight and you want one place that shows who's stuck.",
  },

  // ── Tools dock ───────────────────────────────────────────────────────
  {
    id: "dock-sftp", chapter: "Tools dock", target: '[data-tour="dock-files"]',
    title: "SFTP file browser",
    body: "A file browser for the active SSH session. Upload, download, rename, delete; double-click a remote file to edit it locally and it writes back on save. F4 toggles it.",
    useCase: "Use it when: config edits and file moves without ever typing scp.",
    prep: (ctx) => { ctx.collapseDock?.(false); ctx.setDockTab?.("files"); },
  },
  {
    id: "dock-assistant", chapter: "Tools dock", target: '[data-tour="dock-assistant"]',
    title: "AI Assistant",
    body: "The chat AI with your terminal as context: it can read your scrollback (you control how much) and answer about errors on screen.",
    useCase: "Use it when: a wall of stack trace just hit and you want 'what broke?' answered in place.",
    prep: (ctx) => { ctx.collapseDock?.(false); ctx.setDockTab?.("assistant"); },
  },
  {
    id: "dock-monitor", chapter: "Tools dock", target: '[data-tour="dock-monitor"]',
    title: "System monitor",
    body: "Live CPU, memory, and disk for the machine you're ON in the active tab: local shows local, SSH shows the remote.",
    useCase: "Use it when: 'is it my machine or the server' takes one glance.",
    prep: (ctx) => { ctx.collapseDock?.(false); ctx.setDockTab?.("monitor"); },
  },
  {
    id: "dock-collapse", chapter: "Tools dock", target: '[data-tour="dock-collapse"]',
    title: "Collapse the dock",
    body: "The whole dock collapses to a rail when you want pure terminal width; drag the edge to resize.",
    useCase: "Use it when: ultrawide focus mode, or small laptop screens.",
    prep: (ctx) => { ctx.collapseDock?.(false); },
  },

  // ── Speed ────────────────────────────────────────────────────────────
  {
    id: "quick-connect", chapter: "Speed", target: '[data-tour="quick-connect"]',
    title: "Quick connect",
    body: "Type user@host or an IP and hit Enter: instant SSH, no session setup. It also searches your saved sessions by name.",
    useCase: "Use it when: one-off connections, or jumping to a saved box by typing three letters.",
  },
  {
    id: "palette", chapter: "Speed", target: '[data-tour="fkey-palette"]',
    title: "Command palette",
    body: "Ctrl+K: every command in the app, searchable. New tab, split, start recording, switch theme, open settings: type a word, Enter.",
    useCase: "Use it when: you know what you want and don't want to find the button.",
  },
  {
    id: "fkey-bar", chapter: "Speed", target: '[data-tour="fkey-bar"]',
    title: "Function key bar",
    body: "The MobaXterm-style function row: F1 help, F2 new tab, F3 split, F4 SFTP, F9 macros, plus the Ctrl chords. Click or press.",
    useCase: "Use it when: muscle memory from MobaXterm, or discovering shortcuts.",
  },
  {
    id: "status-bar", chapter: "Speed", target: '[data-tour="status-bar"]',
    title: "Status bar",
    body: "Live session facts: active session name, terminal size in columns x rows, your shell, recording indicator, app version, and the GitHub and Discord links.",
    useCase: "Use it when: quick 'what am I looking at' checks.",
  },
  {
    id: "theme-toggle", chapter: "Speed", target: '[data-tour="theme-toggle"]',
    title: "Themes",
    body: "Dark, light, and OLED-black skins; the terminal palette is separately themeable (import Warp or iTerm themes in Settings).",
    useCase: "Use it when: bright room, dark room, AMOLED battery, taste.",
  },

  // ── Finish ───────────────────────────────────────────────────────────
  {
    id: "finish", chapter: "Finish", target: null,
    title: "That's the whole surface",
    body: "Three things worth doing now: save your first SSH session, pick an AI model (Ctrl+M), and join the Discord for packs, tips, and help. Replay this tour any time: Help > Take the tour.",
  },
];
