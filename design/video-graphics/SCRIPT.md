# YouTube script — Pluto's Terminals launch

**Target:** ~10-12 min when read aloud · **Tone:** direct, no corporate filler · **Skin in recording:** Synthwave Sunset (recommended) or Pluto Magenta · **Density:** Spacious

> Read it once silently. Mark cuts you'll edit. Then record. If a line feels off in your voice, rewrite it on the fly — these are anchors, not a teleprompter.

---

## 0:00 — Cold open (30 sec)

**[ON SCREEN]** Quick montage: 4 terminal panels lit up, activity dots flicking yellow, Claude responses streaming, magenta `● rec` indicator visible.

> "What if Claude wasn't ONE thing?"
>
> "What if it was five specialized agents — one reading your code, one designing the architecture, one writing the implementation, one debugging — all running side by side, in parallel, in one window?"
>
> "I built that. It's free. Let me show you."

**[CUT]** to your face on camera.

---

## 0:30 — The problem (90 sec)

**[ON SCREEN]** Static title card: "ONE CLAUDE. FIVE JOBS." Then your face.

> "Most people use Claude like this: open a chat, ask a question, ask a follow-up, ask another, ask another. Eventually you've got 40 messages of mixed concerns — research, code, debugging, writing — all in one thread.
>
> "And Claude does its best, but you're context-switching for it. Every time you change topics, it has to re-read the whole conversation. Performance drops. You hedge. You repeat yourself. The good stuff gets buried.
>
> "That's not Claude's fault. It's the interface. One chat, doing five jobs.
>
> "What if instead, you had five Claudes — each one running in its own terminal, each one with a system prompt that locks it into ONE role: researcher, planner, coder, writer, debugger. They run in parallel. They stay in character. You glance at the grid, you know which agent has what ready.
>
> "That's Pluto's Terminals."

**[CUT]** to app screenshot — full grid of 4 panels.

---

## 2:00 — The concept: prompt packs (90 sec)

**[ON SCREEN]** Pack JSON file open in editor next to the app.

> "Here's how it works. Each terminal is a real shell — PowerShell on Windows. When you load a 'pack' — a single `.deck.json` file — the app spawns Claude in that terminal, waits 2 seconds for it to be ready, and types a system prompt as the first message.
>
> "That system prompt is what makes this Claude different from any other Claude. The codebase-explorer pack tells it to read first and recommend second, never propose edits unless asked. The debug pack tells it to find the root cause, not to paper over symptoms with try/catch. The rubber-duck pack tells it to never solve the problem — just ask short clarifying questions until you figure it out yourself.
>
> "Same Claude. Different prompt. Different agent.
>
> "And the cool thing — every layout you build is just a `.deck.json` file. Drag it into Discord, share it as a gist, post it as a tweet — anyone with the app loads it in one click and gets your exact setup. Same prompts, same panels, same workflow.
>
> "26 packs ship in the binary today."

**[CUT]** to the 11-section graphics file at the pack-grid section. Slow zoom across.

---

## 3:30 — Install (60 sec)

**[ON SCREEN]** Browser at `github.com/plutothedev/plutos-terminals/releases/latest`.

> "Setup is one minute. Go to github.com/plutothedev/plutos-terminals — link in the description. Latest release. Download the MSI. Run it. Windows might warn about an unsigned installer — I'll fix that when I have $400 lying around for a code-signing cert; for now click 'more info' and 'run anyway.'
>
> "First launch — paste your Anthropic API key on the welcome screen. Or skip it and paste per-shell. The setup checker auto-opens if it doesn't see Claude Code on your PATH and walks you through installing it. Live API test confirms your key actually works before you waste time.
>
> "OK, that's it. Let me show you what I actually use this for."

**[CUT]** to your face.

---

## 5:00 — Live workflow demo (3 min)

**[ON SCREEN]** App open, 4-panel layout. Skin: Synthwave Sunset, Density: Spacious.

> "Real task. I'm adding a dark-mode toggle to a side project of mine. Four agents, four panels, one task.
>
> "Top-left, codebase-explorer. Its job is to find where the existing styling lives. Type: 'where does theming live?'"

**[ACTION]** Type the prompt in panel 1. Hit Enter. Activity dot goes yellow.

> "While that runs, I jump to the plan pane. Top-right. Same task, but its prompt tells it to articulate options with tradeoffs, not to write code. Type: 'I want to add a dark mode toggle. Two options with tradeoffs.'"

**[ACTION]** Type the prompt in panel 2. Both dots are now yellow.

> "Now I've got two agents working in parallel. The explorer's reading my codebase. The plan agent is designing options. I'm not waiting on either one — I'll come back when they're done."

**[CUT]** Brief pause. Wait for the explorer's response to start streaming.

> "Look at this. The explorer didn't try to fix anything — it just told me where colors live. File path, line number, no edits proposed. That's the system prompt working."

**[CUT]** Switch to the plan pane.

> "Plan pane gave me two options: CSS-var swap on a body class, or Tailwind dark variant. It recommended option A — no dependency change. That's the answer I needed.
>
> "Now I drop that recommendation into the code pane. Bottom-left. Type: 'implement option A'."

