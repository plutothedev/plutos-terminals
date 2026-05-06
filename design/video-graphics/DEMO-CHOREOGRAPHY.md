# Demo choreography — multi-agent showcase

Script for the live "agents working in flow" segment of the YouTube video. Goal: viewers see 4 specialized Claudes doing genuinely different work on the same task, in parallel, in 5 minutes of screen time.

## The task: "add a dark-mode toggle to a React side project"

Picked because:
- **Universal** — every web dev has wanted dark mode on something
- **Visible** — the result is a togglable UI in the browser
- **Multi-step** — naturally splits into read / plan / code / verify
- **Achievable in 30 min** — but you can record the highlights in 5

If you don't have a React side project handy: clone literally any small one ([this list](https://github.com/topics/react-todo) has thousands), or use an old project of yours. Doesn't have to ship — viewers care about the workflow, not the artifact.

## The 4 agents (panel layout)

```
┌─────────────────┬─────────────────┐
│  🔍 EXPLORER    │  ⚖️  PLAN        │
│  codebase-      │  dual-claude-   │
│  explorer pack  │  pair (plan)    │
├─────────────────┼─────────────────┤
│  ⚙️  CODE        │  🐛 DEBUG        │
│  dual-claude-   │  debug-session  │
│  pair (code)    │  pack           │
└─────────────────┴─────────────────┘
```

**Setup before recording:**
1. Open Pluto's Terminals
2. `Ctrl+K → Reset workspace` (clean slate)
3. Skin: pick **Synthwave Sunset** or **Pluto Magenta** (most photogenic)
4. Density: **Spacious** (reads better at 1080p)
5. `+ pane` button 3 times → 4-panel grid
6. In each panel: `📚 packs…` → load the corresponding pack
7. Wait for each Claude to spawn + systemPrompt to land

If loading 4 packs feels like a setup tax in the video, **build a custom 4-pane combined pack** beforehand and just load that one with `🔍 find` — see "Author your own pack" below.

## 5-minute take (recordable in one shot)

