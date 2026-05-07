# How other AI creators visualize agents — research findings

Looked at how the Claude Code / agent space currently demonstrates "agents working in parallel" on screen. Filtered findings + how each technique applies (or doesn't) to Pluto's Terminals.

## What the space does today

### 1. tmux split-panes (Claude Code official + Indy Dev Dan school)

Anthropic recently shipped "agent teams" in Claude Code with explicit tmux integration. Each teammate gets its own pane in a tmux split. **Cole Medin** uses this. **Indy Dev Dan** uses this with git worktrees.

**Limitations they all hit:**
- tmux doesn't work in Windows Terminal, VS Code integrated terminal, Ghostty
- Configuring tmux is gatekeeping — most viewers can't replicate the demo
- Pane layout is keyboard-driven; not very photogenic

**What Pluto's Terminals does better:**
- Native multi-pane on Windows out of the box, no tmux
- Visual grid renders cleanly without keyboard incantations
- Same parallel-agent power without the tmux entry tax

**Use this in your video:** position explicitly. *"tmux is what advanced devs use to do this on Mac and Linux. I built Pluto's Terminals because I'm on Windows and I wanted the same thing without the tmux entry tax."*

### 2. Browser dashboards with status cards (Vue/React monitors)

Pattern from "Multi-Agent Orchestration: Running 10+ Claude Instances in Parallel" articles. Browser-based dashboards showing:

- Agent cards in a grid layout with status, current task, progress bars
- Color-coded status indicators (green active / amber busy / red error)
- Live activity stream with timestamps
- WebSocket-driven real-time updates
- Conflict alerts highlighted in red

**The convention is settled:** yellow-while-working / green-when-done / red-on-error. Pluto's Terminals already follows this convention — viewers will pattern-match instantly.

**What Pluto's Terminals does better:**
- Each panel is a REAL PTY shell, not a status card abstraction
- Viewers see Claude's actual output streaming, not just "✓ task complete"
- Real audio cue when agents finish (no other tool has this)
- One unified app, not "browser dashboard + 10 invisible processes"

### 3. Whiteboard / animated diagrams between code segments

Used by **AI Jason**, **David Shapiro**, **Mervin Praison**. Common pattern:

- 60-second code segment
- Cut to a clean animated diagram explaining the architecture
- Cut back to code

The diagrams are usually built in Figma / Canva / After Effects with simple "agent → arrow → next agent" flow charts.

**Use this:** the [`design/video-graphics/index.html`](index.html) file you have is exactly this — a slide deck for cuts between live demo segments. Screen-record sections of it and use as B-roll between the live demo footage.

### 4. Code-streaming captured at full speed

Used by **Indy Dev Dan**, **Theo (t3.gg)**, **Fireship**.

The technique: don't speed up Claude's output. The variable-speed character streaming IS the proof it's real Claude. Speeding it up makes viewers suspicious.

**Use this:** in your demo, hit `Ctrl+1` etc. to switch to whichever panel just started streaming. Hold the wide shot. The streaming is its own visual.

### 5. Picture-in-picture face cam reacting to agent output

Used by **Matthew Berman**, **AI Search**, basically anyone who has a face cam. The pattern: agents work in main shot, your face in a corner reacts (lean in when something cool happens, eyes-up-thinking during pauses, slight nod when an agent finishes).

**Use this:** your face cam in the bottom-right corner. When the audio cue fires (agents finishing), let yourself smile / nod. Viewers subconsciously read this as "even the creator is impressed."

### 6. Annotated callouts on top of recordings

Used by **Cole Medin**, **Theo**. Add post-production annotations:

- Circle around a specific file path Claude cited
- Arrow pointing to the activity dot when it changes
- Box highlighting the cost meter ticking up
- Caption-style text overlay: "← Claude just READ this file, no edits yet"

**Use this:** in your edit pass, add 3-4 callout overlays at the moments that prove "this is doing real work" — file path citations, activity dot transitions, cost meter ticks.

### 7. Asciinema cast playback at 4× speed

Surprisingly underused. **No major creator I found uses asciinema casts as B-roll.** Pluto's Terminals just shipped `.cast` file recording in v0.1.18.

**Use this — this is your differentiator:** record a real 30-min session, save the `.cast`, play it back at 4× speed in a corner of the video while you talk. Hard proof that's not edited. Casts are the YouTube equivalent of an open-source receipt.

## Composite recommendation for your video

Combine techniques 1, 4, 5, 6, 7 in this order:

1. **Cold open:** picture-in-picture face cam + 4-panel agent grid going yellow→green sequentially
2. **Problem statement:** cut to whiteboard-style graphic from `index.html` (single Claude vs multi-agent)
3. **Live demo:** full-speed streaming captures, no edits during agent thinking time
4. **Mid-roll proof:** quick PIP showing your face leaning in as the audio cue fires
5. **Annotated callouts** (post): circle file paths + activity dot transitions in editing
6. **Outro proof:** asciinema cast playing back at 4× speed in a corner while you wrap up

## What the space is NOT doing yet (your opening)

- **Audio cue when agents finish** — nobody has this. You shipped it in v0.1.25.
- **Full-app theming with skin-aware xterm** — nobody else themes the terminal output area to match the chrome. You have 10 skins.
- **Pack-as-a-file shareability** — Claude Code's agent teams are config-as-code (settings.json). Yours is one drag-and-droppable file. Stronger primitive.
- **Drag-drop overlay UX** — when someone drags a `.deck.json` over your window, the overlay appears. That's a designed gesture. Show it.
- **Per-window skin / density** — you can have multiple windows with totally different visual themes. Nobody else does this.

Sources:
- [Anthropic Claude Code agent teams documentation](https://code.claude.com/docs/en/agent-teams)
- [Watch Claude Code Agents Work Side by Side: tmux Setup Guide](https://ksingh7.medium.com/watch-claude-code-agents-work-side-by-side-a-tmux-setup-guide-1ef3ba1531c4)
- [Multi-Agent Orchestration: Running 10+ Claude Instances in Parallel](https://dev.to/bredmond1019/multi-agent-orchestration-running-10-claude-instances-in-parallel-part-3-29da)
- [Cole Medin's AI Agents Masterclass](https://github.com/coleam00/ai-agents-masterclass)
- [Indy Dev Dan's Infinite Agentic Loop](https://github.com/disler/infinite-agentic-loop)
- [Cole Medin YouTube channel](https://www.youtube.com/@ColeMedin)
- [Matthew Berman YouTube channel](https://www.youtube.com/@matthew_berman)
- [Claude Code Multi-Agent tmux Setup (Dariusz Parys)](https://www.dariuszparys.com/claude-code-multi-agent-tmux-setup/)