**[ACTION]** Type into panel 3. Yellow dot. Streaming output.

> "While that's working, debug pane stays idle on the bottom-right. It only wakes up if the code pane reports a failing test."

**[CUT]** Wait for code pane to finish. Activity dot goes green. Audio cue plays.

> "Hear that? That's the audio cue when an agent finishes. I don't have to flip between tabs to know — I HEARD it.
>
> "Code pane wrote the toggle component, updated the CSS, ran tests. Everything passes. Debug stayed idle the whole time because nothing failed. Let me check it in the browser."

**[CUT]** to browser. Toggle dark mode. Show it works.

> "Done. 5 minutes, real Claude, real code, real result."

---

## 8:00 — Power features (90 sec)

**[ON SCREEN]** Back to app.

> "Quick tour of what's under Ctrl-K."

**[ACTION]** Press Ctrl+K. Command palette opens.

> "Everything the app does — find a pack, MCPs, settings, recording, multi-window — all in one search. Type what you want, hit Enter.
>
> "Type 'record'."

**[ACTION]** Type "record" → Enter on Start recording.

> "I'm now recording the active terminal as an asciinema cast file. Real format, plays in any browser, embeds anywhere. Magenta dot in the status bar. When I'm done — Ctrl-K, stop and save, pick a path. Done. I can drop that file in Discord and you can replay my exact session."

**[ACTION]** Stop recording, save to disk.

> "Cmd-K, type 'new window'. Boom — second window, totally independent. Different skin if I want, different packs, different workflows. I can have my trading agents in one window, my coding agents in another, content in a third. They all run concurrent."

**[ACTION]** Open new window. Set it to a different skin.

> "10 skins ship — every visible surface follows the active skin. Three densities — compact, default, spacious. Pure black terminal toggle if you don't like the skin's bg in the actual terminal area. I'm using Synthwave Sunset right now because it looks good on camera."

---

## 9:30 — Personal setup (60 sec)

**[ON SCREEN]** Your face + a screenshot of your real setup.

> "How I actually use this every day:
>
> "Mornings — standup-prep pack while I drink coffee. Two minutes, formatted update, ready before standup starts.
>
> "Mid-morning — codebase-explorer + dual-claude-pair on whatever I'm shipping that day. Plan agent tells me the approach, code agent writes it, debug pane catches anything weird.
>
> "Afternoon when I'm writing — content-script-writer for video drafts, writing-helper for blog posts and emails, tweet-thread-writer for twitter. Three writing agents with totally different prompts, none of them doing the wrong thing.
>
> "Evening — journal-buddy. Three questions, five minutes. Friday night I run weekly-retro to find the patterns across the week.
>
> "Plus trading-workflow on market days because that's where the real research lives.
>
> "It's not magic. It's just better context engineering. The Claude inside is the same Claude. The system prompt is what makes it useful for the specific thing I'm doing right now."

---

## 10:30 — Outro + CTA (60 sec)

**[ON SCREEN]** GitHub URL + Discord URL on screen.

> "Free, open source, MIT license. Windows installer right now — Mac and Linux when I have a Mac and the cross-compile toolchain stops fighting me.
>
> "GitHub link is in the description. Pluto Discord is also in the description — there's a `#plutos-terminals` channel where the community shares custom packs. If you build a pack that's useful, drop it in there. I'll feature the best ones in the next video.
>
> "Question for you: what's a task you do every week that has multiple modes — researching, then writing, then editing, or planning then coding then debugging? Drop it in the comments. I'll suggest which packs to combine.
>
> "Subscribe if you want more of this. Next video I'll go deeper on writing your own packs.
>
> "See you then."

**[CUT]** End card. Sub button + recommended video thumb.

---

## Recording notes

**Pre-record (do once):**
- ✓ Open browser tab to a real React side project running locally
- ✓ Open browser tab to GitHub releases page (for the install demo)
- ✓ Open browser tab to asciinema.org (for the recording demo)
- ✓ Pluto's Terminals open with 4-panel layout pre-built
- ✓ Skin set: Synthwave Sunset · Density: Spacious
- ✓ All notification apps muted (Slack, Discord, phone)

**During recording:**
- Talk like you're talking to one specific person, not a "audience"
- The 2-second pause before systemPrompt arrives — DON'T edit it out. That's the magic.
- If a Claude pause is awkward (>15 seconds), narrate the pause: "while it's thinking, here's what's happening behind the scenes…"
- Audio cue when agents finish — react to it on camera. Lean in.

**Edit pass:**
- Cut all "uhms" and 2-second pauses (except the systemPrompt-arrival ones)
- B-roll: cut to the graphics HTML file at section transitions
- Lower-third overlays for shortcuts as you mention them ("Ctrl+K = command palette")
- Closing CTA card with subscribe button + GitHub link visible

**Length target:** 10-12 minutes published. If your raw cut is 13-14, that's fine — YouTube algorithm favors 8-12 but the content earns its length.

**Title pick:** "The way I actually use Claude Code (free app, 26 specialized agents)" — personal authority + concrete number + free download soft hook.

**Thumbnail:** your face + 4-panel grid behind you + bracket-style text "26 CLAUDES" or "MULTI-AGENT CLAUDE" in Pluto magenta.