| Time | Action | What viewers see |
|---|---|---|
| 0:00 | App open, panels arranged, Claudes booting | The grid lighting up — 4 active agents, activity dots flicking yellow |
| 0:15 | Click EXPLORER panel, type: `read the css file and tell me where colors live` | EXPLORER works (yellow dot), responds with file paths |
| 0:45 | While EXPLORER works, click PLAN, type: `i want to add a dark mode toggle. give me 2 implementation options with tradeoffs` | PLAN active alongside EXPLORER — both yellow simultaneously |
| 1:30 | EXPLORER goes green (done). Read out loud what it found. | Visible "agent finished" moment — green dot + bell icon vibe |
| 2:00 | Pick a plan. Click CODE: `implement option A: CSS variables + a ThemeToggle component` | CODE goes yellow, real code starts streaming |
| 3:00 | CODE working in background. Open browser, show the existing app (still light-only). | Cuts to browser tab — proves you're operating on real software |
| 4:00 | CODE goes green. Run the app — toggle works. Show on camera. | Live result. The thing actually works. |
| 4:30 | Briefly note DEBUG stayed idle (because the code pane didn't fail). Activity dots prove the pipeline. | Closes the loop — viewer understands "agents woke up only when needed" |
| 5:00 | `Ctrl+K → 💾 Export current panels as pack` → save as `dark-mode-toggle.deck.json` | Punchline: "the workflow I just used is now a single file I can share" |

## Authoring a custom 4-pane pack (optional, recommended)

Save 30 seconds of setup-on-camera by pre-building the pack and just loading it once:

```json
{
  "schema": "plutos-terminals/deck.json/v0",
  "name": "Feature Ship — 4-pane",
  "description": "Four agents for shipping a feature: explorer reads, plan designs, code implements, debug verifies.",
  "panels": [
    {
      "label": "explorer",
      "tabs": [{
        "label": "Claude — explorer",
        "cwd": null,
        "startCommands": ["claude"],
        "systemPrompt": "[paste codebase-explorer's systemPrompt]"
      }]
    },
    {
      "label": "plan",
      "tabs": [{
        "label": "Claude — plan",
        "cwd": null,
        "startCommands": ["claude"],
        "systemPrompt": "[paste dual-claude-pair's plan systemPrompt]"
      }]
    },
    {
      "label": "code",
      "tabs": [{
        "label": "Claude — code",
        "cwd": null,
        "startCommands": ["claude"],
        "systemPrompt": "[paste dual-claude-pair's code systemPrompt]"
      }]
    },
    {
      "label": "debug",
      "tabs": [{
        "label": "Claude — debug",
        "cwd": null,
        "startCommands": ["claude"],
        "systemPrompt": "[paste debug-session's systemPrompt]"
      }]
    }
  ]
}
```

Save as `prompt-packs/feature-ship.deck.json`. In the video: `Ctrl+P → "feature ship" → Enter` and all 4 agents spin up at once. Single click, 4 specialists, instant grid.

## What if Claude is slow?

You'll be sending real prompts to real Claude. Latency is variable. Two options:

**Option 1 — Edit-out wait time.** Record the full take, cut the dead seconds in editing. Most viewers expect this.

**Option 2 — Pre-record and splice.** Record each agent's response separately in dry runs, splice them into the master take in editing. Trades authenticity for tightness. Don't do this if you can help it — viewers can tell.

**Option 3 — Speed up the grid.** Record at 1.0× and play back at 1.5× during the working sections. Add a "5 minutes later…" caption on the cut. Honest and watchable.

## Pre-flight checklist

Before hitting record:

- [ ] Side-project repo cloned and dependencies installed (so `npm run dev` works)
- [ ] Browser tab open with the running app, in a separate visible window
- [ ] Pluto's Terminals open with the 4-pane setup ready
- [ ] Skin + density confirmed on camera
- [ ] All 4 Claudes responsive (test with one prompt each, then `♻️ Reset workspace` and re-spawn so the conversation history is clean)
- [ ] Microphone working (test the cold-open monologue once)
- [ ] Discord + GitHub URL confirmed in browser bookmarks for the outro
- [ ] Recording app primed (OBS / ScreenFlow / whatever)
- [ ] Quiet 30-min window — no Slack, no notifications, phone on silent

## Voiceover anchors (what to say while it works)

**While EXPLORER runs (15-30s):**
> "I'm pointing the explorer agent at this CSS file. It's not going to suggest changes — that's not its job. It's going to tell me what's already there, with file paths and line numbers, so the next agent has context."

**While PLAN responds (30s):**
> "Plan agent gets the same task but its job is options + tradeoffs. Notice it's not writing code — its systemPrompt explicitly says don't unless I ask. It's surfacing two paths and recommending one."

**While CODE works (60-90s):**
> "Now I'm dropping the chosen plan into the code pane. This Claude has a different prompt — it's the one that ships. It reads files, proposes diffs, runs tests. While it works, the other agents are still in their lanes; I can come back to them with follow-ups."

**At the green dot:**
> "Green dot means done. I didn't have to flip between tabs to watch it — it told me when it was ready."

**At the export:**
> "And here's the kicker — this whole layout, the four prompts, the order I work in — saves to one file. I drop that in Discord, you load it in your app, you run the same workflow. That's the unit of sharing."

## Variants for different audiences

If your audience is more **trader / non-dev**:
- Swap the task to: "build a 1-week trading journal in markdown using my last 5 trades"
- Use packs: `trading-workflow` + `writing-helper` + `claude-code-basic`

If your audience is more **content creator**:
- Swap to: "write a YouTube script + thumbnail copy for a video about X"
- Use packs: `content-script-writer` + `writing-helper` + `claude-code-basic`

If your audience is **mixed** (likely):
- Stick with the dark-mode toggle. It's universally legible. Viewers who don't code still understand the concept.

## The take you actually want

The most compelling 5 minutes are the one where you **don't** edit anything. Real prompts, real Claude, real latency, real result. If a Claude says something weird, that's PROOF the demo is real, not a marketing reel. Confidence comes from showing the seams, not hiding them.
